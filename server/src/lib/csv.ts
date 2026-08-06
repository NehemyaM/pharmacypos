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
