import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { rupees, formatDateTime, todayIso } from '../lib/format';
import { Alert, Spinner, EmptyState, PageHeader } from '../components/ui';

type SaleRow = {
  id: number; invoice_no: string; invoice_date: string; customer_name: string;
  customer_phone: string; total_paise: number; payment_mode: string; status: string;
  item_count: number; served_by_name: string | null;
};

export default function Invoices() {
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [totals, setTotals] = useState({ count: 0, total_paise: 0 });
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ from, to, limit: '200' });
    if (query.trim()) params.set('q', query.trim());
    api.get<{ rows: SaleRow[]; totals: { count: number; total_paise: number } }>(`/sales?${params}`)
      .then((d) => { setRows(d.rows); setTotals(d.totals); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to, query]);

  useEffect(() => {
    const timer = setTimeout(load, query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  return (
    <div className="p-6">
      <PageHeader
        title="Invoices"
        subtitle="Every bill raised, including cancelled ones"
        actions={<Link to="/billing" className="btn-primary">New bill</Link>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="from">From</label>
          <input id="from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="to">To</label>
          <input id="to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[16rem]">
          <label className="label" htmlFor="q">Search</label>
          <input id="q" className="input" placeholder="Invoice number, customer name or phone…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            {totals.count} {totals.count === 1 ? 'bill' : 'bills'}
          </p>
          <p className="text-lg font-semibold tabular text-slate-900">{rupees(totals.total_paise)}</p>
        </div>
      </div>

      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="No invoices in this range" icon="📄"
            hint="Widen the date range or clear the search." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Invoice</th>
                <th className="th">Date &amp; time</th>
                <th className="th">Customer</th>
                <th className="th text-right">Items</th>
                <th className="th">Payment</th>
                <th className="th">Billed by</th>
                <th className="th text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((s) => (
                <tr key={s.id} className={s.status === 'CANCELLED' ? 'bg-red-50/50 opacity-60' : ''}>
                  <td className="td">
                    <Link to={`/invoices/${s.id}`}
                      className="font-mono text-xs font-medium text-brand-700 hover:underline">
                      {s.invoice_no}
                    </Link>
                    {s.status === 'CANCELLED' && (
                      <span className="chip ml-2 border-red-200 bg-red-100 text-red-700">Cancelled</span>
                    )}
                  </td>
                  <td className="td whitespace-nowrap text-xs text-slate-600">
                    {formatDateTime(s.invoice_date)}
                  </td>
                  <td className="td">
                    {s.customer_name}
                    {s.customer_phone && (
                      <span className="block text-xs text-slate-400">{s.customer_phone}</span>
                    )}
                  </td>
                  <td className="td text-right tabular text-slate-500">{s.item_count}</td>
                  <td className="td">
                    <span className="chip border-slate-200 bg-slate-100 text-slate-600">
                      {s.payment_mode}
                    </span>
                  </td>
                  <td className="td text-xs text-slate-500">{s.served_by_name ?? '—'}</td>
                  <td className="td text-right font-semibold tabular">{rupees(s.total_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
