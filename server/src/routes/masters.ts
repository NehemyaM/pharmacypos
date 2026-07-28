import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, currentMonth } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { isValidGstin } from '../lib/gst.js';
import { audit } from '../lib/audit.js';
import type { Product } from '../types.js';

export const productsRouter = Router();
export const suppliersRouter = Router();
export const customersRouter = Router();
export const doctorsRouter = Router();

productsRouter.use(requireAuth);
suppliersRouter.use(requireAuth);
customersRouter.use(requireAuth);
doctorsRouter.use(requireAuth);

// ===========================================================================
// Products
// ===========================================================================

/**
 * Product search for the billing screen. Ranked so an exact brand-name prefix
 * beats a mid-string or composition hit — a pharmacist typing "PARA" wants
 * Paracetamol first, not every product containing paracetamol.
 */
productsRouter.get('/', (req, res) => {
  const db = getDb();
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const includeInactive = req.query.includeInactive === 'true';
  const inStockOnly = req.query.inStock === 'true';
  const cm = currentMonth();

  const where: string[] = [];
  const params: unknown[] = [];
  if (!includeInactive) where.push('p.active = 1');
  if (q) {
    where.push('(p.name LIKE ? OR p.generic_name LIKE ? OR p.manufacturer LIKE ? OR p.barcode = ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, q);
  }

  const having = inStockOnly ? 'HAVING stock_units > 0' : '';
  const rank = q
    ? `CASE WHEN p.barcode = ? THEN 0
            WHEN p.name LIKE ? THEN 1
            WHEN p.name LIKE ? THEN 2
            WHEN p.generic_name LIKE ? THEN 3
            ELSE 4 END`
    : '0';
  const rankParams = q ? [q, `${q}%`, `%${q}%`, `${q}%`] : [];

  const rows = db.prepare(
    `SELECT p.*,
            ${rank} AS rank,
            COALESCE(SUM(CASE WHEN b.expiry >= ? AND b.active = 1 THEN b.qty_units END), 0) AS stock_units,
            MIN(CASE WHEN b.qty_units > 0 AND b.expiry >= ? AND b.active = 1 THEN b.expiry END) AS nearest_expiry,
            MAX(CASE WHEN b.qty_units > 0 AND b.expiry >= ? AND b.active = 1 THEN b.mrp_paise END) AS mrp_paise
       FROM products p
       LEFT JOIN batches b ON b.product_id = p.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY p.id
      ${having}
      ORDER BY rank, p.name
      LIMIT ?`,
  ).all(...rankParams, cm, cm, cm, ...params, limit);

  res.json(rows);
});

productsRouter.get('/:id', (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const batches = db.prepare(
    `SELECT b.*, s.name AS supplier_name
       FROM batches b LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.product_id = ? ORDER BY b.expiry`,
  ).all(Number(req.params.id));
  res.json({ ...product, batches });
});

/** Batches available to dispense for a product, earliest expiry first (FEFO). */
productsRouter.get('/:id/batches', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, batch_no, expiry, mrp_paise, sale_rate_paise, purchase_rate_paise, qty_units
       FROM batches
      WHERE product_id = ? AND qty_units > 0 AND active = 1 AND expiry >= ?
      ORDER BY expiry, id`,
  ).all(Number(req.params.id), currentMonth());
  res.json(rows);
});

const productSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  generic_name: z.string().default(''),
  manufacturer: z.string().default(''),
  category: z.string().default('GENERAL'),
  schedule_type: z.enum(['OTC', 'G', 'H', 'H1', 'X', 'C', 'C1']).default('OTC'),
  hsn_code: z.string().default('3004'),
  gst_rate: z.number().int().min(0).max(28).default(5),
  unit: z.string().default('TAB'),
  pack_size: z.number().int().positive().default(1),
  pack_label: z.string().default(''),
  barcode: z.string().default(''),
  rack: z.string().default(''),
  reorder_level: z.number().int().min(0).default(0),
  cold_chain: z.boolean().default(false),
  allow_loose: z.boolean().default(true),
  active: z.boolean().default(true),
});

productsRouter.post('/', requireRole('pharmacist'), (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();
  const ts = nowIso();
  const info = db.prepare(
    `INSERT INTO products (name, generic_name, manufacturer, category, schedule_type, hsn_code,
       gst_rate, unit, pack_size, pack_label, barcode, rack, reorder_level, cold_chain,
       allow_loose, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(d.name.trim(), d.generic_name, d.manufacturer, d.category, d.schedule_type, d.hsn_code,
    d.gst_rate, d.unit, d.pack_size, d.pack_label, d.barcode, d.rack, d.reorder_level,
    d.cold_chain ? 1 : 0, d.allow_loose ? 1 : 0, d.active ? 1 : 0, ts, ts);

  audit(req.user!.id, req.user!.username, 'CREATE_PRODUCT', 'products', Number(info.lastInsertRowid), d.name);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

productsRouter.patch('/:id', requireRole('pharmacist'), (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Product | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const parsed = productSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  db.prepare(
    `UPDATE products SET name=?, generic_name=?, manufacturer=?, category=?, schedule_type=?,
       hsn_code=?, gst_rate=?, unit=?, pack_size=?, pack_label=?, barcode=?, rack=?,
       reorder_level=?, cold_chain=?, allow_loose=?, active=?, updated_at=? WHERE id=?`,
  ).run(
    d.name ?? existing.name, d.generic_name ?? existing.generic_name,
    d.manufacturer ?? existing.manufacturer, d.category ?? existing.category,
    d.schedule_type ?? existing.schedule_type, d.hsn_code ?? existing.hsn_code,
    d.gst_rate ?? existing.gst_rate, d.unit ?? existing.unit,
    d.pack_size ?? existing.pack_size, d.pack_label ?? existing.pack_label,
    d.barcode ?? existing.barcode, d.rack ?? existing.rack,
    d.reorder_level ?? existing.reorder_level,
    d.cold_chain === undefined ? existing.cold_chain : d.cold_chain ? 1 : 0,
    d.allow_loose === undefined ? existing.allow_loose : d.allow_loose ? 1 : 0,
    d.active === undefined ? existing.active : d.active ? 1 : 0,
    nowIso(), id,
  );
  audit(req.user!.id, req.user!.username, 'UPDATE_PRODUCT', 'products', id, existing.name);
  res.json({ ok: true });
});

// ===========================================================================
// Suppliers
// ===========================================================================

suppliersRouter.get('/', (req, res) => {
  const db = getDb();
  const q = String(req.query.q ?? '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM suppliers WHERE active = 1 AND (name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 100')
      .all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all();
  res.json(rows);
});

const supplierSchema = z.object({
  name: z.string().min(1, 'Supplier name is required'),
  contact_person: z.string().default(''),
  phone: z.string().default(''),
  email: z.string().default(''),
  address: z.string().default(''),
  city: z.string().default(''),
  state: z.string().default('Telangana'),
  state_code: z.string().default('36'),
  gstin: z.string().default(''),
  dl_no: z.string().default(''),
  credit_days: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

suppliersRouter.post('/', requireRole('pharmacist'), (req, res) => {
  const parsed = supplierSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  if (d.gstin && !isValidGstin(d.gstin)) {
    res.status(400).json({ error: 'That GSTIN is not valid' });
    return;
  }
  const info = getDb().prepare(
    `INSERT INTO suppliers (name, contact_person, phone, email, address, city, state, state_code,
       gstin, dl_no, credit_days, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(d.name.trim(), d.contact_person, d.phone, d.email, d.address, d.city, d.state,
    d.state_code, d.gstin.toUpperCase(), d.dl_no, d.credit_days, d.active ? 1 : 0, nowIso());
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

suppliersRouter.patch('/:id', requireRole('pharmacist'), (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Supplier not found' });
    return;
  }
  const parsed = supplierSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  if (d.gstin && !isValidGstin(d.gstin)) {
    res.status(400).json({ error: 'That GSTIN is not valid' });
    return;
  }
  db.prepare(
    `UPDATE suppliers SET name=?, contact_person=?, phone=?, email=?, address=?, city=?, state=?,
       state_code=?, gstin=?, dl_no=?, credit_days=?, active=? WHERE id=?`,
  ).run(
    d.name ?? existing.name, d.contact_person ?? existing.contact_person,
    d.phone ?? existing.phone, d.email ?? existing.email, d.address ?? existing.address,
    d.city ?? existing.city, d.state ?? existing.state, d.state_code ?? existing.state_code,
    (d.gstin ?? existing.gstin as string).toUpperCase(), d.dl_no ?? existing.dl_no,
    d.credit_days ?? existing.credit_days,
    d.active === undefined ? existing.active : d.active ? 1 : 0, id,
  );
  res.json({ ok: true });
});

// ===========================================================================
// Customers
// ===========================================================================

customersRouter.get('/', (req, res) => {
  const db = getDb();
  const q = String(req.query.q ?? '').trim();
  const rows = q
    ? db.prepare(
      `SELECT * FROM customers WHERE active = 1 AND (name LIKE ? OR phone LIKE ?)
        ORDER BY CASE WHEN phone = ? THEN 0 ELSE 1 END, name LIMIT 50`,
    ).all(`%${q}%`, `%${q}%`, q)
    : db.prepare('SELECT * FROM customers WHERE active = 1 ORDER BY name LIMIT 100').all();
  res.json(rows);
});

/** Purchase history for a walk-in customer — used for refill reminders. */
customersRouter.get('/:id/history', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.total_paise, s.status,
            COUNT(si.id) AS item_count
       FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE s.customer_id = ?
      GROUP BY s.id ORDER BY s.invoice_date DESC LIMIT 50`,
  ).all(Number(req.params.id));
  res.json(rows);
});

const customerSchema = z.object({
  name: z.string().min(1, 'Customer name is required'),
  phone: z.string().default(''),
  email: z.string().default(''),
  address: z.string().default(''),
  city: z.string().default('Hyderabad'),
  state_code: z.string().default('36'),
  gstin: z.string().default(''),
  credit_limit: z.number().int().min(0).default(0),
  notes: z.string().default(''),
  active: z.boolean().default(true),
});

customersRouter.post('/', (req, res) => {
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  if (d.gstin && !isValidGstin(d.gstin)) {
    res.status(400).json({ error: 'That GSTIN is not valid' });
    return;
  }
  const info = getDb().prepare(
    `INSERT INTO customers (name, phone, email, address, city, state_code, gstin, credit_limit,
       notes, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(d.name.trim(), d.phone, d.email, d.address, d.city, d.state_code,
    d.gstin.toUpperCase(), d.credit_limit, d.notes, d.active ? 1 : 0, nowIso());
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

customersRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const parsed = customerSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  db.prepare(
    `UPDATE customers SET name=?, phone=?, email=?, address=?, city=?, state_code=?, gstin=?,
       credit_limit=?, notes=?, active=? WHERE id=?`,
  ).run(
    d.name ?? existing.name, d.phone ?? existing.phone, d.email ?? existing.email,
    d.address ?? existing.address, d.city ?? existing.city,
    d.state_code ?? existing.state_code, (d.gstin ?? existing.gstin as string).toUpperCase(),
    d.credit_limit ?? existing.credit_limit, d.notes ?? existing.notes,
    d.active === undefined ? existing.active : d.active ? 1 : 0, id,
  );
  res.json({ ok: true });
});

// ===========================================================================
// Doctors (prescribers) — their name and address are mandatory H1 register data
// ===========================================================================

doctorsRouter.get('/', (req, res) => {
  const db = getDb();
  const q = String(req.query.q ?? '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM doctors WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT 50').all(`%${q}%`)
    : db.prepare('SELECT * FROM doctors WHERE active = 1 ORDER BY name').all();
  res.json(rows);
});

const doctorSchema = z.object({
  name: z.string().min(1, 'Doctor name is required'),
  qualification: z.string().default(''),
  reg_no: z.string().default(''),
  hospital: z.string().default(''),
  address: z.string().default(''),
  phone: z.string().default(''),
  active: z.boolean().default(true),
});

doctorsRouter.post('/', (req, res) => {
  const parsed = doctorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const info = getDb().prepare(
    `INSERT INTO doctors (name, qualification, reg_no, hospital, address, phone, active, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(d.name.trim(), d.qualification, d.reg_no, d.hospital, d.address, d.phone,
    d.active ? 1 : 0, nowIso());
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

doctorsRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM doctors WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Doctor not found' });
    return;
  }
  const parsed = doctorSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  db.prepare(
    `UPDATE doctors SET name=?, qualification=?, reg_no=?, hospital=?, address=?, phone=?, active=?
      WHERE id=?`,
  ).run(
    d.name ?? existing.name, d.qualification ?? existing.qualification,
    d.reg_no ?? existing.reg_no, d.hospital ?? existing.hospital,
    d.address ?? existing.address, d.phone ?? existing.phone,
    d.active === undefined ? existing.active : d.active ? 1 : 0, id,
  );
  res.json({ ok: true });
});
