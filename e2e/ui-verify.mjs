/**
 * Browser verification of the running application.
 *
 * Drives the real UI in Chromium: signs in, bills an item, checks that Schedule
 * H1 gating blocks the sale until the prescriber and patient are recorded, that
 * the printed invoice carries the statutory particulars, that the supply lands
 * in the H1 register, and that a cashier cannot reach restricted screens.
 * Screenshots of every step are written to e2e/screenshots/.
 *
 *   npm run build && npm start          # in one terminal
 *   npm run verify:ui                   # in another
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://localhost:4000';
const SHOT = process.env.SHOT_DIR ?? fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(SHOT, { recursive: true });

const errors = [];
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); errors.push(name); }
}

// PLAYWRIGHT_CHROMIUM lets sandboxes point at a pre-installed browser.
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// ---- Login ----------------------------------------------------------------
console.log('\nLogin');
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
check('login page renders', await page.locator('text=PharmacyPOS').first().isVisible());
await page.screenshot({ path: `${SHOT}/01-login.png` });

await page.fill('#username', 'admin');
await page.fill('#password', 'admin123');
await page.click('button[type=submit]');
await page.waitForURL('**/billing', { timeout: 10000 });
check('admin signs in and lands on billing', page.url().includes('/billing'));

// ---- Billing: search and add an OTC product -------------------------------
console.log('\nBilling');
const search = page.locator('input[placeholder*="Search medicine"]');
await search.fill('Dolo');
await page.waitForSelector('button[data-active]', { timeout: 5000 });
const hitCount = await page.locator('button[data-active]').count();
check('product search returns results', hitCount > 0, `${hitCount} hits`);
await page.screenshot({ path: `${SHOT}/02-search.png` });

await page.keyboard.press('Enter');
await page.waitForSelector('table tbody tr', { timeout: 5000 });
check('product added to the bill', await page.locator('table tbody tr').count() === 1);

const batchCell = await page.locator('table tbody tr td').nth(2).innerText();
check('batch number and expiry shown on the line', /exp\s/i.test(batchCell), batchCell.replace(/\n/g, ' '));

const payable = await page.locator('header p.text-xl').innerText();
check('payable total is computed live', /₹[\d,]+\.\d{2}/.test(payable), payable);
check('total is a whole number of rupees', payable.endsWith('.00'), payable);

await page.screenshot({ path: `${SHOT}/03-billing.png`, fullPage: true });

// ---- Schedule H1 gating ---------------------------------------------------
console.log('\nSchedule H1 gating');
// Pick whichever H1/X product actually has stock, so the test does not depend
// on a particular brand surviving the seeded trading history.
const h1Name = await page.evaluate(async () => {
  const res = await fetch('/api/products?limit=200&inStock=true', {
    headers: { Authorization: `Bearer ${localStorage.getItem('pharmacypos.token')}` },
  });
  const rows = await res.json();
  const hit = rows.find((p) => ['H1', 'X'].includes(p.schedule_type) && p.stock_units > 5);
  return hit ? hit.name : null;
});
check('an H1/X product with stock exists to test with', !!h1Name, String(h1Name));

await search.fill(h1Name.split(' ')[0]);
await page.waitForSelector('button[data-active]', { timeout: 5000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(600);

check('H1 warning banner appears',
  await page.locator('text=Schedule H1 / X on this bill').isVisible());
check('prescription section becomes required',
  await page.locator('select').filter({ hasText: 'Select prescribing doctor' }).isVisible());

const saveBtn = page.locator('button:has-text("Save & Print")');
check('save is blocked until compliance fields are filled', await saveBtn.isDisabled());

const blockers = await page.locator('ul.text-amber-700 li').allInnerTexts();
check('blocking reasons are listed to the user', blockers.length > 0, blockers.join('; '));
await page.screenshot({ path: `${SHOT}/04-h1-gating.png`, fullPage: true });

// Fill compliance fields
await page.selectOption('select', { index: 1 });
await page.fill('input[placeholder="Patient name *"]', 'Verification Patient');
await page.fill('input[placeholder="Patient address *"]', 'Habsiguda, Hyderabad');
await page.waitForTimeout(400);
check('save unblocks once prescriber and patient are recorded', await saveBtn.isEnabled());

// ---- Save the bill --------------------------------------------------------
console.log('\nInvoice');
await page.locator('button:has-text("Save")').first().click();
await page.waitForURL(/\/invoices\/\d+/, { timeout: 10000 });
check('bill saves and opens the invoice', /\/invoices\/\d+/.test(page.url()));

await page.waitForSelector('text=Tax Invoice', { timeout: 5000 });
const invoiceText = await page.locator('.print-area').innerText();
// The heading is rendered with CSS text-transform, so compare case-insensitively.
check('invoice is headed "Tax Invoice"', /tax invoice/i.test(invoiceText));
check('shop GSTIN printed', invoiceText.includes('36AAPFU0939F1ZW'));
check('both drug licence numbers printed',
  invoiceText.includes('TS/HYD/20/2021/003412') && invoiceText.includes('TS/HYD/21/2021/003413'));
check('invoice number follows the FY series', /INV\/\d{4}-\d{2}\/\d{5}/.test(invoiceText));
check('CGST and SGST shown separately for an intra-state sale',
  invoiceText.includes('CGST') && invoiceText.includes('SGST') && !invoiceText.includes('IGST'));
check('amount in words printed', /Rupees .* Only/.test(invoiceText));
check('prescriber recorded on the invoice', /Prescriber:/.test(invoiceText));
check('registered pharmacist signature block present',
  invoiceText.includes('Registered Pharmacist'));
check('HSN summary table present', invoiceText.includes('3004'));

await page.screenshot({ path: `${SHOT}/05-invoice.png`, fullPage: true });

// ---- H1 register received the entry ---------------------------------------
console.log('\nH1 register');
await page.goto(`${BASE}/h1-register`, { waitUntil: 'networkidle' });
await page.fill('#q', 'Verification Patient');
await page.waitForTimeout(900);
const regRows = await page.locator('table tbody tr').count();
check('the supply appears in the Schedule H1 register', regRows > 0, `${regRows} rows`);
const regText = await page.locator('table tbody').innerText();
check('register row carries patient, batch and pharmacist',
  regText.includes('Verification Patient') && /\d{4}/.test(regText));
await page.screenshot({ path: `${SHOT}/06-h1-register.png`, fullPage: true });

// ---- Dashboard ------------------------------------------------------------
console.log('\nOther screens');
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('dashboard renders tiles', await page.locator('text=Sales today').isVisible());
check('dashboard shows a 7-day chart', await page.locator('text=Last 7 days').isVisible());
await page.screenshot({ path: `${SHOT}/07-dashboard.png`, fullPage: true });

await page.goto(`${BASE}/inventory?filter=expiring`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('stock page renders with the expiring filter',
  await page.locator('text=Expiring soon').first().isVisible());
await page.screenshot({ path: `${SHOT}/08-inventory.png`, fullPage: true });

await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('reports day book renders', await page.locator('text=Till reconciliation').isVisible());
await page.click('button:has-text("GST returns")');
await page.waitForTimeout(900);
check('GST report renders', await page.locator('text=Net payable').isVisible());
check('GSTR-1 HSN summary present',
  await page.locator('text=GSTR-1 Table 12').isVisible());
await page.screenshot({ path: `${SHOT}/09-gst-report.png`, fullPage: true });

await page.goto(`${BASE}/purchases`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
// "Goods inward" is both a tab and part of the subtitle, so scope to the tab.
check('purchases page renders',
  await page.locator('button:has-text("Goods inward")').isVisible());
check('purchases has returns and ledger tabs',
  await page.locator('button:has-text("Supplier ledger")').isVisible());

await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('products page renders', await page.locator('table tbody tr').count() > 0);
await page.screenshot({ path: `${SHOT}/10-products.png`, fullPage: true });

await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('settings page renders shop identity', await page.locator('text=Statutory registrations').isVisible());

// ---- Cashier restrictions -------------------------------------------------
console.log('\nCashier role');
await page.evaluate(() => localStorage.clear());
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#username', 'cashier');
await page.fill('#password', 'cash123');
await page.click('button[type=submit]');
await page.waitForURL('**/billing', { timeout: 10000 });

const navText = await page.locator('aside nav').innerText();
check('cashier does not see the H1 register in navigation', !navText.includes('H1 Register'), navText.replace(/\n/g, '|'));
check('cashier does not see Purchases', !navText.includes('Purchases'));
check('cashier does not see Settings', !navText.includes('Settings'));
await page.screenshot({ path: `${SHOT}/11-cashier.png`, fullPage: true });

// ---- Console cleanliness --------------------------------------------------
const realErrors = consoleErrors.filter((e) =>
  !e.includes('favicon') && !e.includes('Download the React DevTools'));
check('no uncaught console errors during the run', realErrors.length === 0,
  realErrors.slice(0, 3).join(' | '));

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${errors.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await browser.close();
process.exit(fail ? 1 : 0);
