import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, today, currentMonth, nextCounter, financialYear } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { addExclusive } from '../lib/gst.js';
import { roundHalfUp, roundOff } from '../lib/money.js';
import { audit } from '../lib/audit.js';
import { HttpError } from './sales.js';
import type { Settings, Batch, Product } from '../types.js';

export const purchaseReturnsRouter = Router();
purchaseReturnsRouter.use(requireAuth, requireRole('pharmacist'));

const returnSchema = z.object({
  supplier_id: z.number().int().positive(),
  reason: z.enum(['NEAR_EXPIRY', 'EXPIRED', 'DAMAGED', 'WRONG_SUPPLY', 'RECALL', 'OTHER'])
    .default('NEAR_EXPIRY'),
  notes: z.string().default(''),
  items: z.array(z.object({
    batch_id: z.number().int().positive(),
    qty_units: z.number().int().positive(),
    /** Override the rate if the distributor credits at something other than cost. */
    rate_paise: z.number().int().min(0).optional(),
  })).min(1, 'Select at least one batch to return'),
});

/**
 * Send stock back to the distributor and raise a debit note.
 *
 * Goods leave the shop, so stock reduces — the mirror image of a sales return.
 * Credit is claimed at the rate the goods were bought at (exclusive of GST),
 * and the claim stays PENDING until the distributor issues their credit note.
 *
 * Expired stock *is* returnable here: many distributors accept expired goods on
 * an expiry-claim basis, and even when they don't, recording the return is how
 * the shop gets it off the shelf with an audit trail.
 */
purchaseReturnsRouter.post('/', (req, res) => {
  const parsed = returnSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();
  const user = req.user!;
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Settings;

  try {
    const result = db.transaction(() => {
      const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?')
        .get(d.supplier_id) as { name: string; state_code: string } | undefined;
      if (!supplier) throw new HttpError(404, 'Supplier not found');

      const isInterstate = supplier.state_code !== settings.state_code;
      const returnDate = today();
      const fy = financialYear(returnDate);
      const seq = nextCounter(db, `purchase_return:${fy}`);
      const returnNo = `DN/${fy}/${String(seq).padStart(5, '0')}`;
      const ts = nowIso();

      const info = db.prepare(
        `INSERT INTO purchase_returns (return_no, return_date, supplier_id, is_interstate,
           reason, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(returnNo, returnDate, d.supplier_id, isInterstate ? 1 : 0, d.reason, d.notes,
        user.id, ts);
      const returnId = Number(info.lastInsertRowid);

      let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;

      for (const item of d.items) {
        const batch = db.prepare('SELECT * FROM batches WHERE id = ?')
          .get(item.batch_id) as Batch | undefined;
        if (!batch) throw new HttpError(404, `Batch #${item.batch_id} not found`);
        if (batch.qty_units < item.qty_units) {
          throw new HttpError(400,
            `Only ${batch.qty_units} units in batch ${batch.batch_no} — cannot return ${item.qty_units}`);
        }
        const product = db.prepare('SELECT * FROM products WHERE id = ?')
          .get(batch.product_id) as Product;

        // Credit is claimed at cost, not MRP — the shop never bought at MRP.
        const ratePerPack = item.rate_paise ?? batch.purchase_rate_paise;
        const taxablePaise = roundHalfUp((ratePerPack * item.qty_units) / product.pack_size);
        const tax = addExclusive(taxablePaise, product.gst_rate, isInterstate);

        taxableTotal += taxablePaise;
        cgstTotal += tax.cgst;
        sgstTotal += tax.sgst;
        igstTotal += tax.igst;

        db.prepare(
          `INSERT INTO purchase_return_items (return_id, product_id, batch_id, product_name,
             manufacturer, hsn_code, batch_no, expiry, pack_size, qty_units, rate_paise,
             mrp_paise, gst_rate, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(returnId, product.id, batch.id, product.name, product.manufacturer,
          product.hsn_code, batch.batch_no, batch.expiry, product.pack_size, item.qty_units,
          ratePerPack, batch.mrp_paise, product.gst_rate, taxablePaise, tax.cgst, tax.sgst,
          tax.igst, tax.total);

        const balance = batch.qty_units - item.qty_units;
        db.prepare('UPDATE batches SET qty_units = ? WHERE id = ?').run(balance, batch.id);
        db.prepare(
          `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
             qty_in, qty_out, balance_after, note, created_by, created_at)
           VALUES (?,?,'PURCHASE_RETURN','purchase_returns',?,0,?,?,?,?,?)`,
        ).run(product.id, batch.id, returnId, item.qty_units, balance,
          `${returnNo} to ${supplier.name} (${d.reason})`, user.id, ts);
      }

      const { adjustment, total } = roundOff(taxableTotal + cgstTotal + sgstTotal + igstTotal);
      db.prepare(
        `UPDATE purchase_returns SET taxable_paise=?, cgst_paise=?, sgst_paise=?, igst_paise=?,
           round_off_paise=?, total_paise=? WHERE id=?`,
      ).run(taxableTotal, cgstTotal, sgstTotal, igstTotal, adjustment, total, returnId);

      return { returnId, returnNo, total };
    })();

    audit(user.id, user.username, 'PURCHASE_RETURN', 'purchase_returns', result.returnId,
      `${result.returnNo} (${d.reason})`);
    res.status(201).json(getFullReturn(result.returnId));
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[purchase-returns] failed:', err);
    res.status(500).json({ error: 'Could not save the return. No stock was changed.' });
  }
});

purchaseReturnsRouter.get('/', (req, res) => {
  const db = getDb();
  const status = String(req.query.status ?? '');
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { where.push('r.status = ?'); params.push(status); }

  res.json(db.prepare(
    `SELECT r.*, s.name AS supplier_name,
            (SELECT COUNT(*) FROM purchase_return_items i WHERE i.return_id = r.id) AS item_count
       FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.id DESC LIMIT 200`,
  ).all(...params));
});

purchaseReturnsRouter.get('/:id', (req, res) => {
  const data = getFullReturn(Number(req.params.id));
  if (!data) {
    res.status(404).json({ error: 'Debit note not found' });
    return;
  }
  res.json(data);
});

/** Record the distributor's response — credit received, or claim rejected. */
purchaseReturnsRouter.post('/:id/settle', (req, res) => {
  const schema = z.object({
    status: z.enum(['CREDITED', 'REJECTED']),
    credit_note_no: z.string().default(''),
    credited_paise: z.number().int().min(0).default(0),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(id) as
    { status: string; return_no: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Debit note not found' });
    return;
  }
  if (existing.status !== 'PENDING') {
    res.status(400).json({ error: `This claim is already ${existing.status.toLowerCase()}` });
    return;
  }
  const d = parsed.data;
  db.prepare(
    `UPDATE purchase_returns SET status=?, credit_note_no=?, credited_paise=?, settled_at=?
      WHERE id=?`,
  ).run(d.status, d.credit_note_no, d.status === 'CREDITED' ? d.credited_paise : 0, nowIso(), id);

  audit(req.user!.id, req.user!.username, 'SETTLE_PURCHASE_RETURN', 'purchase_returns', id,
    `${existing.return_no} -> ${d.status}`);
  res.json({ ok: true });
});

/** Batches worth returning: expired, or expiring within the given window. */
purchaseReturnsRouter.get('/candidates/list', (req, res) => {
  const months = Math.min(Number(req.query.months) || 3, 12);
  const db = getDb();
  const cm = currentMonth();
  const [y, m] = cm.split('-').map(Number);
  const totalM = y * 12 + (m - 1) + months;
  const horizon = `${Math.floor(totalM / 12)}-${String((totalM % 12) + 1).padStart(2, '0')}`;

  res.json(db.prepare(
    `SELECT b.id AS batch_id, b.batch_no, b.expiry, b.qty_units, b.purchase_rate_paise,
            b.mrp_paise, p.id AS product_id, p.name AS product_name, p.manufacturer,
            p.unit, p.pack_size, p.gst_rate, p.rack,
            b.supplier_id, s.name AS supplier_name, s.phone AS supplier_phone,
            (b.qty_units * b.purchase_rate_paise) / p.pack_size AS claim_value_paise,
            CASE WHEN b.expiry < ? THEN 'EXPIRED' ELSE 'NEAR_EXPIRY' END AS suggested_reason
       FROM batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.qty_units > 0 AND b.expiry <= ?
      ORDER BY b.expiry, p.name`,
  ).all(cm, horizon));
});

function getFullReturn(id: number) {
  const db = getDb();
  const row = db.prepare(
    `SELECT r.*, s.name AS supplier_name, s.gstin AS supplier_gstin, s.address AS supplier_address,
            s.phone AS supplier_phone, s.dl_no AS supplier_dl_no
       FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ?`,
  ).get(id);
  if (!row) return null;
  const items = db.prepare(
    'SELECT * FROM purchase_return_items WHERE return_id = ? ORDER BY id',
  ).all(id);
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  return { ...(row as object), items, settings };
}
