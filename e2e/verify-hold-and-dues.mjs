/**
 * Browser verification of Hold Bill and customer dues.
 * Needs the app running (`npm run dev` or `npm start`).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const SHOT = fileURLToPath(new URL('./screenshots/hold-dues', import.meta.url));
mkdirSync(SHOT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
}

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
await page.waitForURL('**/billing');

const search = page.locator('input[placeholder*="Search medicine"]');

async function addItem(term) {
  await search.fill(term);
  await page.waitForSelector('button[data-active]', { timeout: 5000 }).catch(() => {});
  if (await page.locator('button[data-active]').count()) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

// ---- Hold ------------------------------------------------------------------
console.log('\nHold Bill');
await addItem('Dolo');
await addItem('Crocin');
check('two items on the bill', (await page.locator('table tbody tr').count()) === 2);

const beforeTotal = await page.locator('header p.text-xl').innerText();
await page.locator('input[placeholder="Phone number"]').fill('9849011223');
await page.waitForTimeout(900);
const cust = page.locator('button:has-text("Ramesh Kumar")').first();
if (await cust.count()) await cust.click();
await page.waitForTimeout(800);

check('outstanding balance is shown before extending more credit',
  await page.locator('text=/owes ₹/').first().isVisible());
await page.screenshot({ path: `${SHOT}/01-credit-warning.png`, fullPage: true });

await page.keyboard.press('F6');
await page.waitForSelector('text=Hold this bill', { timeout: 5000 });
check('F6 opens the hold prompt', await page.locator('text=Hold this bill').isVisible());
check('it warns that stock is not reserved',
  await page.locator('text=/Stock is/').isVisible());
await page.screenshot({ path: `${SHOT}/02-hold-prompt.png`, fullPage: true });

await page.fill('#hold-label', 'Ramesh — gone to ATM');
// The sidebar also has a "Hold bill" button, so scope to the dialog's confirm.
await page.locator('button.btn-primary:has-text("Hold bill")').click();
await page.waitForTimeout(1500);

check('the cart is cleared after holding',
  (await page.locator('table tbody tr').count()) === 0);
check('the held-bills counter shows one',
  (await page.locator('button:has-text("Held bills")').innerText()).includes('1'));

// ---- Bill someone else, then resume ----------------------------------------
console.log('\nServe the next customer, then resume');
await addItem('Pan 40');
check('a new bill can start immediately', (await page.locator('table tbody tr').count()) === 1);
check('resume is blocked while a bill is on screen', await (async () => {
  await page.click('button:has-text("Held bills")');
  await page.waitForTimeout(600);
  const disabled = await page.locator('button:has-text("Resume")').first().isDisabled();
  await page.keyboard.press('Escape');
  return disabled;
})());

// Clear the interim bill
await page.locator('table tbody tr').first().locator('button[aria-label^="Remove"]').click();
await page.waitForTimeout(400);

await page.click('button:has-text("Held bills")');
await page.waitForTimeout(700);
check('the tray lists the held bill by name',
  await page.locator('text=Ramesh — gone to ATM').isVisible());
await page.screenshot({ path: `${SHOT}/03-held-tray.png`, fullPage: true });

await page.locator('button:has-text("Resume")').first().click();
await page.waitForTimeout(2500);
check('resuming restores the items', (await page.locator('table tbody tr').count()) === 2);
const afterTotal = await page.locator('header p.text-xl').innerText();
check('the total is restored unchanged', afterTotal === beforeTotal, `${beforeTotal} -> ${afterTotal}`);
check('the customer is restored too',
  (await page.locator('input[placeholder="Phone number"]').inputValue()) === '9849011223');
check('the resumed bill is removed from the tray',
  !(await page.locator('button:has-text("Held bills")').innerText()).match(/\d/));
await page.screenshot({ path: `${SHOT}/04-resumed.png`, fullPage: true });

// ---- Customer dues ---------------------------------------------------------
console.log('\nCustomer dues');
await page.goto(`${BASE}/contacts`, { waitUntil: 'networkidle' });
await page.click('button:has-text("Customer dues")');
await page.waitForTimeout(1500);

check('dues tab lists customers who owe money',
  (await page.locator('table tbody tr').count()) > 0);
check('total owed is shown', await page.locator('text=Owed to you').isVisible());
check('over-limit count is tracked', await page.locator('text=Over their limit').isVisible());
await page.screenshot({ path: `${SHOT}/05-dues.png`, fullPage: true });

await page.locator('button:has-text("Statement")').first().click();
await page.waitForSelector('text=/Statement —/', { timeout: 5000 });
await page.waitForTimeout(1200);
check('statement shows bills and receipts',
  await page.locator('text=Bills').first().isVisible());
await page.screenshot({ path: `${SHOT}/06-statement.png`, fullPage: true });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

const owedBefore = await page.locator('table tbody tr').first().innerText();
await page.locator('button:has-text("Receive")').first().click();
await page.waitForSelector('text=/Receive payment/', { timeout: 5000 });
await page.waitForTimeout(900);
check('receipt dialog offers the unpaid bills',
  (await page.locator('select').first().locator('option').count()) > 1);
await page.screenshot({ path: `${SHOT}/07-receipt.png`, fullPage: true });

await page.locator('select').first().selectOption({ index: 1 });
await page.waitForTimeout(400);
await page.click('button:has-text("Record receipt")');
await page.waitForTimeout(2000);
const owedAfter = await page.locator('table tbody tr').first().innerText();
check('recording a receipt reduces what is owed', owedBefore !== owedAfter);

const realErrors = consoleErrors.filter((e) =>
  !e.includes('favicon') && !e.includes('React DevTools'));
check('no uncaught console errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  Failed: ${failures.join(', ')}`);
console.log(`${'='.repeat(60)}\n`);

await browser.close();
process.exit(fail ? 1 : 0);
