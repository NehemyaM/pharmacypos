/**
 * Database backup.
 *
 * The whole shop is one SQLite file, so this is the single most important
 * piece of operational safety in the system.
 *
 * Copying the file with `cp` while the server is running is NOT safe: in WAL
 * mode the committed data lives partly in `-wal`, so a plain copy can miss the
 * most recent bills or capture a torn page. `VACUUM INTO` asks SQLite itself to
 * write a consistent, fully-checkpointed copy while the database stays open for
 * billing — no downtime, no missing transactions.
 *
 * Every backup is then reopened and integrity-checked before it is allowed to
 * count, because an unverified backup is only the *belief* that you have one.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getDb, DB_PATH, nowIso } from '../db/index.js';

export const BACKUP_DIR = process.env.PHARMACY_BACKUP_DIR
  ? resolve(process.env.PHARMACY_BACKUP_DIR)
  : resolve(dirname(DB_PATH), 'backups');

/** Daily backups to retain before the oldest are pruned. */
export const RETAIN_DAYS = Number(process.env.PHARMACY_BACKUP_KEEP) || 30;

export type BackupResult = {
  file: string;
  bytes: number;
  createdAt: string;
  verified: boolean;
  tables: number;
  sales: number;
  pruned: string[];
};

/** `pharmacy-2026-08-06T14-32-05.sqlite` — sorts chronologically as text. */
function backupName(iso: string): string {
  return `pharmacy-${iso.replace(/:/g, '-')}.sqlite`;
}

/**
 * Take a consistent backup of the live database.
 *
 * @param label optional suffix, e.g. 'pre-update', to mark a manual backup
 */
export function createBackup(label = ''): BackupResult {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const createdAt = nowIso();
  const suffix = label ? `-${label.replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
  const file = join(BACKUP_DIR, backupName(createdAt).replace('.sqlite', `${suffix}.sqlite`));

  if (existsSync(file)) unlinkSync(file);

  // VACUUM INTO cannot use a bound parameter, so the path is inlined — quotes
  // are doubled to escape them, and the filename is machine-generated above.
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  const check = verifyBackup(file);
  const pruned = pruneOldBackups();

  return {
    file,
    bytes: statSync(file).size,
    createdAt,
    verified: check.ok,
    tables: check.tables,
    sales: check.sales,
    pruned,
  };
}

/**
 * Reopen a backup and confirm it is a usable database: integrity check passes,
 * the expected tables exist, and the statutory registers are readable.
 */
export function verifyBackup(file: string): {
  ok: boolean; tables: number; sales: number; error?: string;
} {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });

    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      return { ok: false, tables: 0, sales: 0, error: `integrity_check: ${integrity}` };
    }

    const tables = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).get() as { c: number };

    // Spot-check the tables that would end the business if lost.
    const sales = db.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number };
    db.prepare('SELECT COUNT(*) c FROM h1_register').get();
    db.prepare('SELECT COUNT(*) c FROM batches').get();

    return { ok: true, tables: tables.c, sales: sales.c };
  } catch (err) {
    return {
      ok: false, tables: 0, sales: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

export type BackupInfo = {
  file: string;
  name: string;
  bytes: number;
  modified: string;
};

export function listBackups(): BackupInfo[] {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((n) => n.startsWith('pharmacy-') && n.endsWith('.sqlite'))
    .map((name) => {
      const file = join(BACKUP_DIR, name);
      const s = statSync(file);
      return { file, name, bytes: s.size, modified: s.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first
}

/**
 * Keep the most recent RETAIN_DAYS backups. Manual labelled backups are never
 * pruned — someone took those deliberately, usually before a risky change.
 */
export function pruneOldBackups(): string[] {
  const automatic = listBackups().filter((b) => /^pharmacy-[\dT:-]+\.sqlite$/.test(b.name));
  const doomed = automatic.slice(RETAIN_DAYS);
  const pruned: string[] = [];
  for (const b of doomed) {
    try {
      unlinkSync(b.file);
      pruned.push(b.name);
    } catch {
      /* a locked file will be caught on the next run */
    }
  }
  return pruned;
}
