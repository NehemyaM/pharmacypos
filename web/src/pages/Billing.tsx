import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SessionUser } from '../lib/api';
import {
  rupees, formatExpiry, monthsToExpiry, scheduleClass, formatQty, PAYMENT_MODES,
} from '../lib/format';
import { Alert, Spinner, Modal, useAutoFocus } from '../components/ui';
import DoctorPicker from '../components/DoctorPicker';

type ProductHit = {
  id: number; name: string; generic_name: string; manufacturer: string;
  schedule_type: string; gst_rate: number; hsn_code: string; unit: string;
  pack_size: number; pack_label: string; rack: string; allow_loose: number;
  // Present on search results, absent when a single product is fetched by id.
  stock_units?: number; nearest_expiry?: string | null; mrp_paise?: number | null;
};

type BatchOption = {
  id: number; batch_no: string; expiry: string; mrp_paise: number;
  sale_rate_paise: number; qty_units: number;
};

type Customer = { id: number; name: string; phone: string; address: string; gstin: string };

type HeldBill = {
  id: number; label: string; item_count: number; total_paise: number;
  created_at: string; held_by_name: string | null;
};

type CreditBalance = {
  customer_id: number; name: string; credit_limit_paise: number;
  outstanding_paise: number; available_paise: number | null; over_limit: boolean;
};

type CartLine = {
  key: string;
  product: ProductHit;
  batch: BatchOption;
  batches: BatchOption[];
  qtyUnits: number;
  discountPct: number;
};

const RX_SCHEDULES = new Set(['H', 'H1', 'X', 'C', 'C1']);
const H1_SCHEDULES = new Set(['H1', 'X']);

export default function Billing({ user }: { user: SessionUser }) {
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [searching, setSearching] = useState(false);
  const [lines, setLines] = useState<CartLine[]>([]);

  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerGstin, setCustomerGstin] = useState('');
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerMatches, setCustomerMatches] = useState<Customer[]>([]);

  const [doctorId, setDoctorId] = useState<number | null>(null);
  const [prescriptionNo, setPrescriptionNo] = useState('');
  const [patientName, setPatientName] = useState('');
  const [patientAddress, setPatientAddress] = useState('');

  const [paymentMode, setPaymentMode] = useState<string>('CASH');
  const [paymentRef, setPaymentRef] = useState('');
  const [billDiscountPct, setBillDiscountPct] = useState(0);

  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [saving, setSaving] = useState(false);
  const [batchPickerFor, setBatchPickerFor] = useState<string | null>(null);

  const [heldBills, setHeldBills] = useState<HeldBill[]>([]);
  const [showHeld, setShowHeld] = useState(false);
  const [holdPrompt, setHoldPrompt] = useState(false);
  const [balance, setBalance] = useState<CreditBalance | null>(null);

  const searchRef = useAutoFocus<HTMLInputElement>();
  const resultsRef = useRef<HTMLDivElement>(null);

  const loadHeld = useCallback(() => {
    api.get<HeldBill[]>('/held-bills').then(setHeldBills).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadHeld();
  }, [loadHeld]);

  // What this customer already owes, so the counter sees it before extending more.
  useEffect(() => {
    if (!customerId) {
      setBalance(null);
      return;
    }
    api.get<CreditBalance>(`/customer-ledger/balance/${customerId}`)
      .then(setBalance).catch(() => setBalance(null));
  }, [customerId]);

  // ---- Product search (debounced) -----------------------------------------
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api.get<ProductHit[]>(`/products?q=${encodeURIComponent(q)}&limit=12&inStock=true`)
        .then((rows) => {
          setHits(rows);
          setHighlight(0);
        })
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 160);
    return () => clearTimeout(timer);
  }, [query]);

  // ---- Customer lookup by phone -------------------------------------------
  useEffect(() => {
    const q = customerPhone.trim();
    if (q.length < 4) {
      setCustomerMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      api.get<Customer[]>(`/customers?q=${encodeURIComponent(q)}`)
        .then(setCustomerMatches).catch(() => setCustomerMatches([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [customerPhone]);

  const addProduct = useCallback(async (product: ProductHit) => {
    setError('');
    try {
      const batches = await api.get<BatchOption[]>(`/products/${product.id}/batches`);
      if (batches.length === 0) {
        setError(`${product.name} has no saleable stock — every batch is out or expired.`);
        return;
      }
      const batch = batches[0]; // API returns FEFO order

      // Same product+batch already on the bill? Just bump the quantity.
      const existing = lines.find((l) => l.product.id === product.id && l.batch.id === batch.id);
      if (existing) {
        setLines((prev) => prev.map((l) =>
          l.key === existing.key
            ? { ...l, qtyUnits: Math.min(l.qtyUnits + defaultQty(product), batch.qty_units) }
            : l));
      } else {
        setLines((prev) => [...prev, {
          key: `${product.id}-${batch.id}-${Date.now()}`,
          product, batch, batches,
          qtyUnits: defaultQty(product),
          discountPct: 0,
        }]);
      }
      setQuery('');
      setHits([]);
      searchRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load batches');
    }
  }, [lines, searchRef]);

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (hits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[highlight];
      if (hit) void addProduct(hit);
    } else if (e.key === 'Escape') {
      setQuery('');
      setHits([]);
    }
  }

  useEffect(() => {
    resultsRef.current?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function updateLine(key: string, patch: Partial<CartLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  // ---- Live totals, mirroring the server's arithmetic exactly --------------
  const totals = useMemo(() => {
    let gross = 0, discount = 0, taxable = 0, cgst = 0, sgst = 0;
    const byRate = new Map<number, { taxable: number; tax: number }>();

    for (const l of lines) {
      const effectiveDiscount = Math.min(100, l.discountPct + billDiscountPct);
      const lineGross = Math.round((l.batch.sale_rate_paise * l.qtyUnits) / l.product.pack_size);
      const lineDiscount = Math.round((lineGross * effectiveDiscount) / 100);
      const net = lineGross - lineDiscount;
      const lineTaxable = l.product.gst_rate === 0
        ? net
        : Math.round((net * 100) / (100 + l.product.gst_rate));
      const tax = net - lineTaxable;
      const lineCgst = Math.floor(tax / 2);

      gross += lineGross;
      discount += lineDiscount;
      taxable += lineTaxable;
      cgst += lineCgst;
      sgst += tax - lineCgst;

      const bucket = byRate.get(l.product.gst_rate) ?? { taxable: 0, tax: 0 };
      bucket.taxable += lineTaxable;
      bucket.tax += tax;
      byRate.set(l.product.gst_rate, bucket);
    }

    const beforeRounding = taxable + cgst + sgst;
    const total = Math.round(beforeRounding / 100) * 100;
    return {
      gross, discount, taxable, cgst, sgst,
      roundOff: total - beforeRounding,
      total,
      byRate: [...byRate.entries()].sort((a, b) => a[0] - b[0]),
    };
  }, [lines, billDiscountPct]);

  const needsRx = lines.some((l) => RX_SCHEDULES.has(l.product.schedule_type));
  const needsH1 = lines.some((l) => H1_SCHEDULES.has(l.product.schedule_type));
  const cashierBlocked = needsH1 && user.role === 'cashier';

  const blockers = useMemo(() => {
    const out: string[] = [];
    if (lines.length === 0) out.push('Add at least one item');
    if (needsRx && !doctorId) out.push('Select the prescribing doctor');
    if (needsH1 && !patientName.trim()) out.push('Enter the patient name');
    if (needsH1 && !patientAddress.trim()) out.push('Enter the patient address');
    if (cashierBlocked) out.push('Schedule H1 must be dispensed by a pharmacist');
    return out;
  }, [lines.length, needsRx, doctorId, needsH1, patientName, patientAddress, cashierBlocked]);

  const save = useCallback(async (andPrint: boolean) => {
    if (blockers.length > 0 || saving) return;
    setSaving(true);
    setError('');
    try {
      const sale = await api.post<{ id: number }>('/sales', {
        customer_id: customerId,
        customer_name: customerName.trim() || 'Cash Customer',
        customer_phone: customerPhone.trim(),
        customer_gstin: customerGstin.trim().toUpperCase(),
        doctor_id: doctorId,
        prescription_no: prescriptionNo.trim(),
        patient_name: patientName.trim(),
        patient_address: patientAddress.trim(),
        payment_mode: paymentMode,
        payment_ref: paymentRef.trim(),
        overall_discount_pct: billDiscountPct,
        items: lines.map((l) => ({
          product_id: l.product.id,
          batch_id: l.batch.id,
          qty_units: l.qtyUnits,
          discount_pct: l.discountPct,
        })),
      });
      navigate(`/invoices/${sale.id}${andPrint ? '?print=1' : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the bill');
      setSaving(false);
    }
  }, [blockers.length, saving, customerId, customerName, customerPhone, customerGstin,
    doctorId, prescriptionNo, patientName, patientAddress, paymentMode, paymentRef,
    billDiscountPct, lines, navigate]);

  function resetCart() {
    setLines([]);
    setCustomerId(null);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerGstin('');
    setDoctorId(null);
    setPrescriptionNo('');
    setPatientName('');
    setPatientAddress('');
    setPaymentMode('CASH');
    setPaymentRef('');
    setBillDiscountPct(0);
    setError('');
    setWarning('');
  }

  /** Park the basket so the counter can serve the next customer. */
  const holdBill = useCallback(async (label: string) => {
    if (lines.length === 0) return;
    setError('');
    try {
      await api.post('/held-bills', {
        label,
        total_paise: totals.total,
        cart: {
          customer_id: customerId,
          customer_name: customerName,
          customer_phone: customerPhone,
          customer_gstin: customerGstin,
          doctor_id: doctorId,
          prescription_no: prescriptionNo,
          patient_name: patientName,
          patient_address: patientAddress,
          payment_mode: paymentMode,
          overall_discount_pct: billDiscountPct,
          items: lines.map((l) => ({
            product_id: l.product.id,
            batch_id: l.batch.id,
            qty_units: l.qtyUnits,
            discount_pct: l.discountPct,
          })),
        },
      });
      resetCart();
      loadHeld();
      setHoldPrompt(false);
      searchRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not hold the bill');
    }
  }, [lines, totals.total, customerId, customerName, customerPhone, customerGstin,
    doctorId, prescriptionNo, patientName, patientAddress, paymentMode, billDiscountPct,
    loadHeld, searchRef]);

  /**
   * Resume a held bill. Stock was never reserved, so the server re-checks every
   * line and tells us what changed while the bill was parked.
   */
  async function resumeBill(id: number) {
    setError('');
    setWarning('');
    try {
      const held = await api.get<{
        cart: any; warnings: string[];
      }>(`/held-bills/${id}`);

      const rebuilt: CartLine[] = [];
      for (const item of held.cart.items) {
        const [product, batches] = await Promise.all([
          api.get<ProductHit>(`/products/${item.product_id}`),
          api.get<BatchOption[]>(`/products/${item.product_id}/batches`),
        ]);
        const batch = batches.find((b) => b.id === item.batch_id);
        if (!batch) continue;
        rebuilt.push({
          key: `${item.product_id}-${item.batch_id}-${Date.now()}-${rebuilt.length}`,
          product, batch, batches,
          qtyUnits: item.qty_units,
          discountPct: item.discount_pct ?? 0,
        });
      }

      setLines(rebuilt);
      setCustomerId(held.cart.customer_id ?? null);
      setCustomerName(held.cart.customer_name ?? '');
      setCustomerPhone(held.cart.customer_phone ?? '');
      setCustomerGstin(held.cart.customer_gstin ?? '');
      setDoctorId(held.cart.doctor_id ?? null);
      setPrescriptionNo(held.cart.prescription_no ?? '');
      setPatientName(held.cart.patient_name ?? '');
      setPatientAddress(held.cart.patient_address ?? '');
      setPaymentMode(held.cart.payment_mode ?? 'CASH');
      setBillDiscountPct(held.cart.overall_discount_pct ?? 0);

      if (held.warnings.length > 0) setWarning(held.warnings.join(' · '));
      if (rebuilt.length === 0) {
        setError('Nothing on that held bill is still available to sell.');
      }

      // The bill is now on screen, so it must not also remain in the tray —
      // otherwise the same basket can be resumed twice and billed twice.
      await api.del(`/held-bills/${id}`);
      loadHeld();
      setShowHeld(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resume that bill');
    }
  }

  // ---- Global shortcuts ---------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F9') {
        e.preventDefault();
        void save(true);
      } else if (e.key === 'F8') {
        e.preventDefault();
        void save(false);
      } else if (e.key === 'F6') {
        e.preventDefault();
        if (lines.length > 0) setHoldPrompt(true);
        else setShowHeld(true);
      } else if (e.key === 'F7') {
        e.preventDefault();
        setShowHeld(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, searchRef, lines.length]);

  const pickerLine = lines.find((l) => l.key === batchPickerFor);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-slate-800">New Bill</h1>
          <span className="text-xs text-slate-400">
            <span className="kbd">Ctrl</span>+<span className="kbd">K</span> search ·
            <span className="kbd ml-1">F6</span> hold ·
            <span className="kbd ml-1">F8</span> save ·
            <span className="kbd ml-1">F9</span> save &amp; print
          </span>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowHeld(true)}
            className={`relative rounded-lg border px-3 py-1.5 text-sm font-medium ${
              heldBills.length > 0
                ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                : 'border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}
            title="Bills parked for later (F7)"
          >
            Held bills
            {heldBills.length > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white">
                {heldBills.length}
              </span>
            )}
          </button>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-slate-400">Payable</p>
            <p className="text-xl font-bold tabular text-slate-900">{rupees(totals.total)}</p>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ------------------------------- Items ------------------------------- */}
        <section className="flex min-w-0 flex-1 flex-col border-r border-slate-200">
          <div className="relative border-b border-slate-200 bg-white p-3">
            <input
              ref={searchRef}
              className="input py-2.5 text-base"
              placeholder="Search medicine by brand, salt, manufacturer or scan barcode…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            {searching && <Spinner className="absolute right-6 top-6 text-slate-400" />}

            {hits.length > 0 && (
              <div
                ref={resultsRef}
                className="absolute left-3 right-3 top-full z-20 max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
              >
                {hits.map((hit, i) => {
                  const expiryMonths = hit.nearest_expiry ? monthsToExpiry(hit.nearest_expiry) : 99;
                  return (
                    <button
                      key={hit.id}
                      data-active={i === highlight}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => void addProduct(hit)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left ${
                        i === highlight ? 'bg-brand-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-slate-800">{hit.name}</span>
                          {hit.schedule_type !== 'OTC' && (
                            <span className={`chip ${scheduleClass(hit.schedule_type)}`}>{hit.schedule_type}</span>
                          )}
                        </div>
                        <p className="truncate text-xs text-slate-500">
                          {hit.generic_name} · {hit.manufacturer}
                          {hit.rack && ` · Rack ${hit.rack}`}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold tabular text-slate-800">
                          {hit.mrp_paise ? rupees(hit.mrp_paise) : '—'}
                        </p>
                        <p className={`text-xs tabular ${expiryMonths <= 3 ? 'text-amber-600' : 'text-slate-400'}`}>
                          {hit.stock_units} {hit.unit}
                          {hit.nearest_expiry && ` · exp ${formatExpiry(hit.nearest_expiry)}`}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {lines.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <div className="text-4xl opacity-20">🧾</div>
                <p className="text-sm font-medium text-slate-500">Start typing to add medicines</p>
                <p className="text-xs text-slate-400">
                  Earliest-expiring batch is picked automatically (FEFO)
                </p>
              </div>
            ) : (
              <table className="w-full">
                <thead className="sticky top-0 bg-slate-50 shadow-sm">
                  <tr>
                    <th className="th w-8">#</th>
                    <th className="th">Medicine</th>
                    <th className="th w-40">Batch / Expiry</th>
                    <th className="th w-24 text-right">Qty</th>
                    <th className="th w-24 text-right">Rate</th>
                    <th className="th w-20 text-right">Disc %</th>
                    <th className="th w-16 text-right">GST</th>
                    <th className="th w-28 text-right">Amount</th>
                    <th className="th w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lines.map((l, i) => {
                    const effectiveDiscount = Math.min(100, l.discountPct + billDiscountPct);
                    const lineGross = Math.round((l.batch.sale_rate_paise * l.qtyUnits) / l.product.pack_size);
                    const amount = lineGross - Math.round((lineGross * effectiveDiscount) / 100);
                    const expMonths = monthsToExpiry(l.batch.expiry);
                    const overQty = l.qtyUnits > l.batch.qty_units;

                    return (
                      <tr key={l.key} className={overQty ? 'bg-red-50' : 'bg-white'}>
                        <td className="td text-slate-400">{i + 1}</td>
                        <td className="td">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-800">{l.product.name}</span>
                            {l.product.schedule_type !== 'OTC' && (
                              <span className={`chip ${scheduleClass(l.product.schedule_type)}`}>
                                {l.product.schedule_type}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400">
                            {l.product.pack_label || `${l.product.pack_size} ${l.product.unit}`}
                            {' · '}{l.product.manufacturer}
                          </p>
                        </td>
                        <td className="td">
                          <button
                            onClick={() => setBatchPickerFor(l.key)}
                            className="rounded border border-slate-200 px-2 py-1 text-left hover:border-brand-400 hover:bg-brand-50"
                          >
                            <span className="block font-mono text-xs font-medium text-slate-700">
                              {l.batch.batch_no}
                            </span>
                            <span className={`block text-[11px] ${expMonths <= 3 ? 'font-semibold text-amber-600' : 'text-slate-400'}`}>
                              exp {formatExpiry(l.batch.expiry)}
                              {l.batches.length > 1 && ` · ${l.batches.length} batches`}
                            </span>
                          </button>
                        </td>
                        <td className="td text-right">
                          <input
                            type="number" min={1} max={l.batch.qty_units}
                            className="input w-20 py-1 text-right tabular"
                            value={l.qtyUnits}
                            onChange={(e) => updateLine(l.key, {
                              qtyUnits: Math.max(1, Number(e.target.value) || 1),
                            })}
                          />
                          <p className="mt-0.5 text-[11px] text-slate-400">
                            of {l.batch.qty_units} {l.product.unit}
                          </p>
                        </td>
                        <td className="td text-right tabular text-slate-600">
                          {rupees(Math.round(l.batch.sale_rate_paise / l.product.pack_size))}
                        </td>
                        <td className="td text-right">
                          <input
                            type="number" min={0} max={100} step={0.5}
                            className="input w-16 py-1 text-right tabular"
                            value={l.discountPct}
                            onChange={(e) => updateLine(l.key, {
                              discountPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                            })}
                          />
                        </td>
                        <td className="td text-right tabular text-slate-500">{l.product.gst_rate}%</td>
                        <td className="td text-right font-semibold tabular text-slate-900">
                          {rupees(amount)}
                        </td>
                        <td className="td text-right">
                          <button
                            onClick={() => removeLine(l.key)}
                            className="text-slate-300 hover:text-red-600"
                            aria-label={`Remove ${l.product.name}`}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* ------------------------------ Sidebar ------------------------------ */}
        <aside className="flex w-96 shrink-0 flex-col overflow-y-auto bg-white">
          <div className="space-y-4 p-4">
            {error && <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert>}
            {warning && <Alert kind="warning" onDismiss={() => setWarning('')}>{warning}</Alert>}

            {/* What this customer already owes, before more credit is extended */}
            {balance && balance.outstanding_paise > 0 && (
              <Alert kind={balance.over_limit ? 'error' : 'warning'}>
                <p className="font-semibold">
                  {balance.name} owes {rupees(balance.outstanding_paise)}
                </p>
                <p className="mt-0.5 text-xs">
                  {balance.credit_limit_paise > 0 ? (
                    balance.over_limit
                      ? `Already past their ${rupees(balance.credit_limit_paise)} limit — no further credit.`
                      : `${rupees(balance.available_paise ?? 0)} of their ${rupees(balance.credit_limit_paise)} limit still available.`
                  ) : 'No credit limit set for this customer.'}
                </p>
              </Alert>
            )}

            {needsH1 && (
              <Alert kind="warning">
                <p className="font-semibold">Schedule H1 / X on this bill</p>
                <p className="mt-0.5 text-xs">
                  Prescriber and patient details are recorded in the statutory register
                  and retained for three years.
                </p>
              </Alert>
            )}

            {/* Customer */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Customer
              </h3>
              <div className="space-y-2">
                <div className="relative">
                  <input
                    className="input" placeholder="Phone number" value={customerPhone}
                    onChange={(e) => { setCustomerPhone(e.target.value); setCustomerId(null); }}
                  />
                  {customerMatches.length > 0 && !customerId && (
                    <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                      {customerMatches.map((c) => (
                        <button
                          key={c.id}
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                          onClick={() => {
                            setCustomerId(c.id);
                            setCustomerName(c.name);
                            setCustomerPhone(c.phone);
                            setCustomerGstin(c.gstin);
                            setCustomerMatches([]);
                            if (!patientName) setPatientName(c.name);
                            if (!patientAddress) setPatientAddress(c.address);
                          }}
                        >
                          <span className="font-medium text-slate-700">{c.name}</span>
                          <span className="ml-2 text-xs text-slate-400">{c.phone}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  className="input" placeholder="Name (optional — defaults to Cash Customer)"
                  value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                />
                <input
                  className="input font-mono uppercase" placeholder="GSTIN (for B2B invoice)"
                  value={customerGstin} onChange={(e) => setCustomerGstin(e.target.value)}
                />
              </div>
            </div>

            {/* Prescription */}
            {needsRx && (
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Prescription
                  <span className="chip border-red-200 bg-red-100 text-red-700">Required</span>
                </h3>
                <div className="space-y-2">
                  <DoctorPicker value={doctorId} onChange={setDoctorId} />
                  <input
                    className="input" placeholder="Prescription number (optional)"
                    value={prescriptionNo} onChange={(e) => setPrescriptionNo(e.target.value)}
                  />
                  {needsH1 && (
                    <>
                      <input
                        className="input" placeholder="Patient name *"
                        value={patientName} onChange={(e) => setPatientName(e.target.value)}
                      />
                      <input
                        className="input" placeholder="Patient address *"
                        value={patientAddress} onChange={(e) => setPatientAddress(e.target.value)}
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Payment */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Payment
              </h3>
              <div className="mb-2 grid grid-cols-4 gap-1">
                {PAYMENT_MODES.map((m) => (
                  <button
                    key={m}
                    onClick={() => setPaymentMode(m)}
                    className={`rounded-lg border px-2 py-1.5 text-xs font-medium ${
                      paymentMode === m
                        ? 'border-brand-500 bg-brand-50 text-brand-800'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              {(paymentMode === 'UPI' || paymentMode === 'CARD') && (
                <input
                  className="input" placeholder={paymentMode === 'UPI' ? 'UPI reference' : 'Last 4 digits'}
                  value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)}
                />
              )}
              <div className="mt-2 flex items-center gap-2">
                <label className="text-xs text-slate-500" htmlFor="billdisc">Bill discount</label>
                <input
                  id="billdisc" type="number" min={0} max={100} step={0.5}
                  className="input w-20 py-1 text-right tabular"
                  value={billDiscountPct}
                  onChange={(e) => setBillDiscountPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                />
                <span className="text-xs text-slate-500">%</span>
              </div>
            </div>
          </div>

          {/* Totals */}
          <div className="mt-auto border-t border-slate-200 bg-slate-50 p-4">
            <dl className="space-y-1 text-sm">
              <Row label="Gross" value={rupees(totals.gross)} />
              {totals.discount > 0 && (
                <Row label="Discount" value={`− ${rupees(totals.discount)}`} tone="text-emerald-600" />
              )}
              <Row label="Taxable value" value={rupees(totals.taxable)} muted />
              {totals.byRate.map(([rate, b]) => (
                <Row
                  key={rate}
                  label={`CGST + SGST @ ${rate}%`}
                  value={rupees(b.tax)}
                  muted
                />
              ))}
              {totals.roundOff !== 0 && (
                <Row label="Round off" value={rupees(totals.roundOff)} muted />
              )}
              <div className="!mt-3 flex items-baseline justify-between border-t border-slate-200 pt-2">
                <dt className="text-sm font-semibold text-slate-700">Payable</dt>
                <dd className="text-2xl font-bold tabular text-slate-900">{rupees(totals.total)}</dd>
              </div>
            </dl>

            {blockers.length > 0 && lines.length > 0 && (
              <ul className="mt-3 space-y-0.5 text-xs text-amber-700">
                {blockers.map((b) => <li key={b}>• {b}</li>)}
              </ul>
            )}

            <div className="mt-3 space-y-2">
              <button
                className="btn-secondary w-full" disabled={lines.length === 0 || saving}
                onClick={() => setHoldPrompt(true)}
                title="Park this bill and serve the next customer"
              >
                Hold bill <span className="kbd">F6</span>
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="btn-secondary" disabled={blockers.length > 0 || saving}
                  onClick={() => void save(false)}
                >
                  {saving && <Spinner />} Save <span className="kbd">F8</span>
                </button>
                <button
                  className="btn-primary" disabled={blockers.length > 0 || saving}
                  onClick={() => void save(true)}
                >
                  Save &amp; Print <span className="kbd">F9</span>
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Name the held bill so the counter can find it again */}
      <HoldPrompt
        open={holdPrompt}
        onClose={() => setHoldPrompt(false)}
        suggestion={customerName || patientName || customerPhone}
        itemCount={lines.length}
        total={totals.total}
        onHold={(label) => void holdBill(label)}
      />

      {/* Held bills tray */}
      <Modal open={showHeld} onClose={() => setShowHeld(false)} title="Held bills" width="max-w-2xl">
        {heldBills.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-slate-500">Nothing is on hold.</p>
            <p className="mt-1 text-xs text-slate-400">
              Press <span className="kbd">F6</span> during a sale to park it here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">
              Held bills do not reserve stock. If a batch sells out meanwhile, the quantity is
              adjusted when you resume and you will be told what changed.
            </p>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="th">Name</th>
                  <th className="th">Held</th>
                  <th className="th text-right">Items</th>
                  <th className="th text-right">Value</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {heldBills.map((h) => (
                  <tr key={h.id}>
                    <td className="td font-medium">{h.label}</td>
                    <td className="td text-xs text-slate-500">
                      {h.created_at.slice(11, 16)}
                      {h.held_by_name && <span className="block">{h.held_by_name}</span>}
                    </td>
                    <td className="td text-right tabular">{h.item_count}</td>
                    <td className="td text-right tabular">{rupees(h.total_paise)}</td>
                    <td className="td whitespace-nowrap text-right">
                      <button
                        className="btn-primary !px-2 !py-1 text-xs"
                        onClick={() => void resumeBill(h.id)}
                        disabled={lines.length > 0}
                        title={lines.length > 0 ? 'Finish or hold the current bill first' : ''}
                      >
                        Resume
                      </button>
                      <button
                        className="ml-2 text-xs text-slate-400 hover:text-red-600"
                        onClick={() => void api.del(`/held-bills/${h.id}`).then(loadHeld)}
                        title="Discard"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lines.length > 0 && (
              <p className="text-xs text-amber-700">
                Finish or hold the bill on screen before resuming another.
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Batch picker */}
      <Modal
        open={!!pickerLine}
        onClose={() => setBatchPickerFor(null)}
        title={pickerLine ? `Choose batch — ${pickerLine.product.name}` : ''}
        width="max-w-2xl"
      >
        {pickerLine && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">
              Batches are listed earliest-expiry first. Selling the earliest batch first (FEFO)
              minimises expiry write-offs.
            </p>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="th">Batch</th>
                  <th className="th">Expiry</th>
                  <th className="th text-right">Stock</th>
                  <th className="th text-right">MRP</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pickerLine.batches.map((b) => {
                  const months = monthsToExpiry(b.expiry);
                  return (
                    <tr key={b.id} className={b.id === pickerLine.batch.id ? 'bg-brand-50' : ''}>
                      <td className="td font-mono">{b.batch_no}</td>
                      <td className={`td ${months <= 3 ? 'font-semibold text-amber-600' : ''}`}>
                        {formatExpiry(b.expiry)}
                        {months <= 3 && <span className="ml-1 text-xs">({months}mo)</span>}
                      </td>
                      <td className="td text-right tabular">
                        {formatQty(b.qty_units, pickerLine.product.pack_size, pickerLine.product.unit)}
                      </td>
                      <td className="td text-right tabular">{rupees(b.mrp_paise)}</td>
                      <td className="td text-right">
                        <button
                          className="btn-secondary !px-2 !py-1 text-xs"
                          onClick={() => {
                            updateLine(pickerLine.key, {
                              batch: b,
                              qtyUnits: Math.min(pickerLine.qtyUnits, b.qty_units),
                            });
                            setBatchPickerFor(null);
                          }}
                        >
                          {b.id === pickerLine.batch.id ? 'Selected' : 'Use'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Row({ label, value, muted, tone }: {
  label: string; value: string; muted?: boolean; tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className={muted ? 'text-xs text-slate-500' : 'text-slate-600'}>{label}</dt>
      <dd className={`tabular ${tone ?? (muted ? 'text-xs text-slate-500' : 'text-slate-800')}`}>
        {value}
      </dd>
    </div>
  );
}

function HoldPrompt({ open, onClose, suggestion, itemCount, total, onHold }: {
  open: boolean;
  onClose: () => void;
  suggestion: string;
  itemCount: number;
  total: number;
  onHold: (label: string) => void;
}) {
  const [label, setLabel] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setLabel(suggestion);
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [open, suggestion]);

  return (
    <Modal open={open} onClose={onClose} title="Hold this bill">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {itemCount} item{itemCount === 1 ? '' : 's'} worth {rupees(total)} will be parked.
          Stock is <strong>not</strong> reserved.
        </p>
        <div>
          <label className="label" htmlFor="hold-label">Name it so you can find it</label>
          <input
            id="hold-label" ref={inputRef} className="input" value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) onHold(label.trim()); }}
            placeholder="e.g. Ramesh — gone to ATM"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!label.trim()} onClick={() => onHold(label.trim())}>
            Hold bill
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A strip is the natural unit for tablets; everything else defaults to one. */
function defaultQty(product: ProductHit): number {
  return product.pack_size > 1 && product.pack_size <= 30 ? product.pack_size : 1;
}
