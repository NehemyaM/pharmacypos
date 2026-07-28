import { useEffect, useState, useCallback } from 'react';
import { api, type SessionUser } from '../lib/api';
import { rupees, formatExpiry, scheduleClass, SCHEDULE_LABELS } from '../lib/format';
import { Alert, Spinner, Modal, EmptyState, PageHeader } from '../components/ui';

type ProductRow = {
  id: number; name: string; generic_name: string; manufacturer: string; category: string;
  schedule_type: string; hsn_code: string; gst_rate: number; unit: string; pack_size: number;
  pack_label: string; barcode: string; rack: string; reorder_level: number;
  cold_chain: number; allow_loose: number; active: number;
  stock_units: number; nearest_expiry: string | null; mrp_paise: number | null;
};

type Batch = {
  id: number; batch_no: string; expiry: string; mrp_paise: number; sale_rate_paise: number;
  purchase_rate_paise: number; qty_units: number; supplier_name: string | null;
};

const SCHEDULES = ['OTC', 'G', 'H', 'H1', 'X', 'C', 'C1'] as const;
const UNITS = ['TAB', 'CAP', 'BOTTLE', 'TUBE', 'VIAL', 'SACHET', 'BOX', 'TIN', 'ROLL', 'UNIT', 'NOS', 'ML', 'GM'];
/** Medicines (HSN 3003/3004) are Nil/5/18 since 22-Sep-2025; devices keep 12/28. */
const GST_RATES = [0, 5, 12, 18, 28];

const emptyForm = {
  name: '', generic_name: '', manufacturer: '', category: 'GENERAL',
  schedule_type: 'OTC', hsn_code: '3004', gst_rate: 5, unit: 'TAB',
  pack_size: 1, pack_label: '', barcode: '', rack: '', reorder_level: 0,
  cold_chain: false, allow_loose: true, active: true,
};

export default function Products({ user }: { user: SessionUser }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ProductRow | 'new' | null>(null);
  const [viewing, setViewing] = useState<ProductRow | null>(null);

  const canEdit = user.role === 'admin' || user.role === 'pharmacist';

  const load = useCallback(() => {
    setLoading(true);
    const q = query.trim() ? `q=${encodeURIComponent(query.trim())}&` : '';
    api.get<ProductRow[]>(`/products?${q}limit=200&includeInactive=true`)
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  return (
    <div className="p-6">
      <PageHeader
        title="Products"
        subtitle="Medicine master — schedule, HSN, GST rate and pack configuration"
        actions={canEdit && (
          <button className="btn-primary" onClick={() => setEditing('new')}>Add product</button>
        )}
      />

      <div className="mb-4">
        <input
          className="input max-w-md" placeholder="Search by brand, salt or manufacturer…"
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="No products found" icon="💊" hint="Add your first product to start billing." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="th">Product</th>
                  <th className="th">Schedule</th>
                  <th className="th">HSN / GST</th>
                  <th className="th">Pack</th>
                  <th className="th text-right">Stock</th>
                  <th className="th">Nearest expiry</th>
                  <th className="th text-right">MRP</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((p) => (
                  <tr key={p.id} className={p.active ? '' : 'opacity-50'}>
                    <td className="td">
                      <button
                        className="text-left font-medium text-slate-800 hover:text-brand-700 hover:underline"
                        onClick={() => setViewing(p)}
                      >
                        {p.name}
                      </button>
                      <p className="text-xs text-slate-400">{p.generic_name} · {p.manufacturer}</p>
                    </td>
                    <td className="td">
                      <span className={`chip ${scheduleClass(p.schedule_type)}`} title={SCHEDULE_LABELS[p.schedule_type]}>
                        {p.schedule_type}
                      </span>
                    </td>
                    <td className="td text-xs text-slate-600">
                      {p.hsn_code}
                      <span className="block text-slate-400">{p.gst_rate}% GST</span>
                    </td>
                    <td className="td text-xs text-slate-600">
                      {p.pack_label || `${p.pack_size} ${p.unit}`}
                    </td>
                    <td className={`td text-right tabular ${
                      p.stock_units === 0 ? 'text-red-600'
                        : p.reorder_level > 0 && p.stock_units <= p.reorder_level ? 'text-amber-600' : ''
                    }`}>
                      {p.stock_units} {p.unit}
                    </td>
                    <td className="td text-xs text-slate-600">{formatExpiry(p.nearest_expiry)}</td>
                    <td className="td text-right tabular">{p.mrp_paise ? rupees(p.mrp_paise) : '—'}</td>
                    <td className="td text-right">
                      {canEdit && (
                        <button
                          className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                          onClick={() => setEditing(p)}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ProductForm
        target={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
      <ProductDetail product={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

function ProductForm({ target, onClose, onSaved }: {
  target: ProductRow | 'new' | null; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!target) return;
    setError('');
    if (target === 'new') {
      setForm(emptyForm);
    } else {
      setForm({
        name: target.name, generic_name: target.generic_name, manufacturer: target.manufacturer,
        category: target.category, schedule_type: target.schedule_type, hsn_code: target.hsn_code,
        gst_rate: target.gst_rate, unit: target.unit, pack_size: target.pack_size,
        pack_label: target.pack_label, barcode: target.barcode, rack: target.rack,
        reorder_level: target.reorder_level, cold_chain: target.cold_chain === 1,
        allow_loose: target.allow_loose === 1, active: target.active === 1,
      });
    }
  }, [target]);

  if (!target) return null;

  const isMedicineHsn = form.hsn_code.startsWith('300');
  const slabWarning = isMedicineHsn && ![0, 5, 18].includes(form.gst_rate);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (target === 'new') await api.post('/products', form);
      else await api.patch(`/products/${(target as ProductRow).id}`, form);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the product');
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal open onClose={onClose} width="max-w-2xl"
      title={target === 'new' ? 'Add product' : `Edit — ${(target as ProductRow).name}`}>
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Brand name *</label>
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">Composition / salt</label>
            <input className="input" value={form.generic_name}
              onChange={(e) => set('generic_name', e.target.value)}
              placeholder="e.g. Paracetamol 650mg" />
          </div>
          <div>
            <label className="label">Manufacturer</label>
            <input className="input" value={form.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} />
          </div>
          <div>
            <label className="label">Category</label>
            <input className="input" value={form.category} onChange={(e) => set('category', e.target.value)} />
          </div>

          <div>
            <label className="label">Drug schedule</label>
            <select className="input" value={form.schedule_type}
              onChange={(e) => set('schedule_type', e.target.value)}>
              {SCHEDULES.map((s) => <option key={s} value={s}>{s} — {SCHEDULE_LABELS[s]}</option>)}
            </select>
          </div>
          <div>
            <label className="label">HSN code</label>
            <input className="input" value={form.hsn_code} onChange={(e) => set('hsn_code', e.target.value)} />
          </div>

          <div>
            <label className="label">GST rate</label>
            <select className="input" value={form.gst_rate}
              onChange={(e) => set('gst_rate', Number(e.target.value))}>
              {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
            </select>
          </div>
          <div>
            <label className="label">Base unit</label>
            <select className="input" value={form.unit} onChange={(e) => set('unit', e.target.value)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>

          <div>
            <label className="label">Units per pack</label>
            <input type="number" min={1} className="input tabular" value={form.pack_size}
              onChange={(e) => set('pack_size', Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <div>
            <label className="label">Pack label</label>
            <input className="input" value={form.pack_label}
              onChange={(e) => set('pack_label', e.target.value)}
              placeholder="e.g. Strip of 10 tablets" />
          </div>

          <div>
            <label className="label">Rack / shelf</label>
            <input className="input" value={form.rack} onChange={(e) => set('rack', e.target.value)} />
          </div>
          <div>
            <label className="label">Reorder level (units)</label>
            <input type="number" min={0} className="input tabular" value={form.reorder_level}
              onChange={(e) => set('reorder_level', Math.max(0, Number(e.target.value) || 0))} />
          </div>

          <div className="col-span-2">
            <label className="label">Barcode</label>
            <input className="input font-mono" value={form.barcode} onChange={(e) => set('barcode', e.target.value)} />
          </div>
        </div>

        {slabWarning && (
          <Alert kind="warning">
            HSN {form.hsn_code} is a medicament heading. Since 22 September 2025 medicines fall
            only under Nil, 5% or 18% — the 12% slab was withdrawn. Double-check this rate.
          </Alert>
        )}
        {['H1', 'X'].includes(form.schedule_type) && (
          <Alert kind="info">
            Every sale of this product will require the prescriber and patient details and will be
            written to the Schedule H1 register, retained for three years.
          </Alert>
        )}

        <div className="flex flex-wrap gap-4 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.cold_chain}
              onChange={(e) => set('cold_chain', e.target.checked)} />
            Cold chain (2–8°C)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.allow_loose}
              onChange={(e) => set('allow_loose', e.target.checked)} />
            Can be sold loose
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.active}
              onChange={(e) => set('active', e.target.checked)} />
            Active
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!form.name.trim() || busy} onClick={() => void submit()}>
            {busy && <Spinner />} Save product
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProductDetail({ product, onClose }: { product: ProductRow | null; onClose: () => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!product) return;
    setLoading(true);
    api.get<{ batches: Batch[] }>(`/products/${product.id}`)
      .then((d) => setBatches(d.batches)).catch(() => setBatches([]))
      .finally(() => setLoading(false));
  }, [product]);

  if (!product) return null;

  return (
    <Modal open onClose={onClose} width="max-w-3xl" title={product.name}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 text-sm">
          <Field label="Composition" value={product.generic_name || '—'} />
          <Field label="Manufacturer" value={product.manufacturer || '—'} />
          <Field label="Schedule" value={`${product.schedule_type} — ${SCHEDULE_LABELS[product.schedule_type]}`} />
          <Field label="HSN / GST" value={`${product.hsn_code} · ${product.gst_rate}%`} />
          <Field label="Pack" value={product.pack_label || `${product.pack_size} ${product.unit}`} />
          <Field label="Rack" value={product.rack || '—'} />
        </div>

        <h3 className="text-sm font-semibold text-slate-700">Batches</h3>
        {loading ? (
          <div className="flex justify-center py-8"><Spinner className="h-5 w-5 text-slate-400" /></div>
        ) : batches.length === 0 ? (
          <EmptyState title="No batches on record" icon="📦" />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="th">Batch</th>
                <th className="th">Expiry</th>
                <th className="th text-right">Stock</th>
                <th className="th text-right">Cost</th>
                <th className="th text-right">MRP</th>
                <th className="th">Supplier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.map((b) => (
                <tr key={b.id}>
                  <td className="td font-mono text-xs">{b.batch_no}</td>
                  <td className="td">{formatExpiry(b.expiry)}</td>
                  <td className="td text-right tabular">{b.qty_units}</td>
                  <td className="td text-right tabular text-slate-500">{rupees(b.purchase_rate_paise)}</td>
                  <td className="td text-right tabular">{rupees(b.mrp_paise)}</td>
                  <td className="td text-xs text-slate-500">{b.supplier_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-slate-800">{value}</p>
    </div>
  );
}
