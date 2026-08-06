import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createBackup, listBackups, BACKUP_DIR, RETAIN_DAYS } from '../lib/backup.js';
import { audit } from '../lib/audit.js';

export const backupRouter = Router();
backupRouter.use(requireAuth, requireRole('admin'));

backupRouter.get('/', (_req, res) => {
  res.json({ directory: BACKUP_DIR, retain: RETAIN_DAYS, backups: listBackups() });
});

/** Take a backup on demand — the shop owner's "before I do something risky" button. */
backupRouter.post('/', (req, res) => {
  const parsed = z.object({ label: z.string().max(40).default('') }).safeParse(req.body ?? {});
  const label = parsed.success ? parsed.data.label : '';
  try {
    const result = createBackup(label);
    audit(req.user!.id, req.user!.username, 'BACKUP', 'database', null,
      `${basename(result.file)} (${result.bytes} bytes, verified=${result.verified})`);

    if (!result.verified) {
      res.status(500).json({
        error: 'The backup file was written but failed verification — do not rely on it. Check free disk space.',
        ...result,
      });
      return;
    }
    res.status(201).json(result);
  } catch (err) {
    console.error('[backup] failed:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Backup failed',
    });
  }
});

/**
 * Download a backup so it can be taken off the premises. A copy that only
 * exists on the same machine as the original is not a backup.
 */
backupRouter.get('/download/:name', (req, res) => {
  // Resolve and confine to BACKUP_DIR — never trust a filename from the client.
  const name = basename(req.params.name);
  const file = resolve(join(BACKUP_DIR, name));
  if (!file.startsWith(resolve(BACKUP_DIR)) || !existsSync(file) || !name.endsWith('.sqlite')) {
    res.status(404).json({ error: 'Backup not found' });
    return;
  }
  audit(req.user!.id, req.user!.username, 'BACKUP_DOWNLOAD', 'database', null, name);
  res.setHeader('Content-Type', 'application/vnd.sqlite3');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  createReadStream(file).pipe(res);
});
