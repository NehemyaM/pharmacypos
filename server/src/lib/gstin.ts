/**
 * GSTIN: state codes, formatting and validation.
 *
 * Deliberately free of imports so both halves of the application can use it.
 * The counter needs to tell the owner a number is mistyped while they are still
 * looking at the certificate, and the server needs to refuse to store one — and
 * a check digit implemented twice is a check digit that will eventually
 * disagree with itself.
 */

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

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Normalise as typed: strip spaces and hyphens, upper-case. */
export function normaliseGstin(gstin: string): string {
  return gstin.replace(/[\s-]/g, '').toUpperCase();
}

/** The check digit the first 14 characters imply. */
function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/**
 * Say precisely what is wrong with a GSTIN, or `null` if nothing is.
 *
 * "That GSTIN is not valid" is no help to someone holding their registration
 * certificate and reading the number straight off it — the only move it leaves
 * is to type the same thing again. Every branch here names the character at
 * fault, because a GSTIN is nearly always right except for one slip.
 */
export function describeGstinProblem(gstin: string): string | null {
  const g = normaliseGstin(gstin);
  if (!g) return null;

  if (g.length !== 15) {
    return `A GSTIN is 15 characters — this one has ${g.length}.`;
  }

  const state = g.slice(0, 2);
  if (!/^[0-9]{2}$/.test(state)) {
    return `A GSTIN starts with a 2-digit state code — this one starts "${state}".`;
  }
  if (!STATE_CODES[state]) {
    return `"${state}" is not a state code. Telangana is 36, Andhra Pradesh 37.`;
  }

  // Characters 3-12 are the holder's PAN, which has a fixed shape.
  const pan = g.slice(2, 12);
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    return `Characters 3-12 are the PAN, which is 5 letters, 4 digits, then a letter. `
      + `This reads "${pan}".`;
  }
  if (!/^[1-9A-Z]$/.test(g[12])) {
    return `Character 13 is the registration number within the state, 1-9 or A-Z. `
      + `This is "${g[12]}".`;
  }
  if (g[13] !== 'Z') {
    return `Character 14 is Z on a normal registration. This is "${g[13]}".`;
  }

  const expected = gstinCheckDigit(g.slice(0, 14));
  if (expected !== g[14]) {
    return `The last character is a check digit calculated from the other 14. `
      + `For ${g.slice(0, 14)} it should be "${expected}", not "${g[14]}" — `
      + `so either the last character is wrong, or there is a typo earlier in the number.`;
  }
  return null;
}

/**
 * Validate a GSTIN: 15 chars, known state code, and a correct check digit
 * (the standard mod-36 doubling algorithm published by GSTN).
 */
export function isValidGstin(gstin: string): boolean {
  return describeGstinProblem(gstin) === null && normaliseGstin(gstin).length === 15;
}

/** State code embedded in a GSTIN, or `null` if it is not parseable. */
export function stateCodeOfGstin(gstin: string): string | null {
  const g = gstin.trim();
  if (g.length < 2) return null;
  const code = g.slice(0, 2);
  return STATE_CODES[code] ? code : null;
}
