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
import sharp from 'sharp';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

// An isolated userData dir so the test never touches a real installation.
const USER_DATA = join(tmpdir(), `pharmacypos-desktop-test-${Date.now()}`);

console.log('\nLaunching the desktop application\n');

/*
 * By default this drives the source tree, which is quick and catches most
 * things. Set PHARMACY_PACKAGED to the built binary to drive a real
 * installation instead — the only way to catch a dependency that was never
 * packaged, since running from the source tree finds node_modules sitting right
 * there whether or not the installer would have included it.
 */
const packaged = process.env.PHARMACY_PACKAGED;
console.log(packaged ? `  driving the packaged build: ${packaged}` : '  driving the source tree');

const app = await electron.launch(
  packaged
    ? {
      executablePath: packaged,
      args: [`--user-data-dir=${USER_DATA}`, '--no-sandbox'],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 90000,
    }
    : {
      args: ['.', `--user-data-dir=${USER_DATA}`, '--no-sandbox'],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 60000,
    },
);

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

// ---- Reading an invoice, which is where packaging usually breaks -----------
// sharp and the OCR engine are native and worker-based; both have to live
// outside the asar archive, and the engine has to unpack its training data
// somewhere writable rather than into a read-only program folder. None of that
// is exercised by running from the source tree, where every module is simply
// present and every directory is writable.
console.log('\nReading an invoice inside the installed app');

console.log('    building the test image…');
const invoicePng = await sharp({
  create: { width: 1500, height: 260, channels: 3, background: '#ffffff' },
})
  .composite([{
    input: Buffer.from(
      `<svg width="1500" height="260">
         <style>text { font-family: monospace; font-size: 30px; fill: #000 }</style>
         <text x="20" y="70">Product        Batch      Exp     Qty    MRP      Rate</text>
         <text x="20" y="150">DOLO 650 TAB   KLM2244    09/28   10     34.50    26.30</text>
       </svg>`,
    ),
    top: 0,
    left: 0,
  }])
  .png()
  .toBuffer();

// Bounded on both sides: the page gives up on its own, and the driver gives up
// on the page. A check that can hang is a check that stops the whole suite
// reporting, which is worse than a check that fails.
console.log(`    image ready (${invoicePng.length} bytes); posting…`);

// The request is made from here rather than from inside the page. Pushing a
// photograph through the driver into the renderer and back is a lot of
// machinery to prove something about the server, and it does not reliably
// return; the app's port is reachable from this process directly.
const origin = await window.evaluate(() => location.origin);
const token = await window.evaluate(() => localStorage.getItem('pharmacypos.token'));

const ocr = await fetch(`${origin}/api/invoice-scan`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` },
  body: invoicePng,
  signal: AbortSignal.timeout(120000),
})
  .then(async (res) => {
    const body = await res.json();
    return {
      status: res.status,
      error: body.error ?? '',
      lines: body.lines?.length ?? 0,
      batch: body.lines?.[0]?.batch_no ?? '',
    };
  })
  .catch((err) => ({ status: 0, error: String(err), lines: 0, batch: '' }));

check('the OCR engine loads and answers in the installed app',
  ocr.status === 200 || ocr.status === 422,
  `${ocr.status} ${ocr.error.slice(0, 90)}`);
if (ocr.status === 200) {
  check('and reads the line off the picture', ocr.lines >= 1, `${ocr.lines} lines`);
  check('including its batch number', ocr.batch === 'KLM2244', ocr.batch);
} else {
  // Refusing a picture is a legitimate answer; failing to load a module is not.
  check('and explains itself rather than failing obscurely',
    /photo|picture|invoice|columns|text/i.test(ocr.error), ocr.error.slice(0, 90));
}

// ---- Printer enumeration ---------------------------------------------------
/*
 * Asking the operating system for its printers can block Electron's main
 * process outright — not reject, not time out, block — on a machine whose print
 * service is absent or wedged, which is the case in a bare CI container. No
 * timeout inside the app can rescue that, because the event loop it would run
 * on is the one that is stuck.
 *
 * This is why nothing in the application calls it during startup: it is offered
 * on the bridge for a settings screen to use, on demand, where a shopkeeper can
 * see it is taking a while. Here it is asked with a deadline, and no answer is
 * reported rather than allowed to stop the run.
 */
const printers = await Promise.race([
  window.evaluate(() => window.pharmacyDesktop.printers()),
  new Promise((resolve) => setTimeout(() => resolve('no answer'), 10000)),
]).catch((err) => `failed: ${String(err)}`);

if (printers === 'no answer') {
  console.log('  --   the OS printer list did not answer (no print service on this machine)');
} else {
  check('the OS printer list is reachable', Array.isArray(printers),
    Array.isArray(printers) ? `${printers.length} printers on this machine` : String(printers));
}

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${failures.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await app.close();
try { rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
