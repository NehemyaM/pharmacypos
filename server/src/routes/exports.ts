import { Router, type Response } from 'express';
import { getDb, today, currentMonth, addMonths } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { toCsv, csvRupees, csvFilename, type Column } from '../lib/csv.js';
import { audit } from '../lib/audit.js';

export const exportsRouter = Router();
exportsRouter.use(requireAuth);

type Row = Record<string, any>;

function send(res: Response, name: string, rows: Row[], columns: Column<Row>[],
  from?: string, to?: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(name, from, to)}"`);
  res.send(toCsv(rows, columns));
}

function range(q: Record<string, unknown>): { from: string; to: string } {
  return { from: String(q.from ?? today()), to: String(q.to ?? today()) };
}

// --- GST: HSN-wise summary (GSTR-1 Table 12) --------------------------------

exportsRouter.get('/gst', (req, res) => {
  const { from, to } = range(req.query);
  const rows = getDb().prepare(
    `SELECT si.hsn_code, si.gst_rate, SUM(si.qty_units) qty,
            SUM(si.taxable_paise) taxable, SUM(si.cgst_paise) cgst,
            SUM(si.sgst_paise) sgst, SUM(si.igst_paise) igst, SUM(si.total_paise) total
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED'
      GROUP BY si.hsn_code, si.gst_rate ORDER BY si.gst_rate, si.hsn_code`,
  ).all(from, to) as Row[];

  send(res, 'gst-hsn-summary', rows, [
    { header: 'HSN Code', value: (r) => r.hsn_code },
    { header: 'GST Rate %', value: (r) => r.gst_rate },
    { header: 'Quantity', value: (r) => r.qty },
    { header: 'Taxable Value', value: (r) => csvRupees(r.taxable) },
    { header: 'CGST', value: (r) => csvRupees(r.cgst) },
    { header: 'SGST', value: (r) => csvRupees(r.sgst) },
    { header: 'IGST', value: (r) => csvRupees(r.igst) },
    { header: 'Total', value: (r) => csvRupees(r.total) },
  ], from, to);
});

/** Invoice-wise B2B detail — what GSTR-1 needs when the customer has a GSTIN. */
exportsRouter.get('/gst-b2b', (req, res) => {
  const { from, to } = range(req.query);
  const rows = getDb().prepare(
    `SELECT s.invoice_no, date(s.invoice_date) invoice_date, s.customer_name, s.customer_gstin,
            s.place_of_supply, s.taxable_paise, s.cgst_paise, s.sgst_paise, s.igst_paise,
            s.total_paise
       FROM sales s
      WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED'
        AND s.customer_gstin != '' ORDER BY s.invoice_no`,
  ).all(from, to) as Row[];

  send(res, 'gst-b2b-invoices', rows, [
    { header: 'Invoice No', value: (r) => r.invoice_no },
    { header: 'Invoice Date', value: (r) => r.invoice_date },
    { header: 'Customer', value: (r) => r.customer_name },
    { header: 'GSTIN', value: (r) => r.customer_gstin },
    { header: 'Place of Supply', value: (r) => r.place_of_supply },
    { header: 'Taxable Value', value: (r) => csvRupees(r.taxable_paise) },
    { header: 'CGST', value: (r) => csvRupees(r.cgst_paise) },
    { header: 'SGST', value: (r) => csvRupees(r.sgst_paise) },
    { header: 'IGST', value: (r) => csvRupees(r.igst_paise) },
    { header: 'Invoice Total', value: (r) => csvRupees(r.total_paise) },
  ], from, to);
});

// --- Sales -------------------------------------------------------------------

exportsRouter.get('/sales', (req, res) => {
  const { from, to } = range(req.query);
  const rows = getDb().prepare(
    `SELECT date(invoice_date) day, COUNT(*) bills, SUM(gross_paise) gross,
            SUM(discount_paise) discount, SUM(taxable_paise) taxable,
            SUM(cgst_paise + sgst_paise + igst_paise) tax, SUM(total_paise) total
       FROM sales WHERE date(invoice_date) BETWEEN ? AND ? AND status = 'COMPLETED'
      GROUP BY day ORDER BY day`,
  ).all(from, to) as Row[];

  send(res, 'sales-summary', rows, [
    { header: 'Date', value: (r) => r.day },
    { header: 'Bills', value: (r) => r.bills },
    { header: 'Gross', value: (r) => csvRupees(r.gross) },
    { header: 'Discount', value: (r) => csvRupees(r.discount) },
    { header: 'Taxable Value', value: (r) => csvRupees(r.taxable) },
    { header: 'GST', value: (r) => csvRupees(r.tax) },
    { header: 'Total', value: (r) => csvRupees(r.total) },
  ], from, to);
});

/** Every invoice line — the workbook an accountant actually wants. */
exportsRouter.get('/invoice-items', (req, res) => {
  const { from, to } = range(req.query);
  const rows = getDb().prepare(
    `SELECT s.invoice_no, date(s.invoice_date) invoice_date, s.customer_name, s.customer_gstin,
            s.payment_mode, s.status, si.product_name, si.manufacturer, si.hsn_code,
            si.schedule_type, si.batch_no, si.expiry, si.qty_units, si.mrp_paise, si.rate_paise,
            si.discount_paise, si.taxable_paise, si.gst_rate, si.cgst_paise, si.sgst_paise,
            si.igst_paise, si.total_paise
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE date(s.invoice_date) BETWEEN ? AND ?
      ORDER BY s.invoice_no, si.id`,
  ).all(from, to) as Row[];

  send(res, 'invoice-line-items', rows, [
    { header: 'Invoice No', value: (r) => r.invoice_no },
    { header: 'Date', value: (r) => r.invoice_date },
    { header: 'Customer', value: (r) => r.customer_name },
    { header: 'Customer GSTIN', value: (r) => r.customer_gstin },
    { header: 'Payment', value: (r) => r.payment_mode },
    { header: 'Status', value: (r) => r.status },
    { header: 'Product', value: (r) => r.product_name },
    { header: 'Manufacturer', value: (r) => r.manufacturer },
    { header: 'HSN', value: (r) => r.hsn_code },
    { header: 'Schedule', value: (r) => r.schedule_type },
    { header: 'Batch', value: (r) => r.batch_no },
    { header: 'Expiry', value: (r) => r.expiry },
    { header: 'Qty', value: (r) => r.qty_units },
    { header: 'MRP', value: (r) => csvRupees(r.mrp_paise) },
    { header: 'Rate', value: (r) => csvRupees(r.rate_paise) },
    { header: 'Discount', value: (r) => csvRupees(r.discount_paise) },
    { header: 'Taxable Value', value: (r) => csvRupees(r.taxable_paise) },
    { header: 'GST Rate %', value: (r) => r.gst_rate },
    { header: 'CGST', value: (r) => csvRupees(r.cgst_paise) },
    { header: 'SGST', value: (r) => csvRupees(r.sgst_paise) },
    { header: 'IGST', value: (r) => csvRupees(r.igst_paise) },
    { header: 'Line Total', value: (r) => csvRupees(r.total_paise) },
  ], from, to);
});

// --- Stock -------------------------------------------------------------------

exportsRouter.get('/stock', (req, res) => {
  const cm = currentMonth();
  const rows = getDb().prepare(
    `SELECT p.name product, p.generic_name, p.manufacturer, p.schedule_type, p.hsn_code,
            p.gst_rate, p.rack, p.unit, p.pack_size, b.batch_no, b.expiry, b.qty_units,
            b.purchase_rate_paise, b.mrp_paise, s.name supplier,
            (b.qty_units * b.purchase_rate_paise) / p.pack_size cost_value,
            (b.qty_units * b.mrp_paise) / p.pack_size mrp_value,
            CASE WHEN b.expiry < ? THEN 'EXPIRED'
                 WHEN b.expiry <= ? THEN 'EXPIRING' ELSE 'OK' END status
       FROM batches b JOIN products p ON p.id = b.product_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.qty_units > 0 AND p.active = 1
      ORDER BY p.name, b.expiry`,
  ).all(cm, addMonths(cm, 3)) as Row[];

  send(res, 'stock-on-hand', rows, [
    { header: 'Product', value: (r) => r.product },
    { header: 'Composition', value: (r) => r.generic_name },
    { header: 'Manufacturer', value: (r) => r.manufacturer },
    { header: 'Schedule', value: (r) => r.schedule_type },
    { header: 'HSN', value: (r) => r.hsn_code },
    { header: 'GST %', value: (r) => r.gst_rate },
    { header: 'Rack', value: (r) => r.rack },
    { header: 'Batch', value: (r) => r.batch_no },
    { header: 'Expiry', value: (r) => r.expiry },
    { header: 'Status', value: (r) => r.status },
    { header: 'Qty', value: (r) => r.qty_units },
    { header: 'Unit', value: (r) => r.unit },
    { header: 'Pack Size', value: (r) => r.pack_size },
    { header: 'Purchase Rate', value: (r) => csvRupees(r.purchase_rate_paise) },
    { header: 'MRP', value: (r) => csvRupees(r.mrp_paise) },
    { header: 'Value at Cost', value: (r) => csvRupees(r.cost_value) },
    { header: 'Value at MRP', value: (r) => csvRupees(r.mrp_value) },
    { header: 'Supplier', value: (r) => r.supplier },
  ]);
});

exportsRouter.get('/expiry', (req, res) => {
  const months = Math.min(Number(req.query.months) || 6, 24);
  const cm = currentMonth();
  const rows = getDb().prepare(
    `SELECT p.name product, p.manufacturer, p.rack, b.batch_no, b.expiry, b.qty_units,
            p.unit, b.purchase_rate_paise, b.mrp_paise,
            (b.qty_units * b.purchase_rate_paise) / p.pack_size cost_value,
            s.name supplier, s.phone supplier_phone,
            CASE WHEN b.expiry < ? THEN 'EXPIRED' ELSE 'EXPIRING' END status
       FROM batches b JOIN products p ON p.id = b.product_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.qty_units > 0 AND b.expiry <= ?
      ORDER BY b.expiry, p.name`,
  ).all(cm, addMonths(cm, months)) as Row[];

  send(res, 'expiry-pipeline', rows, [
    { header: 'Expiry', value: (r) => r.expiry },
    { header: 'Status', value: (r) => r.status },
    { header: 'Product', value: (r) => r.product },
    { header: 'Manufacturer', value: (r) => r.manufacturer },
    { header: 'Batch', value: (r) => r.batch_no },
    { header: 'Qty', value: (r) => r.qty_units },
    { header: 'Unit', value: (r) => r.unit },
    { header: 'Purchase Rate', value: (r) => csvRupees(r.purchase_rate_paise) },
    { header: 'MRP', value: (r) => csvRupees(r.mrp_paise) },
    { header: 'Cost at Risk', value: (r) => csvRupees(r.cost_value) },
    { header: 'Rack', value: (r) => r.rack },
    { header: 'Supplier', value: (r) => r.supplier },
    { header: 'Supplier Phone', value: (r) => r.supplier_phone },
  ]);
});

exportsRouter.get('/reorder', (_req, res) => {
  const cm = currentMonth();
  const rows = getDb().prepare(
    `SELECT p.name product, p.generic_name, p.manufacturer, p.unit, p.rack, p.reorder_level,
            COALESCE(SUM(b.qty_units), 0) stock_units,
            (SELECT s.name FROM batches b2 JOIN suppliers s ON s.id = b2.supplier_id
              WHERE b2.product_id = p.id ORDER BY b2.id DESC LIMIT 1) last_supplier,
            (SELECT COALESCE(SUM(si.qty_units), 0) FROM sale_items si
               JOIN sales sa ON sa.id = si.sale_id
              WHERE si.product_id = p.id AND sa.status = 'COMPLETED'
                AND date(sa.invoice_date) >= date('now', '-30 days')) sold_30d
       FROM products p
       LEFT JOIN batches b ON b.product_id = p.id AND b.qty_units > 0 AND b.expiry >= ?
      WHERE p.active = 1
      GROUP BY p.id
     HAVING stock_units <= p.reorder_level AND (p.reorder_level > 0 OR sold_30d > 0)
      ORDER BY (stock_units - p.reorder_level), sold_30d DESC`,
  ).all(cm) as Row[];

  send(res, 'reorder-list', rows, [
    { header: 'Product', value: (r) => r.product },
    { header: 'Composition', value: (r) => r.generic_name },
    { header: 'Manufacturer', value: (r) => r.manufacturer },
    { header: 'In Stock', value: (r) => r.stock_units },
    { header: 'Unit', value: (r) => r.unit },
    { header: 'Reorder Level', value: (r) => r.reorder_level },
    { header: 'Sold Last 30 Days', value: (r) => r.sold_30d },
    { header: 'Rack', value: (r) => r.rack },
    { header: 'Usual Supplier', value: (r) => r.last_supplier },
  ]);
});

exportsRouter.get('/movement', (req, res) => {
  const { from, to } = range(req.query);
  const rows = getDb().prepare(
    `SELECT si.product_name product, p.manufacturer, p.unit,
            SUM(si.qty_units) qty, SUM(si.total_paise) revenue,
            SUM(si.total_paise) - SUM((b.purchase_rate_paise * si.qty_units) / si.pack_size) margin,
            COUNT(DISTINCT si.sale_id) bills
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       JOIN batches b ON b.id = si.batch_id
      WHERE date(s.invoice_date) BETWEEN ? AND ? AND s.status = 'COMPLETED'
      GROUP BY si.product_id ORDER BY revenue DESC`,
  ).all(from, to) as Row[];

  send(res, 'product-movement', rows, [
    { header: 'Product', value: (r) => r.product },
    { header: 'Manufacturer', value: (r) => r.manufacturer },
    { header: 'Qty Sold', value: (r) => r.qty },
    { header: 'Unit', value: (r) => r.unit },
    { header: 'Bills', value: (r) => r.bills },
    { header: 'Revenue', value: (r) => csvRupees(r.revenue) },
    { header: 'Gross Margin', value: (r) => csvRupees(r.margin) },
  ], from, to);
});

exportsRouter.get('/daybook', (req, res) => {
  const date = String(req.query.date ?? today());
  const rows = getDb().prepare(
    `SELECT invoice_no, invoice_date, customer_name, customer_phone, payment_mode,
            payment_ref, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
            paid_paise, status, pharmacist_name
       FROM sales WHERE date(invoice_date) = ? ORDER BY id`,
  ).all(date) as Row[];

  send(res, `daybook-${date}`, rows, [
    { header: 'Invoice No', value: (r) => r.invoice_no },
    { header: 'Time', value: (r) => String(r.invoice_date).slice(11, 16) },
    { header: 'Customer', value: (r) => r.customer_name },
    { header: 'Phone', value: (r) => r.customer_phone },
    { header: 'Payment', value: (r) => r.payment_mode },
    { header: 'Reference', value: (r) => r.payment_ref },
    { header: 'Taxable Value', value: (r) => csvRupees(r.taxable_paise) },
    { header: 'CGST', value: (r) => csvRupees(r.cgst_paise) },
    { header: 'SGST', value: (r) => csvRupees(r.sgst_paise) },
    { header: 'IGST', value: (r) => csvRupees(r.igst_paise) },
    { header: 'Total', value: (r) => csvRupees(r.total_paise) },
    { header: 'Collected', value: (r) => csvRupees(r.paid_paise) },
    { header: 'Status', value: (r) => r.status },
    { header: 'Pharmacist', value: (r) => r.pharmacist_name },
  ]);
});

/**
 * Schedule H1 register export — the format a drug inspector expects, in the
 * statutory column order. Restricted to pharmacists and admins.
 */
exportsRouter.get('/h1-register', requireRole('pharmacist'), (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  const where: string[] = [];
  const params: unknown[] = [];
  if (from) { where.push('supply_date >= ?'); params.push(from); }
  if (to) { where.push('supply_date <= ?'); params.push(to); }

  const rows = getDb().prepare(
    `SELECT * FROM h1_register ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY serial_no`,
  ).all(...params) as Row[];

  audit(req.user!.id, req.user!.username, 'EXPORT_H1_REGISTER', 'h1_register', null,
    `${rows.length} entries ${from}..${to}`);

  send(res, 'schedule-h1-register', rows, [
    { header: 'S.No.', value: (r) => r.serial_no },
    { header: 'Date of Supply', value: (r) => r.supply_date },
    { header: 'Prescriber Name', value: (r) => r.prescriber_name },
    { header: 'Prescriber Address', value: (r) => r.prescriber_address },
    { header: 'Prescriber Reg. No.', value: (r) => r.prescriber_reg_no },
    { header: 'Patient Name', value: (r) => r.patient_name },
    { header: 'Patient Address', value: (r) => r.patient_address },
    { header: 'Drug Name', value: (r) => r.drug_name },
    { header: 'Quantity', value: (r) => r.quantity },
    { header: 'Manufacturer', value: (r) => r.manufacturer },
    { header: 'Batch No.', value: (r) => r.batch_no },
    { header: 'Expiry', value: (r) => r.expiry },
    { header: 'Pharmacist', value: (r) => r.pharmacist_name },
    { header: 'Pharmacist Reg. No.', value: (r) => r.pharmacist_reg_no },
    { header: 'Invoice No.', value: (r) => r.invoice_no },
  ], from, to);
});

// --- Purchases ---------------------------------------------------------------

exportsRouter.get('/purchases', requireRole('pharmacist'), (req, res) => {
  const { from, to } = range(req.query);
  const rows = getDb().prepare(
    `SELECT p.invoice_no, p.invoice_date, s.name supplier, s.gstin supplier_gstin,
            pi.batch_no, pi.expiry, pr.name product, pi.qty_packs, pi.free_packs,
            pi.purchase_rate_paise, pi.mrp_paise, pi.discount_pct, pi.gst_rate,
            pi.taxable_paise, pi.cgst_paise, pi.sgst_paise, pi.igst_paise, pi.total_paise
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN products pr ON pr.id = pi.product_id
      WHERE p.invoice_date BETWEEN ? AND ? AND p.status = 'COMPLETED'
      ORDER BY p.invoice_date, p.id, pi.id`,
  ).all(from, to) as Row[];

  send(res, 'purchase-register', rows, [
    { header: 'Invoice No', value: (r) => r.invoice_no },
    { header: 'Date', value: (r) => r.invoice_date },
    { header: 'Supplier', value: (r) => r.supplier },
    { header: 'Supplier GSTIN', value: (r) => r.supplier_gstin },
    { header: 'Product', value: (r) => r.product },
    { header: 'Batch', value: (r) => r.batch_no },
    { header: 'Expiry', value: (r) => r.expiry },
    { header: 'Packs', value: (r) => r.qty_packs },
    { header: 'Free Packs', value: (r) => r.free_packs },
    { header: 'Rate (ex-GST)', value: (r) => csvRupees(r.purchase_rate_paise) },
    { header: 'MRP', value: (r) => csvRupees(r.mrp_paise) },
    { header: 'Discount %', value: (r) => r.discount_pct },
    { header: 'GST %', value: (r) => r.gst_rate },
    { header: 'Taxable Value', value: (r) => csvRupees(r.taxable_paise) },
    { header: 'CGST', value: (r) => csvRupees(r.cgst_paise) },
    { header: 'SGST', value: (r) => csvRupees(r.sgst_paise) },
    { header: 'IGST', value: (r) => csvRupees(r.igst_paise) },
    { header: 'Total', value: (r) => csvRupees(r.total_paise) },
  ], from, to);
});
