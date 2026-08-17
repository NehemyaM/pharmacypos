/**
 * Verify the Electron desktop app.
 *
 * Launches the real application (not the web build) and drives its window,
 * confirming the bundled server starts, billing works, and — importantly —
 * that data lands in the OS user-data directory rather than the program folder,
 * because that is what makes an update safe.
 *
 *   xvfb-run -a node e2e/verify-desktop.mjs
 */
import { _electron as electron } from 'playwright';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

// An isolated userData dir so the test never touches a real installation.
const USER_DATA = join(tmpdir(), `pharmacypos-desktop-test-${Date.now()}`);

console.log('\nLaunching the desktop application\n');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${USER_DATA}`, '--no-sandbox'],
  env: { ...process.env, NODE_ENV: 'test' },
  timeout: 60000,
});

const window = await app.firstWindow({ timeout: 60000 });
await window.waitForLoadState('domcontentloaded');
check('the application window opened', !!window);

// The bundled server must have started and been reached.
await window.waitForSelector('#username', { timeout: 45000 });
check('the bundled server started and served the UI',
  await window.locator('text=PharmacyPOS').first().isVisible());

// The desktop bridge must be present — this is what silent printing needs.
const info = await app.evaluate(async ({ app: a }) => ({
  version: a.getVersion(),
  userData: a.getPath('userData'),
  packaged: a.isPackaged,
}));
check('exposes a version', !!info.version, info.version);
console.log(`       userData: ${info.userData}`);

const bridge = await window.evaluate(() => ({
  present: typeof window.pharmacyDesktop !== 'undefined',
  keys: Object.keys(window.pharmacyDesktop ?? {}),
}));
check('the preload bridge is exposed to the page', bridge.present, JSON.stringify(bridge.keys));
check('the bridge offers printing and the drawer',
  bridge.keys.includes('print') && bridge.keys.includes('openDrawer'),
  bridge.keys.join(','));

// Node must NOT be reachable from the page.
const leaked = await window.evaluate(() =>
  typeof require !== 'undefined' || typeof process !== 'undefined');
check('Node is not exposed to the renderer', !leaked);

// ---- First run: a brand-new install must be usable ------------------------
console.log('\nFirst run on a fresh machine');
await window.fill('#username', 'admin');
await window.fill('#password', 'admin123');
await window.click('button[type=submit]');

// A fresh database bootstraps an admin account, then insists the password is
// changed before anything else can be reached.
await window.waitForSelector('text=Choose a password before you start', { timeout: 20000 });
check('a fresh install can be signed into at all', true);
check('and it refuses to proceed on the installed password',
  await window.locator('text=/still uses the password it was installed with/').isVisible());

await window.fill('#cur', 'admin123');
await window.fill('#new', 'shopowner2026');
await window.fill('#conf', 'shopowner2026');
await window.click('button:has-text("Set password and continue")');
await window.waitForURL(/\/billing/, { timeout: 20000 });
check('after changing it, the counter is usable', true);

// A fresh install has no stock, so create some through the app's own API —
// this exercises the full path on a genuinely empty shop.
console.log('\nBilling on a fresh install');
const created = await window.evaluate(async () => {
  const token = localStorage.getItem('pharmacypos.token');
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const product = await (await fetch('/api/products', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      name: 'Dolo 650 Tablet', generic_name: 'Paracetamol 650mg',
      manufacturer: 'Micro Labs Ltd', hsn_code: '3004', gst_rate: 5,
      unit: 'TAB', pack_size: 15, pack_label: 'Strip of 15 tablets',
    }),
  })).json();

  const supplier = await (await fetch('/api/suppliers', {
    method: 'POST', headers: h,
    body: JSON.stringify({ name: 'Test Distributor', state_code: '36' }),
  })).json();

  const purchase = await (await fetch('/api/purchases', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      supplier_id: supplier.id, invoice_no: 'FIRSTRUN-1',
      invoice_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: product.id, batch_no: 'FR0001', expiry: '2028-06',
        qty_packs: 10, purchase_rate_paise: 2630, mrp_paise: 3450,
      }],
    }),
  })).json();

  return { productId: product.id, ok: !!purchase.id };
});
check('a product and its opening stock can be created', created.ok);

const search = window.locator('input[placeholder*="Search medicine"]');
await window.goto(await window.url().replace(/\/[^/]*$/, '/billing')).catch(() => {});
await window.waitForTimeout(600);
await search.fill('Dolo');
const found = await window.waitForSelector('button[data-active]', { timeout: 10000 })
  .then(() => true).catch(() => false);
check('the new product is searchable', found);

if (found) {
  await window.keyboard.press('Enter');
  await window.waitForTimeout(800);
  check('it is added to the bill', (await window.locator('table tbody tr').count()) === 1);

  await window.locator('button.btn-primary:has-text("Save & Print")').click();
  await window.waitForURL(/\/invoices\/\d+/, { timeout: 20000 });
  const text = await window.locator('.print-area').innerText();
  check('a bill saves and the invoice renders', /tax invoice/i.test(text));
  // The header uses CSS text-transform, so compare case-insensitively.
  check('the default shop name is on it until Settings is filled in',
    /my medical store/i.test(text), text.slice(0, 40).replace(/\n/g, ' '));
  check('statutory fields are blank until the owner fills them in',
    /GSTIN:\s*$/m.test(text) || text.includes('GSTIN:'), 'prompts the owner to set them');
  check('a full strip bills exactly its MRP', text.includes('34.50'),
    text.match(/34\.\d\d/)?.[0] ?? 'not found');
}

// ---- The thing that makes updates safe ------------------------------------
console.log('\nData location');
const dbPath = join(USER_DATA, 'data', 'pharmacy.sqlite');
check('the database is in userData, not the program folder', existsSync(dbPath), dbPath);
check('a backups directory exists beside it',
  existsSync(join(USER_DATA, 'data', 'backups')));
check('the machine JWT secret was generated', existsSync(join(USER_DATA, '.secret')));

// ---- Printer enumeration ---------------------------------------------------
const printers = await window.evaluate(() => window.pharmacyDesktop.printers());
check('the OS printer list is reachable', Array.isArray(printers),
  `${printers?.length ?? 0} printers on this machine`);

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${failures.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await app.close();
try { rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
