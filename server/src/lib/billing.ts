/**
 * Line-level billing arithmetic and FEFO batch allocation.
 */

import { roundHalfUp } from './money.js';
import { splitInclusive, type GstBreakup } from './gst.js';

export type LineInput = {
  /** Base units being sold (tablets, ml-packs, bottles). */
  qtyUnits: number;
  /** Selling rate per *pack*, tax inclusive (usually the batch MRP). */
  saleRatePerPackPaise: number;
  /** Base units in one pack. */
  packSize: number;
  /** Line discount as a percentage of gross. */
  discountPct: number;
  gstRate: number;
  isInterstate: boolean;
};

export type LineResult = {
  /** Per base unit, tax inclusive — the "Rate" column on the invoice. */
  ratePaise: number;
  grossPaise: number;
  discountPaise: number;
  /** grossPaise - discountPaise, the tax-inclusive line value. */
  netPaise: number;
} & GstBreakup;

/**
 * Compute one invoice line.
 *
 * Gross is derived proportionally from the pack rate rather than from a
 * rounded per-unit rate, so selling a full strip bills exactly the strip MRP
 * (a per-unit rounding would silently lose paise on pack sizes like 15).
 */
export function computeLine(input: LineInput): LineResult {
  const { qtyUnits, saleRatePerPackPaise, packSize, discountPct, gstRate, isInterstate } = input;

  if (qtyUnits <= 0) throw new Error('Quantity must be greater than zero');
  if (packSize <= 0) throw new Error('Pack size must be greater than zero');
  if (discountPct < 0 || discountPct > 100) throw new Error('Discount must be between 0 and 100');

  const grossPaise = roundHalfUp((saleRatePerPackPaise * qtyUnits) / packSize);
  const discountPaise = roundHalfUp((grossPaise * discountPct) / 100);
  const netPaise = grossPaise - discountPaise;
  const ratePaise = roundHalfUp(saleRatePerPackPaise / packSize);

  const breakup = splitInclusive(netPaise, gstRate, isInterstate);

  return { ratePaise, grossPaise, discountPaise, netPaise, ...breakup };
}

// ---------------------------------------------------------------------------
// FEFO — First Expiry, First Out
// ---------------------------------------------------------------------------

export type AllocatableBatch = {
  id: number;
  batch_no: string;
  expiry: string;      // 'YYYY-MM'
  qty_units: number;
  mrp_paise: number;
  sale_rate_paise: number;
};

export type Allocation = {
  batchId: number;
  batchNo: string;
  expiry: string;
  qtyUnits: number;
  mrpPaise: number;
  saleRatePaise: number;
};

export class InsufficientStockError extends Error {
  constructor(
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Insufficient stock: requested ${requested}, available ${available}`);
    this.name = 'InsufficientStockError';
  }
}

/**
 * Allocate `qtyUnits` across batches, consuming the earliest-expiring stock
 * first. Expired batches are never allocated — dispensing expired medicine is
 * an offence under the Drugs & Cosmetics Act, not merely a stock error.
 *
 * @param currentMonth 'YYYY-MM'; a batch is expired once this exceeds its expiry.
 */
export function allocateFefo(
  batches: AllocatableBatch[],
  qtyUnits: number,
  currentMonth: string,
): Allocation[] {
  const usable = batches
    .filter((b) => b.qty_units > 0 && b.expiry >= currentMonth)
    .sort((a, b) => (a.expiry === b.expiry ? a.id - b.id : a.expiry < b.expiry ? -1 : 1));

  const available = usable.reduce((sum, b) => sum + b.qty_units, 0);
  if (available < qtyUnits) throw new InsufficientStockError(qtyUnits, available);

  const out: Allocation[] = [];
  let remaining = qtyUnits;
  for (const b of usable) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.qty_units);
    out.push({
      batchId: b.id,
      batchNo: b.batch_no,
      expiry: b.expiry,
      qtyUnits: take,
      mrpPaise: b.mrp_paise,
      saleRatePaise: b.sale_rate_paise,
    });
    remaining -= take;
  }
  return out;
}

/** True when a `YYYY-MM` expiry has passed relative to `currentMonth`. */
export function isExpired(expiry: string, currentMonth: string): boolean {
  return expiry < currentMonth;
}

/** Whole months until expiry; negative when already expired. */
export function monthsToExpiry(expiry: string, currentMonth: string): number {
  const [ey, em] = expiry.split('-').map(Number);
  const [cy, cm] = currentMonth.split('-').map(Number);
  return (ey - cy) * 12 + (em - cm);
}

/** Products in these schedules may only be sold against a prescription. */
export const RX_SCHEDULES = new Set(['H', 'H1', 'X', 'C', 'C1']);

/** Schedule H1 additionally demands an entry in a separate bound register. */
export function requiresH1Register(scheduleType: string): boolean {
  return scheduleType === 'H1' || scheduleType === 'X';
}

export function requiresPrescription(scheduleType: string): boolean {
  return RX_SCHEDULES.has(scheduleType);
}
