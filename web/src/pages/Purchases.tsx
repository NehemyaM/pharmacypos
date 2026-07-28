import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api';
import { rupees, formatDate, formatExpiry, rupeesInput, paiseFromInput, currentMonthIso, todayIso } from '../lib/format';
import { Alert, Spinner, Modal, EmptyState, PageHeader } from '../components/ui';

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

export default function Purchases() {
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
    <div className="p-6">
      <PageHeader
        title="Purchases"
        subtitle="Goods inward against distributor tax invoices — creates batches and claims input credit"
        actions={<button className="btn-primary" onClick={() => setEntering(true)}>New purchase entry</button>}
      />

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
    </div>
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
