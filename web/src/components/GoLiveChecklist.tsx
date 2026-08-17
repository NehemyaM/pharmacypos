import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Alert, Spinner } from './ui';

export type Check = {
  id: string;
  severity: 'blocker' | 'advisory';
  title: string;
  detail: string;
  ok: boolean;
  fix: string;
};

export type Readiness = {
  ready: boolean;
  counts: { blockers_outstanding: number; blockers_total: number; advisories_outstanding: number };
  context: { products: number; products_in_stock: number; completed_bills: number; backups: number };
  weak_accounts: Array<{ id: number; username: string; full_name: string; role: string }>;
  checks: Check[];
};

/** Load the readiness report. Returns null while loading or if it cannot be read. */
export function useReadiness(): { data: Readiness | null; reload: () => void } {
  const [data, setData] = useState<Readiness | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    api.get<Readiness>('/readiness')
      .then((r) => { if (live) setData(r); })
      // A cashier is not allowed to see this, and that is not an error worth
      // showing them — the banner simply does not appear.
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [nonce]);

  return { data, reload: () => setNonce((n) => n + 1) };
}

/**
 * One line at the top of the dashboard while the shop is not ready to bill for
 * real. Deliberately hard to ignore, and it disappears completely once every
 * blocker is cleared.
 */
export function GoLiveBanner({ data, onOpen }: { data: Readiness | null; onOpen?: () => void }) {
  if (!data || data.ready) return null;
  const n = data.counts.blockers_outstanding;

  return (
    <Alert kind="warning">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          <strong>{n} thing{n === 1 ? '' : 's'} to finish before billing for real.</strong>{' '}
          {data.context.completed_bills > 0
            ? `${data.context.completed_bills.toLocaleString('en-IN')} bills have already been issued from this shop.`
            : 'The statutory particulars printed on every bill are not filled in yet.'}
        </span>
        {onOpen && (
          <button className="btn-secondary shrink-0" onClick={onOpen}>See the list</button>
        )}
      </div>
    </Alert>
  );
}

export default function GoLiveChecklist() {
  const { data, reload } = useReadiness();

  if (!data) {
    return <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>;
  }

  const blockers = data.checks.filter((c) => c.severity === 'blocker');
  const advisories = data.checks.filter((c) => c.severity === 'advisory');
  const doneCount = blockers.filter((c) => c.ok).length;

  return (
    <div className="max-w-4xl space-y-4">
      {data.ready ? (
        <Alert kind="success">
          Everything required is in place. The bills this shop prints carry the GSTIN, both drug
          licence numbers and the pharmacist's registration, and no account is on a shipped password.
        </Alert>
      ) : (
        <Alert kind="warning">
          {data.counts.blockers_outstanding} of {blockers.length} required items are still
          outstanding. Until they are done, the bills the shop prints are not valid tax invoices —
          a buyer cannot claim input credit on them, and a drug inspector would take issue with the
          missing licence numbers.
        </Alert>
      )}

      <div className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">
            Required before real billing
          </h3>
          <span className="text-xs text-slate-500">{doneCount} of {blockers.length} done</span>
        </div>
        <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full ${data.ready ? 'bg-emerald-500' : 'bg-amber-500'}`}
            style={{ width: `${blockers.length ? (doneCount / blockers.length) * 100 : 0}%` }}
          />
        </div>
        <ul className="divide-y divide-slate-100">
          {blockers.map((c) => <CheckRow key={c.id} check={c} />)}
        </ul>
      </div>

      <div className="card p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-800">Worth doing</h3>
        <ul className="divide-y divide-slate-100">
          {advisories.map((c) => <CheckRow key={c.id} check={c} />)}
        </ul>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-secondary" onClick={reload}>Check again</button>
        <span className="text-xs text-slate-500">
          {data.context.products.toLocaleString('en-IN')} products,{' '}
          {data.context.products_in_stock.toLocaleString('en-IN')} with stock,{' '}
          {data.context.backups} backup{data.context.backups === 1 ? '' : 's'} taken
        </span>
      </div>

      <p className="text-xs text-slate-400">
        This checks what the software can see. It is not a substitute for your accountant confirming
        the GST treatment, or for the drug inspector accepting the format of the Schedule H1
        register.
      </p>
    </div>
  );
}

function CheckRow({ check }: { check: Check }) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
          check.ok
            ? 'bg-emerald-100 text-emerald-700'
            : check.severity === 'blocker'
              ? 'bg-red-100 text-red-700'
              : 'bg-amber-100 text-amber-700'
        }`}
        aria-hidden
      >
        {check.ok ? '✓' : '!'}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm ${check.ok ? 'text-slate-500' : 'font-medium text-slate-800'}`}>
          {check.title}
        </p>
        {!check.ok && (
          <>
            <p className="mt-0.5 text-xs text-slate-500">{check.detail}</p>
            <p className="mt-1 text-xs text-slate-400">Fix in: {check.fix}</p>
          </>
        )}
      </div>
    </li>
  );
}
