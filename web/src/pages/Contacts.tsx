import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { rupees, formatDate } from '../lib/format';
import { Alert, Spinner, Modal, EmptyState, PageHeader } from '../components/ui';

type Tab = 'customers' | 'doctors' | 'suppliers';

type Customer = {
  id: number; name: string; phone: string; email: string; address: string;
  city: string; gstin: string; credit_limit: number; notes: string; active: number;
};
type Doctor = {
  id: number; name: string; qualification: string; reg_no: string;
  hospital: string; address: string; phone: string; active: number;
};
type Supplier = {
  id: number; name: string; contact_person: string; phone: string; email: string;
  address: string; city: string; state: string; state_code: string; gstin: string;
  dl_no: string; credit_days: number; active: number;
};

export default function Contacts() {
  const [tab, setTab] = useState<Tab>('customers');

  return (
    <div className="p-6">
      <PageHeader title="Contacts" subtitle="Customers, prescribers and distributors" />

      <div className="mb-4 flex gap-2">
        {(['customers', 'doctors', 'suppliers'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? 'border-brand-500 bg-brand-50 text-brand-800'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'customers' && <Customers />}
      {tab === 'doctors' && <Doctors />}
      {tab === 'suppliers' && <Suppliers />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Customers() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [history, setHistory] = useState<Customer | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const q = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    api.get<Customer[]>(`/customers${q}`)
      .then(setRows).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  return (
    <>
      <div className="mb-4 flex gap-2">
        <input className="input max-w-sm" placeholder="Search by name or phone…"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn-primary" onClick={() => setEditing('new')}>Add customer</button>
      </div>

      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="card overflow-hidden">
        {loading ? <Loading /> : rows.length === 0 ? (
          <EmptyState title="No customers yet" icon="👥"
            hint="Customers are optional — walk-in bills are recorded as Cash Customer." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Name</th>
                <th className="th">Phone</th>
                <th className="th">Address</th>
                <th className="th">GSTIN</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="td font-medium">{c.name}</td>
                  <td className="td tabular">{c.phone || '—'}</td>
                  <td className="td max-w-xs truncate text-slate-600">{c.address || '—'}</td>
                  <td className="td font-mono text-xs">{c.gstin || '—'}</td>
                  <td className="td whitespace-nowrap text-right">
                    <button className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                      onClick={() => setHistory(c)}>History</button>
                    <button className="ml-3 text-xs text-slate-500 hover:text-brand-700 hover:underline"
                      onClick={() => setEditing(c)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <CustomerForm target={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }} />
      <CustomerHistory customer={history} onClose={() => setHistory(null)} />
    </>
  );
}

function CustomerForm({ target, onClose, onSaved }: {
  target: Customer | 'new' | null; onClose: () => void; onSaved: () => void;
}) {
  const blank = {
    name: '', phone: '', email: '', address: '', city: 'Hyderabad',
    state_code: '36', gstin: '', credit_limit: 0, notes: '', active: true,
  };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!target) return;
    setError('');
    setForm(target === 'new' ? blank : {
      name: target.name, phone: target.phone, email: target.email, address: target.address,
      city: target.city, state_code: '36', gstin: target.gstin,
      credit_limit: target.credit_limit, notes: target.notes, active: target.active === 1,
    });
  }, [target]);

  if (!target) return null;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (target === 'new') await api.post('/customers', form);
      else await api.patch(`/customers/${(target as Customer).id}`, form);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title={target === 'new' ? 'Add customer' : 'Edit customer'}>
      <div className="space-y-3">
        {error && <Alert kind="error">{error}</Alert>}
        <div><label className="label">Name *</label>
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Phone</label>
            <input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
          <div><label className="label">City</label>
            <input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
        </div>
        <div><label className="label">Address</label>
          <input className="input" value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
        <div><label className="label">GSTIN (for B2B billing)</label>
          <input className="input font-mono uppercase" value={form.gstin}
            onChange={(e) => set('gstin', e.target.value)} /></div>
        <div><label className="label">Notes (allergies, chronic conditions)</label>
          <input className="input" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!form.name.trim() || busy} onClick={() => void submit()}>
            {busy && <Spinner />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CustomerHistory({ customer, onClose }: { customer: Customer | null; onClose: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!customer) return;
    setLoading(true);
    api.get<any[]>(`/customers/${customer.id}/history`)
      .then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, [customer]);

  if (!customer) return null;

  return (
    <Modal open onClose={onClose} width="max-w-2xl" title={`Purchase history — ${customer.name}`}>
      {loading ? <Loading /> : rows.length === 0 ? (
        <EmptyState title="No purchases on record" icon="🧾" />
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="th">Invoice</th>
              <th className="th">Date</th>
              <th className="th text-right">Items</th>
              <th className="th text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'CANCELLED' ? 'opacity-50' : ''}>
                <td className="td font-mono text-xs">{r.invoice_no}</td>
                <td className="td">{formatDate(r.invoice_date)}</td>
                <td className="td text-right tabular">{r.item_count}</td>
                <td className="td text-right font-medium tabular">{rupees(r.total_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Doctors() {
  const [rows, setRows] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Doctor | 'new' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get<Doctor[]>('/doctors').then(setRows)
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return (
    <>
      <div className="mb-4">
        <button className="btn-primary" onClick={() => setEditing('new')}>Add doctor</button>
      </div>
      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="mb-4">
        <Alert kind="info">
          The prescriber's name and address are copied verbatim into the Schedule H1 register.
          Keep them accurate and complete.
        </Alert>
      </div>

      <div className="card overflow-hidden">
        {loading ? <Loading /> : rows.length === 0 ? (
          <EmptyState title="No prescribers on file" icon="🩺" />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Name</th>
                <th className="th">Qualification</th>
                <th className="th">Reg. no.</th>
                <th className="th">Hospital / clinic</th>
                <th className="th">Address</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="td font-medium">{d.name}</td>
                  <td className="td text-slate-600">{d.qualification || '—'}</td>
                  <td className="td font-mono text-xs">{d.reg_no || '—'}</td>
                  <td className="td text-slate-600">{d.hospital || '—'}</td>
                  <td className="td max-w-xs truncate text-xs text-slate-500">{d.address || '—'}</td>
                  <td className="td text-right">
                    <button className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                      onClick={() => setEditing(d)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <DoctorForm target={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }} />
    </>
  );
}

function DoctorForm({ target, onClose, onSaved }: {
  target: Doctor | 'new' | null; onClose: () => void; onSaved: () => void;
}) {
  const blank = { name: '', qualification: '', reg_no: '', hospital: '', address: '', phone: '', active: true };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!target) return;
    setError('');
    setForm(target === 'new' ? blank : {
      name: target.name, qualification: target.qualification, reg_no: target.reg_no,
      hospital: target.hospital, address: target.address, phone: target.phone,
      active: target.active === 1,
    });
  }, [target]);

  if (!target) return null;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (target === 'new') await api.post('/doctors', form);
      else await api.patch(`/doctors/${(target as Doctor).id}`, form);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title={target === 'new' ? 'Add doctor' : 'Edit doctor'}>
      <div className="space-y-3">
        {error && <Alert kind="error">{error}</Alert>}
        <div><label className="label">Name *</label>
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)}
            placeholder="Dr. …" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Qualification</label>
            <input className="input" value={form.qualification}
              onChange={(e) => set('qualification', e.target.value)} placeholder="MBBS, MD" /></div>
          <div><label className="label">Registration no.</label>
            <input className="input" value={form.reg_no} onChange={(e) => set('reg_no', e.target.value)} /></div>
        </div>
        <div><label className="label">Hospital / clinic</label>
          <input className="input" value={form.hospital} onChange={(e) => set('hospital', e.target.value)} /></div>
        <div><label className="label">Address (recorded in the H1 register)</label>
          <input className="input" value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
        <div><label className="label">Phone</label>
          <input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!form.name.trim() || busy} onClick={() => void submit()}>
            {busy && <Spinner />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Suppliers() {
  const [rows, setRows] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get<Supplier[]>('/suppliers').then(setRows)
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return (
    <>
      <div className="mb-4">
        <button className="btn-primary" onClick={() => setEditing('new')}>Add supplier</button>
      </div>
      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="card overflow-hidden">
        {loading ? <Loading /> : rows.length === 0 ? (
          <EmptyState title="No suppliers on file" icon="🚚" />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Name</th>
                <th className="th">Contact</th>
                <th className="th">Location</th>
                <th className="th">GSTIN</th>
                <th className="th">Drug licence</th>
                <th className="th text-right">Credit</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="td font-medium">{s.name}</td>
                  <td className="td text-slate-600">
                    {s.contact_person || '—'}
                    {s.phone && <span className="block text-xs text-slate-400">{s.phone}</span>}
                  </td>
                  <td className="td text-slate-600">
                    {s.city}
                    {s.state_code !== '36' && (
                      <span className="chip ml-2 border-blue-200 bg-blue-50 text-blue-700">
                        {s.state} · IGST
                      </span>
                    )}
                  </td>
                  <td className="td font-mono text-xs">{s.gstin || '—'}</td>
                  <td className="td font-mono text-xs">{s.dl_no || '—'}</td>
                  <td className="td text-right tabular">{s.credit_days} days</td>
                  <td className="td text-right">
                    <button className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                      onClick={() => setEditing(s)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <SupplierForm target={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }} />
    </>
  );
}

function SupplierForm({ target, onClose, onSaved }: {
  target: Supplier | 'new' | null; onClose: () => void; onSaved: () => void;
}) {
  const blank = {
    name: '', contact_person: '', phone: '', email: '', address: '', city: 'Hyderabad',
    state: 'Telangana', state_code: '36', gstin: '', dl_no: '', credit_days: 0, active: true,
  };
  const [form, setForm] = useState(blank);
  const [states, setStates] = useState<Array<{ code: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Array<{ code: string; name: string }>>('/settings/states')
      .then(setStates).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!target) return;
    setError('');
    setForm(target === 'new' ? blank : {
      name: target.name, contact_person: target.contact_person, phone: target.phone,
      email: target.email, address: target.address, city: target.city, state: target.state,
      state_code: target.state_code, gstin: target.gstin, dl_no: target.dl_no,
      credit_days: target.credit_days, active: target.active === 1,
    });
  }, [target]);

  if (!target) return null;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (target === 'new') await api.post('/suppliers', form);
      else await api.patch(`/suppliers/${(target as Supplier).id}`, form);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title={target === 'new' ? 'Add supplier' : 'Edit supplier'}>
      <div className="space-y-3">
        {error && <Alert kind="error">{error}</Alert>}
        <div><label className="label">Firm name *</label>
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Contact person</label>
            <input className="input" value={form.contact_person}
              onChange={(e) => set('contact_person', e.target.value)} /></div>
          <div><label className="label">Phone</label>
            <input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        </div>
        <div><label className="label">Address</label>
          <input className="input" value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">City</label>
            <input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
          <div>
            <label className="label">State</label>
            <select className="input" value={form.state_code}
              onChange={(e) => {
                const st = states.find((s) => s.code === e.target.value);
                setForm((f) => ({ ...f, state_code: e.target.value, state: st?.name ?? f.state }));
              }}>
              {states.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
            </select>
          </div>
        </div>
        {form.state_code !== '36' && (
          <Alert kind="info">Purchases from this supplier will attract IGST.</Alert>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">GSTIN</label>
            <input className="input font-mono uppercase" value={form.gstin}
              onChange={(e) => set('gstin', e.target.value)} /></div>
          <div><label className="label">Drug licence no.</label>
            <input className="input font-mono text-xs" value={form.dl_no}
              onChange={(e) => set('dl_no', e.target.value)} placeholder="20B / 21B" /></div>
        </div>
        <div><label className="label">Credit period (days)</label>
          <input type="number" min={0} className="input tabular" value={form.credit_days}
            onChange={(e) => set('credit_days', Math.max(0, Number(e.target.value) || 0))} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!form.name.trim() || busy} onClick={() => void submit()}>
            {busy && <Spinner />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Loading() {
  return <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>;
}
