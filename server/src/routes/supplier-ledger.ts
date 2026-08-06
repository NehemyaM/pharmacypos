import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, today, nextCounter, financialYear } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { HttpError } from './sales.js';

export const supplierLedgerRouter = Router();
supplierLedgerRouter.use(requireAuth, requireRole('pharmacist'));

const paymentSchema = z.object({
  supplier_id: z.number().int().positive(),
  /** Omit to record an on-account payment not tied to one invoice. */
  purchase_id: z.number().int().positive().nullable().default(null),
  amount_paise: z.number().int().positive('Amount must be more than zero'),
  mode: z.enum(['CASH', 'UPI', 'BANK', 'CHEQUE', 'ADJUSTMENT']).default('CASH'),
  reference: z.string().default(''),
  notes: z.string().default(''),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Record a payment to a distributor. */
supplierLedgerRouter.post('/payments', (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();
  const user = req.user!;

  try {
    const result = db.transaction(() => {
      const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?')
        .get(d.supplier_id) as { name: string } | undefined;
      if (!supplier) throw new HttpError(404, 'Supplier not found');

      if (d.purchase_id) {
        const purchase = db.prepare(
          'SELECT id, supplier_id, invoice_no, total_paise FROM purchases WHERE id = ?',
        ).get(d.purchase_id) as
          { supplier_id: number; invoice_no: string; total_paise: number } | undefined;
        if (!purchase) throw new HttpError(404, 'Purchase invoice not found');
        if (purchase.supplier_id !== d.supplier_id) {
          throw new HttpError(400, 'That invoice belongs to a different supplier');
        }

        // Guard against paying an invoice twice — a common data-entry slip.
        const paid = db.prepare(
          'SELECT COALESCE(SUM(amount_paise), 0) p FROM supplier_payments WHERE purchase_id = ?',
        ).get(d.purchase_id) as { p: number };
        const alreadyPaid = paid.p + (db.prepare('SELECT paid_paise p FROM purchases WHERE id = ?')
          .get(d.purchase_id) as { p: number }).p;
        if (alreadyPaid + d.amount_paise > purchase.total_paise) {
          const due = purchase.total_paise - alreadyPaid;
          throw new HttpError(400,
            `Invoice ${purchase.invoice_no} only has ${(due / 100).toFixed(2)} outstanding`);
        }
      }

      const date = d.payment_date ?? today();
      const fy = financialYear(date);
      const seq = nextCounter(db, `supplier_payment:${fy}`);
      const paymentNo = `PAY/${fy}/${String(seq).padStart(5, '0')}`;

      const info = db.prepare(
        `INSERT INTO supplier_payments (payment_no, payment_date, supplier_id, purchase_id,
           amount_paise, mode, reference, notes, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(paymentNo, date, d.supplier_id, d.purchase_id, d.amount_paise, d.mode,
        d.reference, d.notes, user.id, nowIso());

      return { id: Number(info.lastInsertRowid), paymentNo, supplier: supplier.name };
    })();

    audit(user.id, user.username, 'SUPPLIER_PAYMENT', 'supplier_payments', result.id,
      `${result.paymentNo} ${result.supplier} ${(d.amount_paise / 100).toFixed(2)}`);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[supplier-ledger] payment failed:', err);
    res.status(500).json({ error: 'Could not record the payment' });
  }
});

supplierLedgerRouter.get('/payments', (req, res) => {
  const db = getDb();
  const supplierId = Number(req.query.supplier_id) || null;
  const where: string[] = [];
  const params: unknown[] = [];
  if (supplierId) { where.push('sp.supplier_id = ?'); params.push(supplierId); }

  res.json(db.prepare(
    `SELECT sp.*, s.name AS supplier_name, p.invoice_no
       FROM supplier_payments sp
       JOIN suppliers s ON s.id = sp.supplier_id
       LEFT JOIN purchases p ON p.id = sp.purchase_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY sp.id DESC LIMIT 200`,
  ).all(...params));
});

/**
 * What the shop owes each distributor.
 *
 *   outstanding = purchases − payments − credit received on returns
 *
 * `purchases.paid_paise` records anything paid at the time of entry; the
 * supplier_payments table records everything paid since. Both must be counted
 * or the shop appears to owe money it has already handed over.
 */
supplierLedgerRouter.get('/outstanding', (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.id, s.name, s.phone, s.contact_person, s.credit_days, s.gstin,
            COALESCE(pu.invoices, 0)          AS invoices,
            COALESCE(pu.billed, 0)            AS billed_paise,
            COALESCE(pu.paid_at_entry, 0)     AS paid_at_entry_paise,
            COALESCE(pa.paid_later, 0)        AS payments_paise,
            COALESCE(cr.credited, 0)          AS return_credit_paise,
            COALESCE(pu.billed, 0) - COALESCE(pu.paid_at_entry, 0)
              - COALESCE(pa.paid_later, 0) - COALESCE(cr.credited, 0) AS outstanding_paise,
            COALESCE(pr.pending, 0)           AS pending_claim_paise,
            pu.oldest_unpaid
       FROM suppliers s
       LEFT JOIN (
         SELECT supplier_id, COUNT(*) invoices, SUM(total_paise) billed,
                SUM(paid_paise) paid_at_entry, MIN(invoice_date) oldest_unpaid
           FROM purchases WHERE status = 'COMPLETED' GROUP BY supplier_id
       ) pu ON pu.supplier_id = s.id
       LEFT JOIN (
         SELECT supplier_id, SUM(amount_paise) paid_later
           FROM supplier_payments GROUP BY supplier_id
       ) pa ON pa.supplier_id = s.id
       LEFT JOIN (
         SELECT supplier_id, SUM(credited_paise) credited
           FROM purchase_returns WHERE status = 'CREDITED' GROUP BY supplier_id
       ) cr ON cr.supplier_id = s.id
       LEFT JOIN (
         SELECT supplier_id, SUM(total_paise) pending
           FROM purchase_returns WHERE status = 'PENDING' GROUP BY supplier_id
       ) pr ON pr.supplier_id = s.id
      WHERE s.active = 1
      ORDER BY outstanding_paise DESC, s.name`,
  ).all();

  const totals = rows.reduce((acc: Record<string, number>, r: any) => ({
    billed_paise: acc.billed_paise + r.billed_paise,
    outstanding_paise: acc.outstanding_paise + r.outstanding_paise,
    pending_claim_paise: acc.pending_claim_paise + r.pending_claim_paise,
  }), { billed_paise: 0, outstanding_paise: 0, pending_claim_paise: 0 });

  res.json({ rows, totals });
});

/**
 * Invoice-wise statement for one supplier, aged against each invoice's own due
 * date (invoice date + the supplier's agreed credit period).
 */
supplierLedgerRouter.get('/statement/:supplierId', (req, res) => {
  const db = getDb();
  const id = Number(req.params.supplierId);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as
    { credit_days: number; name: string } | undefined;
  if (!supplier) {
    res.status(404).json({ error: 'Supplier not found' });
    return;
  }

  const invoices = db.prepare(
    `SELECT p.id, p.invoice_no, p.invoice_date, p.total_paise, p.paid_paise,
            COALESCE(sp.paid, 0) AS payments_paise,
            p.total_paise - p.paid_paise - COALESCE(sp.paid, 0) AS due_paise,
            date(p.invoice_date, '+' || ? || ' days') AS due_date,
            CAST(julianday('now') - julianday(date(p.invoice_date, '+' || ? || ' days'))
                 AS INTEGER) AS days_overdue
       FROM purchases p
       LEFT JOIN (
         SELECT purchase_id, SUM(amount_paise) paid FROM supplier_payments
          WHERE purchase_id IS NOT NULL GROUP BY purchase_id
       ) sp ON sp.purchase_id = p.id
      WHERE p.supplier_id = ? AND p.status = 'COMPLETED'
      ORDER BY p.invoice_date DESC`,
  ).all(supplier.credit_days, supplier.credit_days, id);

  const payments = db.prepare(
    `SELECT sp.*, p.invoice_no FROM supplier_payments sp
       LEFT JOIN purchases p ON p.id = sp.purchase_id
      WHERE sp.supplier_id = ? ORDER BY sp.payment_date DESC, sp.id DESC`,
  ).all(id);

  const returns = db.prepare(
    `SELECT id, return_no, return_date, reason, total_paise, status, credited_paise, credit_note_no
       FROM purchase_returns WHERE supplier_id = ? ORDER BY id DESC`,
  ).all(id);

  res.json({ supplier, invoices, payments, returns });
});
