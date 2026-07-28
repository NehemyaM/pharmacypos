import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, currentMonth } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { addExclusive } from '../lib/gst.js';
import { roundHalfUp, roundOff } from '../lib/money.js';
import { audit } from '../lib/audit.js';
import { HttpError } from './sales.js';
import type { Product, Settings, Batch } from '../types.js';

export const purchasesRouter = Router();
purchasesRouter.use(requireAuth, requireRole('pharmacist'));

const purchaseItemSchema = z.object({
  product_id: z.number().int().positive(),
  batch_no: z.string().min(1, 'Batch number is required'),
  /** 'YYYY-MM' — drug expiry is month-granular. */
  expiry: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expiry must be in YYYY-MM format'),
  qty_packs: z.number().int().positive('Quantity must be at least 1'),
  free_packs: z.number().int().min(0).default(0),
  /** Per pack, exclusive of GST, as printed on the distributor's invoice. */
  purchase_rate_paise: z.number().int().min(0),
  mrp_paise: z.number().int().positive('MRP is required'),
  /** Defaults to MRP — most retail chemists sell at MRP. */
  sale_rate_paise: z.number().int().positive().optional(),
  discount_pct: z.number().min(0).max(100).default(0),
});

const purchaseSchema = z.object({
  supplier_id: z.number().int().positive(),
  invoice_no: z.string().min(1, 'Distributor invoice number is required'),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invoice date must be YYYY-MM-DD'),
  payment_mode: z.string().default('CREDIT'),
  paid_paise: z.number().int().min(0).default(0),
  notes: z.string().default(''),
  items: z.array(purchaseItemSchema).min(1, 'Add at least one item'),
});

/**
 * Record goods inward against a distributor's tax invoice.
 *
 * Creates or tops up a batch per line. Unlike sales, purchase rates are quoted
 * *exclusive* of GST, so tax is added on top rather than extracted.
 */
purchasesRouter.post('/', (req, res) => {
  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();
  const user = req.user!;
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Settings;
  const cm = currentMonth();

  try {
    const result = db.transaction(() => {
      const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?')
        .get(d.supplier_id) as { state_code: string; name: string } | undefined;
      if (!supplier) throw new HttpError(404, 'Supplier not found');

      const duplicate = db.prepare('SELECT id FROM purchases WHERE supplier_id = ? AND invoice_no = ?')
        .get(d.supplier_id, d.invoice_no);
      if (duplicate) {
        throw new HttpError(409,
          `Invoice ${d.invoice_no} from ${supplier.name} has already been entered`);
      }

      const isInterstate = supplier.state_code !== settings.state_code;
      const ts = nowIso();

      const purchaseInfo = db.prepare(
        `INSERT INTO purchases (invoice_no, invoice_date, supplier_id, is_interstate,
           payment_mode, paid_paise, notes, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(d.invoice_no, d.invoice_date, d.supplier_id, isInterstate ? 1 : 0,
        d.payment_mode, d.paid_paise, d.notes, user.id, ts);
      const purchaseId = Number(purchaseInfo.lastInsertRowid);

      let taxableTotal = 0, discountTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;

      for (const item of d.items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?')
          .get(item.product_id) as Product | undefined;
        if (!product) throw new HttpError(404, `Product #${item.product_id} not found`);

        if (item.expiry < cm) {
          throw new HttpError(400,
            `${product.name} batch ${item.batch_no} expires ${item.expiry} — already expired, do not take it into stock`);
        }
        const saleRate = item.sale_rate_paise ?? item.mrp_paise;
        if (saleRate > item.mrp_paise) {
          throw new HttpError(400,
            `${product.name}: selling rate cannot exceed the printed MRP`);
        }

        const grossPaise = item.purchase_rate_paise * item.qty_packs;
        const discountPaise = roundHalfUp((grossPaise * item.discount_pct) / 100);
        const taxablePaise = grossPaise - discountPaise;
        const tax = addExclusive(taxablePaise, product.gst_rate, isInterstate);

        taxableTotal += taxablePaise;
        discountTotal += discountPaise;
        cgstTotal += tax.cgst;
        sgstTotal += tax.sgst;
        igstTotal += tax.igst;

        // Free goods enter stock but carry no cost.
        const totalUnits = (item.qty_packs + item.free_packs) * product.pack_size;

        // Same product + batch + expiry tops up the existing batch.
        const existing = db.prepare(
          'SELECT * FROM batches WHERE product_id = ? AND batch_no = ? AND expiry = ?',
        ).get(item.product_id, item.batch_no, item.expiry) as Batch | undefined;

        let batchId: number;
        let balanceAfter: number;
        if (existing) {
          balanceAfter = existing.qty_units + totalUnits;
          db.prepare(
            `UPDATE batches SET qty_units = ?, mrp_paise = ?, sale_rate_paise = ?,
               purchase_rate_paise = ?, supplier_id = ?, active = 1 WHERE id = ?`,
          ).run(balanceAfter, item.mrp_paise, saleRate, item.purchase_rate_paise,
            d.supplier_id, existing.id);
          batchId = existing.id;
        } else {
          const batchInfo = db.prepare(
            `INSERT INTO batches (product_id, batch_no, expiry, mrp_paise, purchase_rate_paise,
               sale_rate_paise, qty_units, supplier_id, received_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          ).run(item.product_id, item.batch_no, item.expiry, item.mrp_paise,
            item.purchase_rate_paise, saleRate, totalUnits, d.supplier_id, d.invoice_date, ts);
          batchId = Number(batchInfo.lastInsertRowid);
          balanceAfter = totalUnits;
        }

        db.prepare(
          `INSERT INTO purchase_items (purchase_id, product_id, batch_id, batch_no, expiry,
             pack_size, qty_packs, free_packs, purchase_rate_paise, mrp_paise, sale_rate_paise,
             discount_pct, gst_rate, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(purchaseId, item.product_id, batchId, item.batch_no, item.expiry,
          product.pack_size, item.qty_packs, item.free_packs, item.purchase_rate_paise,
          item.mrp_paise, saleRate, item.discount_pct, product.gst_rate, taxablePaise,
          tax.cgst, tax.sgst, tax.igst, tax.total);

        db.prepare(
          `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
             qty_in, qty_out, balance_after, note, created_by, created_at)
           VALUES (?,?,'PURCHASE','purchases',?,?,0,?,?,?,?)`,
        ).run(item.product_id, batchId, purchaseId, totalUnits, balanceAfter,
          `${supplier.name} inv ${d.invoice_no}`, user.id, ts);
      }

      const beforeRounding = taxableTotal + cgstTotal + sgstTotal + igstTotal;
      const { adjustment, total } = roundOff(beforeRounding);

      db.prepare(
        `UPDATE purchases SET taxable_paise=?, discount_paise=?, cgst_paise=?, sgst_paise=?,
           igst_paise=?, round_off_paise=?, total_paise=? WHERE id=?`,
      ).run(taxableTotal, discountTotal, cgstTotal, sgstTotal, igstTotal,
        adjustment, total, purchaseId);

      return { purchaseId, total };
    })();

    audit(user.id, user.username, 'CREATE_PURCHASE', 'purchases', result.purchaseId, d.invoice_no);
    res.status(201).json(getFullPurchase(result.purchaseId));
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[purchases] failed:', err);
    res.status(500).json({ error: 'Could not save the purchase. No stock was changed.' });
  }
});

purchasesRouter.get('/', (req, res) => {
  const db = getDb();
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Number(req.query.limit) || 50, 500);

  const where: string[] = [];
  const params: unknown[] = [];
  if (from) { where.push('p.invoice_date >= ?'); params.push(from); }
  if (to) { where.push('p.invoice_date <= ?'); params.push(to); }
  if (q) { where.push('(p.invoice_no LIKE ? OR s.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  res.json(db.prepare(
    `SELECT p.*, s.name AS supplier_name,
            (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS item_count
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
       ${clause} ORDER BY p.id DESC LIMIT ?`,
  ).all(...params, limit));
});

purchasesRouter.get('/:id', (req, res) => {
  const purchase = getFullPurchase(Number(req.params.id));
  if (!purchase) {
    res.status(404).json({ error: 'Purchase not found' });
    return;
  }
  res.json(purchase);
});

function getFullPurchase(id: number) {
  const db = getDb();
  const purchase = db.prepare(
    `SELECT p.*, s.name AS supplier_name, s.gstin AS supplier_gstin, s.address AS supplier_address,
            s.state AS supplier_state, s.dl_no AS supplier_dl_no
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
  ).get(id);
  if (!purchase) return null;
  const items = db.prepare(
    `SELECT pi.*, pr.name AS product_name, pr.unit, pr.manufacturer
       FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id
      WHERE pi.purchase_id = ? ORDER BY pi.id`,
  ).all(id);
  return { ...(purchase as object), items };
}
