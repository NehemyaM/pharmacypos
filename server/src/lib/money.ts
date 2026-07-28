/**
 * Money handling. Every amount in this system is an INTEGER number of paise.
 * Floating point rupees are never stored, summed, or compared.
 */

/** Round half away from zero — the convention used on Indian tax invoices. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function rupeesToPaise(rupees: number | string): number {
  const n = typeof rupees === 'string' ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) throw new Error(`Invalid rupee amount: ${rupees}`);
  return roundHalfUp(n * 100);
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/** `123456789` paise -> `"12,34,567.89"` (Indian lakh/crore grouping). */
export function formatIndian(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const pais = abs % 100;

  const s = String(rupees);
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return `${neg ? '-' : ''}${grouped}.${String(pais).padStart(2, '0')}`;
}

export function formatRupees(paise: number): string {
  return `₹${formatIndian(paise)}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** Whole number to Indian-system words (crore / lakh / thousand). */
export function numberToWordsIndian(n: number): string {
  if (n === 0) return 'Zero';
  if (n < 0) return `Minus ${numberToWordsIndian(-n)}`;

  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;

  if (crore) parts.push(`${numberToWordsIndian(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));

  return parts.join(' ');
}

/**
 * Invoice-footer amount in words, e.g.
 * `"Rupees One Thousand Two Hundred Fifty and Fifty Paise Only"`.
 */
export function amountInWords(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const pais = abs % 100;

  let out = `Rupees ${numberToWordsIndian(rupees)}`;
  if (pais > 0) out += ` and ${twoDigits(pais)} Paise`;
  out += ' Only';
  return neg ? `Minus ${out}` : out;
}

/**
 * Round-off to the nearest rupee as shown on Indian invoices.
 * Returns the adjustment (may be negative) and the final payable amount.
 */
export function roundOff(paise: number): { adjustment: number; total: number } {
  const total = roundHalfUp(paise / 100) * 100;
  return { adjustment: total - paise, total };
}
