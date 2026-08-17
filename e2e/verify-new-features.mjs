/**
 * Browser verification of backup, CSV export, purchase returns and the
 * supplier ledger. Needs the app running (`npm run dev` or `npm start`).
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Defaults to the single-process build, which serves the UI and the API
// together — the same thing a shop runs. Point BASE at :5173 to drive the Vite
// dev server instead.
const BASE = process.env.BASE ?? 'http://localhost:4000';
const SHOT = fileURLToPath(new URL('./screenshots/features', import.meta.url));
const DL = fileURLToPath(new URL('./downloads', import.meta.url));
mkdirSync(SHOT, { recursive: true });
mkdirSync(DL, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
}

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  acceptDownloads: true,
});
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#username', 'admin');
await page.fill('#password', 'admin123');
await page.click('button[type=submit]');
await page.waitForURL('**/billing');

// ---- CSV export -------------------------------------------------------------
console.log('\nCSV export');
await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
await page.click('button:has-text("GST returns")');
await page.waitForTimeout(1200);

const dl = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('button:has-text("Export CSV")'),
]).then(([d]) => d);

const csvPath = `${DL}/${dl.suggestedFilename()}`;
await dl.saveAs(csvPath);
check('GST report downloads a CSV', existsSync(csvPath), dl.suggestedFilename());
check('filename carries the period', /gst.*\d{4}-\d{2}-\d{2}/.test(dl.suggestedFilename()),
  dl.suggestedFilename());

const csv = readFileSync(csvPath, 'utf8');
const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
check('CSV has a header and data rows', lines.length > 1, `${lines.length} lines`);
check('starts with a UTF-8 BOM for Excel', csv.charCodeAt(0) === 0xfeff);
check('amounts are bare numbers a spreadsheet can sum',
  /^\d+,\d+,\d+,[\d.]+,[\d.]+/.test(lines[1]) && !lines[1].includes('₹') && !/\d,\d\d,\d/.test(lines[1]),
  lines[1]);

// The header row must match the tax columns an accountant expects
check('columns are the ones GSTR-1 needs',
  lines[0].includes('HSN Code') && lines[0].includes('Taxable Value')
  && lines[0].includes('CGST') && lines[0].includes('IGST'), lines[0]);

await page.screenshot({ path: `${SHOT}/01-report-export.png`, fullPage: true });

// Stock export from a different page
await page.goto(`${BASE}/inventory`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const dl2 = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('button:has-text("Export CSV")'),
]).then(([d]) => d);
check('stock page exports too', dl2.suggestedFilename() === 'stock-on-hand.csv',
  dl2.suggestedFilename());

// ---- Backup ----------------------------------------------------------------
console.log('\nBackup');
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.click('button:has-text("Backup")');
await page.waitForTimeout(1200);
check('backup screen warns the shop is one file',
  await page.locator('text=Your entire shop is one file').isVisible());
check('restore instructions are shown', await page.locator('text=Restoring').isVisible());

const before = await page.locator('table tbody tr').count();
await page.click('button:has-text("Back up now")');
await page.waitForSelector('text=Backup taken and verified', { timeout: 20000 });
check('taking a backup reports success and verification',
  await page.locator('text=Backup taken and verified').isVisible());
await page.waitForTimeout(1200);
const after = await page.locator('table tbody tr').count();
check('the new backup appears in the list', after > before, `${before} -> ${after}`);
await page.screenshot({ path: `${SHOT}/02-backup.png`, fullPage: true });

const dl3 = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.locator('button:has-text("Download")').first().click(),
]).then(([d]) => d);
const bkPath = `${DL}/${dl3.suggestedFilename()}`;
await dl3.saveAs(bkPath);
check('a backup can be downloaded off the machine',
  existsSync(bkPath) && statSync(bkPath).size > 100_000,
  `${(statSync(bkPath).size / 1048576).toFixed(2)} MB`);
check('the downloaded file is a real SQLite database',
  readFileSync(bkPath).subarray(0, 15).toString() === 'SQLite format 3');

// ---- Purchase returns -------------------------------------------------------
console.log('\nReturns to supplier');
await page.goto(`${BASE}/purchases`, { waitUntil: 'networkidle' });
await page.click('button:has-text("Returns to supplier")');
await page.waitForTimeout(1200);
check('returns tab lists existing debit notes',
  (await page.locator('table tbody tr').count()) > 0);
await page.screenshot({ path: `${SHOT}/03-returns-list.png`, fullPage: true });

await page.click('button:has-text("New return")');
await page.waitForSelector('text=Return stock to supplier', { timeout: 5000 });
check('the picker asks for a supplier first',
  await page.locator('text=Choose a supplier').isVisible());

// Pick the first supplier that has returnable stock
const supplierSelect = page.locator('select').nth(1);
const options = await supplierSelect.locator('option').count();
check('suppliers with returnable stock are offered', options > 1, `${options - 1} suppliers`);

if (options > 1) {
  await supplierSelect.selectOption({ index: 1 });
  await page.waitForTimeout(800);
  const batchRows = await page.locator('table tbody tr').count();
  check('their near-expiry batches are listed', batchRows > 0, `${batchRows} batches`);

  await page.locator('button:has-text("all")').first().click();
  await page.waitForTimeout(400);
  const claimText = await page.locator('text=/Claiming/').innerText();
  check('the claim value is computed at cost', /₹[\d,]+\.\d{2}/.test(claimText), claimText);
  await page.screenshot({ path: `${SHOT}/04-return-entry.png`, fullPage: true });

  await page.click('button:has-text("Raise debit note")');
  await page.waitForTimeout(2000);
  check('the debit note is created', !(await page.locator('text=Return stock to supplier').isVisible()));
}

// ---- Supplier ledger --------------------------------------------------------
console.log('\nSupplier ledger');
await page.goto(`${BASE}/purchases`, { waitUntil: 'networkidle' });
await page.click('button:has-text("Supplier ledger")');
await page.waitForTimeout(1500);
check('ledger shows outstanding per supplier',
  (await page.locator('table tbody tr').count()) > 0);
const totalsText = await page.locator('text=Outstanding').first().isVisible();
check('total outstanding is shown', totalsText);
await page.screenshot({ path: `${SHOT}/05-supplier-ledger.png`, fullPage: true });

await page.locator('button:has-text("Statement")').first().click();
await page.waitForSelector('text=/Statement —/', { timeout: 5000 });
await page.waitForTimeout(1200);
const stmt = await page.locator('.card, [role=dialog]').last().innerText().catch(() => '');
check('statement ages invoices against their due date',
  /due date = invoice date/i.test(stmt) || await page.locator('text=/Due by/').isVisible());
await page.screenshot({ path: `${SHOT}/06-statement.png`, fullPage: true });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

await page.locator('button:has-text("Pay")').first().click();
await page.waitForSelector('text=/Record payment/', { timeout: 5000 });
await page.waitForTimeout(900);
check('payment dialog offers the outstanding invoices',
  (await page.locator('select').first().locator('option').count()) > 1);
await page.screenshot({ path: `${SHOT}/07-payment.png`, fullPage: true });

// Record a real payment and confirm the outstanding figure drops
const beforePay = await page.locator('table tbody tr').first().innerText();
await page.locator('select').first().selectOption({ index: 1 });
await page.waitForTimeout(400);
await page.click('button:has-text("Record payment")');
await page.waitForTimeout(2000);
const afterPay = await page.locator('table tbody tr').first().innerText();
check('recording a payment updates the ledger', beforePay !== afterPay);

// ---- Console ---------------------------------------------------------------
const realErrors = consoleErrors.filter((e) =>
  !e.includes('favicon') && !e.includes('React DevTools'));
check('no uncaught console errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${failures.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await browser.close();
process.exit(fail ? 1 : 0);
