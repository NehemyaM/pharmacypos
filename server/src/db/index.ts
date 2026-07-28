import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.PHARMACY_DB
  ? resolve(process.env.PHARMACY_DB)
  : resolve(__dirname, '../../../data/pharmacy.sqlite');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);

  // WAL keeps the billing counter responsive while reports run.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Current time in IST (Asia/Kolkata) as an ISO-like string `YYYY-MM-DDTHH:mm:ss`.
 * The shop runs on local time; storing UTC would make "today's sales" wrong
 * for the 05:30 offset every night.
 */
export function nowIso(): string {
  return istParts().iso;
}

/** Today in IST as `YYYY-MM-DD`. */
export function today(): string {
  return istParts().date;
}

/** Current month in IST as `YYYY-MM` — the granularity of drug expiry. */
export function currentMonth(): string {
  return istParts().date.slice(0, 7);
}

function istParts(): { iso: string; date: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  // Intl can render midnight as hour "24" in some ICU versions.
  const hour = p.hour === '24' ? '00' : p.hour;
  return { iso: `${date}T${hour}:${p.minute}:${p.second}`, date };
}

/** Add `months` to a `YYYY-MM` string. */
export function addMonths(yyyymm: string, months: number): string {
  const [y, m] = yyyymm.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/**
 * Next value of a named sequence. Must be called inside the caller's
 * transaction so a rolled-back invoice does not burn a number.
 */
export function nextCounter(db: Database.Database, name: string): number {
  db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number };
  return row.value;
}

/**
 * Indian financial year label for a date, e.g. 2026-07-28 -> "2026-27".
 * Invoice series restart every FY (1 April - 31 March).
 */
export function financialYear(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
