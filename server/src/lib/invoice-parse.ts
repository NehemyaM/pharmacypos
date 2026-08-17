/**
 * Turn OCR output into candidate goods-inward lines.
 *
 * The engine's own idea of reading order is useless on a bordered table — it
 * reads cell separators as text and interleaves columns, so a line comes back as
 * `5 [mmwaseme [5 [mawm [wm | 8] eo]`. Every word does come back with a bounding
 * box, though, and those are accurate even when the transcription order is not.
 * So the layout is rebuilt from geometry: cluster words into rows by their
 * vertical centre, read the header row to learn where each column sits
 * horizontally, then drop every later word into the column it physically falls
 * under.
 *
 * Nothing here trusts the result. Each field carries the confidence the engine
 * reported, and anything doubtful is flagged for the pharmacist rather than
 * quietly accepted — a misread expiry is the difference between refusing a
 * batch and selling it.
 */

export type OcrWord = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
};

/** One row of the invoice, as read. */
export type ScannedRow = {
  y: number;
  words: OcrWord[];
  text: string;
};

export type ScannedLine = {
  /** Position in the scan, 1-based — the reviewer's reference. */
  line_no: number;
  /** The row exactly as read, so a reviewer can compare against the picture. */
  raw: string;
  product_name: string;
  pack_size: number | null;
  batch_no: string;
  /** YYYY-MM, or '' when nothing date-shaped was found. */
  expiry: string;
  qty_packs: number | null;
  free_packs: number | null;
  mrp_paise: number | null;
  purchase_rate_paise: number | null;
  gst_rate: number | null;
  /** Lowest word confidence on the row, 0-100. */
  confidence: number;
  /** Per-field confidence, so the review screen can highlight the shaky ones. */
  field_confidence: Record<string, number>;
  /** Things a human must look at before this is accepted. */
  warnings: string[];
};

export type ScannedInvoice = {
  supplier_name: string;
  supplier_gstin: string;
  invoice_no: string;
  /** YYYY-MM-DD, or '' if not found. */
  invoice_date: string;
  lines: ScannedLine[];
  /** Rows that looked like line items but could not be parsed at all. */
  skipped: string[];
  /** Mean confidence across the whole page. */
  confidence: number;
};

// ---------------------------------------------------------------------------
// Rows from geometry
// ---------------------------------------------------------------------------

/**
 * Group words into rows by vertical position.
 *
 * The tolerance is derived from the words themselves rather than fixed, because
 * a phone photo and a flatbed scan of the same invoice differ several-fold in
 * pixel height and a constant would split rows on one and merge them on the
 * other.
 */
export function groupIntoRows(words: OcrWord[]): ScannedRow[] {
  const usable = words.filter((w) => w.text.trim() !== '');
  if (usable.length === 0) return [];

  const heights = usable.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  const tolerance = medianHeight * 0.6;

  const sorted = [...usable].sort((a, b) => midY(a) - midY(b) || a.x0 - b.x0);
  const rows: ScannedRow[] = [];

  for (const w of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(midY(w) - last.y) <= tolerance) {
      last.words.push(w);
      // Running mean keeps a slightly sloped row (a photo is never square to
      // the camera) from drifting away from its own centre.
      last.y = last.words.reduce((s, x) => s + midY(x), 0) / last.words.length;
    } else {
      rows.push({ y: midY(w), words: [w], text: '' });
    }
  }

  for (const r of rows) {
    r.words.sort((a, b) => a.x0 - b.x0);
    r.text = r.words.map((w) => w.text).join(' ');
  }
  return rows;
}

const midY = (w: OcrWord) => (w.y0 + w.y1) / 2;
const midX = (w: OcrWord) => (w.x0 + w.x1) / 2;

// ---------------------------------------------------------------------------
// Columns from the header row
// ---------------------------------------------------------------------------

type Column = { key: ColumnKey; x0: number; x1: number };

export type ColumnKey =
  | 'sno' | 'product' | 'pack' | 'batch' | 'expiry'
  | 'qty' | 'free' | 'mrp' | 'rate' | 'gst' | 'amount';

/**
 * What distributors actually print above each column.
 *
 * Longer, more specific terms come first so "batch no" is not matched as "no",
 * and every entry is matched against a lower-cased, punctuation-stripped word.
 */
const HEADER_TERMS: Array<[ColumnKey, string[]]> = [
  ['sno', ['sno', 'sr', 'srno', 'slno', 'sl', 's']],
  ['product', ['product', 'particulars', 'description', 'item', 'itemname', 'productname', 'goods', 'name']],
  ['pack', ['pack', 'packing', 'packsize', 'unit']],
  ['batch', ['batch', 'batchno', 'bno', 'lot', 'lotno']],
  ['expiry', ['exp', 'expiry', 'expdt', 'expdate', 'expiredate', 'edate']],
  ['qty', ['qty', 'quantity', 'nos', 'noofpacks']],
  ['free', ['free', 'fqty', 'freeqty', 'scheme', 'sch']],
  ['mrp', ['mrp', 'mrprs', 'retail']],
  ['rate', ['rate', 'ptr', 'purchaserate', 'price', 'netrate', 'prate']],
  ['gst', ['gst', 'gstpct', 'tax', 'igst', 'cgst', 'gstrate', 'vat']],
  ['amount', ['amount', 'amt', 'value', 'total', 'netamount', 'netamt']],
];

const normaliseHeader = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

function classifyHeaderWord(text: string): ColumnKey | null {
  const n = normaliseHeader(text);
  if (!n) return null;
  for (const [key, terms] of HEADER_TERMS) {
    if (terms.includes(n)) return key;
  }
  return null;
}

/**
 * Find the row that labels the columns, and where each column sits.
 *
 * The header is the row with the most recognisable column names — not simply
 * the first, because the shop's name and address sit above it and often contain
 * a stray "No" or "Item".
 *
 * Where each column *sits* cannot be taken from the header words themselves.
 * Printers centre a label over its column while the values beneath are
 * left-aligned, so "Product" may begin a hundred pixels right of the product
 * names under it; splitting on the gap between header words swallowed the first
 * word of every product name into the serial-number column. The boundaries are
 * therefore read off the data: project every word in the table onto the
 * horizontal axis, and the columns are the bands of ink separated by the
 * whitespace the printer left between them. The header is then only used to say
 * which band is which.
 */
export function findColumns(rows: ScannedRow[]): { headerIndex: number; columns: Column[] } | null {
  let best: { index: number; keyed: Array<{ key: ColumnKey; centre: number }> } | null = null;

  rows.forEach((row, index) => {
    const keyed: Array<{ key: ColumnKey; centre: number }> = [];
    for (const w of row.words) {
      const key = classifyHeaderWord(w.text);
      // A column name repeated on one row means the guess is wrong somewhere;
      // keep the first, which is nearly always the real one.
      if (key && !keyed.some((c) => c.key === key)) keyed.push({ key, centre: midX(w) });
    }
    if (keyed.length > (best?.keyed.length ?? 0)) best = { index, keyed };
  });

  // Four labels is the point where a run of coincidences becomes a table. A
  // real line-item header always carries at least product, batch, qty and one
  // of the money columns.
  if (!best) return null;
  const header = best as { index: number; keyed: Array<{ key: ColumnKey; centre: number }> };
  if (header.keyed.length < 4) return null;

  const bands = inkBands(rows.slice(header.index, header.index + 12), header.keyed);

  const columns: Column[] = [];
  for (const { key, centre } of header.keyed) {
    const band = bands.find((b) => centre >= b.x0 && centre <= b.x1);
    if (band) columns.push({ key, x0: band.x0, x1: band.x1 });
  }
  if (columns.length < 4) return null;

  columns.sort((a, b) => a.x0 - b.x0);

  // Close the seams so a word sitting in the gutter still lands somewhere, and
  // let the outermost columns run to the edges of the page.
  return {
    headerIndex: header.index,
    columns: columns.map((c, i) => ({
      key: c.key,
      x0: i === 0 ? -Infinity : (columns[i - 1].x1 + c.x0) / 2,
      x1: i === columns.length - 1 ? Infinity : (c.x1 + columns[i + 1].x0) / 2,
    })),
  };
}

/**
 * The vertical bands of ink in a block of rows.
 *
 * Words are merged into a band while the gap between them is small enough to be
 * a space rather than a column gutter — the threshold comes from the widths of
 * the words themselves, so it holds for a phone photo and a flatbed scan alike.
 *
 * One product name long enough to reach into the next column would otherwise
 * fuse two columns together for every row, so a band is split wherever it
 * covers the centres of two different header labels.
 */
function inkBands(
  rows: ScannedRow[],
  headers: Array<{ key: ColumnKey; centre: number }>,
): Array<{ x0: number; x1: number }> {
  const spans = rows
    .flatMap((r) => r.words)
    .map((w) => ({ x0: w.x0, x1: w.x1, width: w.x1 - w.x0 }))
    .sort((a, b) => a.x0 - b.x0);
  if (spans.length === 0) return [];

  const widths = spans.map((s) => s.width).sort((a, b) => a - b);
  const medianWidth = widths[Math.floor(widths.length / 2)] || 20;
  // A space between words in a name is around a third of a character; a column
  // gutter is far wider. Half a median word is comfortably between the two.
  const gutter = medianWidth * 0.5;

  const bands: Array<{ x0: number; x1: number }> = [];
  for (const s of spans) {
    const last = bands[bands.length - 1];
    if (last && s.x0 - last.x1 <= gutter) last.x1 = Math.max(last.x1, s.x1);
    else bands.push({ x0: s.x0, x1: s.x1 });
  }

  // Split any band that has run across two columns.
  const split: Array<{ x0: number; x1: number }> = [];
  for (const band of bands) {
    const inside = headers
      .filter((h) => h.centre >= band.x0 && h.centre <= band.x1)
      .sort((a, b) => a.centre - b.centre);
    if (inside.length < 2) { split.push(band); continue; }

    let left = band.x0;
    for (let i = 0; i < inside.length - 1; i++) {
      const cut = (inside[i].centre + inside[i + 1].centre) / 2;
      split.push({ x0: left, x1: cut });
      left = cut;
    }
    split.push({ x0: left, x1: band.x1 });
  }
  return split;
}

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Read an expiry as printed and return `YYYY-MM`.
 *
 * Distributors write this every way there is: `09/28`, `09-2028`, `SEP28`,
 * `Sep-28`, `09.28`, sometimes `2028-09`. A two-digit year is always this
 * century — an expiry in 1928 is not a thing.
 */
export function parseExpiry(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;

  // ISO-ish, year first: 2028-09
  const iso = /^(20\d{2})[-/.](\d{1,2})$/.exec(s);
  if (iso) return month(Number(iso[1]), Number(iso[2]));

  // Month name: sep28, sep-2028
  const named = /^([a-z]{3,4})[-/.]?(\d{2}|\d{4})$/.exec(s);
  if (named && MONTHS[named[1]]) return month(year(named[2]), MONTHS[named[1]]);

  // Numeric, month first: 09/28, 9-2028, 09.28
  const numeric = /^(\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (numeric) {
    const m = Number(numeric[1]);
    if (m >= 1 && m <= 12) return month(year(numeric[2]), m);
  }

  // Run together, no separator: 0928 or 092028
  const run = /^(\d{2})(\d{2}|\d{4})$/.exec(s);
  if (run) {
    const m = Number(run[1]);
    if (m >= 1 && m <= 12) return month(year(run[2]), m);
  }

  return null;

  function year(v: string): number {
    return v.length === 4 ? Number(v) : 2000 + Number(v);
  }
  function month(y: number, m: number): string | null {
    if (m < 1 || m > 12 || y < 2000 || y > 2099) return null;
    return `${y}-${String(m).padStart(2, '0')}`;
  }
}

/**
 * Read a rupee amount and return paise.
 *
 * OCR reliably turns commas into full stops and vice versa, so `1,234.50` may
 * arrive as `1.234.50`. The last separator followed by exactly two digits is
 * the decimal point; everything before it is the rupee part with its grouping
 * marks discarded.
 */
export function parseMoneyPaise(raw: string): number | null {
  const s = raw.replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return null;

  const decimal = /^(.*)[.,](\d{2})$/.exec(s);
  if (decimal) {
    const rupees = decimal[1].replace(/[.,]/g, '');
    if (rupees === '') return Number(decimal[2]);
    return Number(rupees) * 100 + Number(decimal[2]);
  }
  const whole = s.replace(/[.,]/g, '');
  if (!whole) return null;
  return Number(whole) * 100;
}

/** A plain count. Rejects anything that is not simply a number. */
export function parseCount(raw: string): number | null {
  const s = raw.replace(/[^\d]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A GST percentage, accepting `5`, `5%`, `5.00`. */
export function parseGstRate(raw: string): number | null {
  const s = raw.replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = Math.round(Number(s));
  return [0, 5, 12, 18, 28].includes(n) ? n : null;
}

/**
 * A batch number, cleaned of the characters OCR adds around cell borders.
 *
 * Deliberately not "corrected" beyond that: 0/O and 1/I are genuinely ambiguous
 * in a batch code and guessing would be worse than showing the reviewer what
 * was read.
 */
export function cleanBatch(raw: string): string {
  return raw.replace(/[|\][}{()]/g, '').replace(/\s+/g, '').toUpperCase().slice(0, 24);
}

// ---------------------------------------------------------------------------
// The whole page
// ---------------------------------------------------------------------------

const GSTIN_IN_TEXT = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/;

/** Parse the invoice header block — everything above the line items. */
function parseHeader(rows: ScannedRow[], headerIndex: number) {
  const above = rows.slice(0, headerIndex).map((r) => r.text);
  const blob = above.join('\n');

  const gstin = GSTIN_IN_TEXT.exec(blob.toUpperCase())?.[1] ?? '';

  // The invoice number is labelled far more consistently than anything else.
  // It must contain a digit: when two labels sit side by side on the page, the
  // words get interleaved by reading order and the next label — "Date" — is
  // otherwise a perfectly good match.
  let invoiceNo = '';
  for (const m of blob.matchAll(
    /(?:invoice|inv|bill)\s*(?:no|number|#)?\s*[:.\-]?\s*([A-Za-z0-9][A-Za-z0-9/\-]{3,})/gi,
  )) {
    const candidate = m[1].trim().replace(/[:.]+$/, '');
    if (/\d/.test(candidate) && !/^(date|dt|dated)$/i.test(candidate)) {
      invoiceNo = candidate;
      break;
    }
  }

  let invoiceDate = '';
  const dm = /(?:date|dt)\s*[:.\-]?\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/i.exec(blob);
  if (dm) {
    const d = Number(dm[1]);
    const m = Number(dm[2]);
    const y = dm[3].length === 4 ? Number(dm[3]) : 2000 + Number(dm[3]);
    // Indian invoices are day-first; a value over 12 in the first position
    // confirms it, and nothing here is ever American.
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      invoiceDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // The supplier's name is the first substantial line of the page.
  const supplierName = above.find((t) => {
    const clean = t.trim();
    return clean.length > 6 && /[A-Za-z]/.test(clean) && !/gstin|invoice|date|^to\b/i.test(clean);
  })?.trim() ?? '';

  return { supplierName, gstin, invoiceNo, invoiceDate };
}

/** Cell text for one column of one row, plus the confidence behind it. */
function cell(row: ScannedRow, columns: Column[], key: ColumnKey) {
  const col = columns.find((c) => c.key === key);
  if (!col) return { text: '', confidence: 0, found: false };
  const words = row.words.filter((w) => midX(w) >= col.x0 && midX(w) < col.x1);
  if (words.length === 0) return { text: '', confidence: 0, found: true };
  return {
    text: words.map((w) => w.text).join(' ').trim(),
    confidence: Math.min(...words.map((w) => w.confidence)),
    found: true,
  };
}

/**
 * Read an invoice from its OCR words.
 *
 * Returns candidates, never facts. Everything is shown to a pharmacist before
 * it can touch stock.
 */
export function parseInvoice(words: OcrWord[], opts: { today?: string } = {}): ScannedInvoice {
  const rows = groupIntoRows(words);
  const meanConfidence = words.length
    ? words.reduce((s, w) => s + w.confidence, 0) / words.length
    : 0;

  const found = findColumns(rows);
  if (!found) {
    return {
      supplier_name: '', supplier_gstin: '', invoice_no: '', invoice_date: '',
      lines: [],
      skipped: rows.map((r) => r.text),
      confidence: meanConfidence,
    };
  }

  const { headerIndex, columns } = found;
  const header = parseHeader(rows, headerIndex);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  const lines: ScannedLine[] = [];
  const skipped: string[] = [];

  for (const row of rows.slice(headerIndex + 1)) {
    // The totals block sits below the items and has no product column; it is
    // recognisable because it talks about tax rather than goods.
    if (/^\s*(taxable|total|cgst|sgst|igst|grand|net|round|amount in words|e\.?&?o\.?e)/i.test(row.text)) {
      continue;
    }

    const product = cell(row, columns, 'product');
    const batch = cell(row, columns, 'batch');
    const expiryCell = cell(row, columns, 'expiry');
    const qty = cell(row, columns, 'qty');
    const mrp = cell(row, columns, 'mrp');
    const rate = cell(row, columns, 'rate');

    // A line item names something. Anything else on this part of the page is
    // a continuation, a footer or noise.
    const name = product.text.replace(/[|\]\[]/g, '').trim();
    if (name.replace(/[^A-Za-z]/g, '').length < 3) {
      if (row.text.trim()) skipped.push(row.text);
      continue;
    }

    const expiry = parseExpiry(expiryCell.text) ?? '';
    const warnings: string[] = [];

    if (!batch.text) warnings.push('No batch number was read — every line needs one.');
    if (!expiry) {
      warnings.push(expiryCell.text
        ? `Could not read "${expiryCell.text}" as an expiry.`
        : 'No expiry was read — check it against the invoice.');
    } else if (expiry < thisMonth) {
      warnings.push(`This reads as expiring ${expiry}, which is already past. Check it.`);
    }

    const mrpPaise = parseMoneyPaise(mrp.text);
    const ratePaise = parseMoneyPaise(rate.text);
    if (mrpPaise !== null && ratePaise !== null && ratePaise > mrpPaise) {
      warnings.push('The purchase rate reads higher than the MRP — one of them is misread.');
    }
    if (mrpPaise === null) warnings.push('No MRP was read.');
    if (parseCount(qty.text) === null) warnings.push('No quantity was read.');

    const fieldConfidence: Record<string, number> = {
      product_name: product.confidence,
      batch_no: batch.confidence,
      expiry: expiryCell.confidence,
      qty_packs: qty.confidence,
      mrp_paise: mrp.confidence,
      purchase_rate_paise: rate.confidence,
    };

    lines.push({
      line_no: lines.length + 1,
      raw: row.text,
      product_name: name,
      pack_size: parseCount(cell(row, columns, 'pack').text),
      batch_no: cleanBatch(batch.text),
      expiry,
      qty_packs: parseCount(qty.text),
      free_packs: parseCount(cell(row, columns, 'free').text),
      mrp_paise: mrpPaise,
      purchase_rate_paise: ratePaise,
      gst_rate: parseGstRate(cell(row, columns, 'gst').text),
      confidence: Math.min(...row.words.map((w) => w.confidence)),
      field_confidence: fieldConfidence,
      warnings,
    });
  }

  return {
    supplier_name: header.supplierName,
    supplier_gstin: header.gstin,
    invoice_no: header.invoiceNo,
    invoice_date: header.invoiceDate,
    lines,
    skipped,
    confidence: meanConfidence,
  };
}
