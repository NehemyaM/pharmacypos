import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type SessionUser } from '../lib/api';
import { rupees, formatExpiry, monthsToExpiry, formatQty, scheduleClass, formatDate } from '../lib/format';
import { Alert, Spinner, Modal, EmptyState, PageHeader } from '../components/ui';

type StockRow = {
  id: number; batch_no: string; expiry: string; mrp_paise: number;
  purchase_rate_paise: number; sale_rate_paise: number; qty_units: number; received_at: string;
  product_id: number; product_name: string; generic_name: string; manufacturer: string;
  unit: string; pack_size: number; rack: string; schedule_type: string; gst_rate: number;
  hsn_code: string; reorder_level: number; cold_chain: number;
  supplier_name: string | null; cost_value_paise: number; mrp_value_paise: number;
  expiry_status: 'EXPIRED' | 'EXPIRING' | 'OK';
};

type LedgerRow = {
  id: number; txn_type: string; qty_in: number; qty_out: number; balance_after: number;
  note: string; created_at: string; user_name: string | null;
};

const FILTERS = [
  { key: 'all', label: 'All in stock' },
  { key: 'expiring', label: 'Expiring soon' },
  { key: 'expired', label: 'Expired' },
  { key: 'low', label: 'Low stock' },
  { key: 'out', label: 'Out of stock' },
] as const;

export default function Inventory({ user }: { user: SessionUser }) {
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') ?? 'all';
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adjusting, setAdjusting] = useState<StockRow | null>(null);
  const [ledgerFor, setLedgerFor] = useState<StockRow | null>(null);

  const canAdjust = user.role === 'admin' || user.role === 'pharmacist';

  const load = useCallback(() => {
    setLoading(true);
    const q = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : '';
    api.get<StockRow[]>(`/inventory/stock?filter=${filter}${q}&limit=500`)
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filter, query]);

  useEffect(() => {
    const timer = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  const costTotal = rows.reduce((s, r) => s + r.cost_value_paise, 0);
  const mrpTotal = rows.reduce((s, r) => s + r.mrp_value_paise, 0);

  return (
    <div className="p-6">
      <PageHeader
        title="Stock"
        subtitle="Batch-wise stock on hand, valued at cost and at MRP"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setParams(f.key === 'all' ? {} : { filter: f.key })}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === f.key
                ? 'border-brand-500 bg-brand-50 text-brand-800'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          className="input ml-auto max-w-xs"
          placeholder="Search product, salt, batch or manufacturer…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="mb-3 flex flex-wrap gap-x-8 gap-y-1 text-sm text-slate-600">
        <span><strong className="tabular">{rows.length}</strong> batches</span>
        <span>Cost value: <strong className="tabular">{rupees(costTotal)}</strong></span>
        <span>MRP value: <strong className="tabular">{rupees(mrpTotal)}</strong></span>
        {costTotal > 0 && (
          <span className="text-slate-400">
            Potential margin: <strong className="tabular">{rupees(mrpTotal - costTotal)}</strong>
          </span>
        )}
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing here"
            hint={filter === 'expired' ? 'No expired stock — well managed.' : 'Try a different filter or search.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="th">Product</th>
                  <th className="th">Batch</th>
                  <th className="th">Expiry</th>
                  <th className="th text-right">Stock</th>
                  <th className="th text-right">Cost/pack</th>
                  <th className="th text-right">MRP</th>
                  <th className="th text-right">Value @cost</th>
                  <th className="th">Rack</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const months = monthsToExpiry(r.expiry);
                  const low = r.reorder_level > 0 && r.qty_units <= r.reorder_level;
                  return (
                    <tr key={r.id} className={r.expiry_status === 'EXPIRED' ? 'bg-red-50' : ''}>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-800">{r.product_name}</span>
                          {r.schedule_type !== 'OTC' && (
                            <span className={`chip ${scheduleClass(r.schedule_type)}`}>{r.schedule_type}</span>
                          )}
                          {r.cold_chain === 1 && (
                            <span className="chip border-sky-200 bg-sky-100 text-sky-700" title="Cold chain">
                              ❄ 2–8°C
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400">
                          {r.generic_name} · {r.manufacturer}
                        </p>
                      </td>
                      <td className="td font-mono text-xs">{r.batch_no}</td>
                      <td className="td">
                        <span className={
                          r.expiry_status === 'EXPIRED' ? 'font-semibold text-red-600'
                            : r.expiry_status === 'EXPIRING' ? 'font-semibold text-amber-600'
                              : 'text-slate-600'
                        }>
                          {formatExpiry(r.expiry)}
                        </span>
                        <span className="block text-[11px] text-slate-400">
                          {months < 0 ? `${-months} mo ago` : months === 0 ? 'this month' : `in ${months} mo`}
                        </span>
                      </td>
                      <td className={`td text-right tabular ${low ? 'font-semibold text-amber-600' : ''}`}>
                        {formatQty(r.qty_units, r.pack_size, r.unit)}
                        {low && <span className="block text-[11px]">below reorder ({r.reorder_level})</span>}
                      </td>
                      <td className="td text-right tabular text-slate-500">{rupees(r.purchase_rate_paise)}</td>
                      <td className="td text-right tabular">{rupees(r.mrp_paise)}</td>
                      <td className="td text-right tabular font-medium">{rupees(r.cost_value_paise)}</td>
                      <td className="td text-xs text-slate-500">{r.rack || '—'}</td>
                      <td className="td whitespace-nowrap text-right">
                        <button
                          onClick={() => setLedgerFor(r)}
                          className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
                        >
                          History
                        </button>
                        {canAdjust && (
                          <button
                            onClick={() => setAdjusting(r)}
                            className="ml-3 text-xs text-slate-500 hover:text-brand-700 hover:underline"
                          >
                            Adjust
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AdjustModal
        batch={adjusting} onClose={() => setAdjusting(null)}
        onDone={() => { setAdjusting(null); load(); }}
      />
      <LedgerModal batch={ledgerFor} onClose={() => setLedgerFor(null)} />
    </div>
  );
}

function AdjustModal({ batch, onClose, onDone }: {
  batch: StockRow | null; onClose: () => void; onDone: () => void;
}) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<'DAMAGE' | 'EXPIRED' | 'COUNT_CORRECTION' | 'THEFT' | 'OTHER'>('COUNT_CORRECTION');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (batch) { setDelta(''); setNote(''); setReason('COUNT_CORRECTION'); setError(''); }
  }, [batch]);

  if (!batch) return null;
  const deltaNum = Number(delta) || 0;
  const newQty = batch.qty_units + deltaNum;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post('/inventory/adjust', {
        batch_id: batch!.id, qty_delta: deltaNum, reason, note,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not adjust stock');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Adjust stock — ${batch.product_name}`}>
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p><span className="text-slate-500">Batch</span> <span className="font-mono">{batch.batch_no}</span></p>
          <p><span className="text-slate-500">Expiry</span> {formatExpiry(batch.expiry)}</p>
          <p><span className="text-slate-500">Current stock</span> <strong className="tabular">{batch.qty_units} {batch.unit}</strong></p>
        </div>

        <div>
          <label className="label" htmlFor="delta">
            Change (negative to remove, positive to add)
          </label>
          <input
            id="delta" type="number" className="input tabular" value={delta}
            onChange={(e) => setDelta(e.target.value)} placeholder="e.g. -5"
          />
          {deltaNum !== 0 && (
            <p className={`mt-1 text-xs ${newQty < 0 ? 'text-red-600' : 'text-slate-500'}`}>
              New balance: <strong className="tabular">{newQty} {batch.unit}</strong>
              {newQty < 0 && ' — cannot go below zero'}
            </p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="reason">Reason</label>
          <select id="reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            <option value="COUNT_CORRECTION">Physical count correction</option>
            <option value="DAMAGE">Damaged / breakage</option>
            <option value="EXPIRED">Expired — write off</option>
            <option value="THEFT">Theft / shortage</option>
            <option value="OTHER">Other</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="note">Note</label>
          <input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <p className="text-xs text-slate-400">
          Every adjustment is written to the stock ledger with your name and the time.
        </p>

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary" disabled={deltaNum === 0 || newQty < 0 || busy}
            onClick={() => void submit()}
          >
            {busy && <Spinner />} Apply adjustment
          </button>
        </div>
      </div>
    </Modal>
  );
}

function LedgerModal({ batch, onClose }: { batch: StockRow | null; onClose: () => void }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!batch) return;
    setLoading(true);
    api.get<LedgerRow[]>(`/inventory/batches/${batch.id}/ledger`)
      .then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, [batch]);

  if (!batch) return null;

  return (
    <Modal open onClose={onClose} width="max-w-3xl"
      title={`Movement history — ${batch.product_name} / ${batch.batch_no}`}>
      {loading ? (
        <div className="flex justify-center py-10"><Spinner className="h-5 w-5 text-slate-400" /></div>
      ) : rows.length === 0 ? (
        <EmptyState title="No movements recorded" icon="📋" />
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-200">
                <th className="th">When</th>
                <th className="th">Type</th>
                <th className="th text-right">In</th>
                <th className="th text-right">Out</th>
                <th className="th text-right">Balance</th>
                <th className="th">Reference</th>
                <th className="th">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td whitespace-nowrap text-xs">{formatDate(r.created_at)}</td>
                  <td className="td">
                    <span className={`chip ${
                      r.txn_type === 'SALE' ? 'border-slate-200 bg-slate-100 text-slate-600'
                        : r.txn_type === 'PURCHASE' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-amber-200 bg-amber-50 text-amber-700'
                    }`}>
                      {r.txn_type.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="td text-right tabular text-emerald-700">{r.qty_in || ''}</td>
                  <td className="td text-right tabular text-red-600">{r.qty_out || ''}</td>
                  <td className="td text-right tabular font-medium">{r.balance_after}</td>
                  <td className="td max-w-[16rem] truncate text-xs text-slate-500" title={r.note}>{r.note}</td>
                  <td className="td text-xs text-slate-500">{r.user_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
