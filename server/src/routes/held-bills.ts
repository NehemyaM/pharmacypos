import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, currentMonth } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import type { Batch, Product } from '../types.js';

export const heldBillsRouter = Router();
heldBillsRouter.use(requireAuth);

/** Whatever the billing screen needs to rebuild the cart, stored verbatim. */
const cartSchema = z.object({
  customer_id: z.number().int().positive().nullable().default(null),
  customer_name: z.string().default(''),
  customer_phone: z.string().default(''),
  customer_gstin: z.string().default(''),
  doctor_id: z.number().int().positive().nullable().default(null),
  prescription_no: z.string().default(''),
  patient_name: z.string().default(''),
  patient_address: z.string().default(''),
  payment_mode: z.string().default('CASH'),
  overall_discount_pct: z.number().min(0).max(100).default(0),
  items: z.array(z.object({
    product_id: z.number().int().positive(),
    batch_id: z.number().int().positive(),
    qty_units: z.number().int().positive(),
    discount_pct: z.number().min(0).max(100).default(0),
  })).min(1, 'Nothing to hold — the bill is empty'),
});

const holdSchema = z.object({
  label: z.string().min(1, 'Give the held bill a name so you can find it again').max(60),
  total_paise: z.number().int().min(0).default(0),
  cart: cartSchema,
});

heldBillsRouter.post('/', (req, res) => {
  const parsed = holdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const info = getDb().prepare(
    `INSERT INTO held_bills (label, cart_json, item_count, total_paise, held_by, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(d.label.trim(), JSON.stringify(d.cart), d.cart.items.length, d.total_paise,
    req.user!.id, nowIso());

  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

heldBillsRouter.get('/', (_req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT h.id, h.label, h.item_count, h.total_paise, h.created_at, u.full_name AS held_by_name
       FROM held_bills h LEFT JOIN users u ON u.id = h.held_by
      ORDER BY h.id DESC LIMIT 50`,
  ).all());
});

/**
 * Resume a held bill.
 *
 * Stock was never reserved, so between holding and resuming a batch may have
 * sold out, expired, or been written off. Every line is re-checked and the
 * problems are returned alongside the cart so the counter is told what changed
 * rather than discovering it when the bill fails to save.
 */
heldBillsRouter.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM held_bills WHERE id = ?').get(Number(req.params.id)) as
    { id: number; label: string; cart_json: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'That held bill is no longer there' });
    return;
  }

  const cart = JSON.parse(row.cart_json) as z.infer<typeof cartSchema>;
  const cm = currentMonth();
  const warnings: string[] = [];
  const items: Array<z.infer<typeof cartSchema>['items'][number] & { available: number }> = [];

  for (const item of cart.items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?')
      .get(item.product_id) as Product | undefined;
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?')
      .get(item.batch_id) as Batch | undefined;

    if (!product || !product.active) {
      warnings.push(`${product?.name ?? 'A product'} is no longer active and was removed`);
      continue;
    }
    if (!batch) {
      warnings.push(`${product.name}: that batch no longer exists and was removed`);
      continue;
    }
    if (batch.expiry < cm) {
      warnings.push(`${product.name} batch ${batch.batch_no} expired in ${batch.expiry} and was removed`);
      continue;
    }
    if (batch.qty_units <= 0) {
      warnings.push(`${product.name} batch ${batch.batch_no} has sold out and was removed`);
      continue;
    }
    if (batch.qty_units < item.qty_units) {
      warnings.push(
        `${product.name}: only ${batch.qty_units} ${product.unit} left, quantity reduced from ${item.qty_units}`);
      items.push({ ...item, qty_units: batch.qty_units, available: batch.qty_units });
      continue;
    }
    items.push({ ...item, available: batch.qty_units });
  }

  res.json({ id: row.id, label: row.label, cart: { ...cart, items }, warnings });
});

heldBillsRouter.delete('/:id', (req, res) => {
  const info = getDb().prepare('DELETE FROM held_bills WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'That held bill is no longer there' });
    return;
  }
  res.json({ ok: true });
});
