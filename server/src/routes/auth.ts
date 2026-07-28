import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb, nowIso } from '../db/index.js';
import { signToken, requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import type { User } from '../types.js';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  const db = getDb();
  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
    .get(parsed.data.username.trim().toLowerCase()) as User | undefined;

  // Same message either way — do not reveal which usernames exist.
  if (!user || !bcrypt.compareSync(parsed.data.password, user.password_hash)) {
    res.status(401).json({ error: 'Incorrect username or password' });
    return;
  }

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);

  const payload = {
    id: user.id, username: user.username, role: user.role, full_name: user.full_name,
  };
  audit(user.id, user.username, 'LOGIN', 'users', user.id, '');
  res.json({
    token: signToken(payload),
    user: { ...payload, pharmacist_reg_no: user.pharmacist_reg_no },
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const user = db
    .prepare('SELECT id, username, full_name, role, pharmacist_reg_no, phone, last_login_at FROM users WHERE id = ?')
    .get(req.user!.id);
  if (!user) {
    res.status(404).json({ error: 'User no longer exists' });
    return;
  }
  res.json(user);
});

authRouter.post('/change-password', requireAuth, (req, res) => {
  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(6, 'New password must be at least 6 characters'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as User | undefined;
  if (!user || !bcrypt.compareSync(parsed.data.currentPassword, user.password_hash)) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(parsed.data.newPassword, 10), user.id);
  audit(user.id, user.username, 'CHANGE_PASSWORD', 'users', user.id, '');
  res.json({ ok: true });
});

// --- User administration -----------------------------------------------------

export const usersRouter = Router();
usersRouter.use(requireAuth, requireRole('admin'));

usersRouter.get('/', (_req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT id, username, full_name, role, pharmacist_reg_no, phone, active, last_login_at, created_at
     FROM users ORDER BY active DESC, full_name`,
  ).all());
});

const userSchema = z.object({
  username: z.string().min(3).max(40),
  password: z.string().min(6),
  full_name: z.string().min(1),
  role: z.enum(['admin', 'pharmacist', 'cashier']),
  pharmacist_reg_no: z.string().default(''),
  phone: z.string().default(''),
});

usersRouter.post('/', (req, res) => {
  const parsed = userSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const d = parsed.data;
  const db = getDb();
  const username = d.username.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    res.status(409).json({ error: 'That username is already taken' });
    return;
  }
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, pharmacist_reg_no, phone, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(username, bcrypt.hashSync(d.password, 10), d.full_name, d.role,
    d.pharmacist_reg_no, d.phone, nowIso());

  audit(req.user!.id, req.user!.username, 'CREATE_USER', 'users', Number(info.lastInsertRowid), username);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

usersRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({
    full_name: z.string().min(1).optional(),
    role: z.enum(['admin', 'pharmacist', 'cashier']).optional(),
    pharmacist_reg_no: z.string().optional(),
    phone: z.string().optional(),
    active: z.boolean().optional(),
    password: z.string().min(6).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const d = parsed.data;

  // Never let the last active admin lock everyone out of the system.
  const losingAdmin = (d.role && d.role !== 'admin') || d.active === false;
  if (existing.role === 'admin' && losingAdmin) {
    const others = db.prepare(
      "SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
    ).get(id) as { c: number };
    if (others.c === 0) {
      res.status(400).json({ error: 'This is the last active admin — promote another user first' });
      return;
    }
  }

  db.prepare(
    `UPDATE users SET full_name = ?, role = ?, pharmacist_reg_no = ?, phone = ?, active = ?,
       password_hash = ? WHERE id = ?`,
  ).run(
    d.full_name ?? existing.full_name,
    d.role ?? existing.role,
    d.pharmacist_reg_no ?? existing.pharmacist_reg_no,
    d.phone ?? existing.phone,
    d.active === undefined ? existing.active : d.active ? 1 : 0,
    d.password ? bcrypt.hashSync(d.password, 10) : existing.password_hash,
    id,
  );
  audit(req.user!.id, req.user!.username, 'UPDATE_USER', 'users', id, existing.username);
  res.json({ ok: true });
});
