import { Router } from 'express';
import { getDb, today, currentMonth, addMonths } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

function range(req: { query: Record<string, unknown> }): { from: string; to: string } {
  const from = String(req.query.from ?? today());
  const to = String(req.query.to ?? today());
  return { from, to };
}

/** Today-at-a-glance tiles for the dashboard. */
reportsRouter.get('/dashboard', (_req, res) => {
  const db = getDb();
  const d = today();
  const cm = currentMonth();

  const todaySales = db.prepare(
    `SELECT COUNT(*) AS bills,
            COALESCE(SUM(total_paise), 0) AS total_paise,
            COALESCE(SUM(taxable_paise), 0) AS taxable_paise,
            COALESCE(SUM(cgst_paise + sgst_paise + igst_paise), 0) AS tax_paise
       FROM sales WHERE date(invoice_date) = ? AND status = 'COMPLETED'`,
  ).get(d);

  const monthSales = db.prepare(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(total_paise), 0) AS total_paise
       FROM sales WHERE strftime('%Y-%m', invoice_date) = ? AND status = 'COMPLETED'`,
  ).get(cm);

  const byPayment = db.prepare(
    `SELECT payment_mode, COUNT(*) AS bills, COALESCE(SUM(total_paise), 0) AS total_paise
       FROM sales WHERE date(invoice_date) = ? AND status = 'COMPLETED'
      GROUP BY payment_mode`,
  ).all(d);

  // Approximate gross margin: selling value less batch cost for today's lines.
  const margin = db.prepare(
    `SELECT COALESCE(SUM(si.taxable_paise), 0) AS revenue_paise,
            COALESCE(SUM((b.purchase_rate_paise * si.qty_units) / si.pack_size), 0) AS cost_paise
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN batches b ON b.id = si.batch_id
      WHERE date(s.invoice_date) = ? AND s.status = 'COMPLETED'`,
  ).get(d);

  const last7 = db.prepare(
    `SELECT date(invoice_date) AS day, COUNT(*) AS bills,
            COALESCE(SUM(total_paise), 0) AS total_paise
       FROM sales
      WHERE status = 'COMPLETED' AND date(invoice_date) >= date(?, '-6 days')
      GROUP BY day ORDER BY day`,
  ).all(d);

  const returnsToday = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_paise), 0) AS total_paise
       FROM sale_returns WHERE return_date = ?`,
  ).get(d);

  const alerts = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM batches WHERE qty_units > 0 AND expiry < ?) AS expired_batches,
       (SELECT COUNT(*) FROM batches WHERE qty_units > 0 AND expiry >= ? AND expiry <= ?) AS expiring_batches`,
  ).get(cm, cm, addMonths(cm, 3));

  res.json({ date: d, todaySales, monthSales, byPayment, margin, last7, returnsToday, alerts });
});

/** Day book: every invoice in a date range. */
reportsRouter.get('/sales', (req, res) => {
  const db = getDb();
  const { from, to } = range(req);

  const summary = db.prepare(
    `SELECT COUNT(*) AS bills,
            COALESCE(SUM(gross_paise), 0) AS gross_paise,
            COALESCE(SUM(discount_paise), 0) AS discount_paise,
            COALESCE(SUM(taxable_paise), 0) AS taxable_paise,
            COALESCE(SUM(cgst_paise), 0) AS cgst_paise,
            COALESCE(SUM(sgst_paise), 0) AS sgst_paise,
            COALESCE(SUM(igst_paise), 0) AS igst_paise,
            COALESCE(SUM(round_off_paise), 0) AS round_off_paise,
            COALESCE(SUM(total_paise), 0) AS total_paise
       FROM sales WHERE date(invoice_date) BETWEEN ? AND ? AND status = 'COMPLETED'`,
  ).get(from, to);

  const daily = db.prepare(
    `SELECT date(invoice_date) AS day, COUNT(*) AS bills,
            COALESCE(SUM(total_paise), 0) AS total_paise,
            COALESCE(SUM(taxable_paise), 0) AS taxable_paise,
            COALESCE(SUM(cgst_paise + sgst_paise + igst_paise), 0) AS tax_paise
       FROM sales WHERE date(invoice_date) BETWEEN ? AND ? AND status = 'COMPLETED'
      GROUP BY day ORDER BY day`,
  ).all(from, to);

  const byUser = db.prepare(
    `SELECT COALESCE(u.full_name, 'Unknown') AS user_name, COUNT(*) AS bills,
            COALESCE(SUM(s.total_paise), 0) AS total_paise
       FROM sales s LEFT JOIN users u ON u.id = s.served_by
      WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED'
      GROUP BY s.served_by ORDER BY total_paise DESC`,
  ).all(from, to);

  res.json({ from, to, summary, daily, byUser });
});

/**
 * HSN-wise tax summary — the working for GSTR-1 Table 12 and GSTR-3B.
 * Sales returns are netted off, as credit notes reduce the period's liability.
 */
reportsRouter.get('/gst', (req, res) => {
  const db = getDb();
  const { from, to } = range(req);

  const outward = db.prepare(
    `SELECT si.hsn_code, si.gst_rate,
            SUM(si.qty_units) AS qty_units,
            SUM(si.taxable_paise) AS taxable_paise,
            SUM(si.cgst_paise) AS cgst_paise,
            SUM(si.sgst_paise) AS sgst_paise,
            SUM(si.igst_paise) AS igst_paise,
            SUM(si.total_paise) AS total_paise
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED'
      GROUP BY si.hsn_code, si.gst_rate ORDER BY si.gst_rate, si.hsn_code`,
  ).all(from, to);

  const creditNotes = db.prepare(
    `SELECT ri.hsn_code, ri.gst_rate,
            SUM(ri.qty_units) AS qty_units,
            SUM(ri.taxable_paise) AS taxable_paise,
            SUM(ri.cgst_paise) AS cgst_paise,
            SUM(ri.sgst_paise) AS sgst_paise,
            SUM(ri.igst_paise) AS igst_paise,
            SUM(ri.total_paise) AS total_paise
       FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
      WHERE r.return_date BETWEEN ? AND ?
      GROUP BY ri.hsn_code, ri.gst_rate ORDER BY ri.gst_rate, ri.hsn_code`,
  ).all(from, to);

  // B2B (customer supplied a GSTIN) must be reported invoice-wise in GSTR-1.
  const b2b = db.prepare(
    `SELECT s.invoice_no, date(s.invoice_date) AS invoice_date, s.customer_name, s.customer_gstin,
            s.place_of_supply, s.taxable_paise, s.cgst_paise, s.sgst_paise, s.igst_paise,
            s.total_paise
       FROM sales s
      WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED'
        AND s.customer_gstin != ''
      ORDER BY s.invoice_no`,
  ).all(from, to);

  const b2cSummary = db.prepare(
    `SELECT s.place_of_supply, COUNT(*) AS bills,
            COALESCE(SUM(s.taxable_paise), 0) AS taxable_paise,
            COALESCE(SUM(s.cgst_paise), 0) AS cgst_paise,
            COALESCE(SUM(s.sgst_paise), 0) AS sgst_paise,
            COALESCE(SUM(s.igst_paise), 0) AS igst_paise,
            COALESCE(SUM(s.total_paise), 0) AS total_paise
       FROM sales s
      WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED'
        AND s.customer_gstin = ''
      GROUP BY s.place_of_supply`,
  ).all(from, to);

  // Input tax credit available on purchases in the period.
  const inward = db.prepare(
    `SELECT pi.gst_rate,
            SUM(pi.taxable_paise) AS taxable_paise,
            SUM(pi.cgst_paise) AS cgst_paise,
            SUM(pi.sgst_paise) AS sgst_paise,
            SUM(pi.igst_paise) AS igst_paise
       FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.invoice_date BETWEEN ? AND ? AND p.status = 'COMPLETED'
      GROUP BY pi.gst_rate ORDER BY pi.gst_rate`,
  ).all(from, to);

  const totals = (rows: Record<string, number>[], key: string) =>
    rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);

  const outputTax = totals(outward as never, 'cgst_paise') + totals(outward as never, 'sgst_paise')
    + totals(outward as never, 'igst_paise');
  const creditTax = totals(creditNotes as never, 'cgst_paise') + totals(creditNotes as never, 'sgst_paise')
    + totals(creditNotes as never, 'igst_paise');
  const inputTax = totals(inward as never, 'cgst_paise') + totals(inward as never, 'sgst_paise')
    + totals(inward as never, 'igst_paise');

  res.json({
    from, to, outward, creditNotes, b2b, b2cSummary, inward,
    liability: {
      output_tax_paise: outputTax,
      credit_note_tax_paise: creditTax,
      net_output_tax_paise: outputTax - creditTax,
      input_tax_credit_paise: inputTax,
      net_payable_paise: outputTax - creditTax - inputTax,
    },
  });
});

/** Best and worst sellers by value and quantity. */
reportsRouter.get('/product-movement', (req, res) => {
  const db = getDb();
  const { from, to } = range(req);
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const top = db.prepare(
    `SELECT si.product_id, si.product_name, p.manufacturer, p.unit,
            SUM(si.qty_units) AS qty_units,
            SUM(si.total_paise) AS revenue_paise,
            SUM(si.total_paise) - SUM((b.purchase_rate_paise * si.qty_units) / si.pack_size) AS margin_paise,
            COUNT(DISTINCT si.sale_id) AS bills
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       JOIN batches b ON b.id = si.batch_id
      WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED'
      GROUP BY si.product_id ORDER BY revenue_paise DESC LIMIT ?`,
  ).all(from, to, limit);

  // Stock sitting on the shelf with no sale in the period — dead money.
  const nonMoving = db.prepare(
    `SELECT p.id, p.name, p.manufacturer, p.unit,
            COALESCE(SUM(b.qty_units), 0) AS stock_units,
            COALESCE(SUM((b.qty_units * b.purchase_rate_paise) / p.pack_size), 0) AS cost_paise
       FROM products p JOIN batches b ON b.product_id = p.id
      WHERE p.active = 1 AND b.qty_units > 0
        AND p.id NOT IN (
          SELECT si.product_id FROM sale_items si JOIN sales s ON s.id = si.sale_id
           WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED')
      GROUP BY p.id ORDER BY cost_paise DESC LIMIT ?`,
  ).all(from, to, limit);

  res.json({ from, to, top, nonMoving });
});

/** Purchase register for the period. */
reportsRouter.get('/purchases', (req, res) => {
  const db = getDb();
  const { from, to } = range(req);

  const summary = db.prepare(
    `SELECT COUNT(*) AS invoices,
            COALESCE(SUM(taxable_paise), 0) AS taxable_paise,
            COALESCE(SUM(cgst_paise + sgst_paise + igst_paise), 0) AS tax_paise,
            COALESCE(SUM(total_paise), 0) AS total_paise,
            COALESCE(SUM(paid_paise), 0) AS paid_paise
       FROM purchases WHERE invoice_date BETWEEN ? AND ? AND status = 'COMPLETED'`,
  ).get(from, to);

  const bySupplier = db.prepare(
    `SELECT s.name AS supplier_name, s.gstin, COUNT(*) AS invoices,
            COALESCE(SUM(p.total_paise), 0) AS total_paise,
            COALESCE(SUM(p.total_paise - p.paid_paise), 0) AS outstanding_paise
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.invoice_date BETWEEN ? AND ? AND p.status = 'COMPLETED'
      GROUP BY p.supplier_id ORDER BY total_paise DESC`,
  ).all(from, to);

  res.json({ from, to, summary, bySupplier });
});

/**
 * Schedule H1 register.
 *
 * Reproduces the statutory register: date of supply, prescriber name & address,
 * patient name & address, drug, quantity, manufacturer, batch, expiry and the
 * dispensing pharmacist. Records are retained for three years and must be
 * produced for inspection by the drug control authorities.
 */
reportsRouter.get('/h1-register', requireRole('pharmacist'), (req, res) => {
  const db = getDb();
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  const q = String(req.query.q ?? '').trim();

  const where: string[] = [];
  const params: unknown[] = [];
  if (from) { where.push('supply_date >= ?'); params.push(from); }
  if (to) { where.push('supply_date <= ?'); params.push(to); }
  if (q) {
    where.push('(drug_name LIKE ? OR patient_name LIKE ? OR prescriber_name LIKE ? OR invoice_no LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(
    `SELECT * FROM h1_register ${clause} ORDER BY serial_no DESC LIMIT 2000`,
  ).all(...params);

  const retention = db.prepare(
    `SELECT MIN(supply_date) AS oldest_entry, COUNT(*) AS total_entries FROM h1_register`,
  ).get();

  res.json({ from, to, rows, retention });
});

/** Expiry pipeline grouped by month, for planning supplier returns. */
reportsRouter.get('/expiry', (req, res) => {
  const db = getDb();
  const months = Math.min(Number(req.query.months) || 6, 24);
  const cm = currentMonth();

  const buckets = db.prepare(
    `SELECT b.expiry, COUNT(*) AS batches,
            SUM(b.qty_units) AS qty_units,
            SUM((b.qty_units * b.purchase_rate_paise) / p.pack_size) AS cost_paise,
            SUM((b.qty_units * b.mrp_paise) / p.pack_size) AS mrp_paise
       FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.qty_units > 0 AND b.expiry <= ?
      GROUP BY b.expiry ORDER BY b.expiry`,
  ).all(addMonths(cm, months));

  const detail = db.prepare(
    `SELECT b.id, b.batch_no, b.expiry, b.qty_units, b.mrp_paise, b.purchase_rate_paise,
            p.name AS product_name, p.manufacturer, p.unit, p.pack_size, p.rack,
            s.name AS supplier_name, s.phone AS supplier_phone,
            (b.qty_units * b.purchase_rate_paise) / p.pack_size AS cost_paise,
            CASE WHEN b.expiry < ? THEN 'EXPIRED' ELSE 'EXPIRING' END AS status
       FROM batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.qty_units > 0 AND b.expiry <= ?
      ORDER BY b.expiry, p.name LIMIT 1000`,
  ).all(cm, addMonths(cm, months));

  res.json({ current_month: cm, buckets, detail });
});

/** Cash/UPI/card reconciliation for closing the till. */
reportsRouter.get('/daybook', (req, res) => {
  const db = getDb();
  const date = String(req.query.date ?? today());

  const collections = db.prepare(
    `SELECT payment_mode, COUNT(*) AS bills, COALESCE(SUM(total_paise), 0) AS total_paise,
            COALESCE(SUM(paid_paise), 0) AS collected_paise
       FROM sales WHERE date(invoice_date) = ? AND status = 'COMPLETED'
      GROUP BY payment_mode`,
  ).all(date);

  const refunds = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_paise), 0) AS total_paise
       FROM sale_returns WHERE return_date = ?`,
  ).get(date);

  const credit = db.prepare(
    `SELECT COALESCE(SUM(total_paise - paid_paise), 0) AS outstanding_paise, COUNT(*) AS bills
       FROM sales WHERE date(invoice_date) = ? AND status = 'COMPLETED' AND total_paise > paid_paise`,
  ).get(date);

  const cancelled = db.prepare(
    `SELECT COUNT(*) AS count FROM sales WHERE date(invoice_date) = ? AND status = 'CANCELLED'`,
  ).get(date);

  const bills = db.prepare(
    `SELECT id, invoice_no, invoice_date, customer_name, payment_mode, total_paise, status
       FROM sales WHERE date(invoice_date) = ? ORDER BY id`,
  ).all(date);

  res.json({ date, collections, refunds, credit, cancelled, bills });
});

/** Recent audit entries — who cancelled what, who changed prices. */
reportsRouter.get('/audit', requireRole('admin'), (req, res) => {
  const db = getDb();
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(db.prepare(
    'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?',
  ).all(limit));
});
