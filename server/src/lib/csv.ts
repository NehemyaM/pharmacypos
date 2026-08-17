/**
 * CSV generation for report export.
 *
 * Two things this gets right that naive CSV writers do not:
 *
 * 1. **Formula injection.** A cell beginning `=`, `+`, `-`, `@`, tab or CR is
 *    executed as a formula when the file is opened in Excel or Sheets. Product
 *    and customer names come from user input, so `=cmd|'/c calc'!A1` in a
 *    supplier name would run on the accountant's machine. Such cells are
 *    prefixed with an apostrophe so they stay text.
 *
 * 2. **Numbers stay numbers.** Amounts are written as plain decimals — no `₹`,
 *    no thousands separators. `1,23,456.78` is text to a spreadsheet and cannot
 *    be summed, which defeats the point of exporting to one.
 */

export type Column<T> = {
  header: string;
  /** Return a string for text, a number for numeric cells, null for blank. */
  value: (row: T) => string | number | null | undefined;
};

const NEEDS_QUOTING = /[",\r\n]/;
const DANGEROUS_LEAD = /^[=+\-@\t\r]/;

/** Escape one cell for CSV, defusing spreadsheet formulas. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  let s = String(value);
  if (DANGEROUS_LEAD.test(s)) s = `'${s}`;
  if (NEEDS_QUOTING.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Paise to a plain decimal a spreadsheet will treat as a number. */
export function csvRupees(paise: number | null | undefined): number {
  return Math.round(Number(paise) || 0) / 100;
}

export function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const lines: string[] = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  }
  // CRLF and a UTF-8 BOM: Excel on Windows mis-reads plain UTF-8, which mangles
  // the rupee sign and any Telugu or Hindi text in a product name.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Build a filename like `gst-summary_2026-07-01_to_2026-08-06.csv`. */
export function csvFilename(base: string, from?: string, to?: string): string {
  const slug = base.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (from && to) return `${slug}_${from}_to_${to}.csv`;
  return `${slug}.csv`;
}

// ===========================================================================
// Reading
// ===========================================================================

/**
 * Parse CSV text into rows of cells.
 *
 * Written by hand rather than split(',') because the files that actually turn
 * up are exported from Excel on a shop's Windows machine and contain all of:
 * a UTF-8 BOM, CRLF line endings, quoted fields holding commas ("Strip of 10,
 * blister"), doubled quotes for a literal quote, and newlines inside a quoted
 * cell. Any of those breaks a naive split.
 *
 * The leading apostrophe csvCell() adds to defuse spreadsheet formulas is
 * stripped back off, so a file this system exported can be re-imported.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;

  if (text.charCodeAt(0) === 0xfeff) i = 1; // strip the BOM

  const endCell = () => {
    // Undo the anti-formula apostrophe, but only where it is doing that job.
    row.push(cell.startsWith("'") && DANGEROUS_LEAD.test(cell.slice(1)) ? cell.slice(1) : cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }

    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === ',') { endCell(); i++; continue; }
    if (ch === '\r') { i += text[i + 1] === '\n' ? 2 : 1; endRow(); continue; }
    if (ch === '\n') { i++; endRow(); continue; }
    cell += ch; i++;
  }

  // A trailing newline should not produce a phantom final row.
  if (cell !== '' || row.length > 0) endRow();

  return rows;
}

/** Header text to a comparison key: `"Pack Size "` and `"pack_size"` match. */
export function headerKey(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export type CsvTable = {
  /** Header text as it appeared in the file, in order. */
  headers: string[];
  /** One record per data row, keyed by headerKey(). */
  records: Array<Record<string, string>>;
  /** File line number of each record, for error messages the user can act on. */
  lineNumbers: number[];
};

/**
 * Parse CSV with a header row into keyed records.
 *
 * Blank lines are skipped rather than reported as errors — spreadsheets leave
 * them behind constantly, and a shop owner should not have to tidy the file.
 * Line numbers count every physical line so they match what the user sees in
 * Excel.
 */
export function parseCsvTable(text: string): CsvTable {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (headerIndex === -1) return { headers: [], records: [], lineNumbers: [] };

  const headers = rows[headerIndex].map((h) => h.trim());
  const keys = headers.map(headerKey);
  const records: Array<Record<string, string>> = [];
  const lineNumbers: number[] = [];

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.some((c) => c.trim() !== '')) continue;
    const record: Record<string, string> = {};
    keys.forEach((key, c) => {
      if (key) record[key] = (cells[c] ?? '').trim();
    });
    records.push(record);
    lineNumbers.push(r + 1);
  }

  return { headers, records, lineNumbers };
}
