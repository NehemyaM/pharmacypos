import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, today, currentMonth, nextCounter, financialYear } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { splitInclusive } from '../lib/gst.js';
import { roundHalfUp, roundOff } from '../lib/money.js';
import { audit } from '../lib/audit.js';
import { HttpError } from './sales.js';
import type { Settings, Sale, SaleItem } from '../types.js';

export const returnsRouter = Router();
returnsRouter.use(requireAuth);

const returnSchema = z.object({
  sale_id: z.number().int().positive(),
  reason: z.string().min(1, 'A reason is required for a return'),
  /** 0 when goods come back damaged/opened and must not re-enter saleable stock. */
  restock: z.boolean().default(true),
  items: z.array(z.object({
    sale_item_id: z.number().int().positive(),
    qty_units: z.number().int().positive(),
  })).min(1, 'Select at least one item to return'),
});

/**
 * Sales return / credit note.
 *
 * Guards that matter in a pharmacy:
 *  - cumulative returns can never exceed what was billed;
 *  - a cancelled invoice cannot be returned against;
 *  - stock only goes back if the goods are saleable *and* not expired —
 *    expired returns are written off rather than silently resold.
 */
returnsRouter.post('/', requireRole('pharmacist'), (req, res) => {
  const parsed = returnSchema.safeParse(req.body);
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
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(d.sale_id) as Sale | undefined;
      if (!sale) throw new HttpError(404, 'Invoice not found');
      if (sale.status === 'CANCELLED') {
        throw new HttpError(400, 'This bill was cancelled — nothing to return against it');
      }

      const returnDate = today();
      const fy = financialYear(returnDate);
      const seq = nextCounter(db, `return:${fy}`);
      const returnNo = `${settings.return_prefix}/${fy}/${String(seq).padStart(5, '0')}`;
      const ts = nowIso();

      const returnInfo = db.prepare(
        `INSERT INTO sale_returns (return_no, return_date, sale_id, reason, restock, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(returnNo, returnDate, d.sale_id, d.reason, d.restock ? 1 : 0, user.id, ts);
      const returnId = Number(returnInfo.lastInsertRowid);

      let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;

      for (const line of d.items) {
        const item = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?')
          .get(line.sale_item_id, d.sale_id) as SaleItem | undefined;
        if (!item) throw new HttpError(404, 'That item is not on this invoice');

        const alreadyReturned = item.returned_units;
        const returnable = item.qty_units - alreadyReturned;
        if (line.qty_units > returnable) {
          throw new HttpError(400,
            `${item.product_name}: only ${returnable} of ${item.qty_units} can still be returned`);
        }

        // Refund the same per-unit value that was actually charged, so a
        // discounted line refunds the discounted amount, not the MRP.
        const refundInclusive = roundHalfUp((item.total_paise * line.qty_units) / item.qty_units);
        const tax = splitInclusive(refundInclusive, item.gst_rate, sale.is_interstate === 1);

        taxableTotal += tax.taxable;
        cgstTotal += tax.cgst;
        sgstTotal += tax.sgst;
        igstTotal += tax.igst;

        db.prepare(
          `INSERT INTO sale_return_items (return_id, sale_item_id, product_id, batch_id,
             product_name, batch_no, expiry, hsn_code, qty_units, rate_paise, taxable_paise,
             gst_rate, cgst_paise, sgst_paise, igst_paise, total_paise)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(returnId, item.id, item.product_id, item.batch_id, item.product_name,
          item.batch_no, item.expiry, item.hsn_code, line.qty_units, item.rate_paise,
          tax.taxable, item.gst_rate, tax.cgst, tax.sgst, tax.igst, refundInclusive);

        db.prepare('UPDATE sale_items SET returned_units = returned_units + ? WHERE id = ?')
          .run(line.qty_units, item.id);

        // Expired goods are refunded to the customer but never restocked.
        const saleable = d.restock && item.expiry >= cm;
        if (saleable) {
          db.prepare('UPDATE batches SET qty_units = qty_units + ? WHERE id = ?')
            .run(line.qty_units, item.batch_id);
        }
        const balance = (db.prepare('SELECT qty_units FROM batches WHERE id = ?')
          .get(item.batch_id) as { qty_units: number }).qty_units;

        db.prepare(
          `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
             qty_in, qty_out, balance_after, note, created_by, created_at)
           VALUES (?,?,'SALE_RETURN','sale_returns',?,?,0,?,?,?,?)`,
        ).run(item.product_id, item.batch_id, returnId, saleable ? line.qty_units : 0, balance,
          saleable ? `${returnNo}: ${d.reason}`
            : `${returnNo}: ${d.reason} (not restocked${item.expiry < cm ? ' — expired' : ''})`,
          user.id, ts);
      }

      const beforeRounding = taxableTotal + cgstTotal + sgstTotal + igstTotal;
      const { adjustment, total } = settings.round_off_enabled
        ? roundOff(beforeRounding)
        : { adjustment: 0, total: beforeRounding };

      db.prepare(
        `UPDATE sale_returns SET taxable_paise=?, cgst_paise=?, sgst_paise=?, igst_paise=?,
           round_off_paise=?, total_paise=? WHERE id=?`,
      ).run(taxableTotal, cgstTotal, sgstTotal, igstTotal, adjustment, total, returnId);

      return { returnId, returnNo, total };
    })();

    audit(user.id, user.username, 'CREATE_RETURN', 'sale_returns', result.returnId, result.returnNo);
    res.status(201).json(getFullReturn(result.returnId));
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[returns] failed:', err);
    res.status(500).json({ error: 'Could not save the return. Nothing was changed.' });
  }
});

returnsRouter.get('/', (req, res) => {
  const db = getDb();
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  const where: string[] = [];
  const params: unknown[] = [];
  if (from) { where.push('r.return_date >= ?'); params.push(from); }
  if (to) { where.push('r.return_date <= ?'); params.push(to); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  res.json(db.prepare(
    `SELECT r.*, s.invoice_no, s.customer_name
       FROM sale_returns r JOIN sales s ON s.id = r.sale_id
       ${clause} ORDER BY r.id DESC LIMIT 200`,
  ).all(...params));
});

returnsRouter.get('/:id', (req, res) => {
  const data = getFullReturn(Number(req.params.id));
  if (!data) {
    res.status(404).json({ error: 'Credit note not found' });
    return;
  }
  res.json(data);
});

function getFullReturn(id: number) {
  const db = getDb();
  const row = db.prepare(
    `SELECT r.*, s.invoice_no, s.invoice_date, s.customer_name, s.customer_phone,
            s.customer_gstin, s.is_interstate, s.place_of_supply
       FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE r.id = ?`,
  ).get(id);
  if (!row) return null;
  const items = db.prepare('SELECT * FROM sale_return_items WHERE return_id = ? ORDER BY id').all(id);
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  return { ...(row as object), items, settings };
}
