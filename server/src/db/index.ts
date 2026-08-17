import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
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
  migrate(db);
  bootstrap(db);

  _db = db;
  return db;
}

/**
 * Column additions for databases created by an older version.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a new column has to be added explicitly or an updated shop keeps the old
 * shape and the code reading it breaks.
 */
function migrate(db: Database.Database): void {
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((c) => c.name);

  if (!columns('users').includes('must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * Make a brand-new database usable.
 *
 * The schema creates empty tables, which is not the same as a working shop: with
 * no `settings` row the billing code has nothing to read the shop's state code
 * from, and with no users nobody can sign in at all. A fresh install would look
 * broken on the counter's first morning.
 *
 * The default account is created with a well-known password *and* flagged to
 * force a change at first sign-in, so it cannot quietly stay `admin123`.
 */
function bootstrap(db: Database.Database): void {
  const ts = nowIso();

  const hasSettings = (db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number }).c > 0;
  if (!hasSettings) {
    db.prepare(
      `INSERT INTO settings (id, shop_name, city, state, state_code, invoice_prefix,
         return_prefix, invoice_footer, updated_at)
       VALUES (1, ?, 'Hyderabad', 'Telangana', '36', 'INV', 'CN', ?, ?)`,
    ).run(
      'My Medical Store',
      'Medicines once sold are not returnable except for manufacturing defect. '
      + 'Keep out of reach of children. Store below 25°C.',
      ts,
    );
    console.log('[bootstrap] created default shop settings — set your real details in Settings');
  }

  const userCount = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
  if (userCount === 0) {
    db.prepare(
      `INSERT INTO users (username, password_hash, full_name, role, must_change_password, created_at)
       VALUES ('admin', ?, 'Shop Owner', 'admin', 1, ?)`,
    ).run(bcrypt.hashSync('admin123', 10), ts);
    console.log('[bootstrap] created the first account — username "admin", password "admin123"');
    console.log('[bootstrap] you will be asked to change it at first sign-in');
  }
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
