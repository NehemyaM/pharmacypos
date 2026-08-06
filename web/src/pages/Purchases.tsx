import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api';
import { rupees, formatDate, formatExpiry, rupeesInput, paiseFromInput, currentMonthIso, todayIso } from '../lib/format';
import { Alert, Spinner, Modal, EmptyState, PageHeader, ExportButton, Tile } from '../components/ui';

type Supplier = { id: number; name: string; state_code: string; gstin: string; city: string };
type ProductHit = {
  id: number; name: string; manufacturer: string; unit: string; pack_size: number;
  gst_rate: number; hsn_code: string; mrp_paise: number | null;
};
type PurchaseRow = {
  id: number; invoice_no: string; invoice_date: string; supplier_name: string;
  is_interstate: number; taxable_paise: number; cgst_paise: number; sgst_paise: number;
  igst_paise: number; total_paise: number; paid_paise: number; item_count: number;
};

type Line = {
  key: string;
  product: ProductHit;
  batch_no: string;
  expiry: string;
  qty_packs: number;
  free_packs: number;
  purchase_rate: string; // rupees per pack, ex-GST
  mrp: string;           // rupees per pack
  discount_pct: number;
};

type Tab = 'inward' | 'returns' | 'ledger';

export default function Purchases() {
  const [tab, setTab] = useState<Tab>('inward');

  return (
    <div className="p-6">
      <PageHeader
        title="Purchases"
        subtitle="Goods inward, returns to distributor, and what you owe each supplier"
      />
      <div className="mb-4 flex gap-2">
        {([['inward', 'Goods inward'], ['returns', 'Returns to supplier'],
          ['ledger', 'Supplier ledger']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === k
                ? 'border-brand-500 bg-brand-50 text-brand-800'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'inward' && <GoodsInward />}
      {tab === 'returns' && <SupplierReturns />}
      {tab === 'ledger' && <SupplierLedger />}
    </div>
  );
}

function GoodsInward() {
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [entering, setEntering] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);

  function load() {
    setLoading(true);
    api.get<PurchaseRow[]>('/purchases?limit=100')
      .then(setRows).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <button className="btn-primary" onClick={() => setEntering(true)}>New purchase entry</button>
        <ExportButton path="/exports/purchases?from=2000-01-01&to=2100-01-01"
          filename="purchase-register.csv" />
      </div>

      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="No purchases entered yet" icon="🚚"
            hint="Enter your distributor's invoice to bring stock in with batch and expiry." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Invoice</th>
                <th className="th">Date</th>
                <th className="th">Supplier</th>
                <th className="th text-right">Items</th>
                <th className="th text-right">Taxable</th>
                <th className="th text-right">GST</th>
                <th className="th text-right">Total</th>
                <th className="th text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((p) => {
                const outstanding = p.total_paise - p.paid_paise;
                return (
                  <tr key={p.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setViewing(p.id)}>
                    <td className="td font-mono text-xs font-medium">{p.invoice_no}</td>
                    <td className="td">{formatDate(p.invoice_date)}</td>
                    <td className="td">
                      {p.supplier_name}
                      {p.is_interstate === 1 && (
                        <span className="chip ml-2 border-blue-200 bg-blue-50 text-blue-700">IGST</span>
                      )}
                    </td>
                    <td className="td text-right tabular">{p.item_count}</td>
                    <td className="td text-right tabular">{rupees(p.taxable_paise)}</td>
                    <td className="td text-right tabular text-slate-500">
                      {rupees(p.cgst_paise + p.sgst_paise + p.igst_paise)}
                    </td>
                    <td className="td text-right font-semibold tabular">{rupees(p.total_paise)}</td>
                    <td className={`td text-right tabular ${outstanding > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                      {outstanding > 0 ? rupees(outstanding) : 'Paid'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {entering && (
        <PurchaseEntry onClose={() => setEntering(false)} onSaved={() => { setEntering(false); load(); }} />
      )}
      {viewing && <PurchaseDetail id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function PurchaseEntry({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [paymentMode, setPaymentMode] = useState('CREDIT');
  const [paidRupees, setPaidRupees] = useState('0');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Supplier[]>('/suppliers').then((s) => {
      setSuppliers(s);
      if (s.length > 0) setSupplierId(s[0].id);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    const timer = setTimeout(() => {
      api.get<ProductHit[]>(`/products?q=${encodeURIComponent(q)}&limit=8`)
        .then(setHits).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const supplier = suppliers.find((s) => s.id === supplierId);
  const isInterstate = !!supplier && supplier.state_code !== '36';

  function addLine(product: ProductHit) {
    setLines((prev) => [...prev, {
      key: `${product.id}-${Date.now()}`,
      product,
      batch_no: '',
      expiry: '',
      qty_packs: 1,
      free_packs: 0,
      // Seed the rate at a typical 80% trade margin off the *ex-GST* value of
      // the MRP — the purchase rate column is exclusive of tax.
      purchase_rate: product.mrp_paise
        ? rupeesInput(Math.round((product.mrp_paise * 100 * 0.8) / (100 + product.gst_rate)))
        : '',
      mrp: product.mrp_paise ? rupeesInput(product.mrp_paise) : '',
      discount_pct: 0,
    }]);
    setQuery('');
    setHits([]);
  }

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const totals = useMemo(() => {
    let taxable = 0, tax = 0;
    for (const l of lines) {
      const rate = paiseFromInput(l.purchase_rate);
      const gross = rate * l.qty_packs;
      const net = gross - Math.round((gross * l.discount_pct) / 100);
      const lineTax = Math.round((net * l.product.gst_rate) / 100);
      taxable += net;
      tax += lineTax;
    }
    const before = taxable + tax;
    const total = Math.round(before / 100) * 100;
    return { taxable, tax, roundOff: total - before, total };
  }, [lines]);

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!supplierId) out.push('Select a supplier');
    if (!invoiceNo.trim()) out.push('Enter the distributor invoice number');
    if (lines.length === 0) out.push('Add at least one item');
    for (const l of lines) {
      if (!l.batch_no.trim()) out.push(`${l.product.name}: batch number is required`);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(l.expiry)) out.push(`${l.product.name}: expiry must be YYYY-MM`);
      else if (l.expiry < currentMonthIso()) out.push(`${l.product.name}: batch is already expired`);
      if (paiseFromInput(l.mrp) <= 0) out.push(`${l.product.name}: MRP is required`);
    }
    return [...new Set(out)];
  }, [supplierId, invoiceNo, lines]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post('/purchases', {
        supplier_id: supplierId,
        invoice_no: invoiceNo.trim(),
        invoice_date: invoiceDate,
        payment_mode: paymentMode,
        paid_paise: paiseFromInput(paidRupees),
        notes,
        items: lines.map((l) => ({
          product_id: l.product.id,
          batch_no: l.batch_no.trim(),
          expiry: l.expiry,
          qty_packs: l.qty_packs,
          free_packs: l.free_packs,
          purchase_rate_paise: paiseFromInput(l.purchase_rate),
          mrp_paise: paiseFromInput(l.mrp),
          discount_pct: l.discount_pct,
        })),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the purchase');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} width="max-w-6xl" title="New purchase entry">
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}

        <div className="grid grid-cols-4 gap-3">
          <div className="col-span-2">
            <label className="label">Supplier</label>
            <select className="input" value={supplierId ?? ''}
              onChange={(e) => setSupplierId(Number(e.target.value))}>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.city && ` — ${s.city}`}{s.state_code !== '36' ? ' (out of state)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Their invoice no.</label>
            <input className="input font-mono" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </div>
          <div>
            <label className="label">Invoice date</label>
            <input type="date" className="input" value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
        </div>

        {isInterstate && (
          <Alert kind="info">
            {supplier?.name} is outside Telangana — this purchase attracts <strong>IGST</strong>,
            claimed as input credit against inter-state supplies.
          </Alert>
        )}

        <div className="relative">
          <label className="label">Add product</label>
          <input className="input" placeholder="Search products to add to this invoice…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          {hits.length > 0 && (
            <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
              {hits.map((h) => (
                <button key={h.id} className="block w-full px-3 py-2 text-left hover:bg-slate-50"
                  onClick={() => addLine(h)}>
                  <span className="text-sm font-medium text-slate-800">{h.name}</span>
                  <span className="ml-2 text-xs text-slate-400">
                    {h.manufacturer} · {h.pack_size} {h.unit} · GST {h.gst_rate}%
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {lines.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Product</th>
                  <th className="th w-32">Batch *</th>
                  <th className="th w-28">Expiry *</th>
                  <th className="th w-20 text-right">Packs</th>
                  <th className="th w-20 text-right">Free</th>
                  <th className="th w-28 text-right">Rate ex-GST</th>
                  <th className="th w-28 text-right">MRP</th>
                  <th className="th w-20 text-right">Disc %</th>
                  <th className="th w-16 text-right">GST</th>
                  <th className="th w-28 text-right">Amount</th>
                  <th className="th w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => {
                  const rate = paiseFromInput(l.purchase_rate);
                  const gross = rate * l.qty_packs;
                  const net = gross - Math.round((gross * l.discount_pct) / 100);
                  const amount = net + Math.round((net * l.product.gst_rate) / 100);
                  const expiryBad = l.expiry !== '' &&
                    (!/^\d{4}-(0[1-9]|1[0-2])$/.test(l.expiry) || l.expiry < currentMonthIso());
                  const mrpBelowCost = paiseFromInput(l.mrp) > 0 && paiseFromInput(l.mrp) < rate;

                  return (
                    <tr key={l.key}>
                      <td className="td">
                        <span className="font-medium text-slate-800">{l.product.name}</span>
                        <span className="block text-xs text-slate-400">
                          {l.product.pack_size} {l.product.unit}/pack
                        </span>
                      </td>
                      <td className="td">
                        <input className="input py-1 font-mono text-xs" value={l.batch_no}
                          onChange={(e) => updateLine(l.key, { batch_no: e.target.value })} />
                      </td>
                      <td className="td">
                        <input type="month" className="input py-1 text-xs"
                          value={l.expiry} min={currentMonthIso()}
                          onChange={(e) => updateLine(l.key, { expiry: e.target.value })} />
                        {expiryBad && <span className="text-[10px] text-red-600">expired</span>}
                      </td>
                      <td className="td">
                        <input type="number" min={1} className="input w-full py-1 text-right tabular"
                          value={l.qty_packs}
                          onChange={(e) => updateLine(l.key, { qty_packs: Math.max(1, Number(e.target.value) || 1) })} />
                      </td>
                      <td className="td">
                        <input type="number" min={0} className="input w-full py-1 text-right tabular"
                          value={l.free_packs}
                          onChange={(e) => updateLine(l.key, { free_packs: Math.max(0, Number(e.target.value) || 0) })} />
                      </td>
                      <td className="td">
                        <input className="input w-full py-1 text-right tabular" value={l.purchase_rate}
                          onChange={(e) => updateLine(l.key, { purchase_rate: e.target.value })} />
                      </td>
                      <td className="td">
                        <input className="input w-full py-1 text-right tabular" value={l.mrp}
                          onChange={(e) => updateLine(l.key, { mrp: e.target.value })} />
                        {mrpBelowCost && <span className="text-[10px] text-red-600">below cost</span>}
                      </td>
                      <td className="td">
                        <input type="number" min={0} max={100} step={0.5}
                          className="input w-full py-1 text-right tabular" value={l.discount_pct}
                          onChange={(e) => updateLine(l.key, { discount_pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
                      </td>
                      <td className="td text-right tabular text-slate-500">{l.product.gst_rate}%</td>
                      <td className="td text-right font-semibold tabular">{rupees(amount)}</td>
                      <td className="td text-right">
                        <button onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}
                          className="text-slate-300 hover:text-red-600">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-start justify-between gap-6">
          <div className="flex-1 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Payment</label>
                <select className="input" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
                  <option value="CREDIT">On credit</option>
                  <option value="CASH">Cash</option>
                  <option value="BANK">Bank transfer</option>
                  <option value="CHEQUE">Cheque</option>
                </select>
              </div>
              <div>
                <label className="label">Amount paid now (₹)</label>
                <input className="input tabular text-right" value={paidRupees}
                  onChange={(e) => setPaidRupees(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label">Notes</label>
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            {problems.length > 0 && (
              <ul className="space-y-0.5 text-xs text-amber-700">
                {problems.slice(0, 5).map((p) => <li key={p}>• {p}</li>)}
              </ul>
            )}
          </div>

          <div className="w-64 shrink-0 rounded-lg bg-slate-50 p-4">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600">Taxable</dt>
                <dd className="tabular">{rupees(totals.taxable)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">{isInterstate ? 'IGST' : 'CGST + SGST'}</dt>
                <dd className="tabular">{rupees(totals.tax)}</dd>
              </div>
              {totals.roundOff !== 0 && (
                <div className="flex justify-between text-xs text-slate-500">
                  <dt>Round off</dt><dd className="tabular">{rupees(totals.roundOff)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-slate-200 pt-2">
                <dt className="font-semibold text-slate-700">Total</dt>
                <dd className="text-lg font-bold tabular">{rupees(totals.total)}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={problems.length > 0 || busy} onClick={() => void submit()}>
            {busy && <Spinner />} Save &amp; add to stock
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PurchaseDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api.get(`/purchases/${id}`).then(setData).catch(() => setData(null));
  }, [id]);

  return (
    <Modal open onClose={onClose} width="max-w-4xl"
      title={data ? `Purchase — ${data.invoice_no}` : 'Purchase'}>
      {!data ? (
        <div className="flex justify-center py-10"><Spinner className="h-5 w-5 text-slate-400" /></div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3 rounded-lg bg-slate-50 p-3 text-sm">
            <div><p className="text-xs text-slate-400">Supplier</p><p>{data.supplier_name}</p></div>
            <div><p className="text-xs text-slate-400">GSTIN</p><p className="font-mono text-xs">{data.supplier_gstin || '—'}</p></div>
            <div><p className="text-xs text-slate-400">Date</p><p>{formatDate(data.invoice_date)}</p></div>
            <div><p className="text-xs text-slate-400">Total</p><p className="font-semibold tabular">{rupees(data.total_paise)}</p></div>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="th">Product</th>
                <th className="th">Batch</th>
                <th className="th">Expiry</th>
                <th className="th text-right">Packs</th>
                <th className="th text-right">Free</th>
                <th className="th text-right">Rate</th>
                <th className="th text-right">MRP</th>
                <th className="th text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((it: any) => (
                <tr key={it.id}>
                  <td className="td">{it.product_name}</td>
                  <td className="td font-mono text-xs">{it.batch_no}</td>
                  <td className="td">{formatExpiry(it.expiry)}</td>
                  <td className="td text-right tabular">{it.qty_packs}</td>
                  <td className="td text-right tabular text-emerald-700">{it.free_packs || '—'}</td>
                  <td className="td text-right tabular">{rupees(it.purchase_rate_paise)}</td>
                  <td className="td text-right tabular">{rupees(it.mrp_paise)}</td>
                  <td className="td text-right font-medium tabular">{rupees(it.total_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ===========================================================================
// Returns to supplier — near-expiry and damaged stock going back for credit
// ===========================================================================

type Candidate = {
  batch_id: number; batch_no: string; expiry: string; qty_units: number;
  purchase_rate_paise: number; mrp_paise: number; product_id: number;
  product_name: string; manufacturer: string; unit: string; pack_size: number;
  rack: string; supplier_id: number | null; supplier_name: string | null;
  supplier_phone: string | null; claim_value_paise: number; suggested_reason: string;
};

type ReturnRow = {
  id: number; return_no: string; return_date: string; supplier_name: string;
  reason: string; total_paise: number; status: string; credited_paise: number;
  credit_note_no: string; item_count: number;
};

function SupplierReturns() {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [settling, setSettling] = useState<ReturnRow | null>(null);

  function load() {
    setLoading(true);
    api.get<ReturnRow[]>('/purchase-returns')
      .then(setRows).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  const pending = rows.filter((r) => r.status === 'PENDING');
  const pendingValue = pending.reduce((s, r) => s + r.total_paise, 0);

  return (
    <>
      <div className="mb-4">
        <Alert kind="info">
          Most distributors accept returns 3–6 months before expiry. Send stock back while the
          credit is still available rather than writing it off later.
        </Alert>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <button className="btn-primary" onClick={() => setCreating(true)}>New return</button>
        {pending.length > 0 && (
          <span className="text-sm text-slate-600">
            <strong className="tabular">{pending.length}</strong> claims awaiting credit,
            worth <strong className="tabular">{rupees(pendingValue)}</strong>
          </span>
        )}
      </div>

      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="No returns raised yet" icon="↩️"
            hint="Check the expiry report, then raise a return for anything the supplier will still credit." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Debit note</th>
                <th className="th">Date</th>
                <th className="th">Supplier</th>
                <th className="th">Reason</th>
                <th className="th text-right">Items</th>
                <th className="th text-right">Claimed</th>
                <th className="th">Status</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td font-mono text-xs font-medium">{r.return_no}</td>
                  <td className="td">{formatDate(r.return_date)}</td>
                  <td className="td">{r.supplier_name}</td>
                  <td className="td text-xs text-slate-600">{r.reason.replace(/_/g, ' ')}</td>
                  <td className="td text-right tabular">{r.item_count}</td>
                  <td className="td text-right font-semibold tabular">{rupees(r.total_paise)}</td>
                  <td className="td">
                    <span className={`chip ${
                      r.status === 'CREDITED' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : r.status === 'REJECTED' ? 'border-red-200 bg-red-50 text-red-700'
                          : 'border-amber-200 bg-amber-50 text-amber-700'
                    }`}>{r.status}</span>
                    {r.status === 'CREDITED' && r.credited_paise !== r.total_paise && (
                      <span className="block text-[11px] text-slate-500">
                        got {rupees(r.credited_paise)}
                      </span>
                    )}
                  </td>
                  <td className="td text-right">
                    {r.status === 'PENDING' && (
                      <button className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                        onClick={() => setSettling(r)}>Record credit</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <ReturnEntry onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />
      )}
      {settling && (
        <SettleModal row={settling} onClose={() => setSettling(null)}
          onSaved={() => { setSettling(null); load(); }} />
      )}
    </>
  );
}

function ReturnEntry({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [months, setMonths] = useState(3);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('NEAR_EXPIRY');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Candidate[]>(`/purchase-returns/candidates/list?months=${months}`)
      .then(setCandidates).catch((e) => setError(e.message));
  }, [months]);

  // A debit note goes to one distributor, so only their batches can be on it.
  const suppliers = [...new Map(
    candidates.filter((c) => c.supplier_id).map((c) => [c.supplier_id, c.supplier_name]),
  ).entries()];
  const visible = supplierId ? candidates.filter((c) => c.supplier_id === supplierId) : [];
  const selected = Object.entries(qty).filter(([, q]) => q > 0);

  const claimValue = visible.reduce((sum, c) => {
    const q = qty[c.batch_id] ?? 0;
    return sum + Math.round((c.purchase_rate_paise * q) / c.pack_size);
  }, 0);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post('/purchase-returns', {
        supplier_id: supplierId, reason, notes,
        items: selected.map(([batchId, q]) => ({ batch_id: Number(batchId), qty_units: q })),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the return');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} width="max-w-5xl" title="Return stock to supplier">
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Show stock expiring within</label>
            <select className="input" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              <option value={1}>1 month</option>
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </select>
          </div>
          <div>
            <label className="label">Supplier</label>
            <select className="input" value={supplierId ?? ''}
              onChange={(e) => { setSupplierId(Number(e.target.value) || null); setQty({}); }}>
              <option value="">Select supplier…</option>
              {suppliers.map(([id, name]) => <option key={id} value={id!}>{name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Reason</label>
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="NEAR_EXPIRY">Near expiry</option>
              <option value="EXPIRED">Expired</option>
              <option value="DAMAGED">Damaged</option>
              <option value="WRONG_SUPPLY">Wrong supply</option>
              <option value="RECALL">Product recall</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
        </div>

        {!supplierId ? (
          <EmptyState title="Choose a supplier" icon="🚚"
            hint="A debit note goes to one distributor, so pick whose stock you are sending back." />
        ) : visible.length === 0 ? (
          <EmptyState title="Nothing to return for this supplier" icon="✅"
            hint="Widen the expiry window if you expected to see stock here." />
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200">
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="th">Product</th>
                  <th className="th">Batch</th>
                  <th className="th">Expiry</th>
                  <th className="th text-right">In stock</th>
                  <th className="th text-right">Cost/pack</th>
                  <th className="th text-right">Return qty</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((c) => (
                  <tr key={c.batch_id} className={c.suggested_reason === 'EXPIRED' ? 'bg-red-50' : ''}>
                    <td className="td">
                      {c.product_name}
                      <span className="block text-xs text-slate-400">{c.manufacturer}</span>
                    </td>
                    <td className="td font-mono text-xs">{c.batch_no}</td>
                    <td className={`td ${c.suggested_reason === 'EXPIRED' ? 'font-semibold text-red-600' : 'text-amber-600'}`}>
                      {formatExpiry(c.expiry)}
                    </td>
                    <td className="td text-right tabular">{c.qty_units} {c.unit}</td>
                    <td className="td text-right tabular text-slate-500">
                      {rupees(c.purchase_rate_paise)}
                    </td>
                    <td className="td text-right">
                      <div className="flex items-center justify-end gap-1">
                        <input type="number" min={0} max={c.qty_units}
                          className="input w-20 py-1 text-right tabular"
                          value={qty[c.batch_id] ?? 0}
                          onChange={(e) => setQty((p) => ({
                            ...p,
                            [c.batch_id]: Math.min(c.qty_units, Math.max(0, Number(e.target.value) || 0)),
                          }))} />
                        <button className="text-[11px] text-brand-700 hover:underline"
                          onClick={() => setQty((p) => ({ ...p, [c.batch_id]: c.qty_units }))}>
                          all
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <label className="label">Notes</label>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Collected by their delivery boy on Tuesday" />
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-600">
            Claiming <strong className="tabular">{rupees(claimValue)}</strong> at cost,
            across {selected.length} batch{selected.length === 1 ? '' : 'es'}
          </p>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={selected.length === 0 || busy}
              onClick={() => void submit()}>
              {busy && <Spinner />} Raise debit note
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SettleModal({ row, onClose, onSaved }: {
  row: ReturnRow; onClose: () => void; onSaved: () => void;
}) {
  const [status, setStatus] = useState<'CREDITED' | 'REJECTED'>('CREDITED');
  const [creditNoteNo, setCreditNoteNo] = useState('');
  const [amount, setAmount] = useState(rupeesInput(row.total_paise));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/purchase-returns/${row.id}/settle`, {
        status, credit_note_no: creditNoteNo, credited_paise: paiseFromInput(amount),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the credit');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Record the distributor's response — ${row.return_no}`}>
      <div className="space-y-3">
        {error && <Alert kind="error">{error}</Alert>}
        <p className="text-sm text-slate-600">
          Claimed <strong className="tabular">{rupees(row.total_paise)}</strong> from {row.supplier_name}.
        </p>
        <div>
          <label className="label">Outcome</label>
          <select className="input" value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="CREDITED">Credit received</option>
            <option value="REJECTED">Claim rejected</option>
          </select>
        </div>
        {status === 'CREDITED' && (
          <>
            <div>
              <label className="label">Their credit note number</label>
              <input className="input font-mono" value={creditNoteNo}
                onChange={(e) => setCreditNoteNo(e.target.value)} />
            </div>
            <div>
              <label className="label">Amount credited (₹)</label>
              <input className="input tabular text-right" value={amount}
                onChange={(e) => setAmount(e.target.value)} />
              <p className="mt-1 text-xs text-slate-400">
                Distributors often credit less than claimed. Enter what they actually gave.
              </p>
            </div>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy && <Spinner />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ===========================================================================
// Supplier ledger — what the shop owes each distributor
// ===========================================================================

type Outstanding = {
  id: number; name: string; phone: string; contact_person: string; credit_days: number;
  invoices: number; billed_paise: number; paid_at_entry_paise: number; payments_paise: number;
  return_credit_paise: number; outstanding_paise: number; pending_claim_paise: number;
};

function SupplierLedger() {
  const [data, setData] = useState<{ rows: Outstanding[]; totals: any } | null>(null);
  const [error, setError] = useState('');
  const [statementFor, setStatementFor] = useState<Outstanding | null>(null);
  const [payingFor, setPayingFor] = useState<Outstanding | null>(null);

  function load() {
    api.get<{ rows: Outstanding[]; totals: any }>('/supplier-ledger/outstanding')
      .then(setData).catch((e) => setError(e.message));
  }
  useEffect(load, []);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>;

  const active = data.rows.filter((r) => r.invoices > 0);

  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Tile label="Total purchased" value={rupees(data.totals.billed_paise)} />
        <Tile label="Outstanding" value={rupees(data.totals.outstanding_paise)}
          tone={data.totals.outstanding_paise > 0 ? 'warn' : 'good'} />
        <Tile label="Claims awaiting credit" value={rupees(data.totals.pending_claim_paise)}
          sub="Debit notes not yet settled" />
      </div>

      <div className="card overflow-hidden">
        {active.length === 0 ? (
          <EmptyState title="No purchases recorded" icon="🧾"
            hint="Enter a distributor invoice under Goods inward and it will appear here." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Supplier</th>
                <th className="th text-right">Invoices</th>
                <th className="th text-right">Purchased</th>
                <th className="th text-right">Paid</th>
                <th className="th text-right">Return credit</th>
                <th className="th text-right">Outstanding</th>
                <th className="th text-right">Credit days</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {active.map((s) => (
                <tr key={s.id}>
                  <td className="td">
                    <span className="font-medium text-slate-800">{s.name}</span>
                    {s.phone && <span className="block text-xs text-slate-400">{s.phone}</span>}
                  </td>
                  <td className="td text-right tabular">{s.invoices}</td>
                  <td className="td text-right tabular">{rupees(s.billed_paise)}</td>
                  <td className="td text-right tabular text-emerald-700">
                    {rupees(s.paid_at_entry_paise + s.payments_paise)}
                  </td>
                  <td className="td text-right tabular text-slate-500">
                    {s.return_credit_paise > 0 ? rupees(s.return_credit_paise) : '—'}
                  </td>
                  <td className={`td text-right font-semibold tabular ${
                    s.outstanding_paise > 0 ? 'text-amber-700' : 'text-slate-400'
                  }`}>
                    {rupees(s.outstanding_paise)}
                  </td>
                  <td className="td text-right tabular text-slate-500">{s.credit_days}</td>
                  <td className="td whitespace-nowrap text-right">
                    <button className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                      onClick={() => setStatementFor(s)}>Statement</button>
                    <button className="ml-3 text-xs text-slate-500 hover:text-brand-700 hover:underline"
                      onClick={() => setPayingFor(s)}>Pay</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {statementFor && (
        <StatementModal supplier={statementFor} onClose={() => setStatementFor(null)} />
      )}
      {payingFor && (
        <PaymentModal supplier={payingFor} onClose={() => setPayingFor(null)}
          onSaved={() => { setPayingFor(null); load(); }} />
      )}
    </>
  );
}

function StatementModal({ supplier, onClose }: { supplier: Outstanding; onClose: () => void }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api.get(`/supplier-ledger/statement/${supplier.id}`).then(setData).catch(() => setData(null));
  }, [supplier.id]);

  return (
    <Modal open onClose={onClose} width="max-w-4xl" title={`Statement — ${supplier.name}`}>
      {!data ? (
        <div className="flex justify-center py-10"><Spinner className="h-5 w-5 text-slate-400" /></div>
      ) : (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">
              Invoices <span className="font-normal text-slate-400">
                (due date = invoice date + {supplier.credit_days} days credit)
              </span>
            </h3>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="th">Invoice</th>
                  <th className="th">Date</th>
                  <th className="th">Due by</th>
                  <th className="th text-right">Total</th>
                  <th className="th text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.invoices.map((i: any) => (
                  <tr key={i.id} className={i.due_paise > 0 && i.days_overdue > 0 ? 'bg-red-50' : ''}>
                    <td className="td font-mono text-xs">{i.invoice_no}</td>
                    <td className="td">{formatDate(i.invoice_date)}</td>
                    <td className="td">
                      {formatDate(i.due_date)}
                      {i.due_paise > 0 && i.days_overdue > 0 && (
                        <span className="block text-[11px] font-semibold text-red-600">
                          overdue {i.days_overdue} days
                        </span>
                      )}
                    </td>
                    <td className="td text-right tabular">{rupees(i.total_paise)}</td>
                    <td className={`td text-right tabular ${i.due_paise > 0 ? 'font-semibold text-amber-700' : 'text-slate-400'}`}>
                      {i.due_paise > 0 ? rupees(i.due_paise) : 'Paid'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.payments.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">Payments made</h3>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th">Payment</th>
                    <th className="th">Date</th>
                    <th className="th">Against</th>
                    <th className="th">Mode</th>
                    <th className="th text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.payments.map((p: any) => (
                    <tr key={p.id}>
                      <td className="td font-mono text-xs">{p.payment_no}</td>
                      <td className="td">{formatDate(p.payment_date)}</td>
                      <td className="td text-xs">{p.invoice_no ?? 'On account'}</td>
                      <td className="td text-xs">{p.mode}</td>
                      <td className="td text-right font-medium tabular">{rupees(p.amount_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.returns.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">Returns to this supplier</h3>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th">Debit note</th>
                    <th className="th">Date</th>
                    <th className="th">Reason</th>
                    <th className="th text-right">Claimed</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.returns.map((r: any) => (
                    <tr key={r.id}>
                      <td className="td font-mono text-xs">{r.return_no}</td>
                      <td className="td">{formatDate(r.return_date)}</td>
                      <td className="td text-xs">{r.reason.replace(/_/g, ' ')}</td>
                      <td className="td text-right tabular">{rupees(r.total_paise)}</td>
                      <td className="td text-xs">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function PaymentModal({ supplier, onClose, onSaved }: {
  supplier: Outstanding; onClose: () => void; onSaved: () => void;
}) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [purchaseId, setPurchaseId] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('BANK');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<any>(`/supplier-ledger/statement/${supplier.id}`)
      .then((d) => setInvoices(d.invoices.filter((i: any) => i.due_paise > 0)))
      .catch(() => setInvoices([]));
  }, [supplier.id]);

  const chosen = invoices.find((i) => i.id === purchaseId);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post('/supplier-ledger/payments', {
        supplier_id: supplier.id,
        purchase_id: purchaseId,
        amount_paise: paiseFromInput(amount),
        mode, reference,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the payment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Record payment — ${supplier.name}`}>
      <div className="space-y-3">
        {error && <Alert kind="error">{error}</Alert>}
        <p className="text-sm text-slate-600">
          Outstanding: <strong className="tabular">{rupees(supplier.outstanding_paise)}</strong>
        </p>

        <div>
          <label className="label">Against invoice</label>
          <select className="input" value={purchaseId ?? ''}
            onChange={(e) => {
              const id = Number(e.target.value) || null;
              setPurchaseId(id);
              const inv = invoices.find((i) => i.id === id);
              if (inv) setAmount(rupeesInput(inv.due_paise));
            }}>
            <option value="">On account (not a specific invoice)</option>
            {invoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.invoice_no} — {formatDate(i.invoice_date)} — due {rupees(i.due_paise)}
              </option>
            ))}
          </select>
          {chosen && (
            <p className="mt-1 text-xs text-slate-400">
              This invoice has {rupees(chosen.due_paise)} outstanding.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Amount (₹)</label>
            <input className="input tabular text-right" value={amount}
              onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="label">Mode</label>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="BANK">Bank transfer</option>
              <option value="UPI">UPI</option>
              <option value="CASH">Cash</option>
              <option value="CHEQUE">Cheque</option>
              <option value="ADJUSTMENT">Adjustment</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">Reference</label>
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)}
            placeholder="UTR, cheque number or UPI reference" />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={paiseFromInput(amount) <= 0 || busy}
            onClick={() => void submit()}>
            {busy && <Spinner />} Record payment
          </button>
        </div>
      </div>
    </Modal>
  );
}
