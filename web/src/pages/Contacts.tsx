import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { rupees, formatDate, rupeesInput, paiseFromInput } from '../lib/format';
import { Alert, Spinner, Modal, EmptyState, PageHeader, Tile } from '../components/ui';

type Tab = 'customers' | 'dues' | 'doctors' | 'suppliers';

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
        {([['customers', 'Customers'], ['dues', 'Customer dues'],
          ['doctors', 'Doctors'], ['suppliers', 'Suppliers']] as const).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t
                ? 'border-brand-500 bg-brand-50 text-brand-800'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'customers' && <Customers />}
      {tab === 'dues' && <CustomerDues />}
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

// ===========================================================================
// Customer dues — money the shop is owed
// ===========================================================================

type Due = {
  id: number; name: string; phone: string; address: string; credit_limit: number;
  credit_bills: number; billed_paise: number; collected_paise: number;
  receipts_paise: number; credit_note_paise: number; outstanding_paise: number;
  oldest_unpaid: string | null; oldest_days: number | null;
};

function CustomerDues() {
  const [data, setData] = useState<{ rows: Due[]; totals: any } | null>(null);
  const [error, setError] = useState('');
  const [statementFor, setStatementFor] = useState<Due | null>(null);
  const [receiptFor, setReceiptFor] = useState<Due | null>(null);

  function load() {
    api.get<{ rows: Due[]; totals: any }>('/customer-ledger/outstanding')
      .then(setData).catch((e) => setError(e.message));
  }
  useEffect(load, []);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Loading />;

  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Tile label="Owed to you" value={rupees(data.totals.outstanding_paise)}
          tone={data.totals.outstanding_paise > 0 ? 'warn' : 'good'} />
        <Tile label="Customers with dues" value={data.totals.customers} />
        <Tile label="Over their limit" value={data.totals.over_limit}
          tone={data.totals.over_limit > 0 ? 'bad' : 'good'}
          sub={data.totals.over_limit > 0 ? 'No further credit until paid' : 'All within limit'} />
      </div>

      <div className="card overflow-hidden">
        {data.rows.length === 0 ? (
          <EmptyState title="Nobody owes you anything" icon="✅"
            hint="Credit bills appear here until the money is received." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Customer</th>
                <th className="th text-right">Bills</th>
                <th className="th text-right">Billed</th>
                <th className="th text-right">Received</th>
                <th className="th text-right">Outstanding</th>
                <th className="th text-right">Limit</th>
                <th className="th">Oldest</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((c) => {
                const overLimit = c.credit_limit > 0 && c.outstanding_paise > c.credit_limit;
                return (
                  <tr key={c.id} className={overLimit ? 'bg-red-50' : ''}>
                    <td className="td">
                      <span className="font-medium text-slate-800">{c.name}</span>
                      {c.phone && <span className="block text-xs text-slate-400">{c.phone}</span>}
                    </td>
                    <td className="td text-right tabular">{c.credit_bills}</td>
                    <td className="td text-right tabular">{rupees(c.billed_paise)}</td>
                    <td className="td text-right tabular text-emerald-700">
                      {rupees(c.collected_paise + c.receipts_paise)}
                    </td>
                    <td className={`td text-right font-semibold tabular ${
                      overLimit ? 'text-red-700' : 'text-amber-700'
                    }`}>
                      {rupees(c.outstanding_paise)}
                    </td>
                    <td className="td text-right tabular text-slate-500">
                      {c.credit_limit > 0 ? rupees(c.credit_limit) : '—'}
                      {overLimit && (
                        <span className="block text-[11px] font-semibold text-red-600">over limit</span>
                      )}
                    </td>
                    <td className="td text-xs">
                      {c.oldest_unpaid ? (
                        <>
                          {formatDate(c.oldest_unpaid)}
                          {c.oldest_days !== null && c.oldest_days > 30 && (
                            <span className="block font-semibold text-red-600">
                              {c.oldest_days} days
                            </span>
                          )}
                        </>
                      ) : '—'}
                    </td>
                    <td className="td whitespace-nowrap text-right">
                      <button className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                        onClick={() => setStatementFor(c)}>Statement</button>
                      <button className="ml-3 text-xs font-medium text-brand-700 hover:underline"
                        onClick={() => setReceiptFor(c)}>Receive</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {statementFor && (
        <CustomerStatement customer={statementFor} onClose={() => setStatementFor(null)} />
      )}
      {receiptFor && (
        <ReceiptModal customer={receiptFor} onClose={() => setReceiptFor(null)}
          onSaved={() => { setReceiptFor(null); load(); }} />
      )}
    </>
  );
}

function CustomerStatement({ customer, onClose }: { customer: Due; onClose: () => void }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api.get(`/customer-ledger/statement/${customer.id}`).then(setData).catch(() => setData(null));
  }, [customer.id]);

  return (
    <Modal open onClose={onClose} width="max-w-3xl" title={`Statement — ${customer.name}`}>
      {!data ? <Loading /> : (
        <div className="space-y-5">
          <p className="text-sm text-slate-600">
            Currently owes <strong className="tabular">{rupees(data.outstanding_paise)}</strong>
          </p>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Bills</h3>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="th">Invoice</th>
                  <th className="th">Date</th>
                  <th className="th text-right">Total</th>
                  <th className="th text-right">Paid</th>
                  <th className="th text-right">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.bills.map((b: any) => (
                  <tr key={b.id} className={b.due_paise > 0 && b.age_days > 30 ? 'bg-red-50' : ''}>
                    <td className="td font-mono text-xs">{b.invoice_no}</td>
                    <td className="td">
                      {formatDate(b.invoice_date)}
                      {b.due_paise > 0 && b.age_days > 30 && (
                        <span className="block text-[11px] font-semibold text-red-600">
                          {b.age_days} days old
                        </span>
                      )}
                    </td>
                    <td className="td text-right tabular">{rupees(b.total_paise)}</td>
                    <td className="td text-right tabular text-emerald-700">
                      {rupees(b.paid_paise + b.receipts_paise)}
                    </td>
                    <td className={`td text-right tabular ${b.due_paise > 0 ? 'font-semibold text-amber-700' : 'text-slate-400'}`}>
                      {b.due_paise > 0 ? rupees(b.due_paise) : 'Settled'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.receipts.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">Receipts</h3>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th">Receipt</th>
                    <th className="th">Date</th>
                    <th className="th">Against</th>
                    <th className="th">Mode</th>
                    <th className="th text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.receipts.map((r: any) => (
                    <tr key={r.id}>
                      <td className="td font-mono text-xs">{r.receipt_no}</td>
                      <td className="td">{formatDate(r.receipt_date)}</td>
                      <td className="td text-xs">{r.invoice_no ?? 'On account'}</td>
                      <td className="td text-xs">
                        {r.mode}
                        {r.reference === 'WRITE-OFF' && (
                          <span className="chip ml-1 border-red-200 bg-red-50 text-red-700">
                            written off
                          </span>
                        )}
                      </td>
                      <td className="td text-right font-medium tabular">{rupees(r.amount_paise)}</td>
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

function ReceiptModal({ customer, onClose, onSaved }: {
  customer: Due; onClose: () => void; onSaved: () => void;
}) {
  const [bills, setBills] = useState<any[]>([]);
  const [saleId, setSaleId] = useState<number | null>(null);
  const [amount, setAmount] = useState(rupeesInput(customer.outstanding_paise));
  const [mode, setMode] = useState('CASH');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<any>(`/customer-ledger/statement/${customer.id}`)
      .then((d) => setBills(d.bills.filter((b: any) => b.due_paise > 0)))
      .catch(() => setBills([]));
  }, [customer.id]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post('/customer-ledger/receipts', {
        customer_id: customer.id,
        sale_id: saleId,
        amount_paise: paiseFromInput(amount),
        mode, reference,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the receipt');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Receive payment — ${customer.name}`}>
      <div className="space-y-3">
        {error && <Alert kind="error">{error}</Alert>}
        <p className="text-sm text-slate-600">
          Owes <strong className="tabular">{rupees(customer.outstanding_paise)}</strong>
          {' '}across {customer.credit_bills} bill{customer.credit_bills === 1 ? '' : 's'}
        </p>

        <div>
          <label className="label">Against which bill</label>
          <select className="input" value={saleId ?? ''}
            onChange={(e) => {
              const id = Number(e.target.value) || null;
              setSaleId(id);
              const b = bills.find((x) => x.id === id);
              setAmount(rupeesInput(b ? b.due_paise : customer.outstanding_paise));
            }}>
            <option value="">Oldest first (on account)</option>
            {bills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.invoice_no} — {formatDate(b.invoice_date)} — due {rupees(b.due_paise)}
              </option>
            ))}
          </select>
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
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="BANK">Bank transfer</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">Reference</label>
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)}
            placeholder="UPI reference or cheque number" />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={paiseFromInput(amount) <= 0 || busy}
            onClick={() => void submit()}>
            {busy && <Spinner />} Record receipt
          </button>
        </div>
      </div>
    </Modal>
  );
}
