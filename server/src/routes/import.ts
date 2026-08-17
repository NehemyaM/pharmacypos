/**
 * Bulk import of the product list and opening stock.
 *
 * A medical store carries two to four thousand lines. Typing them in one at a
 * time is not a realistic way to open the shop, and it is the single thing that
 * stands between this software and a real counter. Distributors and the shop's
 * previous software can both produce a spreadsheet, so that is the input.
 *
 * Two rules shape the design:
 *
 * 1. **Nothing is written until the whole file is valid.** A half-imported
 *    price list is worse than no import — the shop cannot tell which lines
 *    landed, and re-running it would double the stock that did. Preview first,
 *    then one transaction.
 *
 * 2. **Re-running the same file must not double stock.** An opening balance is
 *    a one-off statement of what is on the shelf, so a batch that already
 *    exists is reported and left alone rather than topped up. Importing the
 *    same file twice is therefore safe, which matters because the first attempt
 *    usually fails somewhere and gets fixed and re-uploaded.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso, currentMonth } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseCsvTable, toCsv } from '../lib/csv.js';
import { rupeesToPaise } from '../lib/money.js';
import { audit } from '../lib/audit.js';
import type { Product } from '../types.js';

export const importRouter = Router();

// Setting up the shop's catalogue is an owner's job, not a counter task.
importRouter.use(requireAuth, requireRole('admin'));

const SCHEDULES = ['OTC', 'G', 'H', 'H1', 'X', 'C', 'C1'] as const;
const GST_RATES = [0, 5, 12, 18, 28];

/**
 * Accepted column headings, most specific first.
 *
 * Matched through headerKey(), so case, spaces, underscores and hyphens are all
 * equivalent — a distributor's "Pack Size", the old software's "PACK_SIZE" and
 * a hand-typed "packsize" are the same column.
 */
const COLUMNS: Record<string, string[]> = {
  name: ['name', 'productname', 'itemname', 'brandname', 'product', 'item', 'description'],
  generic_name: ['genericname', 'generic', 'composition', 'salt', 'molecule', 'content'],
  manufacturer: ['manufacturer', 'company', 'mfr', 'mfg', 'companyname', 'brand'],
  category: ['category', 'group', 'type'],
  schedule_type: ['scheduletype', 'schedule', 'drugschedule'],
  hsn_code: ['hsncode', 'hsn', 'hsnsac'],
  gst_rate: ['gstrate', 'gst', 'gst%', 'taxrate', 'tax', 'gstpercent'],
  unit: ['unit', 'uom', 'baseunit'],
  pack_size: ['packsize', 'pack', 'qtyperpack', 'unitsperpack', 'strip'],
  pack_label: ['packlabel', 'packing', 'packdescription'],
  barcode: ['barcode', 'ean', 'upc'],
  rack: ['rack', 'shelf', 'location', 'binlocation'],
  reorder_level: ['reorderlevel', 'reorder', 'minstock', 'minimumstock'],

  batch_no: ['batchno', 'batch', 'batchnumber', 'lot', 'lotno'],
  expiry: ['expiry', 'expirydate', 'exp', 'expdate', 'expiresat'],
  mrp: ['mrp', 'mrpperpack', 'printedmrp', 'retailprice'],
  purchase_rate: ['purchaserate', 'ptr', 'rate', 'costprice', 'purchaseprice', 'tradeprice'],
  sale_rate: ['salerate', 'sellingrate', 'sellingprice', 'saleprice'],
  qty_packs: ['qtypacks', 'packs', 'qty', 'quantity', 'stock', 'openingstock', 'boxes'],
  qty_units: ['qtyunits', 'units', 'looseunits', 'loose', 'tablets'],
};

/** The stock block is only expected when at least one of these is filled in. */
const STOCK_FIELDS = ['batch_no', 'expiry', 'mrp', 'purchase_rate', 'sale_rate', 'qty_packs', 'qty_units'];

type Message = { level: 'error' | 'warning'; text: string };

type ParsedRow = {
  line: number;
  /** 'create' / 'update' for the product; 'skip' when the row cannot be used. */
  action: 'create' | 'update' | 'skip';
  product: {
    id?: number;
    name: string;
    generic_name: string;
    manufacturer: string;
    category: string;
    schedule_type: string;
    hsn_code: string;
    gst_rate: number;
    unit: string;
    pack_size: number;
    pack_label: string;
    barcode: string;
    rack: string;
    reorder_level: number;
  };
  stock: {
    batch_no: string;
    expiry: string;
    mrp_paise: number;
    purchase_rate_paise: number;
    sale_rate_paise: number;
    qty_units: number;
    /** True when this batch is already on the shelf, so it must not be added again. */
    already_present: boolean;
  } | null;
  messages: Message[];
};

/** Resolve a value from a record using the aliases for a logical field. */
function pick(record: Record<string, string>, field: string): string {
  for (const alias of COLUMNS[field] ?? []) {
    const v = record[alias];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

/**
 * Normalise the many ways an expiry is written to 'YYYY-MM'.
 *
 * Distributor files use every one of these, and a wrong guess would put stock
 * on the shelf with the wrong expiry — which FEFO then dispenses in the wrong
 * order. Anything ambiguous is refused rather than guessed at.
 */
export function normaliseExpiry(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  const inRange = (y: number, m: number) =>
    y >= 2000 && y <= 2099 && m >= 1 && m <= 12
      ? `${y}-${String(m).padStart(2, '0')}`
      : null;

  // 2028-06, 2028/06, 2028-06-30 — year first, so unambiguous.
  let m = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(s);
  if (m) return inRange(Number(m[1]), Number(m[2]));

  // 06-2028, 6/2028 — month first with a four-digit year.
  m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return inRange(Number(m[2]), Number(m[1]));

  // 06-28, 6/28 — two-digit year, taken as 20xx. Drug expiries are in the
  // future, so there is no 19xx case to worry about.
  m = /^(\d{1,2})[-/](\d{2})$/.exec(s);
  if (m) return inRange(2000 + Number(m[2]), Number(m[1]));

  // JUN-2028, Jun 28, JUNE/2028
  m = /^([A-Za-z]{3,9})[-/ ]?(\d{2,4})$/.exec(s);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const idx = months.indexOf(m[1].slice(0, 3).toLowerCase());
    if (idx === -1) return null;
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    return inRange(year, idx + 1);
  }

  // 202806
  m = /^(\d{4})(\d{2})$/.exec(s);
  if (m) return inRange(Number(m[1]), Number(m[2]));

  return null;
}

/** Rupees as typed by a human to integer paise, or null if it is not a number. */
function money(raw: string): number | null {
  const s = raw.replace(/[₹,\s]/g, '');
  if (!s) return null;
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  try {
    return rupeesToPaise(s);
  } catch {
    return null;
  }
}

function integer(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, '');
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Turn the file into rows ready to write, annotated with everything wrong.
 *
 * Reads the database to decide create-vs-update and to spot batches already on
 * the shelf, but writes nothing.
 */
function analyse(csv: string) {
  const db = getDb();
  const { headers, records, lineNumbers } = parseCsvTable(csv);

  const nameColumnPresent = headers.some((h) =>
    COLUMNS.name.includes(h.trim().toLowerCase().replace(/[\s_-]+/g, '')));

  const rows: ParsedRow[] = [];
  const cm = currentMonth();

  // Existing products, keyed the two ways a file can identify one.
  const existing = db.prepare(
    'SELECT id, name, manufacturer, barcode, pack_size FROM products',
  ).all() as Array<Pick<Product, 'id' | 'name' | 'manufacturer' | 'barcode' | 'pack_size'>>;

  const byBarcode = new Map<string, typeof existing[number]>();
  const byNameMfr = new Map<string, typeof existing[number]>();
  const key = (name: string, mfr: string) => `${name.trim().toLowerCase()}|${mfr.trim().toLowerCase()}`;
  for (const p of existing) {
    if (p.barcode) byBarcode.set(p.barcode, p);
    byNameMfr.set(key(p.name, p.manufacturer), p);
  }

  const existingBatch = db.prepare(
    'SELECT 1 FROM batches WHERE product_id = ? AND batch_no = ? AND expiry = ?',
  );

  // Rows already seen in this file, so a duplicate is reported rather than
  // silently applied twice.
  const seenProducts = new Map<string, number>();
  const seenBatches = new Map<string, number>();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const line = lineNumbers[i];
    const messages: Message[] = [];
    const err = (text: string) => messages.push({ level: 'error', text });
    const warn = (text: string) => messages.push({ level: 'warning', text });

    const name = pick(record, 'name').trim();
    if (!name) {
      err('No product name in this row');
      rows.push({ line, action: 'skip', product: blankProduct(), stock: null, messages });
      continue;
    }

    const manufacturer = pick(record, 'manufacturer');
    const barcode = pick(record, 'barcode');

    const match = (barcode && byBarcode.get(barcode)) || byNameMfr.get(key(name, manufacturer));

    // --- product fields ------------------------------------------------------
    const scheduleRaw = pick(record, 'schedule_type').toUpperCase().replace(/^SCHEDULE\s*/, '');
    let schedule_type = scheduleRaw || 'OTC';
    if (!SCHEDULES.includes(schedule_type as typeof SCHEDULES[number])) {
      err(`Schedule "${scheduleRaw}" is not one of ${SCHEDULES.join(', ')}`);
      schedule_type = 'OTC';
    }

    const gstRaw = pick(record, 'gst_rate').replace('%', '');
    let gst_rate = gstRaw === '' ? 5 : Number(gstRaw);
    if (!Number.isInteger(gst_rate) || !GST_RATES.includes(gst_rate)) {
      err(`GST rate "${gstRaw}" is not one of ${GST_RATES.join('/')}%`);
      gst_rate = 5;
    }

    const hsn_code = pick(record, 'hsn_code') || '3004';
    // 12% was withdrawn for medicines with effect from 22 September 2025. It is
    // still correct for devices and consumables, so this is a warning.
    if (gst_rate === 12 && hsn_code.startsWith('30')) {
      warn('12% GST no longer applies to medicines (withdrawn 22-Sep-2025) — check this should not be 5%');
    }

    const packRaw = pick(record, 'pack_size');
    let pack_size = packRaw === '' ? 1 : (integer(packRaw) ?? 0);
    if (pack_size <= 0) {
      err(`Pack size "${packRaw}" must be a whole number of 1 or more`);
      pack_size = 1;
    }
    if (match && packRaw !== '' && pack_size !== match.pack_size) {
      warn(`Pack size changes from ${match.pack_size} to ${pack_size}; existing stock of this product is counted in the old size`);
    }

    const reorderRaw = pick(record, 'reorder_level');
    let reorder_level = reorderRaw === '' ? 0 : (integer(reorderRaw) ?? -1);
    if (reorder_level < 0) {
      err(`Reorder level "${reorderRaw}" must be a whole number of 0 or more`);
      reorder_level = 0;
    }

    const product = {
      id: match?.id,
      name,
      generic_name: pick(record, 'generic_name'),
      manufacturer,
      category: pick(record, 'category') || 'GENERAL',
      schedule_type,
      hsn_code,
      gst_rate,
      unit: (pick(record, 'unit') || 'TAB').toUpperCase(),
      pack_size,
      pack_label: pick(record, 'pack_label'),
      barcode,
      rack: pick(record, 'rack'),
      reorder_level,
    };

    const dupProduct = seenProducts.get(key(name, manufacturer));
    if (dupProduct) {
      warn(`Same product as line ${dupProduct}; the later row's details win`);
    }
    seenProducts.set(key(name, manufacturer), line);

    // --- opening stock -------------------------------------------------------
    const wantsStock = STOCK_FIELDS.some((f) => pick(record, f) !== '');
    let stock: ParsedRow['stock'] = null;

    if (wantsStock) {
      const batch_no = pick(record, 'batch_no');
      if (!batch_no) err('Opening stock needs a batch number — it is required on every invoice line');

      const expiryRaw = pick(record, 'expiry');
      const expiry = normaliseExpiry(expiryRaw);
      if (!expiryRaw) err('Opening stock needs an expiry');
      else if (!expiry) err(`Expiry "${expiryRaw}" is not a date — use YYYY-MM, MM/YYYY or JUN-2028`);
      else if (expiry < cm) err(`Expiry ${expiry} has already passed — expired stock must not be taken in`);

      const mrp_paise = money(pick(record, 'mrp'));
      if (mrp_paise === null) err(`MRP "${pick(record, 'mrp')}" is not an amount`);
      else if (mrp_paise <= 0) err('MRP must be more than zero');

      const purchase_rate_paise = money(pick(record, 'purchase_rate')) ?? 0;
      if (purchase_rate_paise < 0) err('Purchase rate cannot be negative');

      const sale_rate_paise = money(pick(record, 'sale_rate')) ?? mrp_paise ?? 0;
      if (mrp_paise !== null && sale_rate_paise > mrp_paise) {
        err('Selling rate is above the printed MRP — that is an offence under Legal Metrology');
      }

      // Cost is quoted ex-GST; MRP includes it. Compare like with like.
      if (mrp_paise !== null && purchase_rate_paise > 0) {
        const exGstMrp = (mrp_paise * 100) / (100 + gst_rate);
        if (purchase_rate_paise > exGstMrp) {
          warn(`Cost ₹${(purchase_rate_paise / 100).toFixed(2)} exceeds the MRP net of GST (₹${(exGstMrp / 100).toFixed(2)}) — this line sells at a loss`);
        }
      }

      const packs = integer(pick(record, 'qty_packs')) ?? 0;
      const loose = integer(pick(record, 'qty_units')) ?? 0;
      if (packs < 0 || loose < 0) err('Quantity cannot be negative');
      const qty_units = packs * pack_size + loose;
      if (qty_units <= 0) err('Opening stock needs a quantity of at least one');

      let already_present = false;
      if (batch_no && expiry) {
        const batchKey = `${key(name, manufacturer)}|${batch_no.toLowerCase()}|${expiry}`;
        const dupBatch = seenBatches.get(batchKey);
        if (dupBatch) {
          err(`Batch ${batch_no} of ${name} is also on line ${dupBatch} — combine them into one row`);
        }
        seenBatches.set(batchKey, line);

        if (match && existingBatch.get(match.id, batch_no, expiry)) {
          already_present = true;
          warn(`Batch ${batch_no} is already in stock — its quantity is left as it is, so re-importing cannot double it`);
        }
      }

      stock = {
        batch_no,
        expiry: expiry ?? '',
        mrp_paise: mrp_paise ?? 0,
        purchase_rate_paise,
        sale_rate_paise,
        qty_units,
        already_present,
      };
    }

    rows.push({
      line,
      action: messages.some((m) => m.level === 'error') ? 'skip' : match ? 'update' : 'create',
      product,
      stock,
      messages,
    });
  }

  const errorCount = rows.reduce((n, r) => n + r.messages.filter((m) => m.level === 'error').length, 0);
  const warningCount = rows.reduce((n, r) => n + r.messages.filter((m) => m.level === 'warning').length, 0);
  const writable = rows.filter((r) => r.action !== 'skip');
  const newBatches = writable.filter((r) => r.stock && !r.stock.already_present);

  return {
    rows,
    nameColumnPresent,
    headers,
    summary: {
      rows: rows.length,
      products_new: writable.filter((r) => r.action === 'create').length,
      products_updated: writable.filter((r) => r.action === 'update').length,
      batches_new: newBatches.length,
      batches_already_present: writable.filter((r) => r.stock?.already_present).length,
      units: newBatches.reduce((n, r) => n + (r.stock?.qty_units ?? 0), 0),
      /** Opening stock valued at cost, for the owner to sanity-check against their own figure. */
      stock_value_paise: newBatches.reduce((n, r) => {
        const s = r.stock!;
        const perUnit = s.purchase_rate_paise / Math.max(1, r.product.pack_size);
        return n + Math.round(perUnit * s.qty_units);
      }, 0),
      errors: errorCount,
      warnings: warningCount,
    },
  };
}

function blankProduct(): ParsedRow['product'] {
  return {
    name: '', generic_name: '', manufacturer: '', category: 'GENERAL', schedule_type: 'OTC',
    hsn_code: '3004', gst_rate: 5, unit: 'TAB', pack_size: 1, pack_label: '', barcode: '',
    rack: '', reorder_level: 0,
  };
}

const importSchema = z.object({
  csv: z.string().min(1, 'The file is empty'),
  /** False (the default) previews without writing anything. */
  commit: z.boolean().default(false),
});

importRouter.post('/products', (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const result = analyse(parsed.data.csv);

  if (result.rows.length === 0) {
    res.status(400).json({
      error: result.headers.length === 0
        ? 'That file has no rows in it'
        : 'That file has a header row but no products under it',
    });
    return;
  }
  if (!result.nameColumnPresent) {
    res.status(400).json({
      error: `No product name column found. Expected one of: ${COLUMNS.name.join(', ')}. `
        + `The file has: ${result.headers.join(', ')}`,
    });
    return;
  }

  if (!parsed.data.commit) {
    res.json({ committed: false, ...result });
    return;
  }

  // All or nothing: a partially imported catalogue cannot be reasoned about.
  if (result.summary.errors > 0) {
    res.status(400).json({
      error: `${result.summary.errors} problem${result.summary.errors === 1 ? '' : 's'} in the file — nothing was imported. Fix the rows listed and upload it again.`,
      committed: false,
      ...result,
    });
    return;
  }

  const db = getDb();
  const user = req.user!;
  const ts = nowIso();

  try {
    const written = db.transaction(() => {
      let created = 0, updated = 0, batches = 0, units = 0;

      const insertProduct = db.prepare(
        `INSERT INTO products (name, generic_name, manufacturer, category, schedule_type, hsn_code,
           gst_rate, unit, pack_size, pack_label, barcode, rack, reorder_level, cold_chain,
           allow_loose, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,1,?,?)`,
      );
      const updateProduct = db.prepare(
        `UPDATE products SET name=?, generic_name=?, manufacturer=?, category=?, schedule_type=?,
           hsn_code=?, gst_rate=?, unit=?, pack_size=?, pack_label=?, barcode=?, rack=?,
           reorder_level=?, active=1, updated_at=? WHERE id=?`,
      );
      const insertBatch = db.prepare(
        `INSERT INTO batches (product_id, batch_no, expiry, mrp_paise, purchase_rate_paise,
           sale_rate_paise, qty_units, supplier_id, received_at, created_at)
         VALUES (?,?,?,?,?,?,?,NULL,?,?)`,
      );
      // 'OPENING' is not one of the ledger's transaction types, and widening a
      // CHECK constraint means rebuilding the table. An opening balance is an
      // adjustment against a zero start, so record it as one and say where it
      // came from in the note.
      const insertLedger = db.prepare(
        `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
           qty_in, qty_out, balance_after, note, created_by, created_at)
         VALUES (?,?,'ADJUSTMENT','product_import',NULL,?,0,?,?,?,?)`,
      );

      for (const row of result.rows) {
        if (row.action === 'skip') continue;
        const p = row.product;

        let productId: number;
        if (p.id) {
          updateProduct.run(p.name, p.generic_name, p.manufacturer, p.category, p.schedule_type,
            p.hsn_code, p.gst_rate, p.unit, p.pack_size, p.pack_label, p.barcode, p.rack,
            p.reorder_level, ts, p.id);
          productId = p.id;
          updated++;
        } else {
          const info = insertProduct.run(p.name, p.generic_name, p.manufacturer, p.category,
            p.schedule_type, p.hsn_code, p.gst_rate, p.unit, p.pack_size, p.pack_label,
            p.barcode, p.rack, p.reorder_level, ts, ts);
          productId = Number(info.lastInsertRowid);
          created++;
        }

        const s = row.stock;
        if (!s || s.already_present) continue;

        const batchInfo = insertBatch.run(productId, s.batch_no, s.expiry, s.mrp_paise,
          s.purchase_rate_paise, s.sale_rate_paise, s.qty_units, ts.slice(0, 10), ts);
        insertLedger.run(productId, Number(batchInfo.lastInsertRowid), s.qty_units, s.qty_units,
          'Opening stock (imported)', user.id, ts);
        batches++;
        units += s.qty_units;
      }

      return { created, updated, batches, units };
    })();

    audit(user.id, user.username, 'IMPORT_PRODUCTS', 'products', null,
      `${written.created} new, ${written.updated} updated, ${written.batches} batches, ${written.units} units`);

    res.json({ committed: true, written, ...result });
  } catch (err) {
    console.error('[import] failed:', err);
    res.status(500).json({
      error: 'The import failed and nothing was saved. Your catalogue is unchanged.',
    });
  }
});

/**
 * A starter file with the headings this importer understands and two worked
 * examples — one prescription medicine with stock, one over-the-counter line.
 */
importRouter.get('/products/template', (_req, res) => {
  type Row = Record<string, string | number>;
  const rows: Row[] = [
    {
      name: 'Dolo 650 Tablet', generic_name: 'Paracetamol 650mg', manufacturer: 'Micro Labs Ltd',
      category: 'ANALGESIC', schedule_type: 'OTC', hsn_code: '3004', gst_rate: 5, unit: 'TAB',
      pack_size: 15, pack_label: 'Strip of 15 tablets', barcode: '', rack: 'A1', reorder_level: 150,
      batch_no: 'DL24A17', expiry: '2028-06', mrp: 34.50, purchase_rate: 26.30, sale_rate: 34.50,
      qty_packs: 20, qty_units: 0,
    },
    {
      name: 'Azithral 500 Tablet', generic_name: 'Azithromycin 500mg', manufacturer: 'Alembic Ltd',
      category: 'ANTIBIOTIC', schedule_type: 'H1', hsn_code: '3004', gst_rate: 5, unit: 'TAB',
      pack_size: 5, pack_label: 'Strip of 5 tablets', barcode: '', rack: 'B3', reorder_level: 25,
      batch_no: 'AZ7712', expiry: 'JUN-2027', mrp: 132.00, purchase_rate: 100.60, sale_rate: 132.00,
      qty_packs: 8, qty_units: 0,
    },
    {
      name: 'Dettol Antiseptic Liquid 110ml', generic_name: 'Chloroxylenol 4.8% w/v',
      manufacturer: 'Reckitt Benckiser', category: 'ANTISEPTIC', schedule_type: 'OTC',
      hsn_code: '3808', gst_rate: 18, unit: 'BOTTLE', pack_size: 1, pack_label: '110 ml bottle',
      barcode: '8901396324454', rack: 'D2', reorder_level: 6,
      batch_no: 'DT2611', expiry: '11/2027', mrp: 75.00, purchase_rate: 53.80, sale_rate: 75.00,
      qty_packs: 12, qty_units: 0,
    },
  ];

  const csv = toCsv(rows, [
    { header: 'name', value: (r) => r.name },
    { header: 'generic_name', value: (r) => r.generic_name },
    { header: 'manufacturer', value: (r) => r.manufacturer },
    { header: 'category', value: (r) => r.category },
    { header: 'schedule_type', value: (r) => r.schedule_type },
    { header: 'hsn_code', value: (r) => r.hsn_code },
    { header: 'gst_rate', value: (r) => r.gst_rate },
    { header: 'unit', value: (r) => r.unit },
    { header: 'pack_size', value: (r) => r.pack_size },
    { header: 'pack_label', value: (r) => r.pack_label },
    { header: 'barcode', value: (r) => r.barcode },
    { header: 'rack', value: (r) => r.rack },
    { header: 'reorder_level', value: (r) => r.reorder_level },
    { header: 'batch_no', value: (r) => r.batch_no },
    { header: 'expiry', value: (r) => r.expiry },
    { header: 'mrp', value: (r) => r.mrp },
    { header: 'purchase_rate', value: (r) => r.purchase_rate },
    { header: 'sale_rate', value: (r) => r.sale_rate },
    { header: 'qty_packs', value: (r) => r.qty_packs },
    { header: 'qty_units', value: (r) => r.qty_units },
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="product-import-template.csv"');
  res.send(csv);
});
