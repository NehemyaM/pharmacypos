import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { rupees, rupeesShort, formatDate } from '../lib/format';
import { Alert, Spinner, Tile, PageHeader } from '../components/ui';
import { GoLiveBanner, useReadiness } from '../components/GoLiveChecklist';

type Dashboard = {
  date: string;
  todaySales: { bills: number; total_paise: number; taxable_paise: number; tax_paise: number };
  monthSales: { bills: number; total_paise: number };
  byPayment: Array<{ payment_mode: string; bills: number; total_paise: number }>;
  margin: { revenue_paise: number; cost_paise: number };
  last7: Array<{ day: string; bills: number; total_paise: number }>;
  returnsToday: { count: number; total_paise: number };
  alerts: { expired_batches: number; expiring_batches: number };
};

type StockSummary = {
  valuation: { cost_paise: number; mrp_paise: number; products_in_stock: number; batches_in_stock: number };
  expired: { batches: number; cost_paise: number };
  expiring3: { batches: number; cost_paise: number };
  lowStock: { products: number };
  outOfStock: { products: number };
};

export default function Dashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [stock, setStock] = useState<StockSummary | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  // Owner-only, and silently absent for everyone else.
  const { data: readiness } = useReadiness();

  useEffect(() => {
    Promise.all([
      api.get<Dashboard>('/reports/dashboard'),
      api.get<StockSummary>('/inventory/summary'),
    ])
      .then(([d, s]) => { setData(d); setStock(s); })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="p-6"><Alert kind="error">{error}</Alert></div>;
  if (!data || !stock) {
    return <div className="flex h-64 items-center justify-center"><Spinner className="h-6 w-6 text-slate-400" /></div>;
  }

  const marginPaise = data.margin.revenue_paise - data.margin.cost_paise;
  const marginPct = data.margin.revenue_paise > 0
    ? (marginPaise / data.margin.revenue_paise) * 100
    : 0;
  const peak = Math.max(...data.last7.map((d) => d.total_paise), 1);

  return (
    <div className="p-6">
      <PageHeader
        title="Dashboard"
        subtitle={`Trading position for ${formatDate(data.date)}`}
        actions={<Link to="/billing" className="btn-primary">New bill</Link>}
      />

      {readiness && !readiness.ready && (
        <div className="mb-5">
          <GoLiveBanner data={readiness} onOpen={() => navigate('/settings')} />
        </div>
      )}

      {(stock.expired.batches > 0 || stock.expiring3.batches > 0) && (
        <div className="mb-5">
          <Alert kind={stock.expired.batches > 0 ? 'error' : 'warning'}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              {stock.expired.batches > 0 && (
                <span>
                  <strong>{stock.expired.batches} expired {plural(stock.expired.batches, 'batch', 'batches')}</strong>
                  {' '}still showing stock ({rupees(stock.expired.cost_paise)} at cost) — remove from the shelf.
                </span>
              )}
              {stock.expiring3.batches > 0 && (
                <span>
                  {stock.expiring3.batches} {plural(stock.expiring3.batches, 'batch', 'batches')} expiring
                  within 3 months ({rupees(stock.expiring3.cost_paise)}).
                </span>
              )}
              <Link to="/inventory?filter=expiring" className="font-semibold underline">Review stock →</Link>
            </div>
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Sales today"
          value={rupees(data.todaySales.total_paise)}
          sub={`${data.todaySales.bills} ${plural(data.todaySales.bills, 'bill', 'bills')}`}
        />
        <Tile
          label="Gross margin today"
          value={rupees(marginPaise)}
          sub={`${marginPct.toFixed(1)}% of taxable value`}
          tone={marginPct >= 15 ? 'good' : marginPct > 0 ? 'warn' : 'default'}
        />
        <Tile
          label="This month"
          value={rupeesShort(data.monthSales.total_paise)}
          sub={`${data.monthSales.bills} bills`}
        />
        <Tile
          label="Stock value (cost)"
          value={rupeesShort(stock.valuation.cost_paise)}
          sub={`${stock.valuation.products_in_stock} products · ${stock.valuation.batches_in_stock} batches`}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        {/* 7-day trend */}
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Last 7 days</h2>
          {data.last7.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">No sales recorded yet</p>
          ) : (
            <div className="flex h-40 items-stretch gap-2">
              {data.last7.map((d) => (
                <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] tabular text-slate-500">{rupeesShort(d.total_paise)}</span>
                  {/* This wrapper must own the remaining height, otherwise the
                      bar's percentage height resolves against an auto-height
                      parent and collapses to nothing. */}
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className="w-full rounded-t bg-brand-500 transition-all"
                      style={{ height: `${Math.max(3, (d.total_paise / peak) * 100)}%` }}
                      title={`${formatDate(d.day)}: ${rupees(d.total_paise)} across ${d.bills} bills`}
                    />
                  </div>
                  <span className="text-[10px] text-slate-400">{d.day.slice(8)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Collections */}
        <div className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Collections today</h2>
          {data.byPayment.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">Nothing collected yet</p>
          ) : (
            <ul className="space-y-2">
              {data.byPayment.map((p) => (
                <li key={p.payment_mode} className="flex items-baseline justify-between">
                  <span className="text-sm text-slate-600">
                    {p.payment_mode}
                    <span className="ml-1.5 text-xs text-slate-400">({p.bills})</span>
                  </span>
                  <span className="text-sm font-semibold tabular text-slate-900">
                    {rupees(p.total_paise)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.returnsToday.count > 0 && (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-amber-700">
              {data.returnsToday.count} {plural(data.returnsToday.count, 'return', 'returns')} refunded:
              {' '}{rupees(data.returnsToday.total_paise)}
            </p>
          )}
        </div>
      </div>

      {/* Attention */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <AttentionCard
          label="Out of stock" value={stock.outOfStock.products}
          hint="Active products with nothing saleable" to="/inventory?filter=out" tone="bad"
        />
        <AttentionCard
          label="Below reorder level" value={stock.lowStock.products}
          hint="Time to raise a purchase order" to="/inventory?filter=low" tone="warn"
        />
        <AttentionCard
          label="Expiring in 3 months" value={stock.expiring3.batches}
          hint={`${rupees(stock.expiring3.cost_paise)} at cost`} to="/inventory?filter=expiring" tone="warn"
        />
        <AttentionCard
          label="Expired batches" value={stock.expired.batches}
          hint={`${rupees(stock.expired.cost_paise)} to write off`} to="/inventory?filter=expired" tone="bad"
        />
      </div>
    </div>
  );
}

function AttentionCard({ label, value, hint, to, tone }: {
  label: string; value: number; hint: string; to: string; tone: 'warn' | 'bad';
}) {
  const colour = value === 0
    ? 'text-slate-400'
    : tone === 'bad' ? 'text-red-600' : 'text-amber-600';
  return (
    <Link to={to} className="card p-4 transition-shadow hover:shadow-md">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular ${colour}`}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-400">{hint}</p>
    </Link>
  );
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
