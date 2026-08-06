/**
 * Command-line backup, for Task Scheduler / cron.
 *
 *   npm run backup                 take a verified backup, prune old ones
 *   npm run backup -- --label pre-update
 *   npm run backup -- --list       show what backups exist
 *   npm run backup -- --verify <file>
 *
 * Exits non-zero if the backup could not be verified, so a scheduler can alert.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createBackup, listBackups, verifyBackup, BACKUP_DIR, RETAIN_DAYS } from './lib/backup.js';

const args = process.argv.slice(2);

/**
 * npm runs workspace scripts with cwd set to the package directory, so a path
 * the user typed relative to the repo root will not resolve. Accept an absolute
 * path, a path relative to cwd, or a bare filename inside the backup directory.
 */
function locate(input: string): string | null {
  const candidates = isAbsolute(input)
    ? [input]
    : [resolve(process.cwd(), input), join(BACKUP_DIR, input), resolve(process.cwd(), '..', input)];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

if (args.includes('--list')) {
  const rows = listBackups();
  if (rows.length === 0) {
    console.log(`No backups in ${BACKUP_DIR}`);
    process.exit(0);
  }
  console.log(`Backups in ${BACKUP_DIR} (newest first):\n`);
  for (const b of rows) console.log(`  ${b.name.padEnd(48)} ${mb(b.bytes).padStart(10)}`);
  console.log(`\n${rows.length} backups, retaining ${RETAIN_DAYS} automatic.`);
  process.exit(0);
}

const verifyIdx = args.indexOf('--verify');
if (verifyIdx !== -1) {
  const input = args[verifyIdx + 1];
  if (!input) {
    console.error('--verify needs a file path or a backup filename');
    process.exit(2);
  }
  const file = locate(input);
  if (!file) {
    console.error(`Not found: ${input}`);
    console.error(`Looked in the current directory and in ${BACKUP_DIR}`);
    process.exit(2);
  }
  const r = verifyBackup(file);
  if (r.ok) {
    console.log(`OK — ${file}\n  ${r.tables} tables, ${r.sales} sales`);
    process.exit(0);
  }
  console.error(`FAILED — ${file}\n  ${r.error}`);
  process.exit(1);
}

const labelIdx = args.indexOf('--label');
const label = labelIdx !== -1 ? args[labelIdx + 1] ?? '' : '';

try {
  const r = createBackup(label);
  if (!r.verified) {
    console.error(`Backup written but FAILED verification: ${r.file}`);
    console.error('Do not rely on this file. Check disk space and permissions.');
    process.exit(1);
  }
  console.log(`Backup OK  ${r.file}`);
  console.log(`  ${mb(r.bytes)}, ${r.tables} tables, ${r.sales} sales, verified`);
  if (r.pruned.length) console.log(`  pruned ${r.pruned.length} old backup(s)`);
  process.exit(0);
} catch (err) {
  console.error('Backup FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
}
