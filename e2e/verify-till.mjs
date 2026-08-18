/**
 * Opening and closing the cash drawer.
 *
 * The point of this feature is one subtraction — counted less expected — so the
 * test rings up real bills in several payment modes, moves cash in and out, and
 * checks the expected figure moved by exactly the right amount each time. A till
 * that quietly counts a UPI sale as cash would have a shop hunting a shortfall
 * that never existed.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:4000';
const SHOT = fileURLToPath(new URL('./screenshots/till', import.meta.url));
mkdirSync(SHOT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const consoleErrors = [];
// Several checks below deliberately send a bad request — a movement with no
// reason, a drawer opened without one — and the browser logs each 400 as a
// failed resource. Those are the checks working.
page.on('console', (m) => {
  if (m.type() === 'error' && !/400|Bad Request/.test(m.text())) consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#username', 'admin');
await page.fill('#password', 'admin123');
await page.click('button[type=submit]');
await page.waitForURL(/\/billing/, { timeout: 20000 });

/** Call the API as the signed-in user. */
const call = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('pharmacypos.token')}`,
      ...(opts.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { path, opts });

// Any session left open by an earlier run would carry its takings into this one.
const existing = await call('/till/current');
if (existing.body?.open) {
  await call('/till/close', { method: 'POST', body: JSON.stringify({ counted_paise: 0, notes: 'cleared by test' }) });
}

console.log('\nOpening the till');
const opened = await call('/till/open', {
  method: 'POST', body: JSON.stringify({ opening_float_paise: 200000 }),
});
check('the till opens with a float', opened.status === 201, JSON.stringify(opened.body).slice(0, 80));
check('and expects exactly the float before any trading',
  opened.body?.expected_paise === 200000, String(opened.body?.expected_paise));
check('opening it twice is refused',
  (await call('/till/open', { method: 'POST', body: JSON.stringify({ opening_float_paise: 500 }) })).status === 400);

// ---- Bills in different payment modes --------------------------------------
console.log('\nRinging up bills');
const fixture = await page.evaluate(async () => {
  const h = { Authorization: `Bearer ${localStorage.getItem('pharmacypos.token')}` };
  const rows = await (await fetch('/api/products?limit=200&inStock=true', { headers: h })).json();
  const list = rows.data ?? rows;
  for (const p of list.filter((p) => p.schedule_type === 'OTC' && p.stock_units > 40)) {
    const b = await (await fetch(`/api/products/${p.id}/batches`, { headers: h })).json();
    const first = (b.data ?? b)[0];
    if (first && first.qty_units >= p.pack_size * 2) return { id: p.id, pack: p.pack_size };
  }
  return null;
});
check('found an over-the-counter product with stock to bill', !!fixture, String(fixture));

const bill = async (mode) => call('/sales', {
  method: 'POST',
  body: JSON.stringify({
    items: [{ product_id: fixture.id, qty_units: fixture.pack }],
    payment_mode: mode,
    customer_name: 'Till Test',
  }),
});

const cashBill = await bill('CASH');
check('a cash bill is created', cashBill.status === 201, cashBill.body?.error ?? '');
const cashTotal = cashBill.body?.total_paise ?? 0;

const upiBill = await bill('UPI');
check('a UPI bill is created', upiBill.status === 201, upiBill.body?.error ?? '');
const upiTotal = upiBill.body?.total_paise ?? 0;

const after = await call('/till/current');
const expectedAfterBills = after.body?.session?.expected_paise;
check('cash taken over the counter raises what the drawer should hold',
  expectedAfterBills === 200000 + cashTotal,
  `expected ${200000 + cashTotal}, got ${expectedAfterBills}`);
check('the UPI bill does NOT — that money never reached the drawer',
  expectedAfterBills !== 200000 + cashTotal + upiTotal,
  `UPI ${upiTotal} must be excluded`);
check('but the UPI takings are still shown, just not as cash',
  (after.body?.session?.non_cash ?? []).some((m) => m.mode === 'UPI' && m.v >= upiTotal));
check('both bills are counted against the session', after.body?.session?.bills >= 2);

// ---- Cash in and out --------------------------------------------------------
console.log('\nMoving cash');
await call('/till/movement', {
  method: 'POST', body: JSON.stringify({ kind: 'PAY_IN', amount_paise: 50000, reason: 'Change brought in' }),
});
await call('/till/movement', {
  method: 'POST', body: JSON.stringify({ kind: 'PAY_OUT', amount_paise: 30000, reason: 'Paid the courier' }),
});
const moved = await call('/till/current');
check('cash in and out move the expected figure by exactly their amounts',
  moved.body?.session?.expected_paise === expectedAfterBills + 50000 - 30000,
  `${moved.body?.session?.expected_paise} vs ${expectedAfterBills + 20000}`);
check('a movement with no reason is refused',
  (await call('/till/movement', {
    method: 'POST', body: JSON.stringify({ kind: 'PAY_OUT', amount_paise: 100, reason: '' }),
  })).status === 400);

// ---- Opening the drawer without a sale --------------------------------------
console.log('\nOpening the drawer without a sale');
const noSale = await call('/till/drawer-open', {
  method: 'POST', body: JSON.stringify({ reason: 'Change for a UPI customer' }),
});
check('a no-sale drawer open is recorded', noSale.status === 201);
check('opening it with no reason given is refused',
  (await call('/till/drawer-open', { method: 'POST', body: JSON.stringify({ reason: '' }) })).status === 400);

const opens = await call('/till/drawer-opens');
check('the record names who opened it and why',
  (opens.body ?? []).some((d) => d.reason.includes('Change for a UPI customer') && d.by_name));

// ---- Counting and closing, through the screen -------------------------------
console.log('\nCounting the drawer');
await page.goto(`${BASE}/till`, { waitUntil: 'networkidle' });
await page.waitForSelector('#expected', { timeout: 20000 });

const expectedOnScreen = await page.locator('#expected').innerText();
const expectedPaise = moved.body.session.expected_paise;
check('the screen shows what the drawer should hold',
  expectedOnScreen.replace(/[^\d]/g, '') === String(expectedPaise),
  `${expectedOnScreen} vs ${expectedPaise}`);

// Count exactly right, in notes.
const target = expectedPaise;
let left = target;
for (const d of [500, 200, 100, 50, 20, 10, 5, 2, 1]) {
  const n = Math.floor(left / (d * 100));
  if (n > 0) {
    await page.locator(`input[data-denom="${d}"]`).fill(String(n));
    left -= n * d * 100;
  }
}
await page.waitForTimeout(400);
/** "₹14,700.00" -> 1470000 paise, sign included. */
const paiseOnScreen = (text) => {
  const negative = /[-−]/.test(text);
  const digits = Number(text.replace(/[^\d.]/g, '')) || 0;
  return Math.round(digits * 100) * (negative ? -1 : 1);
};

check('counting note by note reaches the same figure',
  paiseOnScreen(await page.locator('#counted').innerText()) === target - left,
  await page.locator('#counted').innerText());
check('and the difference is exactly what is still uncounted',
  paiseOnScreen(await page.locator('#difference').innerText()) === -left,
  `${await page.locator('#difference').innerText()} with ${left} paise left uncounted`);
await page.screenshot({ path: join(SHOT, '01-counting.png'), fullPage: true });

await page.locator('#closetill').click();
await page.waitForSelector('text=/balances exactly|short|over/', { timeout: 20000 });
const verdict = await page.locator('body').innerText();
check('closing reports the verdict in the shop\'s own words',
  /balances exactly|short|over/.test(verdict));
await page.screenshot({ path: join(SHOT, '02-closed.png'), fullPage: true });

const afterClose = await call('/till/current');
check('the till is closed afterwards', afterClose.body?.open === false);

const history = await call('/till/history');
check('the closed session is in the history with its variance',
  (history.body ?? []).some((h) => h.expected_paise === expectedPaise));

// ---- A sale with no till open must never be blocked -------------------------
console.log('\nSelling with the till shut');
const blind = await bill('CASH');
check('a bill still goes through with no till open', blind.status === 201, blind.body?.error ?? '');
const reopened = await call('/till/current');
check('and a session is opened for it rather than losing the money',
  reopened.body?.open === true);
check('flagged as opened by a sale, not by a person',
  reopened.body?.session?.auto_opened === 1);
check('with the takings already counted in it',
  reopened.body?.session?.components?.cash_sales_paise >= (blind.body?.total_paise ?? 1));

// The owner can still give it its float afterwards.
const adopted = await call('/till/open', {
  method: 'POST', body: JSON.stringify({ opening_float_paise: 100000 }),
});
check('the morning float can be recorded after the fact', adopted.status === 200);
check('and the session stops being flagged as unopened',
  adopted.body?.auto_opened === 0, String(adopted.body?.auto_opened));

await call('/till/close', { method: 'POST', body: JSON.stringify({ counted_paise: 0, notes: 'test teardown' }) });

check('no uncaught console errors', consoleErrors.length === 0, consoleErrors[0] ?? '');

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${failures.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await browser.close();
process.exit(fail ? 1 : 0);
