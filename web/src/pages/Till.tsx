import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Alert, Spinner, PageHeader, Modal } from '../components/ui';
import { openCashDrawer, isDesktop } from '../lib/desktop';
import type { SessionUser } from '../lib/api';

const DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const;
type Counts = Partial<Record<(typeof DENOMINATIONS)[number], number>>;

type Movement = {
  id: number; kind: 'PAY_IN' | 'PAY_OUT'; amount_paise: number;
  reason: string; by_name: string | null; at: string;
};

type Session = {
  id: number;
  opened_at: string;
  opening_float_paise: number;
  auto_opened: number;
  status: 'OPEN' | 'CLOSED';
  expected_paise: number;
  bills: number;
  drawer_opens_without_a_sale: number;
  non_cash: Array<{ mode: string; v: number; n: number }>;
  movements: Movement[];
  components: {
    opening_float_paise: number;
    cash_sales_paise: number;
    cash_refunds_paise: number;
    cash_receipts_paise: number;
    pay_in_paise: number;
    pay_out_paise: number;
  };
};

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toPaise = (s: string) => Math.round((Number(s.replace(/[^\d.]/g, '')) || 0) * 100);

export default function Till({ user }: { user: SessionUser }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [float, setFloat] = useState('2000');
  const [counts, setCounts] = useState<Counts>({});
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState<{ text: string; severity: string; unrecorded: boolean } | null>(null);
  const [moveOpen, setMoveOpen] = useState<null | 'PAY_IN' | 'PAY_OUT'>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const canClose = user.role === 'admin' || user.role === 'pharmacist';

  async function load() {
    try {
      const r = await api.get<{ open: boolean; session: Session | null }>('/till/current');
      setSession(r.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the till');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const countedPaise = useMemo(
    () => DENOMINATIONS.reduce((sum, d) => sum + (counts[d] ?? 0) * d * 100, 0),
    [counts],
  );
  const difference = session ? countedPaise - session.expected_paise : 0;

  async function openTill() {
    setError('');
    try {
      await api.post('/till/open', { opening_float_paise: toPaise(float) });
      setNote('Till opened.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the till');
    }
  }

  async function closeTill() {
    setClosing(true);
    setError('');
    try {
      const r = await api.post<{
        variance: { text: string; severity: string };
        float_was_never_recorded: boolean;
      }>('/till/close', { counted_paise: countedPaise, notes: '' });
      setResult({
        text: r.variance.text,
        severity: r.variance.severity,
        unrecorded: r.float_was_never_recorded,
      });
      setCounts({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close the till');
    } finally {
      setClosing(false);
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner className="h-6 w-6 text-slate-400" /></div>;

  return (
    <div className="p-6">
      <PageHeader title="Cash drawer" subtitle="Open the till, move cash, and count it at close" />

      {error && <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert>}
      {note && <Alert kind="success" onDismiss={() => setNote('')}>{note}</Alert>}

      {result && (
        <Alert kind={result.severity === 'balanced' ? 'success' : result.severity === 'minor' ? 'warning' : 'error'}>
          <p className="font-medium">{result.text}</p>
          {result.unrecorded && (
            <p className="mt-1 text-xs">
              Nobody opened the till this morning, so there is no opening float to compare
              against — this difference is not meaningful. Open the till before the first
              sale tomorrow and it will be.
            </p>
          )}
        </Alert>
      )}

      {/* ---- Nothing open ---- */}
      {!session && (
        <div className="card mt-4 max-w-lg p-5">
          <h3 className="text-sm font-semibold text-slate-800">Open the till</h3>
          <p className="mt-1 text-xs text-slate-500">
            Count the cash you are putting in the drawer to start the day. Without this
            figure, tonight's count has nothing to be compared against.
          </p>
          <label className="label mt-4">Opening float</label>
          <div className="flex gap-2">
            <input id="float" className="input !w-40 font-mono" value={float}
              onChange={(e) => setFloat(e.target.value)} />
            <button id="opentill" className="btn-primary" onClick={() => void openTill()}>
              Open the till
            </button>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Billing works whether or not the till is open — a customer is never made to wait
            on this. But a sale before it is opened leaves the morning's float unrecorded.
          </p>
        </div>
      )}

      {/* ---- Open ---- */}
      {session && (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-4">
            {session.auto_opened === 1 && (
              <Alert kind="warning">
                <p className="font-medium">This till was opened by the first sale, not by a person.</p>
                <p className="mt-1 text-xs">
                  No opening float was recorded, so tonight's count cannot be checked against
                  anything. Enter what was in the drawer this morning and it becomes a real
                  session.
                </p>
                <div className="mt-2 flex gap-2">
                  <input className="input !w-32 font-mono !py-1 !text-xs" value={float}
                    onChange={(e) => setFloat(e.target.value)} />
                  <button className="btn-secondary !py-1 !text-xs" onClick={() => void openTill()}>
                    Record the float
                  </button>
                </div>
              </Alert>
            )}

            <div className="card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">Since the till was opened</h3>
                <span className="text-xs text-slate-500">
                  {session.bills} bill{session.bills === 1 ? '' : 's'}
                </span>
              </div>

              <dl className="space-y-1.5 text-sm">
                <Row label="Opening float" value={session.components.opening_float_paise} />
                <Row label="Cash taken over the counter" value={session.components.cash_sales_paise} />
                <Row label="Refunded in cash" value={-session.components.cash_refunds_paise} />
                <Row label="Collected against accounts" value={session.components.cash_receipts_paise} />
                <Row label="Cash put in" value={session.components.pay_in_paise} />
                <Row label="Cash taken out" value={-session.components.pay_out_paise} />
                <div className="!mt-3 flex items-center justify-between border-t border-slate-200 pt-2">
                  <dt className="font-semibold text-slate-800">Should be in the drawer</dt>
                  <dd id="expected" className="font-mono text-lg font-bold text-slate-900">
                    {rupees(session.expected_paise)}
                  </dd>
                </div>
              </dl>

              {session.non_cash.length > 0 && (
                <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">
                  Not in the drawer:{' '}
                  {session.non_cash.map((m) => `${m.mode} ${rupees(m.v)}`).join(' · ')}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn-secondary !text-xs" onClick={() => setMoveOpen('PAY_IN')}>
                  Put cash in
                </button>
                <button className="btn-secondary !text-xs" onClick={() => setMoveOpen('PAY_OUT')}>
                  Take cash out
                </button>
                <button id="nosale" className="btn-ghost !text-xs" onClick={() => setDrawerOpen(true)}>
                  Open the drawer
                </button>
              </div>
            </div>

            {session.movements.length > 0 && (
              <div className="card p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-800">Cash in and out</h3>
                <ul className="divide-y divide-slate-100 text-sm">
                  {session.movements.map((m) => (
                    <li key={m.id} className="flex items-center justify-between py-1.5">
                      <span className="min-w-0">
                        <span className="text-slate-700">{m.reason}</span>
                        {m.by_name && <span className="ml-2 text-xs text-slate-400">{m.by_name}</span>}
                      </span>
                      <span className={`font-mono ${m.kind === 'PAY_IN' ? 'text-emerald-700' : 'text-red-700'}`}>
                        {m.kind === 'PAY_IN' ? '+' : '−'}{rupees(m.amount_paise)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {session.drawer_opens_without_a_sale > 0 && (
              <p className="text-xs text-slate-500">
                The drawer has been opened {session.drawer_opens_without_a_sale} time
                {session.drawer_opens_without_a_sale === 1 ? '' : 's'} without a bill behind it.
              </p>
            )}
          </div>

          {/* ---- Counting ---- */}
          <div className="xl:sticky xl:top-4 xl:self-start">
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-800">Count the drawer</h3>
              <p className="mt-1 text-xs text-slate-500">
                Count by note, not by total. A single figure can be made to agree with the
                expected amount; a count of notes has to be justified note by note.
              </p>

              <div className="mt-3 space-y-1">
                {DENOMINATIONS.map((d) => (
                  <div key={d} className="flex items-center gap-2">
                    <span className="w-14 text-right font-mono text-sm text-slate-600">₹{d}</span>
                    <span className="text-slate-300">×</span>
                    <input
                      aria-label={`Number of ${d} rupee notes`}
                      data-denom={d}
                      className="input !w-20 !py-1 !text-right font-mono !text-sm"
                      value={counts[d] ?? ''}
                      onChange={(e) => setCounts((c) => ({ ...c, [d]: Number(e.target.value) || 0 }))}
                    />
                    <span className="ml-auto font-mono text-sm text-slate-500">
                      {rupees((counts[d] ?? 0) * d * 100)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-3 border-t border-slate-200 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">Counted</span>
                  <span id="counted" className="font-mono text-lg font-bold">{rupees(countedPaise)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-sm text-slate-600">Difference</span>
                  <span
                    id="difference"
                    className={`font-mono text-sm font-semibold ${
                      difference === 0 ? 'text-emerald-700'
                        : Math.abs(difference) <= 1000 ? 'text-amber-700' : 'text-red-700'
                    }`}
                  >
                    {difference > 0 ? '+' : ''}{rupees(difference)}
                  </span>
                </div>
              </div>

              {canClose ? (
                <button
                  id="closetill"
                  className="btn-primary mt-3 w-full"
                  disabled={closing || countedPaise === 0}
                  onClick={() => void closeTill()}
                >
                  {closing ? <Spinner /> : null} Close the till
                </button>
              ) : (
                <p className="mt-3 text-xs text-slate-500">
                  A pharmacist or the owner closes the till.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {moveOpen && (
        <MovementDialog
          kind={moveOpen}
          onClose={() => setMoveOpen(null)}
          onDone={() => { setMoveOpen(null); void load(); }}
        />
      )}
      {drawerOpen && (
        <DrawerDialog onClose={() => setDrawerOpen(false)} onDone={() => { setDrawerOpen(false); void load(); }} />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd className={`font-mono ${value < 0 ? 'text-red-700' : 'text-slate-800'}`}>
        {value < 0 ? '−' : ''}{rupees(Math.abs(value))}
      </dd>
    </div>
  );
}

function MovementDialog({ kind, onClose, onDone }: {
  kind: 'PAY_IN' | 'PAY_OUT'; onClose: () => void; onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.post('/till/movement', {
        kind, amount_paise: toPaise(amount), reason: reason.trim(),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={kind === 'PAY_IN' ? 'Put cash in the drawer' : 'Take cash out of the drawer'} onClose={onClose}>
      {error && <Alert kind="error">{error}</Alert>}
      <label className="label">Amount</label>
      <input id="moveamt" className="input font-mono" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <label className="label mt-3">What for?</label>
      <input
        id="movereason" className="input" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={kind === 'PAY_IN' ? 'Change brought from home' : 'Paid the courier'}
      />
      <p className="mt-2 text-xs text-slate-400">
        This is what makes tonight's count add up. Cash that leaves with no note against it
        looks exactly like cash that went missing.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner /> : null} Record it
        </button>
      </div>
    </Modal>
  );
}

function DrawerDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setError('');
    try {
      // Recorded first, then sprung. If the record fails the drawer stays shut,
      // which is the right way round: an unrecorded opening is the thing this
      // is here to prevent.
      await api.post('/till/drawer-open', { reason: reason.trim() });
      await openCashDrawer();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the drawer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="Open the drawer" onClose={onClose}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="text-sm text-slate-600">
        Opening the drawer without a sale is recorded against your name. Say why.
      </p>
      <label className="label mt-3">Reason</label>
      <input
        id="drawerreason" className="input" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="Giving change for a UPI customer"
      />
      {!isDesktop && (
        <p className="mt-2 text-xs text-amber-700">
          The drawer can only be sprung from the installed application on the machine the
          printer is attached to. This will be recorded, but nothing will open.
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button id="doopen" className="btn-primary" disabled={busy} onClick={() => void go()}>
          {busy ? <Spinner /> : null} Record and open
        </button>
      </div>
    </Modal>
  );
}
