import { useEffect, useState } from 'react';
import { api, downloadFile, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Alert, Spinner, Modal, PageHeader, EmptyState } from '../components/ui';
import GoLiveChecklist, { useReadiness } from '../components/GoLiveChecklist';
import { describeGstinProblem, normaliseGstin } from '@shared/gstin';

type Settings = {
  shop_name: string; legal_name: string; address_line1: string; address_line2: string;
  city: string; state: string; state_code: string; pincode: string; phone: string;
  email: string; gstin: string; pan: string; dl_no_form20: string; dl_no_form21: string;
  fssai_no: string; pharmacist_name: string; pharmacist_reg_no: string;
  invoice_prefix: string; return_prefix: string; invoice_footer: string;
  round_off_enabled: number; expiry_alert_days: number; low_stock_enabled: number;
  updated_at: string;
};

type User = {
  id: number; username: string; full_name: string; role: string;
  pharmacist_reg_no: string; phone: string; active: number; last_login_at: string | null;
  must_change_password: number;
};

export default function SettingsPage() {
  const [tab, setTab] = useState<'shop' | 'users' | 'backup' | 'audit' | 'golive'>('shop');

  return (
    <div className="p-6">
      <PageHeader title="Settings" subtitle="Shop particulars, staff accounts and audit trail" />

      <div className="mb-4 flex gap-2">
        {([['shop', 'Shop details'], ['users', 'Staff'], ['golive', 'Go-live checklist'],
          ['backup', 'Backup'], ['audit', 'Audit log']] as const).map(([k, label]) => (
          <button
            key={k} onClick={() => setTab(k)}
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

      {tab === 'shop' && <ShopSettings />}
      {tab === 'users' && <Users />}
      {tab === 'golive' && <GoLiveChecklist />}
      {tab === 'backup' && <Backups />}
      {tab === 'audit' && <AuditLog />}
    </div>
  );
}

function ShopSettings() {
  const [form, setForm] = useState<Settings | null>(null);
  const [states, setStates] = useState<Array<{ code: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // Set when the server rejects the GSTIN, so the owner can insist.
  const [overridable, setOverridable] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<Settings>('/settings'),
      api.get<Array<{ code: string; name: string }>>('/settings/states'),
    ]).then(([s, st]) => { setForm(s); setStates(st); })
      .catch((e) => setError(e.message));
  }, []);

  if (error && !form) return <Alert kind="error">{error}</Alert>;
  if (!form) return <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  async function submit(gstinOverride = false) {
    setBusy(true);
    setError('');
    setOverridable(false);
    setSaved(false);
    try {
      const updated = await api.put<Settings>('/settings', {
        ...form,
        round_off_enabled: form!.round_off_enabled === 1,
        low_stock_enabled: form!.low_stock_enabled === 1,
        gstin_override: gstinOverride,
      });
      setForm(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
      // Only the check-digit complaint can be overruled; a state-code clash
      // would silently mis-tax every sale, so that one stands.
      setOverridable(err instanceof ApiError && err.overridable === true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      {error && (
        <Alert kind="error" onDismiss={() => { setError(''); setOverridable(false); }}>
          <p>{error}</p>
          {overridable && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span>Certain the number is right? Your certificate wins over this check.</span>
              <button className="btn-secondary !py-1 !text-xs" disabled={busy}
                onClick={() => submit(true)}>
                Save it anyway
              </button>
            </p>
          )}
        </Alert>
      )}
      {saved && <Alert kind="success">Settings saved.</Alert>}

      <div className="card p-5">
        <h3 className="mb-4 text-sm font-semibold text-slate-700">Shop identity</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Shop name (printed on the invoice) *</label>
            <input className="input" value={form.shop_name} onChange={(e) => set('shop_name', e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">Legal / registered name</label>
            <input className="input" value={form.legal_name} onChange={(e) => set('legal_name', e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">Address line 1</label>
            <input className="input" value={form.address_line1} onChange={(e) => set('address_line1', e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">Address line 2</label>
            <input className="input" value={form.address_line2} onChange={(e) => set('address_line2', e.target.value)} />
          </div>
          <div>
            <label className="label">City</label>
            <input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} />
          </div>
          <div>
            <label className="label">PIN code</label>
            <input className="input tabular" value={form.pincode} onChange={(e) => set('pincode', e.target.value)} />
          </div>
          <div>
            <label className="label">State</label>
            <select className="input" value={form.state_code}
              onChange={(e) => {
                const st = states.find((s) => s.code === e.target.value);
                setForm((f) => (f ? { ...f, state_code: e.target.value, state: st?.name ?? f.state } : f));
              }}>
              {states.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">Email</label>
            <input className="input" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card p-5">
        <h3 className="mb-1 text-sm font-semibold text-slate-700">Statutory registrations</h3>
        <p className="mb-4 text-xs text-slate-400">
          These appear on every tax invoice. A retail chemist holds Form 20 (general drugs) and
          Form 21 (Schedule C &amp; C1 drugs).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">GSTIN</label>
            <input className="input font-mono uppercase" value={form.gstin}
              onChange={(e) => set('gstin', e.target.value)} />
            <GstinNote value={form.gstin} stateCode={form.state_code} />
          </div>
          <div>
            <label className="label">PAN</label>
            <input className="input font-mono uppercase" value={form.pan}
              onChange={(e) => set('pan', e.target.value)} />
          </div>
          <div>
            <label className="label">Drug licence — Form 20</label>
            <input className="input font-mono text-xs" value={form.dl_no_form20}
              onChange={(e) => set('dl_no_form20', e.target.value)} />
          </div>
          <div>
            <label className="label">Drug licence — Form 21</label>
            <input className="input font-mono text-xs" value={form.dl_no_form21}
              onChange={(e) => set('dl_no_form21', e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">FSSAI licence (for nutraceuticals &amp; food supplements)</label>
            <input className="input font-mono text-xs" value={form.fssai_no}
              onChange={(e) => set('fssai_no', e.target.value)} />
          </div>
          <div>
            <label className="label">Registered pharmacist</label>
            <input className="input" value={form.pharmacist_name}
              onChange={(e) => set('pharmacist_name', e.target.value)} />
          </div>
          <div>
            <label className="label">Pharmacist registration no.</label>
            <input className="input font-mono text-xs" value={form.pharmacist_reg_no}
              onChange={(e) => set('pharmacist_reg_no', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card p-5">
        <h3 className="mb-4 text-sm font-semibold text-slate-700">Billing preferences</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Invoice number prefix</label>
            <input className="input" value={form.invoice_prefix}
              onChange={(e) => set('invoice_prefix', e.target.value)} />
            <p className="mt-1 text-xs text-slate-400">
              Numbers run as {form.invoice_prefix}/2026-27/00001 and restart each financial year.
            </p>
          </div>
          <div>
            <label className="label">Credit note prefix</label>
            <input className="input" value={form.return_prefix}
              onChange={(e) => set('return_prefix', e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">Invoice footer text</label>
            <textarea className="input" rows={2} value={form.invoice_footer}
              onChange={(e) => set('invoice_footer', e.target.value)} />
          </div>
          <div>
            <label className="label">Expiry alert (days ahead)</label>
            <input type="number" min={0} max={365} className="input tabular" value={form.expiry_alert_days}
              onChange={(e) => set('expiry_alert_days', Number(e.target.value) || 0)} />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.round_off_enabled === 1}
                onChange={(e) => set('round_off_enabled', e.target.checked ? 1 : 0)} />
              Round invoice totals to the nearest rupee
            </label>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy && <Spinner />} Save settings
        </button>
        <span className="text-xs text-slate-400">
          Last updated {formatDateTime(form.updated_at)}
        </span>
      </div>
    </div>
  );
}

function Users() {
  const [rows, setRows] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<User | 'new' | null>(null);

  const { data: readiness, reload: recheck } = useReadiness();
  const weak = new Set((readiness?.weak_accounts ?? []).map((u) => u.id));

  function load() {
    setLoading(true);
    api.get<User[]>('/users').then(setRows)
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex justify-between">
        <Alert kind="info">
          Only pharmacists and admins may dispense Schedule H1/X medicines, process returns or
          cancel bills. Cashiers can bill over-the-counter items.
        </Alert>
      </div>

      {weak.size > 0 && (
        <Alert kind="error">
          {weak.size} account{weak.size === 1 ? '' : 's'} still use the password this software was
          installed with. Anyone who has read the setup guide can sign in as them. Set a new
          password on each — or disable the accounts the shop does not use.
        </Alert>
      )}

      <button className="btn-primary" onClick={() => setEditing('new')}>Add staff member</button>

      {error && <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert>}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Name</th>
                <th className="th">Username</th>
                <th className="th">Role</th>
                <th className="th">Pharmacist reg.</th>
                <th className="th">Last signed in</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'opacity-50'}>
                  <td className="td font-medium">
                    {u.full_name}
                    {!u.active && <span className="chip ml-2 border-slate-200 bg-slate-100 text-slate-500">Disabled</span>}
                    {u.active && weak.has(u.id) && (
                      <span className="chip ml-2 border-red-200 bg-red-50 text-red-700"
                        title="This account still uses a password this software shipped with">
                        Shipped password
                      </span>
                    )}
                    {u.active && !weak.has(u.id) && u.must_change_password === 1 && (
                      <span className="chip ml-2 border-amber-200 bg-amber-50 text-amber-700"
                        title="They must choose their own password at the next sign-in">
                        Temporary password
                      </span>
                    )}
                  </td>
                  <td className="td font-mono text-xs">{u.username}</td>
                  <td className="td">
                    <span className={`chip ${
                      u.role === 'admin' ? 'border-purple-200 bg-purple-50 text-purple-700'
                        : u.role === 'pharmacist' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-slate-200 bg-slate-100 text-slate-600'
                    }`}>{u.role}</span>
                  </td>
                  <td className="td font-mono text-xs">{u.pharmacist_reg_no || '—'}</td>
                  <td className="td text-xs text-slate-500">{formatDateTime(u.last_login_at)}</td>
                  <td className="td text-right">
                    <button className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                      onClick={() => setEditing(u)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <UserForm target={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); recheck(); }} />
    </div>
  );
}

function UserForm({ target, onClose, onSaved }: {
  target: User | 'new' | null; onClose: () => void; onSaved: () => void;
}) {
  const blank = {
    username: '', password: '', full_name: '', role: 'cashier',
    pharmacist_reg_no: '', phone: '', active: true,
  };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!target) return;
    setError('');
    setForm(target === 'new' ? blank : {
      username: target.username, password: '', full_name: target.full_name,
      role: target.role, pharmacist_reg_no: target.pharmacist_reg_no,
      phone: target.phone, active: target.active === 1,
    });
  }, [target]);

  if (!target) return null;
  const isNew = target === 'new';

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (isNew) {
        await api.post('/users', form);
      } else {
        const patch: Record<string, unknown> = {
          full_name: form.full_name, role: form.role,
          pharmacist_reg_no: form.pharmacist_reg_no, phone: form.phone, active: form.active,
        };
        if (form.password) patch.password = form.password;
        await api.patch(`/users/${(target as User).id}`, patch);
      }
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
    <Modal open onClose={onClose} title={isNew ? 'Add staff member' : `Edit — ${form.full_name}`}>
      <div className="space-y-3">
        {error && <Alert kind="error">{error}</Alert>}
        <div><label className="label">Full name *</label>
          <input className="input" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} /></div>
        <div><label className="label">Username *</label>
          <input className="input font-mono" value={form.username} disabled={!isNew}
            onChange={(e) => set('username', e.target.value)} /></div>
        <div>
          <label className="label">{isNew ? 'Password *' : 'New password (leave blank to keep)'}</label>
          <input type="password" className="input" value={form.password}
            onChange={(e) => set('password', e.target.value)} />
        </div>
        <div><label className="label">Role</label>
          <select className="input" value={form.role} onChange={(e) => set('role', e.target.value)}>
            <option value="cashier">Cashier — OTC billing only</option>
            <option value="pharmacist">Pharmacist — billing, H1, purchases, returns</option>
            <option value="admin">Admin — full access</option>
          </select>
        </div>
        {form.role !== 'cashier' && (
          <div><label className="label">Pharmacist registration no.</label>
            <input className="input font-mono text-xs" value={form.pharmacist_reg_no}
              onChange={(e) => set('pharmacist_reg_no', e.target.value)} /></div>
        )}
        <div><label className="label">Phone</label>
          <input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        {!isNew && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
            Account is active
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary"
            disabled={!form.full_name.trim() || !form.username.trim() || (isNew && form.password.length < 6) || busy}
            onClick={() => void submit()}>
            {busy && <Spinner />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

type BackupFile = { name: string; bytes: number; modified: string };

function Backups() {
  const [data, setData] = useState<{ directory: string; retain: number; backups: BackupFile[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function load() {
    api.get<typeof data>('/backup').then(setData).catch((e) => setError(e.message));
  }
  useEffect(load, []);

  async function takeBackup() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await api.post<{ file: string; bytes: number; sales: number; verified: boolean }>(
        '/backup', { label: '' },
      );
      setMessage(
        `Backup taken and verified — ${(r.bytes / 1048576).toFixed(2)} MB covering ${r.sales} bills.`,
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setBusy(false);
    }
  }

  async function download(name: string) {
    setError('');
    try {
      await downloadFile(`/backup/download/${encodeURIComponent(name)}`, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  }

  return (
    <div className="max-w-4xl space-y-4">
      <Alert kind="warning">
        <p className="font-semibold">Your entire shop is one file.</p>
        <p className="mt-1 text-xs">
          Stock, every bill, and the Schedule H1 register you must produce for three years all live
          in a single database. A backup kept only on this computer is not a backup — download it
          to a pen drive or cloud folder regularly. Take one before any software update.
        </p>
      </Alert>

      {error && <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert>}
      {message && <Alert kind="success" onDismiss={() => setMessage('')}>{message}</Alert>}

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={() => void takeBackup()} disabled={busy}>
          {busy && <Spinner />} Back up now
        </button>
        {data && (
          <span className="text-xs text-slate-500">
            Saved to <code className="rounded bg-slate-100 px-1">{data.directory}</code>,
            keeping the latest {data.retain}.
          </span>
        )}
      </div>

      <div className="card overflow-hidden">
        {!data ? (
          <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
        ) : data.backups.length === 0 ? (
          <EmptyState title="No backups yet" icon="💾"
            hint="Take one now, then schedule it daily — see the README for Task Scheduler and cron." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Backup</th>
                <th className="th">Taken</th>
                <th className="th text-right">Size</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.backups.map((b) => (
                <tr key={b.name}>
                  <td className="td font-mono text-xs">
                    {b.name}
                    {!/^pharmacy-[\dT:-]+\.sqlite$/.test(b.name) && (
                      <span className="chip ml-2 border-brand-200 bg-brand-50 text-brand-700">
                        kept
                      </span>
                    )}
                  </td>
                  <td className="td text-xs text-slate-600">{formatDateTime(b.modified)}</td>
                  <td className="td text-right tabular">{(b.bytes / 1048576).toFixed(2)} MB</td>
                  <td className="td text-right">
                    <button
                      className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                      onClick={() => void download(b.name)}
                    >
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card p-5 text-sm text-slate-600">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Restoring</h3>
        <ol className="list-decimal space-y-1 pl-5 text-xs">
          <li>Stop PharmacyPOS.</li>
          <li>Rename the damaged <code className="rounded bg-slate-100 px-1">pharmacy.sqlite</code> —
            do not delete it; a partly-readable file is still evidence.</li>
          <li>Copy the backup into its place and rename it to
            <code className="ml-1 rounded bg-slate-100 px-1">pharmacy.sqlite</code>.</li>
          <li>Delete any leftover <code className="rounded bg-slate-100 px-1">-wal</code> and
            <code className="ml-1 rounded bg-slate-100 px-1">-shm</code> files beside it.</li>
          <li>Start PharmacyPOS and check today's bill count on the Dashboard.</li>
        </ol>
        <p className="mt-2 text-xs text-slate-500">
          Anything billed after the backup was taken will need re-entering, which is why a daily
          schedule matters.
        </p>
      </div>
    </div>
  );
}

function AuditLog() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<any[]>('/reports/audit?limit=300')
      .then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, []);

  return (
    <div className="card max-w-4xl overflow-hidden">
      {loading ? (
        <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
      ) : (
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="th">When</th>
              <th className="th">User</th>
              <th className="th">Action</th>
              <th className="th">Entity</th>
              <th className="th">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="td whitespace-nowrap text-xs">{formatDateTime(r.created_at)}</td>
                <td className="td text-xs font-medium">{r.username}</td>
                <td className="td">
                  <span className="chip border-slate-200 bg-slate-100 text-slate-600">
                    {r.action.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="td text-xs text-slate-500">{r.entity}#{r.entity_id ?? '—'}</td>
                <td className="td max-w-xs truncate text-xs text-slate-600" title={r.details}>
                  {r.details || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}


/**
 * What the GSTIN field says under itself.
 *
 * Shown while typing rather than only on save, so a mistyped character is
 * caught with the certificate still in hand — not after filling in the rest of
 * the form and pressing a button that then refuses.
 */
function GstinNote({ value, stateCode }: { value: string; stateCode: string }) {
  const g = normaliseGstin(value);

  if (!g) {
    return (
      <p className="mt-1 text-xs text-slate-400">
        15 characters, beginning with your state code ({stateCode}).
      </p>
    );
  }

  // Nothing is said until it is long enough to judge; complaining about the
  // length of a number half-typed is just noise.
  if (g.length < 15) {
    return (
      <p className="mt-1 text-xs text-slate-400">
        {15 - g.length} more character{15 - g.length === 1 ? '' : 's'} to go.
      </p>
    );
  }

  const problem = describeGstinProblem(g);
  if (problem) return <p className="mt-1 text-xs text-red-600">{problem}</p>;
  if (g.slice(0, 2) !== stateCode) {
    return (
      <p className="mt-1 text-xs text-red-600">
        This GSTIN is registered in state {g.slice(0, 2)}, but the shop above is set to{' '}
        {stateCode}. Fix whichever is wrong.
      </p>
    );
  }
  return <p className="mt-1 text-xs text-emerald-600">Valid, and it matches the shop's state.</p>;
}
