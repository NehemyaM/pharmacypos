/**
 * Verification of the catalogue importer and the go-live checklist.
 *
 * Drives the API for the import rules (they are the part that can silently
 * corrupt a shop's stock) and the browser for the screens.
 *
 *   node e2e/verify-import-and-golive.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = process.env.API ?? 'http://localhost:4000';
// Defaults to the single-process build, which serves the UI and the API
// together — the same thing a shop runs. Point BASE at :5173 to drive the Vite
// dev server instead.
const BASE = process.env.BASE ?? 'http://localhost:4000';
const SHOT = fileURLToPath(new URL('./screenshots/import', import.meta.url));
mkdirSync(SHOT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

// ---- API -------------------------------------------------------------------

async function token(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  return body.token;
}

const admin = await token('admin', 'admin123');
const cashier = await token('cashier', 'cash123');

async function preview(csv, commit = false, auth = admin) {
  const res = await fetch(`${API}/api/import/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ csv, commit }),
  });
  return { status: res.status, body: await res.json() };
}

const messagesOf = (r) => r.body.rows.flatMap((x) => x.messages.map((m) => m.text)).join(' | ');
const stamp = Date.now();

console.log('\nImport — permissions');
{
  const r = await preview('name\nX');
  check('an owner may import', r.status === 200);
  const c = await preview('name\nX', false, cashier);
  check('a cashier may not', c.status === 403, String(c.status));
}

console.log('\nImport — reading the file');
{
  const r = await preview('Product Name,Pack Size,GST %\r\nTest Widget,10,5\r\n');
  check('matches column names loosely', r.status === 200 && r.body.summary.rows === 1,
    JSON.stringify(r.body.summary ?? r.body));
  check('reads the pack size from "Pack Size"', r.body.rows?.[0]?.product.pack_size === 10);

  const missing = await preview('sku,qty\n123,5');
  check('refuses a file with no name column', missing.status === 400
    && /name column/i.test(missing.body.error), missing.body.error);

  const empty = await preview('name\n');
  check('refuses a header with no rows under it', empty.status === 400, empty.body.error);

  const quoted = await preview('name,pack_label\n"Widget, large","Strip of 10, blister"');
  check('keeps commas inside quoted cells', quoted.body.rows?.[0]?.product.name === 'Widget, large',
    quoted.body.rows?.[0]?.product.name);
}

console.log('\nImport — expiry formats a distributor actually sends');
{
  const csv = [
    'name,batch_no,expiry,mrp,qty_packs',
    'Exp A,B1,2028-06,10,1',
    'Exp B,B2,06/2028,10,1',
    'Exp C,B3,JUN-2028,10,1',
    'Exp D,B4,06-28,10,1',
    'Exp E,B5,202806,10,1',
  ].join('\n');
  const r = await preview(csv);
  const expiries = r.body.rows.map((x) => x.stock?.expiry);
  check('all five spellings normalise to 2028-06',
    expiries.every((e) => e === '2028-06'), expiries.join(','));

  const bad = await preview('name,batch_no,expiry,mrp,qty_packs\nExp F,B6,next year,10,1');
  check('refuses an expiry it cannot read rather than guessing',
    bad.body.summary.errors === 1 && /is not a date/.test(messagesOf(bad)), messagesOf(bad));

  const past = await preview('name,batch_no,expiry,mrp,qty_packs\nExp G,B7,2020-01,10,1');
  check('refuses stock that has already expired',
    past.body.summary.errors === 1 && /already passed/.test(messagesOf(past)), messagesOf(past));
}

console.log('\nImport — validation that protects the shop');
{
  const overMrp = await preview('name,batch_no,expiry,mrp,sale_rate,qty_packs\nOver,B1,2028-06,50,60,1');
  check('refuses a selling rate above MRP',
    overMrp.body.summary.errors === 1 && /Legal Metrology/.test(messagesOf(overMrp)),
    messagesOf(overMrp));

  const loss = await preview('name,gst_rate,batch_no,expiry,mrp,purchase_rate,qty_packs\nLoss,5,B1,2028-06,50,49,1');
  check('warns when the cost exceeds MRP net of GST',
    loss.body.summary.warnings >= 1 && /loss/.test(messagesOf(loss)), messagesOf(loss));

  const gst12 = await preview('name,hsn_code,gst_rate\nOld Rate,3004,12');
  check('warns that 12% no longer applies to medicines',
    /withdrawn 22-Sep-2025/.test(messagesOf(gst12)), messagesOf(gst12));

  const gst12dev = await preview('name,hsn_code,gst_rate\nDevice,9018,12');
  check('but accepts 12% on a device without complaint',
    gst12dev.body.summary.warnings === 0 && gst12dev.body.summary.errors === 0,
    messagesOf(gst12dev));

  const badGst = await preview('name,gst_rate\nBad,7');
  check('refuses a GST rate that is not a real slab',
    badGst.body.summary.errors === 1, messagesOf(badGst));

  const badSchedule = await preview('name,schedule_type\nBad,Z9');
  check('refuses an unknown drug schedule', badSchedule.body.summary.errors === 1,
    messagesOf(badSchedule));

  const noBatch = await preview('name,mrp,qty_packs\nNoBatch,50,2');
  check('refuses opening stock with no batch number',
    /batch number/.test(messagesOf(noBatch)), messagesOf(noBatch));

  const noQty = await preview('name,batch_no,expiry,mrp\nNoQty,B1,2028-06,50');
  check('refuses opening stock with no quantity',
    /quantity/.test(messagesOf(noQty)), messagesOf(noQty));

  const dupBatch = await preview([
    'name,batch_no,expiry,mrp,qty_packs',
    'Dup Line,B9,2028-06,50,1',
    'Dup Line,B9,2028-06,50,1',
  ].join('\n'));
  check('refuses the same batch twice in one file',
    /also on line/.test(messagesOf(dupBatch)), messagesOf(dupBatch));

  const noStockCols = await preview('name,manufacturer\nCatalogue Only,Acme');
  check('a row with no stock columns is a product-only row',
    noStockCols.body.rows[0].stock === null && noStockCols.body.summary.errors === 0);
}

console.log('\nImport — nothing is written until it is all valid');
{
  const name = `Atomic Test ${stamp}`;
  const csv = [
    'name,manufacturer,pack_size,gst_rate,batch_no,expiry,mrp,purchase_rate,qty_packs',
    `${name},Acme Labs,10,5,AT1,2028-06,100,70,5`,
    'Broken Row,Acme Labs,10,5,AT2,not-a-date,100,70,5',
  ].join('\n');

  const r = await preview(csv, true);
  check('a file with one bad row is refused outright', r.status === 400, String(r.status));
  check('and says so in plain words', /nothing was imported/i.test(r.body.error), r.body.error);

  const search = await fetch(`${API}/api/products?q=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${admin}` },
  }).then((x) => x.json());
  check('the good row from that file was not written either', search.length === 0,
    `${search.length} found`);
}

console.log('\nImport — a clean file');
let importedName = '';
{
  importedName = `Importest Tablet ${stamp}`;
  const csv = [
    'name,generic_name,manufacturer,category,schedule_type,hsn_code,gst_rate,unit,pack_size,pack_label,rack,reorder_level,batch_no,expiry,mrp,purchase_rate,qty_packs',
    `${importedName},Testolol 10mg,Acme Labs,TEST,H1,3004,5,TAB,10,Strip of 10,Z9,50,IT${stamp},2029-03,120.00,86.40,7`,
    `Importest Syrup ${stamp},Testolol 5mg/5ml,Acme Labs,TEST,OTC,3004,5,BOTTLE,1,60 ml bottle,Z9,4,IS${stamp},2029-01,88.50,63.20,6`,
  ].join('\n');

  const dry = await preview(csv);
  check('preview reports two new products',
    dry.body.summary.products_new === 2 && dry.body.summary.products_updated === 0,
    JSON.stringify(dry.body.summary));
  check('preview counts the units it would add',
    dry.body.summary.units === 7 * 10 + 6, String(dry.body.summary.units));
  check('preview values the opening stock at cost',
    dry.body.summary.stock_value_paise === 7 * 8640 + 6 * 6320,
    String(dry.body.summary.stock_value_paise));
  check('preview finds no problems', dry.body.summary.errors === 0, messagesOf(dry));
  check('and writes nothing', dry.body.committed === false);

  const committed = await preview(csv, true);
  check('the import commits', committed.status === 200 && committed.body.committed === true,
    JSON.stringify(committed.body.error ?? ''));
  check('it reports what it wrote',
    committed.body.written.created === 2 && committed.body.written.batches === 2
      && committed.body.written.units === 76,
    JSON.stringify(committed.body.written));

  const found = await fetch(`${API}/api/products?q=${encodeURIComponent(importedName)}`, {
    headers: { Authorization: `Bearer ${admin}` },
  }).then((x) => x.json());
  check('the product is searchable straight away', found.length === 1, `${found.length} found`);
  check('with its stock on hand', found[0]?.stock_units === 70, String(found[0]?.stock_units));
  check('and its Schedule H1 classification kept', found[0]?.schedule_type === 'H1',
    found[0]?.schedule_type);
  check('MRP came through as paise', found[0]?.mrp_paise === 12000, String(found[0]?.mrp_paise));
}

console.log('\nImport — re-running the same file cannot double the stock');
{
  const csv = [
    'name,manufacturer,pack_size,gst_rate,batch_no,expiry,mrp,purchase_rate,qty_packs',
    `${importedName},Acme Labs,10,5,IT${stamp},2029-03,120.00,86.40,7`,
  ].join('\n');

  const again = await preview(csv);
  check('the existing product is an update, not a duplicate',
    again.body.summary.products_updated === 1 && again.body.summary.products_new === 0,
    JSON.stringify(again.body.summary));
  check('the batch is recognised as already in stock',
    again.body.summary.batches_already_present === 1 && again.body.summary.batches_new === 0,
    JSON.stringify(again.body.summary));
  check('and it says why it is leaving it alone',
    /cannot double it/.test(messagesOf(again)), messagesOf(again));

  await preview(csv, true);
  const after = await fetch(`${API}/api/products?q=${encodeURIComponent(importedName)}`, {
    headers: { Authorization: `Bearer ${admin}` },
  }).then((x) => x.json());
  check('stock is unchanged after importing the same file twice',
    after[0]?.stock_units === 70, String(after[0]?.stock_units));
}

console.log('\nImport — the imported stock can actually be billed');
{
  const found = await fetch(`${API}/api/products?q=${encodeURIComponent(importedName)}`, {
    headers: { Authorization: `Bearer ${admin}` },
  }).then((x) => x.json());
  const batches = await fetch(`${API}/api/products/${found[0].id}/batches`, {
    headers: { Authorization: `Bearer ${admin}` },
  }).then((x) => x.json());
  check('the imported batch is dispensable under FEFO', batches.length === 1,
    `${batches.length} batches`);

  // H1, so it needs a prescriber and a patient — bill one full strip.
  const doctors = await fetch(`${API}/api/doctors`, {
    headers: { Authorization: `Bearer ${admin}` },
  }).then((x) => x.json());

  const sale = await fetch(`${API}/api/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
    body: JSON.stringify({
      customer_name: 'Import Test Buyer',
      doctor_id: doctors[0]?.id,
      prescription_no: `RX-${stamp}`,
      patient_name: 'Test Patient',
      patient_address: 'Habsiguda, Hyderabad',
      payment_mode: 'CASH',
      items: [{ product_id: found[0].id, batch_id: batches[0].id, qty_units: 10 }],
    }),
  });
  const bill = await sale.json();
  check('a bill can be raised against imported stock', sale.status === 201,
    JSON.stringify(bill.error ?? ''));
  // MRP is tax inclusive, so a full strip must bill at exactly its MRP.
  check('a full strip bills at exactly the imported MRP', bill.total_paise === 12000,
    String(bill.total_paise));
}

// ---- Go-live checklist ------------------------------------------------------

console.log('\nGo-live checklist');
{
  const res = await fetch(`${API}/api/readiness`, { headers: { Authorization: `Bearer ${admin}` } });
  const r = await res.json();
  check('the owner can read the checklist', res.status === 200);
  check('it names the accounts still on a shipped password',
    r.weak_accounts.some((u) => u.username === 'admin'),
    r.weak_accounts.map((u) => u.username).join(','));
  check('every check says where to fix it', r.checks.every((c) => c.fix && c.detail));
  // A green tick beside "GSTIN is not set" reads as a contradiction, so each
  // check carries a separate wording for the satisfied state.
  check('a passing check is worded as satisfied, not as a problem',
    r.checks.every((c) => c.titleOk && c.titleOk !== c.title)
      && r.checks.find((c) => c.id === 'gstin')?.titleOk === 'GSTIN is set and valid');
  check('it counts outstanding blockers',
    r.counts.blockers_outstanding === r.checks.filter((c) => c.severity === 'blocker' && !c.ok).length);
  check('a seeded shop passes the statutory checks',
    r.checks.find((c) => c.id === 'gstin')?.ok === true
      && r.checks.find((c) => c.id === 'dl_form20')?.ok === true
      && r.checks.find((c) => c.id === 'pharmacist')?.ok === true,
    'gstin/dl/pharmacist');
  check('but is not ready while the demo passwords stand', r.ready === false);

  const denied = await fetch(`${API}/api/readiness`, {
    headers: { Authorization: `Bearer ${cashier}` },
  });
  check('a cashier cannot read it', denied.status === 403, String(denied.status));
}

console.log('\nAdmin password resets force the staff member to choose their own');
{
  const created = await fetch(`${API}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
    body: JSON.stringify({
      username: `temp${stamp}`, password: 'ownerchose1',
      full_name: 'Temp Staff', role: 'cashier',
    }),
  });
  const { id } = await created.json();
  check('a new staff account is created', created.status === 201);

  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `temp${stamp}`, password: 'ownerchose1' }),
  }).then((x) => x.json());
  check('they must change the owner-set password before billing',
    login.user.must_change_password === true, JSON.stringify(login.user));

  // Change it themselves, then have the owner reset it again.
  await fetch(`${API}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ currentPassword: 'ownerchose1', newPassword: 'theirownpick9' }),
  });
  const own = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `temp${stamp}`, password: 'theirownpick9' }),
  }).then((x) => x.json());
  check('once they pick their own, they are not asked again',
    own.user.must_change_password === false, JSON.stringify(own.user));

  await fetch(`${API}/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
    body: JSON.stringify({ password: 'ownerreset7' }),
  });
  const afterReset = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `temp${stamp}`, password: 'ownerreset7' }),
  }).then((x) => x.json());
  check('an owner reset flags the account again',
    afterReset.user.must_change_password === true, JSON.stringify(afterReset.user));

  // Tidy up so the next run starts clean.
  await fetch(`${API}/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
    body: JSON.stringify({ active: false }),
  });
}

// ---- Browser ---------------------------------------------------------------

console.log('\nThe screens');
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#username', 'admin');
await page.fill('#password', 'admin123');
await page.click('button[type=submit]');
await page.waitForURL(/\/billing/, { timeout: 15000 });

// Dashboard banner
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check('the dashboard warns that the shop is not ready to bill for real',
  await page.locator('text=/to finish before billing for real/').isVisible());
await page.screenshot({ path: `${SHOT}/dashboard-banner.png` });

// Checklist
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.click('button:has-text("Go-live checklist")');
// The first readiness call runs bcrypt over the shipped-password list, so wait
// for the content rather than guessing at a delay.
const checklistShown = await page.waitForSelector('text=Required before real billing', { timeout: 20000 })
  .then(() => true).catch(() => false);
check('the checklist lists what is required before real billing', checklistShown);
check('and flags the shipped passwords',
  await page.locator('text=/shipped with/').first().isVisible());
await page.screenshot({ path: `${SHOT}/checklist.png`, fullPage: true });

// Staff tab chips
await page.click('button:has-text("Staff")');
await page.waitForSelector('span.chip:has-text("Shipped password")', { timeout: 20000 })
  .catch(() => null);
check('the staff list marks accounts on a shipped password',
  (await page.locator('span.chip:has-text("Shipped password")').count()) >= 3,
  String(await page.locator('span.chip:has-text("Shipped password")').count()));
await page.screenshot({ path: `${SHOT}/staff.png`, fullPage: true });

// Import screen
await page.goto(`${BASE}/import`, { waitUntil: 'networkidle' });
check('the import screen is reachable from the sidebar',
  await page.locator('text=Import products & opening stock').isVisible());

const download = page.waitForEvent('download', { timeout: 15000 });
await page.click('button:has-text("Download template")');
const file = await download;
check('the template downloads', /product-import-template\.csv$/.test(file.suggestedFilename()),
  file.suggestedFilename());

// Paste a file with one good row and one bad one, and confirm the UI blocks it.
await page.click('summary:has-text("paste the rows instead")');
await page.fill('#csvtext', [
  'name,manufacturer,pack_size,batch_no,expiry,mrp,qty_packs',
  `UI Good ${stamp},Acme,10,UG${stamp},2029-05,60,3`,
  'UI Bad,Acme,10,UB1,rubbish,60,3',
].join('\n'));
await page.click('button:has-text("Check the file")');
await page.waitForSelector('text=/problem/', { timeout: 15000 });
check('the preview shows the problem rows',
  await page.locator('text=/Nothing has been imported/').isVisible());
check('there is no import button while the file has errors',
  (await page.locator('button:has-text("Import 2 rows")').count()) === 0);
await page.screenshot({ path: `${SHOT}/preview-errors.png`, fullPage: true });

// Now a clean file, imported through the UI.
await page.fill('#csvtext', [
  'name,manufacturer,pack_size,batch_no,expiry,mrp,purchase_rate,qty_packs',
  `UI Import ${stamp},Acme Labs,10,UI${stamp},2029-05,60,42,4`,
].join('\n'));
await page.click('button:has-text("Check the file")');
await page.waitForSelector('button:has-text("Import 1 row")', { timeout: 15000 });
check('a clean file offers to import', true);
await page.click('button:has-text("Import 1 row")');
await page.waitForSelector('text=/Imported 1 new product/', { timeout: 20000 });
check('the UI confirms what it imported', true);
await page.screenshot({ path: `${SHOT}/imported.png`, fullPage: true });

// And the stock is really there.
await page.goto(`${BASE}/inventory`, { waitUntil: 'networkidle' });
await page.fill('input[placeholder*="Search"]', `UI Import ${stamp}`);
await page.waitForTimeout(1200);
check('the imported stock shows on the Stock screen',
  await page.locator(`text=UI Import ${stamp}`).first().isVisible());

check('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${failures.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await browser.close();
process.exit(fail ? 1 : 0);
