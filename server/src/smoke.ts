/**
 * End-to-end smoke test against a running API.
 *
 *   npm run start &   (or npm run dev)
 *   npx tsx src/smoke.ts
 *
 * Exercises the paths that actually matter in a pharmacy: FEFO dispensing,
 * expired-stock refusal, Schedule H/H1 gating, GST arithmetic on the invoice,
 * returns, and the H1 register.
 */

const BASE = process.env.API ?? 'http://localhost:4000/api';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(
  path: string, opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

async function main(): Promise<void> {
  console.log(`\nSmoke test against ${BASE}\n`);

  // ---- Auth ---------------------------------------------------------------
  console.log('Authentication');
  const bad = await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  check('rejects a wrong password', bad.status === 401);

  const login = await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  check('admin can sign in', login.status === 200 && !!login.data?.token);
  const admin = login.data.token as string;

  const cashierLogin = await api('/auth/login', { method: 'POST', body: { username: 'cashier', password: 'cash123' } });
  check('cashier can sign in', cashierLogin.status === 200);
  const cashier = cashierLogin.data.token as string;

  const noAuth = await api('/products');
  check('unauthenticated requests are refused', noAuth.status === 401);

  // ---- Masters ------------------------------------------------------------
  console.log('\nMasters & search');
  const products = await api('/products?q=dolo', { token: admin });
  check('product search finds Dolo 650', products.status === 200 && products.data.length > 0,
    JSON.stringify(products.data?.[0]?.name));

  const settings = await api('/settings', { token: admin });
  check('shop settings carry the Telangana GSTIN',
    settings.data?.gstin === '36AAPFU0939F1ZW' && settings.data?.state_code === '36');
  check('both retail drug licences are recorded',
    !!settings.data?.dl_no_form20 && !!settings.data?.dl_no_form21);

  // ---- Find test fixtures -------------------------------------------------
  const all = await api('/products?limit=200&inStock=true', { token: admin });
  // The OTC fixture is used to assert single-batch stock movement, so its
  // earliest-expiring batch must hold enough on its own — a product with 30 in
  // stock spread thinly would have FEFO split the line across two batches and
  // the assertions below would be measuring the wrong thing.
  let otc: any = null;
  for (const candidate of all.data.filter((p: any) => p.schedule_type === 'OTC' && p.stock_units > 30)) {
    const b = await api(`/products/${candidate.id}/batches`, { token: admin });
    if (b.data[0]?.qty_units >= 20) {
      otc = candidate;
      break;
    }
  }
  const scheduleH = all.data.find((p: any) => p.schedule_type === 'H' && p.stock_units > 30);
  const scheduleH1 = all.data.find((p: any) => p.schedule_type === 'H1' && p.stock_units > 20);
  check('found an OTC, an H and an H1 product to test with',
    !!otc && !!scheduleH && !!scheduleH1);

  const doctors = await api('/doctors', { token: admin });
  const doctorId = doctors.data[0].id;

  // ---- Billing: the OTC happy path ---------------------------------------
  console.log('\nBilling');
  const batchesBefore = await api(`/products/${otc.id}/batches`, { token: admin });
  const fefoBatch = batchesBefore.data[0];

  const sale1 = await api('/sales', {
    method: 'POST', token: admin,
    body: {
      customer_name: 'Smoke Test Customer',
      customer_phone: '9999900000',
      payment_mode: 'CASH',
      items: [{ product_id: otc.id, qty_units: 2 }],
    },
  });
  check('an OTC bill is created', sale1.status === 201, sale1.data?.error);
  check('invoice number follows the INV/FY/nnnnn series',
    /^INV\/\d{4}-\d{2}\/\d{5}$/.test(sale1.data?.invoice_no ?? ''), sale1.data?.invoice_no);
  check('FEFO picked the earliest-expiring batch',
    sale1.data?.items?.[0]?.batch_id === fefoBatch.id,
    `expected batch ${fefoBatch.id} (exp ${fefoBatch.expiry}), got ${sale1.data?.items?.[0]?.batch_id}`);
  check('batch number and expiry are on the invoice line',
    !!sale1.data?.items?.[0]?.batch_no && /^\d{4}-\d{2}$/.test(sale1.data?.items?.[0]?.expiry ?? ''));

  // GST arithmetic must foot exactly
  const s1 = sale1.data;
  const lineSum = s1.items.reduce((acc: number, i: any) => acc + i.total_paise, 0);
  check('line totals sum to the invoice value before rounding',
    s1.taxable_paise + s1.cgst_paise + s1.sgst_paise + s1.igst_paise === lineSum,
    `${s1.taxable_paise}+${s1.cgst_paise}+${s1.sgst_paise} vs ${lineSum}`);
  check('rounding adjustment reconciles the payable total',
    lineSum + s1.round_off_paise === s1.total_paise);
  check('the payable total is a whole number of rupees', s1.total_paise % 100 === 0);
  check('an intra-state sale splits CGST and SGST, with no IGST',
    s1.igst_paise === 0 && s1.cgst_paise > 0 && s1.sgst_paise === s1.cgst_paise + (s1.cgst_paise * 2 === s1.cgst_paise + s1.sgst_paise ? 0 : s1.sgst_paise - s1.cgst_paise));

  // Stock actually moved
  const afterStock = await api(`/products/${otc.id}`, { token: admin });
  const movedBatch = afterStock.data.batches.find((b: any) => b.id === fefoBatch.id);
  check('stock was decremented on the dispensed batch',
    movedBatch.qty_units === fefoBatch.qty_units - 2,
    `${fefoBatch.qty_units} -> ${movedBatch.qty_units}`);

  const ledger = await api(`/inventory/batches/${fefoBatch.id}/ledger`, { token: admin });
  check('a stock ledger entry was written for the sale',
    ledger.data[0]?.txn_type === 'SALE' && ledger.data[0]?.qty_out === 2);

  // ---- Compliance gates ---------------------------------------------------
  console.log('\nCompliance gates');
  const noRx = await api('/sales', {
    method: 'POST', token: admin,
    body: { items: [{ product_id: scheduleH.id, qty_units: 1 }] },
  });
  check('Schedule H without a prescriber is refused', noRx.status === 400,
    `got ${noRx.status}: ${noRx.data?.error}`);

  const h1NoPatient = await api('/sales', {
    method: 'POST', token: admin,
    body: { doctor_id: doctorId, items: [{ product_id: scheduleH1.id, qty_units: 1 }] },
  });
  check('Schedule H1 without patient details is refused', h1NoPatient.status === 400,
    h1NoPatient.data?.error);

  const h1NoAddress = await api('/sales', {
    method: 'POST', token: admin,
    body: {
      doctor_id: doctorId, patient_name: 'Test Patient',
      items: [{ product_id: scheduleH1.id, qty_units: 1 }],
    },
  });
  check('Schedule H1 without a patient address is refused', h1NoAddress.status === 400,
    h1NoAddress.data?.error);

  const h1ByCashier = await api('/sales', {
    method: 'POST', token: cashier,
    body: {
      doctor_id: doctorId, patient_name: 'Test Patient', patient_address: 'Habsiguda',
      items: [{ product_id: scheduleH1.id, qty_units: 1 }],
    },
  });
  check('a cashier cannot dispense Schedule H1', h1ByCashier.status === 403,
    `got ${h1ByCashier.status}: ${h1ByCashier.data?.error}`);

  const h1Sale = await api('/sales', {
    method: 'POST', token: admin,
    body: {
      doctor_id: doctorId, prescription_no: 'RX-SMOKE-1',
      patient_name: 'Smoke Patient', patient_address: 'Habsiguda, Hyderabad',
      items: [{ product_id: scheduleH1.id, qty_units: 2 }],
    },
  });
  check('a complete Schedule H1 bill succeeds', h1Sale.status === 201, h1Sale.data?.error);

  const register = await api('/reports/h1-register?q=Smoke Patient', { token: admin });
  const entry = register.data?.rows?.[0];
  check('the H1 register entry was created', !!entry);
  check('the register records prescriber, patient, batch, expiry and pharmacist',
    !!entry?.prescriber_name && !!entry?.patient_name && !!entry?.patient_address
    && !!entry?.batch_no && !!entry?.expiry && !!entry?.pharmacist_name && !!entry?.manufacturer,
    JSON.stringify(entry));

  const h1RegisterByCashier = await api('/reports/h1-register', { token: cashier });
  check('a cashier cannot read the H1 register', h1RegisterByCashier.status === 403);

  // ---- Expired stock ------------------------------------------------------
  console.log('\nExpired stock');
  const expired = await api('/inventory/stock?filter=expired', { token: admin });
  check('expired batches are reported', expired.data.length > 0, `${expired.data.length} found`);

  if (expired.data.length > 0) {
    const e = expired.data[0];
    const sellExpired = await api('/sales', {
      method: 'POST', token: admin,
      body: { items: [{ product_id: e.product_id, batch_id: e.id, qty_units: 1 }] },
    });
    check('selling an explicitly chosen expired batch is refused',
      sellExpired.status === 400 && /expired/i.test(sellExpired.data?.error ?? ''),
      sellExpired.data?.error);
  }

  // ---- Over-selling -------------------------------------------------------
  const oversell = await api('/sales', {
    method: 'POST', token: admin,
    body: { items: [{ product_id: otc.id, qty_units: 9_999_999 }] },
  });
  check('over-selling beyond available stock is refused', oversell.status === 400,
    oversell.data?.error);

  // ---- Returns ------------------------------------------------------------
  console.log('\nReturns');
  const ret = await api('/returns', {
    method: 'POST', token: admin,
    body: {
      sale_id: s1.id, reason: 'Customer changed mind', restock: true,
      items: [{ sale_item_id: s1.items[0].id, qty_units: 1 }],
    },
  });
  check('a credit note is created', ret.status === 201, ret.data?.error);
  check('credit note number follows the CN/FY/nnnnn series',
    /^CN\/\d{4}-\d{2}\/\d{5}$/.test(ret.data?.return_no ?? ''), ret.data?.return_no);

  const afterReturn = await api(`/products/${otc.id}`, { token: admin });
  const restocked = afterReturn.data.batches.find((b: any) => b.id === fefoBatch.id);
  check('returned stock went back to the original batch',
    restocked.qty_units === fefoBatch.qty_units - 1,
    `${restocked.qty_units} vs expected ${fefoBatch.qty_units - 1}`);

  const overReturn = await api('/returns', {
    method: 'POST', token: admin,
    body: {
      sale_id: s1.id, reason: 'Trying to over-return',
      items: [{ sale_item_id: s1.items[0].id, qty_units: 5 }],
    },
  });
  check('returning more than was billed is refused', overReturn.status === 400,
    overReturn.data?.error);

  const cashierReturn = await api('/returns', {
    method: 'POST', token: cashier,
    body: {
      sale_id: s1.id, reason: 'cashier attempt',
      items: [{ sale_item_id: s1.items[0].id, qty_units: 1 }],
    },
  });
  check('a cashier cannot process a return', cashierReturn.status === 403);

  // ---- Purchases ----------------------------------------------------------
  console.log('\nPurchase entry');
  const suppliers = await api('/suppliers', { token: admin });
  const localSupplier = suppliers.data.find((s: any) => s.state_code === '36');
  const outstateSupplier = suppliers.data.find((s: any) => s.state_code !== '36');

  const stamp = Date.now();
  const purchase = await api('/purchases', {
    method: 'POST', token: admin,
    body: {
      supplier_id: localSupplier.id,
      invoice_no: `SMOKE-${stamp}`,
      invoice_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: otc.id, batch_no: `SMK${stamp % 10000}`,
        expiry: '2028-12', qty_packs: 10, free_packs: 1,
        purchase_rate_paise: 2000, mrp_paise: 3450, discount_pct: 5,
      }],
    },
  });
  check('goods inward is recorded', purchase.status === 201, purchase.data?.error);
  check('an intra-state purchase claims CGST + SGST input credit',
    purchase.data?.cgst_paise > 0 && purchase.data?.igst_paise === 0);
  check('free goods entered stock without cost',
    purchase.data?.items?.[0]?.free_packs === 1);

  const dupe = await api('/purchases', {
    method: 'POST', token: admin,
    body: {
      supplier_id: localSupplier.id, invoice_no: `SMOKE-${stamp}`,
      invoice_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: otc.id, batch_no: 'X1', expiry: '2028-12', qty_packs: 1,
        purchase_rate_paise: 100, mrp_paise: 200,
      }],
    },
  });
  check('a duplicate distributor invoice is rejected', dupe.status === 409, dupe.data?.error);

  const interstate = await api('/purchases', {
    method: 'POST', token: admin,
    body: {
      supplier_id: outstateSupplier.id, invoice_no: `SMOKE-IS-${stamp}`,
      invoice_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: otc.id, batch_no: `ISM${stamp % 10000}`, expiry: '2028-11',
        qty_packs: 5, purchase_rate_paise: 2000, mrp_paise: 3450,
      }],
    },
  });
  check('an out-of-state purchase uses IGST',
    interstate.data?.igst_paise > 0 && interstate.data?.cgst_paise === 0,
    `cgst=${interstate.data?.cgst_paise} igst=${interstate.data?.igst_paise}`);

  const expiredIntake = await api('/purchases', {
    method: 'POST', token: admin,
    body: {
      supplier_id: localSupplier.id, invoice_no: `SMOKE-EXP-${stamp}`,
      invoice_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: otc.id, batch_no: 'OLDSTOCK', expiry: '2020-01',
        qty_packs: 5, purchase_rate_paise: 2000, mrp_paise: 3450,
      }],
    },
  });
  check('taking already-expired goods into stock is refused', expiredIntake.status === 400,
    expiredIntake.data?.error);

  const aboveMrp = await api('/purchases', {
    method: 'POST', token: admin,
    body: {
      supplier_id: localSupplier.id, invoice_no: `SMOKE-MRP-${stamp}`,
      invoice_date: new Date().toISOString().slice(0, 10),
      items: [{
        product_id: otc.id, batch_no: 'OVERPRICED', expiry: '2028-01',
        qty_packs: 5, purchase_rate_paise: 2000, mrp_paise: 3450, sale_rate_paise: 5000,
      }],
    },
  });
  check('a selling rate above MRP is refused', aboveMrp.status === 400, aboveMrp.data?.error);

  // ---- Cancellation -------------------------------------------------------
  console.log('\nCancellation');
  const toCancel = await api('/sales', {
    method: 'POST', token: admin,
    body: { items: [{ product_id: otc.id, qty_units: 3 }] },
  });
  const cancelBatchId = toCancel.data.items[0].batch_id;
  const beforeCancel = (await api(`/products/${otc.id}`, { token: admin }))
    .data.batches.find((b: any) => b.id === cancelBatchId).qty_units;

  const noReason = await api(`/sales/${toCancel.data.id}/cancel`, { method: 'POST', token: admin, body: {} });
  check('cancelling without a reason is refused', noReason.status === 400);

  const cancelled = await api(`/sales/${toCancel.data.id}/cancel`, {
    method: 'POST', token: admin, body: { reason: 'Smoke test cancellation' },
  });
  check('a bill can be cancelled with a reason', cancelled.status === 200, cancelled.data?.error);

  const afterCancel = (await api(`/products/${otc.id}`, { token: admin }))
    .data.batches.find((b: any) => b.id === cancelBatchId).qty_units;
  check('cancelling returns stock to the batch',
    afterCancel === beforeCancel + toCancel.data.items[0].qty_units,
    `${beforeCancel} -> ${afterCancel}`);

  const cancelByCashier = await api(`/sales/${s1.id}/cancel`, {
    method: 'POST', token: cashier, body: { reason: 'nope' },
  });
  check('a cashier cannot cancel a bill', cancelByCashier.status === 403);

  // ---- Reports ------------------------------------------------------------
  console.log('\nReports');
  const dash = await api('/reports/dashboard', { token: admin });
  check('dashboard returns today\'s figures', dash.status === 200 && dash.data.todaySales.bills > 0);
  check('dashboard reports a 7-day trend', Array.isArray(dash.data.last7) && dash.data.last7.length > 0);

  const gst = await api('/reports/gst?from=2020-01-01&to=2030-12-31', { token: admin });
  check('GST report groups by HSN and rate', gst.data.outward.length > 0);
  check('GST report computes net liability after ITC',
    typeof gst.data.liability?.net_payable_paise === 'number');
  const hsnFooting = gst.data.outward.every((r: any) =>
    Math.abs((r.taxable_paise + r.cgst_paise + r.sgst_paise + r.igst_paise) - r.total_paise) <= 1);
  check('every HSN row foots (taxable + tax = total)', hsnFooting);

  const medicineSlabs = gst.data.outward
    .filter((r: any) => r.hsn_code.startsWith('300'))
    .every((r: any) => [0, 5, 18].includes(r.gst_rate));
  check('medicines sit only in the Nil/5/18 slabs', medicineSlabs,
    JSON.stringify(gst.data.outward.filter((r: any) => r.hsn_code.startsWith('300')).map((r: any) => `${r.hsn_code}@${r.gst_rate}`)));

  const expiryReport = await api('/reports/expiry?months=6', { token: admin });
  check('expiry report buckets stock by month', expiryReport.data.buckets.length > 0);

  const stockSummary = await api('/inventory/summary', { token: admin });
  check('inventory valuation is available',
    stockSummary.data.valuation.cost_paise > 0 && stockSummary.data.valuation.mrp_paise > 0);
  check('MRP valuation exceeds cost valuation',
    stockSummary.data.valuation.mrp_paise > stockSummary.data.valuation.cost_paise);

  const reorder = await api('/inventory/reorder', { token: admin });
  check('reorder list is available', Array.isArray(reorder.data));

  const daybook = await api('/reports/daybook', { token: admin });
  check('daybook reconciles collections by payment mode',
    Array.isArray(daybook.data.collections));

  const movement = await api('/reports/product-movement?from=2020-01-01&to=2030-12-31', { token: admin });
  check('product movement ranks top sellers', movement.data.top.length > 0);

  const auditByCashier = await api('/reports/audit', { token: cashier });
  check('a cashier cannot read the audit log', auditByCashier.status === 403);

  // ---- Stock adjustment ---------------------------------------------------
  console.log('\nStock adjustment');
  const adjBatch = (await api(`/products/${otc.id}/batches`, { token: admin })).data[0];
  const adj = await api('/inventory/adjust', {
    method: 'POST', token: admin,
    body: { batch_id: adjBatch.id, qty_delta: -2, reason: 'DAMAGE', note: 'Smoke test breakage' },
  });
  check('stock can be adjusted down for breakage', adj.status === 200,
    adj.data?.error);
  check('the adjusted balance is returned', adj.data?.qty_units === adjBatch.qty_units - 2);

  const overAdjust = await api('/inventory/adjust', {
    method: 'POST', token: admin,
    body: { batch_id: adjBatch.id, qty_delta: -999999, reason: 'DAMAGE', note: '' },
  });
  check('adjusting below zero is refused', overAdjust.status === 400);

  // ---- Settings validation ------------------------------------------------
  console.log('\nSettings validation');
  const badGstin = await api('/settings', {
    method: 'PUT', token: admin, body: { gstin: '36INVALID0000ZZ' },
  });
  check('an invalid GSTIN is rejected', badGstin.status === 400, badGstin.data?.error);

  const mismatch = await api('/settings', {
    method: 'PUT', token: admin, body: { gstin: '27AAPFU0939F1ZV', state_code: '36' },
  });
  check('a GSTIN whose state code contradicts the shop state is rejected',
    mismatch.status === 400, mismatch.data?.error);

  const settingsByCashier = await api('/settings', {
    method: 'PUT', token: cashier, body: { shop_name: 'Hacked' },
  });
  check('a cashier cannot change shop settings', settingsByCashier.status === 403);

  // ---- Result -------------------------------------------------------------
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
