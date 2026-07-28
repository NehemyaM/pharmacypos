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
export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory',
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Validate a GSTIN: 15 chars, known state code, and a correct check digit
 * (the standard mod-36 doubling algorithm published by GSTN).
 */
export function isValidGstin(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return false;
  if (!STATE_CODES[g.slice(0, 2)]) return false;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(g[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkDigit = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  return checkDigit === g[14];
}

/** State code embedded in a GSTIN, or `null` if it is not parseable. */
export function stateCodeOfGstin(gstin: string): string | null {
  const g = gstin.trim();
  if (g.length < 2) return null;
  const code = g.slice(0, 2);
  return STATE_CODES[code] ? code : null;
}

/**
 * A supply is inter-state when the place of supply differs from the supplier's
 * state. For an over-the-counter walk-in sale the place of supply is the shop.
 */
export function isInterstateSupply(shopStateCode: string, placeOfSupply: string): boolean {
  if (!placeOfSupply) return false;
  return shopStateCode !== placeOfSupply;
}
