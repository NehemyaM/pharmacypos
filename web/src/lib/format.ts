/** Display helpers. All monetary values arrive from the API as integer paise. */

/** `123456789` -> `"12,34,567.89"` — Indian lakh/crore grouping. */
export function formatIndian(paise: number | null | undefined): string {
  const p = Math.round(Number(paise) || 0);
  const neg = p < 0;
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100);
  const pais = abs % 100;

  const s = String(rupees);
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const last3 = s.slice(-3);
    grouped = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return `${neg ? '-' : ''}${grouped}.${String(pais).padStart(2, '0')}`;
}

export function rupees(paise: number | null | undefined): string {
  return `₹${formatIndian(paise)}`;
}

/** Compact form for dashboard tiles: ₹1.24L, ₹3.1Cr. */
export function rupeesShort(paise: number | null | undefined): string {
  const p = Math.round(Number(paise) || 0);
  const r = Math.abs(p) / 100;
  const sign = p < 0 ? '-' : '';
  if (r >= 1_00_00_000) return `${sign}₹${(r / 1_00_00_000).toFixed(2)}Cr`;
  if (r >= 1_00_000) return `${sign}₹${(r / 1_00_000).toFixed(2)}L`;
  if (r >= 1_000) return `${sign}₹${(r / 1_000).toFixed(1)}K`;
  return `${sign}₹${r.toFixed(0)}`;
}

export function paiseFromInput(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function rupeesInput(paise: number | null | undefined): string {
  return ((Number(paise) || 0) / 100).toFixed(2);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `'2027-03'` -> `'Mar 2027'` — how expiry is printed on a pack. */
export function formatExpiry(yyyymm: string | null | undefined): string {
  if (!yyyymm) return '—';
  const [y, m] = yyyymm.split('-');
  const idx = Number(m) - 1;
  return idx >= 0 && idx < 12 ? `${MONTHS[idx]} ${y}` : yyyymm;
}

/** `'2026-07-28'` or an ISO datetime -> `'28 Jul 2026'`. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-');
  const idx = Number(m) - 1;
  return idx >= 0 && idx < 12 ? `${d} ${MONTHS[idx]} ${y}` : value;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = formatDate(value);
  const time = value.length > 10 ? value.slice(11, 16) : '';
  return time ? `${date}, ${time}` : date;
}

export function todayIso(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(now);
}

export function currentMonthIso(): string {
  return todayIso().slice(0, 7);
}

export function addMonths(yyyymm: string, months: number): string {
  const [y, m] = yyyymm.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Months remaining before a pack expires; negative once it has expired. */
export function monthsToExpiry(expiry: string, from = currentMonthIso()): number {
  const [ey, em] = expiry.split('-').map(Number);
  const [cy, cm] = from.split('-').map(Number);
  return (ey - cy) * 12 + (em - cm);
}

/** How many packs and loose units a base-unit quantity represents. */
export function formatQty(units: number, packSize: number, unit: string): string {
  if (packSize <= 1) return `${units} ${unit}`;
  const packs = Math.floor(units / packSize);
  const loose = units % packSize;
  if (packs === 0) return `${loose} ${unit}`;
  if (loose === 0) return `${packs} × ${packSize}`;
  return `${packs} × ${packSize} + ${loose}`;
}

export const SCHEDULE_LABELS: Record<string, string> = {
  OTC: 'Over the counter',
  G: 'Schedule G',
  H: 'Schedule H — prescription only',
  H1: 'Schedule H1 — register entry required',
  X: 'Schedule X — narcotic/psychotropic',
  C: 'Schedule C',
  C1: 'Schedule C1',
};

/** Tailwind classes for the schedule chip shown next to a drug name. */
export function scheduleClass(schedule: string): string {
  switch (schedule) {
    case 'H1':
    case 'X':
      return 'bg-red-100 text-red-800 border-red-200';
    case 'H':
    case 'C':
    case 'C1':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'G':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

export const PAYMENT_MODES = ['CASH', 'UPI', 'CARD', 'CREDIT'] as const;
