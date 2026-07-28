import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, today, currentMonth, nextCounter, financialYear } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { computeLine, allocateFefo, InsufficientStockError, requiresH1Register, requiresPrescription } from '../lib/billing.js';
import { isInterstateSupply, isValidGstin } from '../lib/gst.js';
import { roundOff } from '../lib/money.js';
import { audit } from '../lib/audit.js';
import type { Settings, Product, Batch, Sale, SaleItem } from '../types.js';

export const salesRouter = Router();
salesRouter.use(requireAuth);

const itemSchema = z.object({
  product_id: z.number().int().positive(),
  /** Omit to auto-allocate by FEFO across batches. */
  batch_id: z.number().int().positive().optional(),
  qty_units: z.number().int().positive('Quantity must be at least 1'),
  discount_pct: z.number().min(0).max(100).default(0),
});

const saleSchema = z.object({
  customer_id: z.number().int().positive().nullable().default(null),
  customer_name: z.string().default('Cash Customer'),
  customer_phone: z.string().default(''),
  customer_gstin: z.string().default(''),
  doctor_id: z.number().int().positive().nullable().default(null),
  prescription_no: z.string().default(''),
  patient_name: z.string().default(''),
  patient_address: z.string().default(''),
  place_of_supply: z.string().default(''),
  payment_mode: z.enum(['CASH', 'UPI', 'CARD', 'CREDIT', 'SPLIT']).default('CASH'),
  payment_ref: z.string().default(''),
  paid_paise: z.number().int().min(0).default(0),
  notes: z.string().default(''),
  /** Bill-level discount applied to every line. */
  overall_discount_pct: z.number().min(0).max(100).default(0),
  items: z.array(itemSchema).min(1, 'Add at least one item to the bill'),
});

type PreparedLine = {
  product: Product;
  batch: Batch;
  qtyUnits: number;
  discountPct: number;
  line: ReturnType<typeof computeLine>;
};

/**
 * Create a retail tax invoice.
 *
 * Everything happens inside one SQLite transaction: stock decrement, ledger
 * entries, H1 register rows and the invoice number all commit together or not
 * at all. A crash mid-bill can never leave stock deducted without an invoice.
 */
salesRouter.post('/', (req, res) => {
  const parsed = saleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Settings;
  const user = req.user!;

  if (d.customer_gstin && !isValidGstin(d.customer_gstin)) {
    res.status(400).json({ error: 'That customer GSTIN is not valid' });
    return;
  }

  const placeOfSupply = d.place_of_supply || settings.state_code;
  const isInterstate = isInterstateSupply(settings.state_code, placeOfSupply);
  const cm = currentMonth();

  try {
    const result = db.transaction(() => {
      // ---- Resolve every requested item to concrete batches -----------------
      const prepared: PreparedLine[] = [];

      for (const item of d.items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1')
          .get(item.product_id) as Product | undefined;
        if (!product) throw new HttpError(404, `Product #${item.product_id} not found`);

        const discountPct = Math.min(100, item.discount_pct + d.overall_discount_pct);

        if (item.batch_id) {
          // Pharmacist picked a specific batch.
          const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND product_id = ?')
            .get(item.batch_id, item.product_id) as Batch | undefined;
          if (!batch) throw new HttpError(404, `Batch not found for ${product.name}`);
          if (batch.expiry < cm) {
            throw new HttpError(400,
              `${product.name} batch ${batch.batch_no} expired in ${batch.expiry} and cannot be sold`);
          }
          if (batch.qty_units < item.qty_units) {
            throw new HttpError(400,
              `Only ${batch.qty_units} ${product.unit} left in ${product.name} batch ${batch.batch_no}`);
          }
          prepared.push(makeLine(product, batch, item.qty_units, discountPct, isInterstate));
        } else {
          // Auto-allocate earliest-expiring stock first.
          const batches = db.prepare(
            `SELECT * FROM batches
              WHERE product_id = ? AND qty_units > 0 AND active = 1 AND expiry >= ?
              ORDER BY expiry, id`,
          ).all(item.product_id, cm) as Batch[];

          let allocations;
          try {
            allocations = allocateFefo(batches, item.qty_units, cm);
          } catch (err) {
            if (err instanceof InsufficientStockError) {
              throw new HttpError(400,
                `Not enough stock of ${product.name}: ${err.available} ${product.unit} available, ${err.requested} requested`);
            }
            throw err;
          }
          for (const alloc of allocations) {
            const batch = batches.find((b) => b.id === alloc.batchId)!;
            prepared.push(makeLine(product, batch, alloc.qtyUnits, discountPct, isInterstate));
          }
        }
      }

      // ---- Compliance gates -------------------------------------------------
      const rxItems = prepared.filter((p) => requiresPrescription(p.product.schedule_type));
      const h1Items = prepared.filter((p) => requiresH1Register(p.product.schedule_type));

      if (rxItems.length > 0 && !d.doctor_id) {
        const names = [...new Set(rxItems.map((p) => `${p.product.name} (Schedule ${p.product.schedule_type})`))];
        throw new HttpError(400,
          `A prescriber must be recorded for prescription-only medicine: ${names.join(', ')}`);
      }

      if (h1Items.length > 0) {
        // Schedule H1/X may only be dispensed by a registered pharmacist, and the
        // register demands the patient's name and address.
        if (user.role === 'cashier') {
          throw new HttpError(403,
            'Schedule H1 medicines must be dispensed by a registered pharmacist');
        }
        if (!d.patient_name.trim()) {
          throw new HttpError(400, 'Patient name is required for Schedule H1 medicines');
        }
        if (!d.patient_address.trim()) {
          throw new HttpError(400, 'Patient address is required for Schedule H1 medicines');
        }
      }

      let doctor: { name: string; address: string; reg_no: string } | undefined;
      if (d.doctor_id) {
        doctor = db.prepare('SELECT name, address, reg_no FROM doctors WHERE id = ?')
          .get(d.doctor_id) as typeof doctor;
        if (!doctor) throw new HttpError(404, 'Prescriber not found');
      }

      // ---- Totals -----------------------------------------------------------
      const gross = sum(prepared, (p) => p.line.grossPaise);
      const discount = sum(prepared, (p) => p.line.discountPaise);
      const taxable = sum(prepared, (p) => p.line.taxable);
      const cgst = sum(prepared, (p) => p.line.cgst);
      const sgst = sum(prepared, (p) => p.line.sgst);
      const igst = sum(prepared, (p) => p.line.igst);
      const beforeRounding = taxable + cgst + sgst + igst;

      const { adjustment, total } = settings.round_off_enabled
        ? roundOff(beforeRounding)
        : { adjustment: 0, total: beforeRounding };

      // ---- Persist ----------------------------------------------------------
      const invoiceDate = today();
      const fy = financialYear(invoiceDate);
      const seq = nextCounter(db, `invoice:${fy}`);
      const invoiceNo = `${settings.invoice_prefix}/${fy}/${String(seq).padStart(5, '0')}`;
      const ts = nowIso();

      const pharmacistName = user.role === 'cashier' ? settings.pharmacist_name : user.full_name;

      const saleInfo = db.prepare(
        `INSERT INTO sales (invoice_no, invoice_date, customer_id, customer_name, customer_phone,
           customer_gstin, doctor_id, prescription_no, patient_name, patient_address,
           place_of_supply, is_interstate, gross_paise, discount_paise, taxable_paise,
           cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, paid_paise,
           payment_mode, payment_ref, notes, served_by, pharmacist_name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        invoiceNo, ts, d.customer_id, d.customer_name.trim() || 'Cash Customer', d.customer_phone,
        d.customer_gstin.toUpperCase(), d.doctor_id, d.prescription_no, d.patient_name,
        d.patient_address, placeOfSupply, isInterstate ? 1 : 0, gross, discount, taxable,
        cgst, sgst, igst, adjustment, total,
        d.payment_mode === 'CREDIT' ? d.paid_paise : (d.paid_paise || total),
        d.payment_mode, d.payment_ref, d.notes, user.id, pharmacistName, ts,
      );
      const saleId = Number(saleInfo.lastInsertRowid);

      const insertItem = db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, batch_id, product_name, manufacturer,
           hsn_code, schedule_type, batch_no, expiry, pack_size, qty_units, mrp_paise, rate_paise,
           gross_paise, discount_pct, discount_paise, taxable_paise, gst_rate, cgst_paise,
           sgst_paise, igst_paise, total_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const decBatch = db.prepare('UPDATE batches SET qty_units = qty_units - ? WHERE id = ?');
      const insertLedger = db.prepare(
        `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
           qty_in, qty_out, balance_after, note, created_by, created_at)
         VALUES (?,?,'SALE','sales',?,0,?,?,?,?,?)`,
      );
      const insertH1 = db.prepare(
        `INSERT INTO h1_register (serial_no, supply_date, sale_id, sale_item_id, invoice_no,
           prescriber_name, prescriber_address, prescriber_reg_no, patient_name, patient_address,
           drug_name, quantity, manufacturer, batch_no, expiry, pharmacist_name,
           pharmacist_reg_no, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );

      for (const p of prepared) {
        const itemInfo = insertItem.run(
          saleId, p.product.id, p.batch.id, p.product.name, p.product.manufacturer,
          p.product.hsn_code, p.product.schedule_type, p.batch.batch_no, p.batch.expiry,
          p.product.pack_size, p.qtyUnits, p.batch.mrp_paise, p.line.ratePaise,
          p.line.grossPaise, p.discountPct, p.line.discountPaise, p.line.taxable,
          p.product.gst_rate, p.line.cgst, p.line.sgst, p.line.igst, p.line.netPaise,
        );
        const saleItemId = Number(itemInfo.lastInsertRowid);

        decBatch.run(p.qtyUnits, p.batch.id);
        insertLedger.run(
          p.product.id, p.batch.id, saleId, p.qtyUnits,
          p.batch.qty_units - p.qtyUnits, invoiceNo, user.id, ts,
        );

        if (requiresH1Register(p.product.schedule_type)) {
          insertH1.run(
            nextCounter(db, 'h1_register'), invoiceDate, saleId, saleItemId, invoiceNo,
            doctor?.name ?? '', doctor?.address ?? '', doctor?.reg_no ?? '',
            d.patient_name, d.patient_address, p.product.name,
            `${p.qtyUnits} ${p.product.unit}`, p.product.manufacturer, p.batch.batch_no,
            p.batch.expiry, pharmacistName, user.role === 'cashier' ? settings.pharmacist_reg_no : '',
            ts,
          );
        }
      }

      return { saleId, invoiceNo, total };
    })();

    audit(user.id, user.username, 'CREATE_SALE', 'sales', result.saleId, result.invoiceNo);
    res.status(201).json(getFullSale(result.saleId));
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[sales] failed to create invoice:', err);
    res.status(500).json({ error: 'Could not save the bill. Nothing was charged — please retry.' });
  }
});

/** Paginated invoice list with date, customer and text filters. */
salesRouter.get('/', (req, res) => {
  const db = getDb();
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  const q = String(req.query.q ?? '').trim();
  const status = String(req.query.status ?? '');
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Number(req.query.offset) || 0;

  const where: string[] = [];
  const params: unknown[] = [];
  if (from) { where.push('date(s.invoice_date) >= ?'); params.push(from); }
  if (to) { where.push('date(s.invoice_date) <= ?'); params.push(to); }
  if (status) { where.push('s.status = ?'); params.push(status); }
  if (q) {
    where.push('(s.invoice_no LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(
    `SELECT s.*, u.full_name AS served_by_name,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
       FROM sales s LEFT JOIN users u ON u.id = s.served_by
       ${clause} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);

  const totals = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status='COMPLETED' THEN total_paise END),0) AS total_paise
       FROM sales s ${clause}`,
  ).get(...params);

  res.json({ rows, totals });
});

salesRouter.get('/:id', (req, res) => {
  const sale = getFullSale(Number(req.params.id));
  if (!sale) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  res.json(sale);
});

/**
 * Cancel an invoice and return every dispensed unit to its original batch.
 * Restricted to pharmacists/admins — a cashier must not be able to void a bill
 * after taking cash.
 */
salesRouter.post('/:id/cancel', requireRole('pharmacist'), (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) {
    res.status(400).json({ error: 'A reason is required to cancel a bill' });
    return;
  }
  const db = getDb();
  const user = req.user!;

  try {
    db.transaction(() => {
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as Sale | undefined;
      if (!sale) throw new HttpError(404, 'Invoice not found');
      if (sale.status === 'CANCELLED') throw new HttpError(400, 'This bill is already cancelled');

      const returned = db.prepare('SELECT COUNT(*) c FROM sale_returns WHERE sale_id = ?')
        .get(id) as { c: number };
      if (returned.c > 0) {
        throw new HttpError(400,
          'This bill already has a credit note against it — cancel the return first');
      }

      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id) as SaleItem[];
      const ts = nowIso();
      for (const item of items) {
        db.prepare('UPDATE batches SET qty_units = qty_units + ? WHERE id = ?')
          .run(item.qty_units, item.batch_id);
        const balance = (db.prepare('SELECT qty_units FROM batches WHERE id = ?')
          .get(item.batch_id) as { qty_units: number }).qty_units;
        db.prepare(
          `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
             qty_in, qty_out, balance_after, note, created_by, created_at)
           VALUES (?,?,'SALE_CANCEL','sales',?,?,0,?,?,?,?)`,
        ).run(item.product_id, item.batch_id, id, item.qty_units, balance,
          `Cancelled ${sale.invoice_no}: ${reason}`, user.id, ts);
      }

      db.prepare("UPDATE sales SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?")
        .run(reason, id);
      // The H1 register is a statutory record: the entry stays, annotated.
      db.prepare(
        "UPDATE h1_register SET quantity = quantity || ' [BILL CANCELLED]' WHERE sale_id = ?",
      ).run(id);

      audit(user.id, user.username, 'CANCEL_SALE', 'sales', id, `${sale.invoice_no}: ${reason}`);
    })();
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[sales] cancel failed:', err);
    res.status(500).json({ error: 'Could not cancel the bill' });
  }
});

// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function sum<T>(items: T[], pick: (t: T) => number): number {
  return items.reduce((acc, t) => acc + pick(t), 0);
}

function makeLine(
  product: Product, batch: Batch, qtyUnits: number, discountPct: number, isInterstate: boolean,
): PreparedLine {
  const line = computeLine({
    qtyUnits,
    saleRatePerPackPaise: batch.sale_rate_paise,
    packSize: product.pack_size,
    discountPct,
    gstRate: product.gst_rate,
    isInterstate,
  });
  return { product, batch, qtyUnits, discountPct, line };
}

export function getFullSale(id: number) {
  const db = getDb();
  const sale = db.prepare(
    `SELECT s.*, u.full_name AS served_by_name, d.name AS doctor_name,
            d.qualification AS doctor_qualification, d.reg_no AS doctor_reg_no
       FROM sales s
       LEFT JOIN users u ON u.id = s.served_by
       LEFT JOIN doctors d ON d.id = s.doctor_id
      WHERE s.id = ?`,
  ).get(id);
  if (!sale) return null;

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id);
  const returns = db.prepare('SELECT * FROM sale_returns WHERE sale_id = ? ORDER BY id').all(id);
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  return { ...(sale as object), items, returns, settings };
}
