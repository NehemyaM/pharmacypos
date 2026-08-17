import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExpiry, parseMoneyPaise, parseCount, parseGstRate, cleanBatch,
  groupIntoRows, findColumns, parseInvoice, type OcrWord,
} from './invoice-parse.js';

/**
 * Build a page of words the way OCR reports them: each cell at a fixed
 * horizontal position, as a printed table actually lays out. The product column
 * is wide because product names are, and the numeric columns are narrow.
 */
const COLUMN_X = [0, 90, 520, 600, 760, 900, 990, 1080, 1210, 1340, 1450];

function page(rows: string[][], opts: { confidence?: number } = {}): OcrWord[] {
  const words: OcrWord[] = [];
  rows.forEach((cells, r) => {
    cells.forEach((cell, c) => {
      let x = COLUMN_X[c] ?? 1450 + (c - 10) * 120;
      for (const token of cell.split(' ').filter(Boolean)) {
        words.push({
          text: token,
          x0: x, x1: x + token.length * 9,
          y0: r * 30, y1: r * 30 + 20,
          confidence: opts.confidence ?? 90,
        });
        x += token.length * 9 + 8;
      }
    });
  });
  return words;
}

describe('expiry as distributors print it', () => {
  test('every common format reads to the same month', () => {
    for (const raw of ['09/28', '09-28', '09.28', '9/28', '09/2028', '09-2028',
      'SEP28', 'Sep-28', 'sep 2028', '2028-09', '0928', '092028']) {
      assert.equal(parseExpiry(raw), '2028-09', raw);
    }
  });

  test('a two-digit year is this century', () => {
    assert.equal(parseExpiry('01/05'), '2005-01');
    assert.equal(parseExpiry('12/99'), '2099-12');
  });

  test('nonsense is refused rather than guessed at', () => {
    for (const raw of ['', 'NA', '--', 'sometime', '13/28', '00/28', '99/99', 'ABC']) {
      assert.equal(parseExpiry(raw), null, raw);
    }
  });
});

describe('money as OCR mangles it', () => {
  test('plain amounts', () => {
    assert.equal(parseMoneyPaise('34.50'), 3450);
    assert.equal(parseMoneyPaise('223.42'), 22342);
    assert.equal(parseMoneyPaise('65'), 6500);
    assert.equal(parseMoneyPaise('1,234.50'), 123450);
  });

  test('a comma read as a full stop still gives the right figure', () => {
    // OCR routinely swaps these; 1.234.50 is 1,234.50 misread, not 1.23450.
    assert.equal(parseMoneyPaise('1.234.50'), 123450);
    assert.equal(parseMoneyPaise('1,234,567.89'), 123456789);
  });

  test('rupee signs and stray characters are ignored', () => {
    assert.equal(parseMoneyPaise('₹34.50'), 3450);
    assert.equal(parseMoneyPaise('Rs. 34.50'), 3450);
    assert.equal(parseMoneyPaise('|34.50|'), 3450);
  });

  test('nothing numeric means nothing', () => {
    assert.equal(parseMoneyPaise(''), null);
    assert.equal(parseMoneyPaise('---'), null);
    assert.equal(parseMoneyPaise('|'), null);
  });
});

describe('other fields', () => {
  test('counts ignore decoration', () => {
    assert.equal(parseCount('10'), 10);
    assert.equal(parseCount('| 10 |'), 10);
    assert.equal(parseCount(''), null);
    assert.equal(parseCount('-'), null);
  });

  test('GST is only accepted at a real slab', () => {
    assert.equal(parseGstRate('5'), 5);
    assert.equal(parseGstRate('5%'), 5);
    assert.equal(parseGstRate('18.00'), 18);
    // 7% is not a GST rate; better to leave it blank than invent one.
    assert.equal(parseGstRate('7'), null);
    assert.equal(parseGstRate(''), null);
  });

  test('batch numbers are cleaned but never corrected', () => {
    assert.equal(cleanBatch('| KLM2244 |'), 'KLM2244');
    assert.equal(cleanBatch('az4471b'), 'AZ4471B');
    // 0 and O are genuinely ambiguous — guessing would be worse than showing
    // the reviewer exactly what was read.
    assert.equal(cleanBatch('OO123'), 'OO123');
  });
});

describe('rebuilding the table from geometry', () => {
  test('words on the same line become one row', () => {
    const rows = groupIntoRows(page([
      ['S.No', 'Product', 'Batch', 'Exp', 'Qty', 'MRP', 'Rate'],
      ['1', 'DOLO 650 TAB', 'KLM2244', '09/28', '10', '34.50', '26.30'],
    ]));
    assert.equal(rows.length, 2);
    assert.match(rows[1].text, /DOLO 650 TAB/);
  });

  test('a slightly sloped photograph still groups correctly', () => {
    // Every word nudged down a little more than the last, as when the page is
    // not square to the camera.
    const words = page([
      ['S.No', 'Product', 'Batch', 'Exp', 'Qty', 'MRP', 'Rate'],
      ['1', 'DOLO 650 TAB', 'KLM2244', '09/28', '10', '34.50', '26.30'],
    ]).map((w, i) => ({ ...w, y0: w.y0 + i * 0.4, y1: w.y1 + i * 0.4 }));
    assert.equal(groupIntoRows(words).length, 2);
  });

  test('the header row is found even with a shop name above it', () => {
    const rows = groupIntoRows(page([
      ['SRI VENKATESWARA PHARMA DISTRIBUTORS'],
      ['GSTIN: 36AAPFU0939F1ZW'],
      ['S.No', 'Product', 'Batch', 'Exp', 'Qty', 'MRP', 'Rate'],
      ['1', 'DOLO 650 TAB', 'KLM2244', '09/28', '10', '34.50', '26.30'],
    ]));
    const found = findColumns(rows);
    assert.ok(found, 'no header found');
    assert.equal(found.headerIndex, 2);
    assert.ok(found.columns.some((c) => c.key === 'batch'));
    assert.ok(found.columns.some((c) => c.key === 'expiry'));
  });

  test('a page with no table at all is reported, not invented', () => {
    const rows = groupIntoRows(page([['Just'], ['some'], ['prose']]));
    assert.equal(findColumns(rows), null);
  });
});

describe('a whole invoice', () => {
  const invoice = () => page([
    ['SRI VENKATESWARA PHARMA DISTRIBUTORS'],
    ['GSTIN: 36AAPFU0939F1ZW'],
    ['Invoice No: SVP/2026/04871', '', '', '', '', 'Date: 14/08/2026'],
    ['S.No', 'Product', 'Pack', 'Batch', 'Exp', 'Qty', 'Free', 'MRP', 'Rate', 'GST'],
    ['1', 'DOLO 650 TAB', '15', 'KLM2244', '09/28', '10', '1', '34.50', '26.30', '5'],
    ['2', 'PAN 40 TAB', '15', 'PN80921', '03/29', '5', '0', '178.00', '128.16', '5'],
    ['Taxable: 4659.68', 'Total: 4950.28'],
  ]);

  test('reads the supplier and the invoice particulars', () => {
    const r = parseInvoice(invoice(), { today: '2026-08-17' });
    assert.match(r.supplier_name, /VENKATESWARA/);
    assert.equal(r.supplier_gstin, '36AAPFU0939F1ZW');
    assert.equal(r.invoice_no, 'SVP/2026/04871');
    assert.equal(r.invoice_date, '2026-08-14');
  });

  test('reads every line item with its batch and expiry', () => {
    const r = parseInvoice(invoice(), { today: '2026-08-17' });
    assert.equal(r.lines.length, 2);

    const [dolo, pan] = r.lines;
    assert.match(dolo.product_name, /DOLO 650/);
    assert.equal(dolo.batch_no, 'KLM2244');
    assert.equal(dolo.expiry, '2028-09');
    assert.equal(dolo.qty_packs, 10);
    assert.equal(dolo.free_packs, 1);
    assert.equal(dolo.mrp_paise, 3450);
    assert.equal(dolo.purchase_rate_paise, 2630);
    assert.equal(dolo.gst_rate, 5);
    assert.equal(dolo.pack_size, 15);
    assert.deepEqual(dolo.warnings, []);

    assert.equal(pan.batch_no, 'PN80921');
    assert.equal(pan.mrp_paise, 17800);
  });

  test('the totals row is not mistaken for stock', () => {
    const r = parseInvoice(invoice(), { today: '2026-08-17' });
    assert.ok(!r.lines.some((l) => /taxable|total/i.test(l.product_name)),
      r.lines.map((l) => l.product_name).join(', '));
  });

  test('keeps the row as read so a reviewer can compare with the picture', () => {
    const r = parseInvoice(invoice(), { today: '2026-08-17' });
    assert.match(r.lines[0].raw, /KLM2244/);
  });
});

describe('what it refuses to accept quietly', () => {
  const withLine = (cells: string[]) => parseInvoice(page([
    ['S.No', 'Product', 'Pack', 'Batch', 'Exp', 'Qty', 'Free', 'MRP', 'Rate', 'GST'],
    cells,
  ]), { today: '2026-08-17' }).lines[0];

  test('an expiry already past is flagged, not imported', () => {
    const line = withLine(['1', 'DOLO 650 TAB', '15', 'KLM2244', '09/25', '10', '0', '34.50', '26.30', '5']);
    assert.match(line.warnings.join(' '), /already past/);
  });

  test('an unreadable expiry says what it could not read', () => {
    const line = withLine(['1', 'DOLO 650 TAB', '15', 'KLM2244', 'XX', '10', '0', '34.50', '26.30', '5']);
    assert.match(line.warnings.join(' '), /Could not read "XX"/);
  });

  test('a missing batch number is flagged — stock cannot be taken in without one', () => {
    const line = withLine(['1', 'DOLO 650 TAB', '15', '', '09/28', '10', '0', '34.50', '26.30', '5']);
    assert.match(line.warnings.join(' '), /No batch number/);
  });

  test('a rate above the MRP means something was misread', () => {
    const line = withLine(['1', 'DOLO 650 TAB', '15', 'KLM2244', '09/28', '10', '0', '26.30', '34.50', '5']);
    assert.match(line.warnings.join(' '), /higher than the MRP/);
  });

  test('low confidence is carried per field for the review screen', () => {
    const words = page([
      ['S.No', 'Product', 'Pack', 'Batch', 'Exp', 'Qty', 'Free', 'MRP', 'Rate', 'GST'],
      ['1', 'DOLO 650 TAB', '15', 'KLM2244', '09/28', '10', '0', '34.50', '26.30', '5'],
    ], { confidence: 41 });
    const line = parseInvoice(words, { today: '2026-08-17' }).lines[0];
    assert.equal(line.confidence, 41);
    assert.equal(line.field_confidence.batch_no, 41);
  });

  test('a page it cannot read returns nothing rather than guesses', () => {
    const r = parseInvoice(page([['some'], ['unrelated'], ['document']]));
    assert.equal(r.lines.length, 0);
    assert.ok(r.skipped.length > 0);
  });
});
