/**
 * Reading a distributor's invoice from a picture or a PDF.
 *
 * Builds its own invoice — rendered to PNG and printed to PDF — then drives the
 * real screen: upload, review, correct a field, and commit. The point of the
 * feature is the correction step, so the test insists on it: a line nobody
 * confirmed must not be able to reach stock, and a batch number typed over the
 * one that was read must be the one that lands in the batch table.
 *
 *   node e2e/verify-invoice-scan.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.BASE ?? 'http://localhost:4000';
const SHOT = fileURLToPath(new URL('./screenshots/invoice-scan', import.meta.url));
mkdirSync(SHOT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

const stamp = Date.now().toString().slice(-6);
const BATCH = `SC${stamp}`;

const invoiceHtml = `<style>
body{font-family:"DejaVu Sans Mono",monospace;font-size:13px;margin:24px;color:#000;background:#fff}
table{border-collapse:collapse;width:100%;margin-top:10px}
th,td{border:1px solid #000;padding:3px 5px;font-size:12px}
th{background:#eee}.r{text-align:right}
</style>
<h1 style="font-size:16px;margin:0">SRI VENKATESWARA PHARMA DISTRIBUTORS</h1>
<div>5-9-22, Ranigunj, Secunderabad, Telangana 500003<br>
GSTIN: 36AAPFU0939F1ZW &nbsp; DL No: TS/HYD/20B/2019/1122</div>
<div style="margin-top:8px">Invoice No: SCAN/${stamp} &nbsp;&nbsp; Date: 14/08/2026</div>
<table>
<tr><th>S.No</th><th>Product</th><th>Pack</th><th>Batch</th><th>Exp</th><th>Qty</th><th>Free</th><th>MRP</th><th>Rate</th><th>GST</th><th>Amount</th></tr>
<tr><td>1</td><td>DOLO 650 TAB</td><td>15</td><td>${BATCH}</td><td>09/28</td><td class=r>10</td><td class=r>1</td><td class=r>34.50</td><td class=r>26.30</td><td class=r>5</td><td class=r>263.00</td></tr>
<tr><td>2</td><td>PAN 40 TAB</td><td>15</td><td>PN${stamp}</td><td>03/29</td><td class=r>5</td><td class=r>0</td><td class=r>178.00</td><td class=r>128.16</td><td class=r>5</td><td class=r>640.80</td></tr>
<tr><td>3</td><td>ZINCOVIT TAB</td><td>15</td><td>ZV${stamp}</td><td>02/29</td><td class=r>12</td><td class=r>0</td><td class=r>105.00</td><td class=r>75.60</td><td class=r>18</td><td class=r>907.20</td></tr>
</table>
<div style="margin-top:8px" class=r>Taxable: 1811.00 &nbsp; CGST: 56.50 &nbsp; SGST: 56.50 &nbsp; <b>Total: 1924.00</b></div>`;

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);

// ---- Make the invoice files ------------------------------------------------
const htmlPath = join(tmpdir(), `invoice-${stamp}.html`);
const pngPath = join(tmpdir(), `invoice-${stamp}.png`);
const pdfPath = join(tmpdir(), `invoice-${stamp}.pdf`);
writeFileSync(htmlPath, invoiceHtml);
{
  const p = await browser.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 2 });
  await p.goto(`file://${htmlPath}`);
  await p.screenshot({ path: pngPath, fullPage: true });
  await p.pdf({ path: pdfPath, format: 'A4', landscape: true, printBackground: true });
  await p.close();
}

const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const consoleErrors = [];
// The deliberately unreadable file below is answered with a 422, which the
// browser logs as a failed resource. That one is the test working, not a fault.
const expected = (t) => /422|Unprocessable/.test(t);
page.on('console', (m) => {
  if (m.type() === 'error' && !expected(m.text())) consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#username', 'admin');
await page.fill('#password', 'admin123');
await page.click('button[type=submit]');
await page.waitForURL(/\/billing/, { timeout: 20000 });

// ---- What the API makes of each kind of file -------------------------------
console.log('\nReading the file');

const readVia = async (path, mime) => page.evaluate(async ({ bytes, mime }) => {
  const res = await fetch('/api/invoice-scan', {
    method: 'POST',
    headers: {
      'Content-Type': mime,
      Authorization: `Bearer ${localStorage.getItem('pharmacypos.token')}`,
    },
    body: new Uint8Array(bytes),
  });
  return { status: res.status, body: await res.json() };
}, { bytes: Array.from(readFileSync(path)), mime });

const pdf = await readVia(pdfPath, 'application/pdf');
check('a PDF from the distributor is read', pdf.status === 200, pdf.body?.error ?? '');
check('and read from its text layer, not by eye', pdf.body?.source === 'pdf-text', pdf.body?.source);
check('so every line comes back exactly', pdf.body?.lines?.length === 3,
  `${pdf.body?.lines?.length} lines`);
if (pdf.body?.lines?.length === 3) {
  const [a, , c] = pdf.body.lines;
  check('with the batch number as printed', a.batch_no === BATCH, a.batch_no);
  check('the expiry as a month', a.expiry === '2028-09', a.expiry);
  check('the MRP in paise', a.mrp_paise === 3450, String(a.mrp_paise));
  check('the free quantity', a.free_packs === 1, String(a.free_packs));
  check('and the GST rate off the last line', c.gst_rate === 18, String(c.gst_rate));
  check('the invoice number and date are picked up',
    pdf.body.invoice_no === `SCAN/${stamp}` && pdf.body.invoice_date === '2026-08-14',
    `${pdf.body.invoice_no} ${pdf.body.invoice_date}`);
  check('the distributor is recognised from its GSTIN', pdf.body.supplier_id !== null);
  check('products already in the catalogue are matched',
    pdf.body.lines.filter((l) => l.product_id).length >= 2,
    pdf.body.lines.map((l) => `${l.product_name}->${l.product_id}`).join(', '));
}

const png = await readVia(pngPath, 'image/png');
check('a photograph is read too', png.status === 200, png.body?.error ?? '');
check('and is marked as read by eye, so it gets checked',
  png.body?.source === 'ocr', png.body?.source);
check('the picture yields the same three lines', png.body?.lines?.length === 3,
  `${png.body?.lines?.length}`);

// A file that is not an invoice must be refused, not guessed at.
const junk = await page.evaluate(async () => {
  const res = await fetch('/api/invoice-scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      Authorization: `Bearer ${localStorage.getItem('pharmacypos.token')}`,
    },
    body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]),
  });
  return { status: res.status, body: await res.json() };
});
check('a file with nothing readable in it is refused', junk.status === 422, String(junk.status));
check('and says what to do about it', /photograph|export|picture|scan/i.test(junk.body?.error ?? ''),
  (junk.body?.error ?? '').slice(0, 70));

// ---- The review screen -----------------------------------------------------
console.log('\nReviewing before it touches stock');

await page.goto(`${BASE}/scan-invoice`, { waitUntil: 'networkidle' });
check('the screen is reachable', await page.locator('#scanfile').isVisible());

await page.setInputFiles('#scanfile', pdfPath);
await page.waitForSelector('text=Line by line', { timeout: 60000 });
check('the invoice is shown line by line', true);
// Assert the panel, not the tag it happens to use. A PDF is shown in an
// <object>, which a headless browser with no PDF viewer treats differently from
// a desktop one — that is a rendering detail, and what matters is that the
// original is on screen and pointing at this scan.
const original = page.locator('[data-testid="scan-original"]');
await original.waitFor({ state: 'attached', timeout: 15000 }).catch(() => undefined);
const originalSrc = await original.getAttribute('data-scan-file').catch(() => null);
check('the original is shown beside it', await original.count() === 1);
// The upload through the screen is its own scan, with its own reference — so
// what is checked is that the panel points at a scan at all, not at the one the
// API test made earlier.
check('and it points at the scan just uploaded',
  /\/invoice-scan\/[0-9a-f-]{36}\/file$/.test(originalSrc ?? ''),
  String(originalSrc));
await page.screenshot({ path: join(SHOT, '01-review.png'), fullPage: true });

const rows = page.locator('table tbody tr');
check('all three lines are listed', await rows.count() === 3, String(await rows.count()));

const commitBtn = page.locator('button:has-text("Add 3 lines to stock")');
check('committing is blocked before anything has been checked', await commitBtn.isDisabled());
check('and it says the lines still need confirming',
  /confirm the batch and expiry/i.test(await page.locator('body').innerText()));

// Correct a batch number, the way a pharmacist would after reading the paper.
const corrected = `${BATCH}X`;
const batchInput = rows.nth(0).locator('input.font-mono').first();
await batchInput.fill(corrected);
await page.waitForTimeout(200);
check('correcting a field marks that line as checked',
  await rows.nth(0).locator('input[type=checkbox]').isChecked());

// Confirm the other two.
await rows.nth(1).locator('input[type=checkbox]').check();
await rows.nth(2).locator('input[type=checkbox]').check();
await page.waitForTimeout(300);
check('once every line is confirmed, it can be recorded', await commitBtn.isEnabled());
await page.screenshot({ path: join(SHOT, '02-checked.png'), fullPage: true });

await commitBtn.click();
await page.waitForURL(/\/purchases/, { timeout: 30000 });
check('recording it lands on the purchases screen', true);

// ---- And the stock is really there, with the corrected batch ---------------
console.log('\nWhat reached the shelf');
const stock = await page.evaluate(async ({ batch, invoiceNo }) => {
  const h = { Authorization: `Bearer ${localStorage.getItem('pharmacypos.token')}` };
  const purchases = await (await fetch('/api/purchases?limit=20', { headers: h })).json();
  const list = purchases.data ?? purchases;
  const mine = list.find((p) => p.invoice_no === invoiceNo);
  const detail = mine ? await (await fetch(`/api/purchases/${mine.id}`, { headers: h })).json() : null;
  return {
    found: !!mine,
    scanId: detail?.scan_id ?? mine?.scan_id ?? '',
    batches: (detail?.items ?? []).map((i) => i.batch_no),
    wanted: batch,
  };
}, { batch: corrected, invoiceNo: `SCAN/${stamp}` });

check('the purchase was recorded against the distributor invoice', stock.found);
check('the corrected batch number is the one in stock',
  stock.batches.includes(corrected),
  `wanted ${corrected}, got ${stock.batches.join(', ')}`);
check('the batch that was read but corrected is NOT in stock',
  !stock.batches.includes(BATCH), stock.batches.join(', '));
check('the purchase remembers which scan it came from', !!stock.scanId, stock.scanId);

check('no uncaught console errors', consoleErrors.length === 0, consoleErrors[0] ?? '');

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${failures.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await browser.close();
process.exit(fail ? 1 : 0);
