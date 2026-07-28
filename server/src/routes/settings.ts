import { Router } from 'express';
import { z } from 'zod';
import { getDb, nowIso } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { isValidGstin, STATE_CODES } from '../lib/gst.js';
import { audit } from '../lib/audit.js';
import type { Settings } from '../types.js';

export const settingsRouter = Router();

/** Shop particulars are printed on every invoice, so any signed-in user reads them. */
settingsRouter.get('/', requireAuth, (_req, res) => {
  res.json(getDb().prepare('SELECT * FROM settings WHERE id = 1').get());
});

settingsRouter.get('/states', (_req, res) => {
  res.json(Object.entries(STATE_CODES).map(([code, name]) => ({ code, name })));
});

const settingsSchema = z.object({
  shop_name: z.string().min(1, 'Shop name is required'),
  legal_name: z.string().default(''),
  address_line1: z.string().default(''),
  address_line2: z.string().default(''),
  city: z.string().default('Hyderabad'),
  state: z.string().default('Telangana'),
  state_code: z.string().default('36'),
  pincode: z.string().default(''),
  phone: z.string().default(''),
  email: z.string().default(''),
  gstin: z.string().default(''),
  pan: z.string().default(''),
  dl_no_form20: z.string().default(''),
  dl_no_form21: z.string().default(''),
  fssai_no: z.string().default(''),
  pharmacist_name: z.string().default(''),
  pharmacist_reg_no: z.string().default(''),
  invoice_prefix: z.string().default('INV'),
  return_prefix: z.string().default('CN'),
  invoice_footer: z.string().default(''),
  round_off_enabled: z.boolean().default(true),
  expiry_alert_days: z.number().int().min(0).max(365).default(90),
  low_stock_enabled: z.boolean().default(true),
}).partial().refine((d) => !d.gstin || isValidGstin(d.gstin), {
  message: 'That GSTIN is not valid',
  path: ['gstin'],
});

settingsRouter.put('/', requireAuth, requireRole('admin'), (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const db = getDb();
  const existing = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Settings;
  const d = parsed.data;

  // A GSTIN embeds its state code; a mismatch would misclassify every supply
  // as inter-state and put the tax in the wrong column.
  const gstin = (d.gstin ?? existing.gstin).toUpperCase();
  const stateCode = d.state_code ?? existing.state_code;
  if (gstin && gstin.slice(0, 2) !== stateCode) {
    res.status(400).json({
      error: `GSTIN starts with ${gstin.slice(0, 2)} but the state code is ${stateCode} — they must match`,
    });
    return;
  }

  db.prepare(
    `UPDATE settings SET shop_name=?, legal_name=?, address_line1=?, address_line2=?, city=?,
       state=?, state_code=?, pincode=?, phone=?, email=?, gstin=?, pan=?, dl_no_form20=?,
       dl_no_form21=?, fssai_no=?, pharmacist_name=?, pharmacist_reg_no=?, invoice_prefix=?,
       return_prefix=?, invoice_footer=?, round_off_enabled=?, expiry_alert_days=?,
       low_stock_enabled=?, updated_at=? WHERE id=1`,
  ).run(
    d.shop_name ?? existing.shop_name, d.legal_name ?? existing.legal_name,
    d.address_line1 ?? existing.address_line1, d.address_line2 ?? existing.address_line2,
    d.city ?? existing.city, d.state ?? existing.state, stateCode,
    d.pincode ?? existing.pincode, d.phone ?? existing.phone, d.email ?? existing.email,
    gstin, (d.pan ?? existing.pan).toUpperCase(),
    d.dl_no_form20 ?? existing.dl_no_form20, d.dl_no_form21 ?? existing.dl_no_form21,
    d.fssai_no ?? existing.fssai_no, d.pharmacist_name ?? existing.pharmacist_name,
    d.pharmacist_reg_no ?? existing.pharmacist_reg_no,
    d.invoice_prefix ?? existing.invoice_prefix, d.return_prefix ?? existing.return_prefix,
    d.invoice_footer ?? existing.invoice_footer,
    d.round_off_enabled === undefined ? existing.round_off_enabled : d.round_off_enabled ? 1 : 0,
    d.expiry_alert_days ?? existing.expiry_alert_days,
    d.low_stock_enabled === undefined ? existing.low_stock_enabled : d.low_stock_enabled ? 1 : 0,
    nowIso(),
  );

  audit(req.user!.id, req.user!.username, 'UPDATE_SETTINGS', 'settings', 1, '');
  res.json(db.prepare('SELECT * FROM settings WHERE id = 1').get());
});
