/**
 * Two things a shop hits on its first day.
 *
 * A prescription arrives from a doctor who is not on file — which is every
 * doctor, on day one — and the counter has to be able to bill it. And the
 * catalogue arrives as a spreadsheet, chosen with the file picker rather than
 * pasted, very often saved out of Excel with a byte-order mark and CRLF line
 * endings.
 *
 *   node e2e/verify-doctor-and-upload.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.BASE ?? 'http://localhost:4000';
const SHOT = fileURLToPath(new URL('./screenshots/doctor-upload', import.meta.url));
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#username', 'admin');
await page.fill('#password', 'admin123');
await page.click('button[type=submit]');
await page.waitForURL(/\/billing/, { timeout: 20000 });

// ---- A prescription from a doctor nobody has heard of ----------------------
console.log('\nBilling a prescription from a new doctor');

// Find a Schedule H product, which is what forces a prescriber to be named.
// The earliest-expiring batch must hold a full strip on its own, or FEFO
// splits the line and the sale is refused for want of stock — which would be
// the fixture failing, not the prescriber field.
const hProduct = await page.evaluate(async () => {
  const token = localStorage.getItem('pharmacypos.token');
  const h = { Authorization: `Bearer ${token}` };
  const rows = await (await fetch('/api/products?limit=200&inStock=true', { headers: h })).json();
  const list = rows.data ?? (Array.isArray(rows) ? rows : rows.items ?? []);
  for (const p of list.filter((p) => p.schedule_type === 'H' && p.stock_units > 30)) {
    const batches = await (await fetch(`/api/products/${p.id}/batches`, { headers: h })).json();
    const first = (batches.data ?? batches)[0];
    if (first && first.qty_units >= p.pack_size) return p.name;
  }
  return null;
});
check('found a Schedule H product to bill', !!hProduct, String(hProduct));

const search = page.locator('input[placeholder*="Search medicine"]');
await search.fill(hProduct.slice(0, 12));
await page.waitForSelector('button[data-active]', { timeout: 10000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(700);

const doctorField = page.locator('#doctor');
check('the prescriber is a field you can type into, not a fixed list',
  await doctorField.count() === 1 && await doctorField.isEditable());

// A name that is certainly not in the seeded list.
const newDoctor = `Dr Ramesh Varma ${Date.now().toString().slice(-5)}`;
await doctorField.fill(newDoctor);
await page.waitForTimeout(400);
await page.screenshot({ path: join(SHOT, '01-new-doctor.png') });

const addOption = page.locator(`button:has-text("Add \\"${newDoctor}\\" as a new doctor")`);
check('it offers to add a doctor it has never seen', await addOption.count() === 1);

await addOption.click();
await page.waitForTimeout(900);
check('the new doctor is selected once added',
  (await page.locator('text=' + newDoctor).count()) > 0);

// It must now be billable — the whole point.
const blockers = await page.locator('text=/Select the prescribing doctor/').count();
check('naming them clears the block on saving the bill', blockers === 0);

await page.locator('button.btn-primary:has-text("Save & Print")').click();
await page.waitForURL(/\/invoices\/\d+/, { timeout: 20000 });
check('the bill saves', true);
const invoice = await page.locator('.print-area').innerText();
check('the new doctor is printed on the invoice', invoice.includes(newDoctor),
  invoice.match(/Dr[^\n]*/)?.[0] ?? 'no doctor line');
await page.screenshot({ path: join(SHOT, '02-invoice.png'), fullPage: true });

// And they are on file for next time, without anyone visiting Contacts.
await page.goto(`${BASE}/contacts`, { waitUntil: 'networkidle' });
await page.click('button:has-text("Doctors")');
await page.waitForTimeout(900);
check('the doctor was added to the register for next time',
  (await page.locator(`text=${newDoctor}`).count()) > 0);

// Typing an existing name must not offer to duplicate it.
await page.goto(`${BASE}/billing`, { waitUntil: 'networkidle' });
await search.fill(hProduct.slice(0, 12));
await page.waitForSelector('button[data-active]', { timeout: 10000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
await page.locator('#doctor').fill(newDoctor);
await page.waitForTimeout(400);
check('an existing doctor is offered rather than duplicated',
  (await page.locator(`button:has-text("Add \\"${newDoctor}\\"")`).count()) === 0
  && (await page.locator(`button:has-text("${newDoctor}")`).count()) > 0);

// ---- Choosing a file, including one saved by Excel -------------------------
console.log('\nChoosing a catalogue file');

const header = 'name,manufacturer,gst_rate,pack_size,batch_no,expiry,mrp,purchase_rate,qty_packs';
const stamp = Date.now().toString().slice(-6);
const plain = join(tmpdir(), `catalogue-${stamp}.csv`);
const excel = join(tmpdir(), `catalogue-excel-${stamp}.csv`);
writeFileSync(plain, `${header}\nUpload Check ${stamp},Testco,5,10,UP${stamp},2029-05,88.00,63.00,4\n`);
// Excel writes a BOM and CRLF line endings; a shop's file will look like this.
writeFileSync(excel, `﻿${header}\r\nExcel Check ${stamp},Testco,5,10,XL${stamp},2029-05,120.00,86.00,3\r\n`);

for (const [label, file] of [['a plain CSV', plain], ['a CSV saved by Excel', excel]]) {
  await page.goto(`${BASE}/import`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#csvfile', file);
  await page.waitForTimeout(600);

  const note = await page.locator('text=/row.*bytes|row.*KB/').first().innerText().catch(() => '');
  check(`${label}: choosing it says what was read`, /1 row/.test(note), note || '(nothing shown)');
  check(`${label}: and never claims 0 KB`, !/\b0 KB\b/.test(note), note);

  await page.click('button:has-text("Check the file")');
  await page.waitForSelector('text=ROWS READ', { timeout: 20000 });
  const body = await page.locator('body').innerText();
  check(`${label}: the row is read`, /ROWS READ\s*1/.test(body));
  check(`${label}: with no problems`, /PROBLEMS\s*0/.test(body));
  // The BOM must not have been swallowed into the first column name, which
  // would leave every product nameless.
  check(`${label}: the product name survived`, body.includes(`Check ${stamp}`));
}
await page.screenshot({ path: join(SHOT, '03-upload.png'), fullPage: true });

check('no uncaught console errors', consoleErrors.length === 0, consoleErrors[0] ?? '');

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${failures.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await browser.close();
process.exit(fail ? 1 : 0);
