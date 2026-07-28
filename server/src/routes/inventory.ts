import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, currentMonth, addMonths } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { HttpError } from './sales.js';
import type { Batch, Product } from '../types.js';

export const inventoryRouter = Router();
inventoryRouter.use(requireAuth);

/** Batch-wise stock on hand with valuation at cost and at MRP. */
inventoryRouter.get('/stock', (req, res) => {
  const db = getDb();
  const q = String(req.query.q ?? '').trim();
  const filter = String(req.query.filter ?? 'all'); // all | low | out | expiring | expired
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const cm = currentMonth();

  const where: string[] = ['p.active = 1'];
  const params: unknown[] = [];
  if (q) {
    where.push('(p.name LIKE ? OR p.generic_name LIKE ? OR b.batch_no LIKE ? OR p.manufacturer LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  switch (filter) {
    case 'expired':
      where.push('b.expiry < ? AND b.qty_units > 0');
      params.push(cm);
      break;
    case 'expiring': {
      const months = Math.max(1, Math.round((Number(req.query.days) || 90) / 30));
      where.push('b.expiry >= ? AND b.expiry <= ? AND b.qty_units > 0');
      params.push(cm, addMonths(cm, months));
      break;
    }
    case 'out':
      where.push('b.qty_units <= 0');
      break;
    case 'low':
      where.push('b.qty_units > 0 AND b.qty_units <= p.reorder_level AND p.reorder_level > 0');
      break;
    default:
      where.push('b.qty_units > 0');
  }

  const rows = db.prepare(
    `SELECT b.id, b.batch_no, b.expiry, b.mrp_paise, b.purchase_rate_paise, b.sale_rate_paise,
            b.qty_units, b.received_at,
            p.id AS product_id, p.name AS product_name, p.generic_name, p.manufacturer,
            p.unit, p.pack_size, p.rack, p.schedule_type, p.gst_rate, p.hsn_code,
            p.reorder_level, p.cold_chain,
            s.name AS supplier_name,
            (b.qty_units * b.purchase_rate_paise) / p.pack_size AS cost_value_paise,
            (b.qty_units * b.mrp_paise) / p.pack_size AS mrp_value_paise,
            CASE WHEN b.expiry < ? THEN 'EXPIRED'
                 WHEN b.expiry <= ? THEN 'EXPIRING'
                 ELSE 'OK' END AS expiry_status
       FROM batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.expiry, p.name
      LIMIT ?`,
  ).all(cm, addMonths(cm, 3), ...params, limit);

  res.json(rows);
});

/** Counts and valuation for the dashboard tiles. */
inventoryRouter.get('/summary', (_req, res) => {
  const db = getDb();
  const cm = currentMonth();
  const in3 = addMonths(cm, 3);
  const in6 = addMonths(cm, 6);

  const valuation = db.prepare(
    `SELECT COALESCE(SUM((b.qty_units * b.purchase_rate_paise) / p.pack_size), 0) AS cost_paise,
            COALESCE(SUM((b.qty_units * b.mrp_paise) / p.pack_size), 0) AS mrp_paise,
            COUNT(DISTINCT b.product_id) AS products_in_stock,
            COUNT(*) AS batches_in_stock
       FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.qty_units > 0 AND b.expiry >= ? AND p.active = 1`,
  ).get(cm);

  const expired = db.prepare(
    `SELECT COUNT(*) AS batches,
            COALESCE(SUM((b.qty_units * b.purchase_rate_paise) / p.pack_size), 0) AS cost_paise
       FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.qty_units > 0 AND b.expiry < ?`,
  ).get(cm);

  const expiring3 = db.prepare(
    `SELECT COUNT(*) AS batches,
            COALESCE(SUM((b.qty_units * b.purchase_rate_paise) / p.pack_size), 0) AS cost_paise
       FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.qty_units > 0 AND b.expiry >= ? AND b.expiry <= ?`,
  ).get(cm, in3);

  const expiring6 = db.prepare(
    `SELECT COUNT(*) AS batches FROM batches b
      WHERE b.qty_units > 0 AND b.expiry >= ? AND b.expiry <= ?`,
  ).get(cm, in6);

  const lowStock = db.prepare(
    `SELECT COUNT(*) AS products FROM (
       SELECT p.id FROM products p
         LEFT JOIN batches b ON b.product_id = p.id AND b.qty_units > 0 AND b.expiry >= ?
        WHERE p.active = 1 AND p.reorder_level > 0
        GROUP BY p.id
       HAVING COALESCE(SUM(b.qty_units), 0) <= p.reorder_level)`,
  ).get(cm);

  const outOfStock = db.prepare(
    `SELECT COUNT(*) AS products FROM (
       SELECT p.id FROM products p
         LEFT JOIN batches b ON b.product_id = p.id AND b.qty_units > 0 AND b.expiry >= ?
        WHERE p.active = 1
        GROUP BY p.id
       HAVING COALESCE(SUM(b.qty_units), 0) = 0)`,
  ).get(cm);

  res.json({ valuation, expired, expiring3, expiring6, lowStock, outOfStock });
});

/**
 * Reorder list: active products at or below their reorder level, with the
 * supplier they were last bought from and 30-day movement to size the order.
 */
inventoryRouter.get('/reorder', (_req, res) => {
  const db = getDb();
  const cm = currentMonth();
  const rows = db.prepare(
    `SELECT p.id, p.name, p.generic_name, p.manufacturer, p.unit, p.pack_size,
            p.reorder_level, p.rack,
            COALESCE(SUM(b.qty_units), 0) AS stock_units,
            (SELECT s.name FROM batches b2 JOIN suppliers s ON s.id = b2.supplier_id
              WHERE b2.product_id = p.id ORDER BY b2.id DESC LIMIT 1) AS last_supplier,
            (SELECT COALESCE(SUM(si.qty_units), 0) FROM sale_items si
               JOIN sales sa ON sa.id = si.sale_id
              WHERE si.product_id = p.id AND sa.status = 'COMPLETED'
                AND date(sa.invoice_date) >= date('now', '-30 days')) AS sold_30d
       FROM products p
       LEFT JOIN batches b ON b.product_id = p.id AND b.qty_units > 0 AND b.expiry >= ?
      WHERE p.active = 1
      GROUP BY p.id
     HAVING stock_units <= p.reorder_level AND (p.reorder_level > 0 OR sold_30d > 0)
      ORDER BY (stock_units - p.reorder_level), sold_30d DESC
      LIMIT 300`,
  ).all(cm);
  res.json(rows);
});

/** Full movement history for one batch. */
inventoryRouter.get('/batches/:id/ledger', (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT l.*, u.full_name AS user_name FROM stock_ledger l
       LEFT JOIN users u ON u.id = l.created_by
      WHERE l.batch_id = ? ORDER BY l.id DESC LIMIT 500`,
  ).all(Number(req.params.id)));
});

const adjustSchema = z.object({
  batch_id: z.number().int().positive(),
  qty_delta: z.number().int().refine((n) => n !== 0, 'Adjustment cannot be zero'),
  reason: z.enum(['DAMAGE', 'EXPIRED', 'COUNT_CORRECTION', 'THEFT', 'OTHER']),
  note: z.string().default(''),
});

/** Manual stock correction — breakage, expiry write-off, physical count. */
inventoryRouter.post('/adjust', requireRole('pharmacist'), (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();
  const user = req.user!;

  try {
    const balance = db.transaction(() => {
      const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(d.batch_id) as Batch | undefined;
      if (!batch) throw new HttpError(404, 'Batch not found');

      const newQty = batch.qty_units + d.qty_delta;
      if (newQty < 0) {
        throw new HttpError(400,
          `Cannot remove ${Math.abs(d.qty_delta)} — only ${batch.qty_units} in this batch`);
      }
      const ts = nowIso();
      db.prepare('UPDATE batches SET qty_units = ? WHERE id = ?').run(newQty, d.batch_id);
      db.prepare(
        `INSERT INTO stock_adjustments (batch_id, product_id, qty_delta, reason, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(d.batch_id, batch.product_id, d.qty_delta, d.reason, d.note, user.id, ts);
      db.prepare(
        `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
           qty_in, qty_out, balance_after, note, created_by, created_at)
         VALUES (?,?,'ADJUSTMENT','stock_adjustments',?,?,?,?,?,?,?)`,
      ).run(batch.product_id, d.batch_id, d.batch_id,
        d.qty_delta > 0 ? d.qty_delta : 0, d.qty_delta < 0 ? -d.qty_delta : 0,
        newQty, `${d.reason}: ${d.note}`, user.id, ts);

      return newQty;
    })();

    audit(user.id, user.username, 'STOCK_ADJUST', 'batches', d.batch_id,
      `${d.qty_delta > 0 ? '+' : ''}${d.qty_delta} (${d.reason})`);
    res.json({ ok: true, qty_units: balance });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[inventory] adjust failed:', err);
    res.status(500).json({ error: 'Could not adjust stock' });
  }
});

/** Write off every expired batch in one action, with a full ledger trail. */
inventoryRouter.post('/writeoff-expired', requireRole('admin'), (req, res) => {
  const db = getDb();
  const user = req.user!;
  const cm = currentMonth();
  const note = String(req.body?.note ?? 'Bulk expiry write-off');

  const result = db.transaction(() => {
    const expired = db.prepare(
      'SELECT * FROM batches WHERE expiry < ? AND qty_units > 0',
    ).all(cm) as Batch[];
    const ts = nowIso();
    for (const b of expired) {
      db.prepare('UPDATE batches SET qty_units = 0, active = 0 WHERE id = ?').run(b.id);
      db.prepare(
        `INSERT INTO stock_adjustments (batch_id, product_id, qty_delta, reason, note, created_by, created_at)
         VALUES (?,?,?,'EXPIRED',?,?,?)`,
      ).run(b.id, b.product_id, -b.qty_units, note, user.id, ts);
      db.prepare(
        `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
           qty_in, qty_out, balance_after, note, created_by, created_at)
         VALUES (?,?,'ADJUSTMENT','stock_adjustments',?,0,?,0,?,?,?)`,
      ).run(b.product_id, b.id, b.id, b.qty_units, `Expired ${b.expiry}: ${note}`, user.id, ts);
    }
    return expired.length;
  })();

  audit(user.id, user.username, 'WRITEOFF_EXPIRED', 'batches', null, `${result} batches`);
  res.json({ ok: true, batches_written_off: result });
});

/** Directly revise a batch's MRP / selling rate (e.g. a price revision notice). */
inventoryRouter.patch('/batches/:id', requireRole('pharmacist'), (req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({
    mrp_paise: z.number().int().positive().optional(),
    sale_rate_paise: z.number().int().positive().optional(),
    active: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const db = getDb();
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as Batch | undefined;
  if (!batch) {
    res.status(404).json({ error: 'Batch not found' });
    return;
  }
  const mrp = parsed.data.mrp_paise ?? batch.mrp_paise;
  const rate = parsed.data.sale_rate_paise ?? batch.sale_rate_paise;
  if (rate > mrp) {
    res.status(400).json({ error: 'Selling rate cannot exceed the printed MRP' });
    return;
  }
  db.prepare('UPDATE batches SET mrp_paise = ?, sale_rate_paise = ?, active = ? WHERE id = ?')
    .run(mrp, rate, parsed.data.active === undefined ? batch.active : parsed.data.active ? 1 : 0, id);
  audit(req.user!.id, req.user!.username, 'UPDATE_BATCH', 'batches', id,
    `MRP ${batch.mrp_paise}->${mrp}, rate ${batch.sale_rate_paise}->${rate}`);
  res.json({ ok: true });
});

/** Products never stocked or fully sold out — the "must order" list. */
inventoryRouter.get('/out-of-stock', (_req, res) => {
  const db = getDb();
  const cm = currentMonth();
  res.json(db.prepare(
    `SELECT p.*, COALESCE(SUM(b.qty_units), 0) AS stock_units
       FROM products p
       LEFT JOIN batches b ON b.product_id = p.id AND b.qty_units > 0 AND b.expiry >= ?
      WHERE p.active = 1
      GROUP BY p.id HAVING stock_units = 0
      ORDER BY p.name LIMIT 500`,
  ).all(cm));
});

export type { Product };
