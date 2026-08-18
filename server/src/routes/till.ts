/**
 * Opening and closing the cash drawer.
 *
 * A shop opens the till with a float, sells all day, and counts the money at
 * close. The difference between the count and what the software expected is the
 * one number this whole area exists to produce.
 *
 * Two rules shape everything here.
 *
 * The counter is never blocked. A customer is standing there; refusing to sell
 * because nobody performed a formality this morning would be the software
 * making the shop's problem worse. A sale with no session open therefore opens
 * one itself.
 *
 * But nothing is quietly assumed. A session opened by a sale rather than a
 * person has no recorded float, and its close says so instead of treating the
 * float as zero and reporting a shortfall that means nothing.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import { getDb, nowIso } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { expectedCashPaise, variancePaise, describeVariance } from '../lib/till.js';

export const tillRouter = Router();
tillRouter.use(requireAuth);

export type TillSession = {
  id: number;
  opened_at: string;
  opened_by: number | null;
  opening_float_paise: number;
  auto_opened: number;
  closed_at: string | null;
  closed_by: number | null;
  counted_paise: number | null;
  expected_paise: number | null;
  variance_paise: number | null;
  notes: string;
  status: 'OPEN' | 'CLOSED';
};

/** The session currently open, if any. */
export function openSession(db: Database): TillSession | undefined {
  return db.prepare("SELECT * FROM till_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1")
    .get() as TillSession | undefined;
}

/**
 * The session a sale should be attributed to, opening one if the shop began
 * trading without opening the till.
 *
 * Called from inside the billing transaction, so it must not throw for anything
 * short of a broken database — a sale is not the place to discover a policy.
 */
export function sessionForSale(db: Database, userId: number | null): number {
  const current = openSession(db);
  if (current) return current.id;

  const ts = nowIso();
  const info = db.prepare(
    `INSERT INTO till_sessions
       (opened_at, opened_by, opening_float_paise, auto_opened, status, created_at)
     VALUES (?,?,?,1,'OPEN',?)`,
  ).run(ts, userId, 0, ts);
  return Number(info.lastInsertRowid);
}

/** Every cash movement belonging to a session, netted. */
function componentsFor(db: Database, sessionId: number) {
  const cashSales = (db.prepare(
    `SELECT COALESCE(SUM(total_paise), 0) AS v FROM sales
      WHERE till_session_id = ? AND status = 'COMPLETED' AND payment_mode = 'CASH'`,
  ).get(sessionId) as { v: number }).v;

  // A refund follows the money out of the drawer only if the original bill was
  // paid in cash; a card sale is refunded to the card.
  const cashRefunds = (db.prepare(
    `SELECT COALESCE(SUM(r.total_paise), 0) AS v
       FROM sale_returns r
       JOIN sales s ON s.id = r.sale_id
      WHERE s.till_session_id = ? AND s.payment_mode = 'CASH'`,
  ).get(sessionId) as { v: number }).v;

  // Money collected against an account while this session was open.
  const session = db.prepare('SELECT opened_at, closed_at FROM till_sessions WHERE id = ?')
    .get(sessionId) as { opened_at: string; closed_at: string | null };
  const cashReceipts = (db.prepare(
    `SELECT COALESCE(SUM(amount_paise), 0) AS v FROM customer_receipts
      WHERE mode = 'CASH' AND created_at >= ? AND (? IS NULL OR created_at <= ?)`,
  ).get(session.opened_at, session.closed_at, session.closed_at) as { v: number }).v;

  const moves = db.prepare(
    `SELECT kind, COALESCE(SUM(amount_paise), 0) AS v
       FROM till_movements WHERE session_id = ? GROUP BY kind`,
  ).all(sessionId) as Array<{ kind: 'PAY_IN' | 'PAY_OUT'; v: number }>;

  const float = (db.prepare('SELECT opening_float_paise FROM till_sessions WHERE id = ?')
    .get(sessionId) as { opening_float_paise: number }).opening_float_paise;

  return {
    opening_float_paise: float,
    cash_sales_paise: cashSales,
    cash_refunds_paise: cashRefunds,
    cash_receipts_paise: cashReceipts,
    pay_in_paise: moves.find((m) => m.kind === 'PAY_IN')?.v ?? 0,
    pay_out_paise: moves.find((m) => m.kind === 'PAY_OUT')?.v ?? 0,
  };
}

/** Everything a counter or a close screen needs about a session. */
function describeSession(db: Database, session: TillSession) {
  const components = componentsFor(db, session.id);
  const expected = expectedCashPaise(components);

  const nonCash = db.prepare(
    `SELECT payment_mode AS mode, COALESCE(SUM(total_paise), 0) AS v, COUNT(*) AS n
       FROM sales
      WHERE till_session_id = ? AND status = 'COMPLETED' AND payment_mode <> 'CASH'
      GROUP BY payment_mode`,
  ).all(session.id) as Array<{ mode: string; v: number; n: number }>;

  const bills = (db.prepare(
    "SELECT COUNT(*) AS n FROM sales WHERE till_session_id = ? AND status = 'COMPLETED'",
  ).get(session.id) as { n: number }).n;

  const drawerOpens = (db.prepare(
    'SELECT COUNT(*) AS n FROM drawer_opens WHERE session_id = ?',
  ).get(session.id) as { n: number }).n;

  return {
    ...session,
    components,
    expected_paise: session.status === 'CLOSED' ? session.expected_paise : expected,
    bills,
    non_cash: nonCash,
    drawer_opens_without_a_sale: drawerOpens,
    movements: db.prepare(
      `SELECT m.*, u.full_name AS by_name FROM till_movements m
         LEFT JOIN users u ON u.id = m.by_user
        WHERE m.session_id = ? ORDER BY m.id`,
    ).all(session.id),
  };
}

// ---------------------------------------------------------------------------

tillRouter.get('/current', (_req, res) => {
  const db = getDb();
  const session = openSession(db);
  if (!session) {
    res.json({ open: false, session: null });
    return;
  }
  res.json({ open: true, session: describeSession(db, session) });
});

const openSchema = z.object({
  opening_float_paise: z.number().int().min(0).max(100_000_00),
});

tillRouter.post('/open', (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const db = getDb();
  const existing = openSession(db);

  if (existing && !existing.auto_opened) {
    res.status(400).json({
      error: 'The till is already open. Close it before opening a new one.',
    });
    return;
  }

  const ts = nowIso();

  // A session the first sale created can still be given its float, which is
  // what the shop meant to do before the customer walked in.
  if (existing?.auto_opened) {
    db.prepare(
      `UPDATE till_sessions
          SET opening_float_paise = ?, opened_by = ?, auto_opened = 0
        WHERE id = ?`,
    ).run(parsed.data.opening_float_paise, req.user?.id ?? null, existing.id);
    res.json({ ...describeSession(db, openSession(db)!), adopted: true });
    return;
  }

  const info = db.prepare(
    `INSERT INTO till_sessions
       (opened_at, opened_by, opening_float_paise, auto_opened, status, created_at)
     VALUES (?,?,?,0,'OPEN',?)`,
  ).run(ts, req.user?.id ?? null, parsed.data.opening_float_paise, ts);

  const session = db.prepare('SELECT * FROM till_sessions WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as TillSession;
  res.status(201).json(describeSession(db, session));
});

const movementSchema = z.object({
  kind: z.enum(['PAY_IN', 'PAY_OUT']),
  amount_paise: z.number().int().positive('An amount is required'),
  reason: z.string().min(3, 'Say what the money was for'),
});

tillRouter.post('/movement', (req, res) => {
  const parsed = movementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const db = getDb();
  const session = openSession(db);
  if (!session) {
    res.status(400).json({ error: 'The till is not open, so there is nothing to add to.' });
    return;
  }
  const d = parsed.data;
  db.prepare(
    `INSERT INTO till_movements (session_id, kind, amount_paise, reason, by_user, at)
     VALUES (?,?,?,?,?,?)`,
  ).run(session.id, d.kind, d.amount_paise, d.reason.trim(), req.user?.id ?? null, nowIso());

  res.status(201).json(describeSession(db, session));
});

/**
 * Record that the drawer was sprung outside a sale.
 *
 * The kick itself happens on the machine with the printer attached; this is the
 * record of it. Asking for a reason is the point: a drawer that opens without a
 * bill behind it is the ordinary route by which cash leaves a shop, and a list
 * of those moments with names against them is what makes it answerable.
 */
const drawerSchema = z.object({
  reason: z.string().min(3, 'Say why the drawer was opened'),
});

tillRouter.post('/drawer-open', (req, res) => {
  const parsed = drawerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const db = getDb();
  db.prepare(
    'INSERT INTO drawer_opens (session_id, reason, by_user, at) VALUES (?,?,?,?)',
  ).run(openSession(db)?.id ?? null, parsed.data.reason.trim(), req.user?.id ?? null, nowIso());
  res.status(201).json({ ok: true });
});

const closeSchema = z.object({
  counted_paise: z.number().int().min(0, 'Count the drawer before closing'),
  notes: z.string().default(''),
});

tillRouter.post('/close', requireRole('admin', 'pharmacist'), (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const db = getDb();
  const session = openSession(db);
  if (!session) {
    res.status(400).json({ error: 'The till is not open.' });
    return;
  }

  const components = componentsFor(db, session.id);
  const expected = expectedCashPaise(components);
  const counted = parsed.data.counted_paise;
  const variance = variancePaise(counted, expected);
  const ts = nowIso();

  db.prepare(
    `UPDATE till_sessions
        SET closed_at = ?, closed_by = ?, counted_paise = ?, expected_paise = ?,
            variance_paise = ?, notes = ?, status = 'CLOSED'
      WHERE id = ?`,
  ).run(ts, req.user?.id ?? null, counted, expected, variance,
    parsed.data.notes.trim(), session.id);

  const closed = db.prepare('SELECT * FROM till_sessions WHERE id = ?')
    .get(session.id) as TillSession;

  res.json({
    ...describeSession(db, closed),
    variance: describeVariance(variance),
    // A float nobody recorded makes the variance meaningless, and saying so is
    // more useful than reporting a shortfall the size of the morning's float.
    float_was_never_recorded: session.auto_opened === 1,
  });
});

/** Past sessions, newest first — the shop's cash history. */
tillRouter.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const rows = getDb().prepare(
    `SELECT t.*, o.full_name AS opened_by_name, c.full_name AS closed_by_name,
            (SELECT COUNT(*) FROM sales s
              WHERE s.till_session_id = t.id AND s.status = 'COMPLETED') AS bills
       FROM till_sessions t
       LEFT JOIN users o ON o.id = t.opened_by
       LEFT JOIN users c ON c.id = t.closed_by
      WHERE t.status = 'CLOSED'
      ORDER BY t.id DESC LIMIT ?`,
  ).all(limit);
  res.json(rows);
});

/** Drawer opens with no sale behind them, for the owner to look over. */
tillRouter.get('/drawer-opens', requireRole('admin', 'pharmacist'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = getDb().prepare(
    `SELECT d.*, u.full_name AS by_name FROM drawer_opens d
       LEFT JOIN users u ON u.id = d.by_user
      ORDER BY d.id DESC LIMIT ?`,
  ).all(limit);
  res.json(rows);
});
