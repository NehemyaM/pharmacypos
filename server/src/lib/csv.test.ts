import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvRupees, toCsv, csvFilename } from './csv.js';

describe('CSV cell escaping', () => {
  test('passes plain text through', () => {
    assert.equal(csvCell('Dolo 650'), 'Dolo 650');
  });

  test('quotes cells containing commas, quotes or newlines', () => {
    assert.equal(csvCell('Alkem, Mumbai'), '"Alkem, Mumbai"');
    assert.equal(csvCell('5" strip'), '"5"" strip"');
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  });

  test('blanks null and undefined', () => {
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
  });

  test('writes numbers bare so spreadsheets can sum them', () => {
    assert.equal(csvCell(1234.56), '1234.56');
    assert.equal(csvCell(0), '0');
    assert.equal(csvCell(NaN), '');
    assert.equal(csvCell(Infinity), '');
  });
});

describe('spreadsheet formula injection', () => {
  test('neutralises a leading = so Excel does not execute it', () => {
    assert.equal(csvCell('=1+1'), "'=1+1");
    // The canonical Excel command-execution payload
    const payload = String.raw`=cmd|' /C calc'!A0`;
    assert.equal(csvCell(payload), `'${payload}`);
  });

  test('neutralises the other dangerous leading characters', () => {
    assert.equal(csvCell('+44 20'), "'+44 20");
    assert.equal(csvCell('-1+1'), "'-1+1");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell('\tTAB'), "'\tTAB");
  });

  test('a dangerous cell that also needs quoting gets both treatments', () => {
    // A supplier name a malicious data-entry could plant
    assert.equal(csvCell('=HYPERLINK("http://x"),evil'), '"\'=HYPERLINK(""http://x""),evil"');
  });

  test('leaves an inner = alone — only the leading position is executable', () => {
    assert.equal(csvCell('Vitamin=C'), 'Vitamin=C');
  });

  test('a negative *number* is still written as a number, not escaped', () => {
    // -50 as a number is a legitimate stock adjustment, not a formula
    assert.equal(csvCell(-50), '-50');
  });
});

describe('rupee conversion for spreadsheets', () => {
  test('paise become plain decimals with no symbol or grouping', () => {
    assert.equal(csvRupees(123456789), 1234567.89);
    assert.equal(csvRupees(4550), 45.5);
    assert.equal(csvRupees(0), 0);
    assert.equal(csvRupees(null), 0);
  });

  test('the result is a number, so a spreadsheet can total a column', () => {
    const col = [10050, 4550, 99].map(csvRupees);
    assert.equal(typeof col[0], 'number');
    assert.equal(col.reduce((a, b) => a + b, 0).toFixed(2), '146.99');
  });
});

describe('toCsv', () => {
  type Row = { name: string; qty: number; paise: number };
  const rows: Row[] = [
    { name: 'Dolo 650', qty: 15, paise: 3450 },
    { name: 'Alkem, Mumbai', qty: 2, paise: 15600 },
  ];
  const cols = [
    { header: 'Product', value: (r: Row) => r.name },
    { header: 'Qty', value: (r: Row) => r.qty },
    { header: 'Amount', value: (r: Row) => csvRupees(r.paise) },
  ];

  test('writes a header row and one line per record', () => {
    const csv = toCsv(rows, cols);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'Product,Qty,Amount');
    assert.equal(lines[1], 'Dolo 650,15,34.5');
    assert.equal(lines[2], '"Alkem, Mumbai",2,156');
  });

  test('starts with a UTF-8 BOM so Excel reads it correctly', () => {
    assert.ok(toCsv(rows, cols).startsWith('﻿'));
  });

  test('uses CRLF line endings', () => {
    assert.ok(toCsv(rows, cols).includes('\r\n'));
  });

  test('an empty result still emits headers', () => {
    const csv = toCsv([], cols).replace('﻿', '');
    assert.equal(csv.trim(), 'Product,Qty,Amount');
  });
});

describe('filenames', () => {
  test('includes the period when given one', () => {
    assert.equal(
      csvFilename('GST Summary', '2026-07-01', '2026-08-06'),
      'gst-summary_2026-07-01_to_2026-08-06.csv',
    );
  });

  test('falls back to a bare name', () => {
    assert.equal(csvFilename('reorder'), 'reorder.csv');
  });
});
