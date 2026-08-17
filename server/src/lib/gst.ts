/**
 * GST computation for Indian retail pharmacy.
 *
 * The defining rule: a chemist sells at MRP, and **MRP is inclusive of GST**
 * (Legal Metrology Rules — the printed MRP is the maximum the customer can be
 * charged, all taxes in). Tax is therefore *extracted* from the line value, it
 * is never added on top. Getting this backwards overcharges every customer.
 *
 * Intra-state supply (shop and customer both in Telangana, POS 36)
 *     -> CGST + SGST, each half the tax
 * Inter-state supply (customer in another state)
 *     -> IGST, the whole tax
 *
 * Rate slabs for medicines since 22-Sep-2025: Nil / 5% / 18%.
 * The 12% slab was abolished for pharmaceuticals by the 56th GST Council.
 */

import { roundHalfUp } from './money.js';

/** GST rates applicable to pharmacy products, as whole percentages. */
export const GST_SLABS = [0, 5, 12, 18, 28] as const;

/** Slabs a medicine (HSN 3003/3004) may legitimately fall in post-Sep-2025. */
export const MEDICINE_SLABS = [0, 5, 18] as const;

export type GstBreakup = {
  /** Value the tax is computed on, i.e. line value net of tax. */
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** cgst + sgst + igst */
  tax: number;
  /** taxable + tax — always exactly equal to the inclusive input. */
  total: number;
};

/**
 * Split a **tax-inclusive** amount (paise) into taxable value and GST.
 *
 * Invariant: `taxable + cgst + sgst + igst === inclusivePaise`, exactly.
 * Any rounding residue is absorbed by SGST/IGST so the invoice always foots.
 */
export function splitInclusive(
  inclusivePaise: number,
  gstRate: number,
  isInterstate: boolean,
): GstBreakup {
  if (gstRate === 0) {
    return { taxable: inclusivePaise, cgst: 0, sgst: 0, igst: 0, tax: 0, total: inclusivePaise };
  }

  const taxable = roundHalfUp((inclusivePaise * 100) / (100 + gstRate));
  const tax = inclusivePaise - taxable;

  if (isInterstate) {
    return { taxable, cgst: 0, sgst: 0, igst: tax, tax, total: inclusivePaise };
  }
  // Half to CGST, remainder to SGST so odd paise never vanish.
  const cgst = Math.floor(tax / 2);
  const sgst = tax - cgst;
  return { taxable, cgst, sgst, igst: 0, tax, total: inclusivePaise };
}

/**
 * Add GST on top of a **tax-exclusive** amount (paise). Used for purchase
 * entry, where a distributor's invoice quotes rate ex-GST and adds tax.
 */
export function addExclusive(
  taxablePaise: number,
  gstRate: number,
  isInterstate: boolean,
): GstBreakup {
  if (gstRate === 0) {
    return { taxable: taxablePaise, cgst: 0, sgst: 0, igst: 0, tax: 0, total: taxablePaise };
  }

  const tax = roundHalfUp((taxablePaise * gstRate) / 100);

  if (isInterstate) {
    return {
      taxable: taxablePaise, cgst: 0, sgst: 0, igst: tax, tax, total: taxablePaise + tax,
    };
  }
  const cgst = Math.floor(tax / 2);
  const sgst = tax - cgst;
  return {
    taxable: taxablePaise, cgst, sgst, igst: 0, tax, total: taxablePaise + tax,
  };
}

/** GST state codes. Used to decide CGST+SGST vs IGST and to validate GSTINs. */
export {
  STATE_CODES,
  normaliseGstin,
  describeGstinProblem,
  isValidGstin,
  stateCodeOfGstin,
} from './gstin.js';

/**
 * A supply is inter-state when the place of supply differs from the supplier's
 * state. For an over-the-counter walk-in sale the place of supply is the shop.
 */
export function isInterstateSupply(shopStateCode: string, placeOfSupply: string): boolean {
  if (!placeOfSupply) return false;
  return shopStateCode !== placeOfSupply;
}
