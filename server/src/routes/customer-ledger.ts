import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, today, nextCounter, financialYear } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { HttpError } from './sales.js';

export const customerLedgerRouter = Router();
customerLedgerRouter.use(requireAuth);

/**
 * What a customer owes.
 *
 *   outstanding = (billed - collected at the counter) on completed sales
 *                 - receipts since
 *                 - credit notes for anything returned
 *
 * Cancelled bills are excluded entirely; a cancelled bill was never a debt.
 */
export function customerOutstandingPaise(customerId: number): number {
  const db = getDb();
  const sales = db.prepare(
    `SELECT COALESCE(SUM(total_paise - paid_paise), 0) due
       FROM sales WHERE customer_id = ? AND status = 'COMPLETED'`,
  ).get(customerId) as { due: number };

  const receipts = db.prepare(
    'SELECT COALESCE(SUM(amount_paise), 0) got FROM customer_receipts WHERE customer_id = ?',
  ).get(customerId) as { got: number };

  // A credit note reduces what the customer owes on an unpaid bill.
  const credits = db.prepare(
    `SELECT COALESCE(SUM(r.total_paise), 0) credited
       FROM sale_returns r JOIN sales s ON s.id = r.sale_id
      WHERE s.customer_id = ? AND s.status = 'COMPLETED' AND s.total_paise > s.paid_paise`,
  ).get(customerId) as { credited: number };

  return sales.due - receipts.got - credits.credited;
}

const receiptSchema = z.object({
  customer_id: z.number().int().positive(),
  /** Omit to receive on account rather than against one bill. */
  sale_id: z.number().int().positive().nullable().default(null),
  amount_paise: z.number().int().positive('Amount must be more than zero'),
  mode: z.enum(['CASH', 'UPI', 'CARD', 'BANK', 'ADJUSTMENT']).default('CASH'),
  reference: z.string().default(''),
  notes: z.string().default(''),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Record money received against a customer's outstanding balance. */
customerLedgerRouter.post('/receipts', (req, res) => {
  const parsed = receiptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();
  const user = req.user!;

  try {
    const result = db.transaction(() => {
      const customer = db.prepare('SELECT name FROM customers WHERE id = ?')
        .get(d.customer_id) as { name: string } | undefined;
      if (!customer) throw new HttpError(404, 'Customer not found');

      const owed = customerOutstandingPaise(d.customer_id);
      if (d.amount_paise > owed) {
        throw new HttpError(400,
          `${customer.name} only owes ₹${(owed / 100).toFixed(2)} — cannot receive more than that`);
      }

      if (d.sale_id) {
        const sale = db.prepare(
          'SELECT id, customer_id, invoice_no, total_paise, paid_paise, status FROM sales WHERE id = ?',
        ).get(d.sale_id) as {
          customer_id: number | null; invoice_no: string; total_paise: number;
          paid_paise: number; status: string;
        } | undefined;
        if (!sale) throw new HttpError(404, 'Invoice not found');
        if (sale.customer_id !== d.customer_id) {
          throw new HttpError(400, 'That invoice belongs to a different customer');
        }
        if (sale.status === 'CANCELLED') {
          throw new HttpError(400, 'That bill was cancelled — nothing is owed on it');
        }
        const already = db.prepare(
          'SELECT COALESCE(SUM(amount_paise), 0) p FROM customer_receipts WHERE sale_id = ?',
        ).get(d.sale_id) as { p: number };
        const dueOnBill = sale.total_paise - sale.paid_paise - already.p;
        if (d.amount_paise > dueOnBill) {
          throw new HttpError(400,
            `Invoice ${sale.invoice_no} only has ₹${(dueOnBill / 100).toFixed(2)} outstanding`);
        }
      }

      const date = d.receipt_date ?? today();
      const fy = financialYear(date);
      const seq = nextCounter(db, `customer_receipt:${fy}`);
      const receiptNo = `RCT/${fy}/${String(seq).padStart(5, '0')}`;

      const info = db.prepare(
        `INSERT INTO customer_receipts (receipt_no, receipt_date, customer_id, sale_id,
           amount_paise, mode, reference, notes, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(receiptNo, date, d.customer_id, d.sale_id, d.amount_paise, d.mode,
        d.reference, d.notes, user.id, nowIso());

      return { id: Number(info.lastInsertRowid), receiptNo, customer: customer.name };
    })();

    audit(user.id, user.username, 'CUSTOMER_RECEIPT', 'customer_receipts', result.id,
      `${result.receiptNo} ${result.customer} ${(d.amount_paise / 100).toFixed(2)}`);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[customer-ledger] receipt failed:', err);
    res.status(500).json({ error: 'Could not record the receipt' });
  }
});

customerLedgerRouter.get('/receipts', (req, res) => {
  const db = getDb();
  const customerId = Number(req.query.customer_id) || null;
  const where: string[] = [];
  const params: unknown[] = [];
  if (customerId) { where.push('r.customer_id = ?'); params.push(customerId); }

  res.json(db.prepare(
    `SELECT r.*, c.name AS customer_name, s.invoice_no
       FROM customer_receipts r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN sales s ON s.id = r.sale_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.id DESC LIMIT 200`,
  ).all(...params));
});

/** Everyone who owes the shop money, worst first. */
customerLedgerRouter.get('/outstanding', (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.id, c.name, c.phone, c.address, c.credit_limit,
            COALESCE(s.bills, 0)      AS credit_bills,
            COALESCE(s.billed, 0)     AS billed_paise,
            COALESCE(s.collected, 0)  AS collected_paise,
            COALESCE(r.received, 0)   AS receipts_paise,
            COALESCE(cn.credited, 0)  AS credit_note_paise,
            COALESCE(s.billed, 0) - COALESCE(s.collected, 0)
              - COALESCE(r.received, 0) - COALESCE(cn.credited, 0) AS outstanding_paise,
            s.oldest_unpaid,
            CAST(julianday('now') - julianday(s.oldest_unpaid) AS INTEGER) AS oldest_days
       FROM customers c
       LEFT JOIN (
         SELECT customer_id, COUNT(*) bills, SUM(total_paise) billed,
                SUM(paid_paise) collected, MIN(date(invoice_date)) oldest_unpaid
           FROM sales
          WHERE status = 'COMPLETED' AND customer_id IS NOT NULL
            AND total_paise > paid_paise
          GROUP BY customer_id
       ) s ON s.customer_id = c.id
       LEFT JOIN (
         SELECT customer_id, SUM(amount_paise) received
           FROM customer_receipts GROUP BY customer_id
       ) r ON r.customer_id = c.id
       LEFT JOIN (
         SELECT sa.customer_id, SUM(sr.total_paise) credited
           FROM sale_returns sr JOIN sales sa ON sa.id = sr.sale_id
          WHERE sa.status = 'COMPLETED' AND sa.total_paise > sa.paid_paise
          GROUP BY sa.customer_id
       ) cn ON cn.customer_id = c.id
      WHERE c.active = 1
      GROUP BY c.id
     HAVING outstanding_paise > 0
      ORDER BY outstanding_paise DESC`,
  ).all() as Array<Record<string, number>>;

  const totals = rows.reduce((acc, r) => ({
    customers: acc.customers + 1,
    outstanding_paise: acc.outstanding_paise + Number(r.outstanding_paise),
    over_limit: acc.over_limit
      + (Number(r.credit_limit) > 0 && Number(r.outstanding_paise) > Number(r.credit_limit) ? 1 : 0),
  }), { customers: 0, outstanding_paise: 0, over_limit: 0 });

  res.json({ rows, totals });
});

/** One customer's bills, receipts and current balance. */
customerLedgerRouter.get('/statement/:customerId', (req, res) => {
  const db = getDb();
  const id = Number(req.params.customerId);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  const bills = db.prepare(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.total_paise, s.paid_paise, s.payment_mode,
            s.status, COALESCE(r.received, 0) AS receipts_paise,
            s.total_paise - s.paid_paise - COALESCE(r.received, 0) AS due_paise,
            CAST(julianday('now') - julianday(date(s.invoice_date)) AS INTEGER) AS age_days
       FROM sales s
       LEFT JOIN (
         SELECT sale_id, SUM(amount_paise) received FROM customer_receipts
          WHERE sale_id IS NOT NULL GROUP BY sale_id
       ) r ON r.sale_id = s.id
      WHERE s.customer_id = ? AND s.status = 'COMPLETED'
      ORDER BY s.invoice_date DESC LIMIT 200`,
  ).all(id);

  const receipts = db.prepare(
    `SELECT r.*, s.invoice_no FROM customer_receipts r
       LEFT JOIN sales s ON s.id = r.sale_id
      WHERE r.customer_id = ? ORDER BY r.receipt_date DESC, r.id DESC`,
  ).all(id);

  res.json({ customer, bills, receipts, outstanding_paise: customerOutstandingPaise(id) });
});

/**
 * Balance for one customer — called by the billing screen before a credit sale
 * so the counter sees what is already owed and whether the limit is exhausted.
 */
customerLedgerRouter.get('/balance/:customerId', (req, res) => {
  const db = getDb();
  const id = Number(req.params.customerId);
  const customer = db.prepare('SELECT id, name, credit_limit FROM customers WHERE id = ?')
    .get(id) as { id: number; name: string; credit_limit: number } | undefined;
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const outstanding = customerOutstandingPaise(id);
  res.json({
    customer_id: id,
    name: customer.name,
    credit_limit_paise: customer.credit_limit,
    outstanding_paise: outstanding,
    available_paise: customer.credit_limit > 0
      ? Math.max(0, customer.credit_limit - outstanding)
      : null,
    over_limit: customer.credit_limit > 0 && outstanding > customer.credit_limit,
  });
});

/** Write off a bad debt. Admin only — this is money leaving the books. */
customerLedgerRouter.post('/write-off', requireRole('admin'), (req, res) => {
  const schema = z.object({
    customer_id: z.number().int().positive(),
    amount_paise: z.number().int().positive(),
    reason: z.string().min(1, 'A reason is required to write off a debt'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();

  const owed = customerOutstandingPaise(d.customer_id);
  if (d.amount_paise > owed) {
    res.status(400).json({ error: `Only ₹${(owed / 100).toFixed(2)} is outstanding` });
    return;
  }

  const date = today();
  const fy = financialYear(date);
  const seq = nextCounter(db, `customer_receipt:${fy}`);
  const receiptNo = `RCT/${fy}/${String(seq).padStart(5, '0')}`;

  // Recorded as an ADJUSTMENT receipt so the balance clears while the audit
  // trail still shows the money was never actually collected.
  db.prepare(
    `INSERT INTO customer_receipts (receipt_no, receipt_date, customer_id, sale_id,
       amount_paise, mode, reference, notes, created_by, created_at)
     VALUES (?,?,?,NULL,?,'ADJUSTMENT','WRITE-OFF',?,?,?)`,
  ).run(receiptNo, date, d.customer_id, d.amount_paise, d.reason, req.user!.id, nowIso());

  audit(req.user!.id, req.user!.username, 'WRITE_OFF_DEBT', 'customers', d.customer_id,
    `${(d.amount_paise / 100).toFixed(2)}: ${d.reason}`);
  res.status(201).json({ ok: true, receiptNo });
});
