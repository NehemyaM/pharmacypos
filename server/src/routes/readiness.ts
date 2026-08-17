/**
 * Go-live readiness.
 *
 * A shop can install this software and start billing in ten minutes, which is
 * the problem: an invoice missing the GSTIN or the drug licence numbers is not a
 * valid tax invoice under the CGST Rules, and an account still on the password
 * it shipped with is an open door. Neither failure announces itself — the bills
 * print, the counter works, and the shop only finds out when an inspector or an
 * auditor asks.
 *
 * So the software checks itself and says plainly what is not ready yet.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { isValidGstin } from '../lib/gst.js';
import { listBackups } from '../lib/backup.js';
import type { Settings, User } from '../types.js';

export const readinessRouter = Router();
readinessRouter.use(requireAuth, requireRole('admin'));

/**
 * Passwords this software has ever shipped or demonstrated with, plus the few a
 * shop reliably picks when asked to think of one. Checked by bcrypt comparison
 * against the stored hash — the plaintext is never stored, so the only way to
 * know an account is still on a default is to try it.
 */
const KNOWN_DEFAULTS = [
  'admin123', 'pharma123', 'cash123',
  'password', 'password123', '123456', '12345678', 'admin', 'medical', 'pharmacy',
];

export type Check = {
  id: string;
  /** 'blocker' must be fixed before real billing; 'advisory' should be. */
  severity: 'blocker' | 'advisory';
  title: string;
  /** Why it matters, in the shop's terms — not a rule citation. */
  detail: string;
  ok: boolean;
  /** Where in the app to fix it. */
  fix: string;
};

function settingsChecks(s: Settings): Check[] {
  const filled = (v: string) => typeof v === 'string' && v.trim() !== '';

  return [
    {
      id: 'shop_name',
      severity: 'blocker',
      title: 'Shop name is still the placeholder',
      detail: 'Every bill prints "My Medical Store" until this is the real name of the shop.',
      ok: filled(s.shop_name) && s.shop_name !== 'My Medical Store',
      fix: 'Settings → Shop details',
    },
    {
      id: 'address',
      severity: 'blocker',
      title: 'Shop address is incomplete',
      detail: 'A tax invoice must carry the supplier\'s address and PIN code.',
      ok: filled(s.address_line1) && filled(s.city) && /^\d{6}$/.test(s.pincode.trim()),
      fix: 'Settings → Shop details',
    },
    {
      id: 'gstin',
      severity: 'blocker',
      title: 'GSTIN is not set',
      detail: 'Without it the bill is not a tax invoice, and the buyer cannot claim input credit. '
        + 'It also decides whether tax is split CGST/SGST or charged as IGST.',
      ok: filled(s.gstin) && isValidGstin(s.gstin),
      fix: 'Settings → Shop details',
    },
    {
      id: 'dl_form20',
      severity: 'blocker',
      title: 'Drug licence (Form 20) is not recorded',
      detail: 'The retail licence number for allopathic medicines has to appear on the bill.',
      ok: filled(s.dl_no_form20),
      fix: 'Settings → Shop details',
    },
    {
      id: 'dl_form21',
      severity: 'blocker',
      title: 'Drug licence (Form 21) is not recorded',
      detail: 'The second retail licence, covering the drugs listed in Schedule C and C1.',
      ok: filled(s.dl_no_form21),
      fix: 'Settings → Shop details',
    },
    {
      id: 'pharmacist',
      severity: 'blocker',
      title: 'Registered pharmacist is not named',
      detail: 'Schedule H1 supplies are signed for by the pharmacist on duty. The register is not '
        + 'valid without a name and a State Pharmacy Council registration number.',
      ok: filled(s.pharmacist_name) && filled(s.pharmacist_reg_no),
      fix: 'Settings → Shop details',
    },
    {
      id: 'fssai',
      severity: 'advisory',
      title: 'FSSAI licence is not recorded',
      detail: 'Needed only if the shop sells food items — protein powders, health drinks, baby food.',
      ok: filled(s.fssai_no),
      fix: 'Settings → Shop details',
    },
    {
      id: 'pan',
      severity: 'advisory',
      title: 'PAN is not recorded',
      detail: 'Convenient for the shop\'s accountant at the year end.',
      ok: filled(s.pan),
      fix: 'Settings → Shop details',
    },
  ];
}

/**
 * Answers cached by password hash.
 *
 * bcrypt is slow on purpose, and proving an account is *not* on a default means
 * running every candidate: ten hashes per account, about 170ms each way on shop
 * hardware. The dashboard asks for this on every load, so without a cache a
 * six-person shop pays a second of latency to draw a banner.
 *
 * Keying on the hash makes the cache self-invalidating — changing a password
 * changes the hash, so the old answer can never be served for a new password.
 */
const defaultPasswordCache = new Map<string, boolean>();

function usesDefaultPassword(hash: string): boolean {
  const cached = defaultPasswordCache.get(hash);
  if (cached !== undefined) return cached;

  const result = KNOWN_DEFAULTS.some((p) => bcrypt.compareSync(p, hash));
  // Bounded so a long-lived server with a lot of password churn cannot grow
  // this without limit.
  if (defaultPasswordCache.size > 500) defaultPasswordCache.clear();
  defaultPasswordCache.set(hash, result);
  return result;
}

/** Active accounts whose password is one this software shipped with. */
export function accountsOnDefaultPasswords(): Array<{ id: number; username: string; full_name: string; role: string }> {
  const users = getDb().prepare(
    'SELECT id, username, full_name, role, password_hash FROM users WHERE active = 1',
  ).all() as User[];

  return users
    .filter((u) => usesDefaultPassword(u.password_hash))
    .map(({ id, username, full_name, role }) => ({ id, username, full_name, role }));
}

readinessRouter.get('/', (_req, res) => {
  const db = getDb();
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Settings;

  const weak = accountsOnDefaultPasswords();
  const products = (db.prepare('SELECT COUNT(*) c FROM products WHERE active = 1').get() as { c: number }).c;
  const inStock = (db.prepare('SELECT COUNT(DISTINCT product_id) c FROM batches WHERE qty_units > 0 AND active = 1').get() as { c: number }).c;
  const realBills = (db.prepare("SELECT COUNT(*) c FROM sales WHERE status = 'COMPLETED'").get() as { c: number }).c;

  let backups = 0;
  try {
    backups = listBackups().length;
  } catch {
    // A missing backup directory just means none have been taken yet.
  }

  const checks: Check[] = [
    ...settingsChecks(settings),
    {
      id: 'default_passwords',
      severity: 'blocker',
      title: weak.length > 0
        ? `${weak.length} account${weak.length === 1 ? '' : 's'} still using a password this software shipped with`
        : 'No account is using a shipped password',
      detail: weak.length > 0
        ? `Anyone who has seen the setup guide can sign in as ${weak.map((u) => u.username).join(', ')}. `
          + 'Set a new password for each, or delete the ones the shop does not use.'
        : 'Checked against the passwords this software has shipped and demonstrated with.',
      ok: weak.length === 0,
      fix: 'Settings → Staff',
    },
    {
      id: 'catalogue',
      severity: 'blocker',
      title: 'No products in the catalogue',
      detail: 'Load the shop\'s product list before the counter opens.',
      ok: products > 0,
      fix: 'Import',
    },
    {
      id: 'stock',
      severity: 'blocker',
      title: 'No stock on hand',
      detail: 'Nothing can be billed until there is stock with a batch number and expiry against it.',
      ok: inStock > 0,
      fix: 'Import, or Purchases for goods inward',
    },
    {
      id: 'backup',
      severity: realBills > 0 ? 'blocker' : 'advisory',
      title: 'No backup has been taken',
      detail: 'The shop\'s entire billing and stock history is one file on one machine. '
        + 'Take a backup and keep a copy off this computer.',
      ok: backups > 0,
      fix: 'Settings → Backup',
    },
  ];

  const blockers = checks.filter((c) => c.severity === 'blocker');
  const outstanding = blockers.filter((c) => !c.ok);

  res.json({
    ready: outstanding.length === 0,
    counts: {
      blockers_outstanding: outstanding.length,
      blockers_total: blockers.length,
      advisories_outstanding: checks.filter((c) => c.severity === 'advisory' && !c.ok).length,
    },
    context: { products, products_in_stock: inStock, completed_bills: realBills, backups },
    weak_accounts: weak,
    checks,
  });
});
