import { useEffect, useState, useCallback } from 'react';
import { api, type SessionUser } from '../lib/api';
import { rupees, formatDate, formatExpiry, todayIso } from '../lib/format';
import { Alert, Spinner, EmptyState, PageHeader, Tile } from '../components/ui';

type Tab = 'gst' | 'sales' | 'movement' | 'expiry' | 'reorder' | 'daybook';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'daybook', label: 'Day book' },
  { key: 'sales', label: 'Sales' },
  { key: 'gst', label: 'GST returns' },
  { key: 'movement', label: 'Product movement' },
  { key: 'expiry', label: 'Expiry pipeline' },
  { key: 'reorder', label: 'Reorder list' },
];

export default function Reports({ user }: { user: SessionUser }) {
  const [tab, setTab] = useState<Tab>('daybook');
  const monthStart = `${todayIso().slice(0, 7)}-01`;
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayIso());

  const needsRange = tab !== 'expiry' && tab !== 'reorder' && tab !== 'daybook';

  return (
    <div className="p-6">
      <PageHeader
        title="Reports"
        subtitle="Trading, tax and stock analysis"
        actions={<button className="btn-secondary no-print" onClick={() => window.print()}>Print</button>}
      />

      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'border-brand-500 bg-brand-50 text-brand-800'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}

        <div className="ml-auto flex items-end gap-2">
          {tab === 'daybook' && (
            <div>
              <label className="label" htmlFor="day">Date</label>
              <input id="day" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          )}
          {needsRange && (
            <>
              <div>
                <label className="label" htmlFor="from">From</label>
                <input id="from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="to">To</label>
                <input id="to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
        </div>
      </div>

      {tab === 'daybook' && <DayBook date={to} />}
      {tab === 'sales' && <SalesReport from={from} to={to} />}
      {tab === 'gst' && <GstReport from={from} to={to} />}
      {tab === 'movement' && <MovementReport from={from} to={to} />}
      {tab === 'expiry' && <ExpiryReport />}
      {tab === 'reorder' && <ReorderReport />}
      {user.role !== 'admin' && tab === 'gst' && (
        <p className="mt-3 text-xs text-slate-400">
          Figures are working papers for your accountant, not a filed return.
        </p>
      )}
    </div>
  );
}

function useReport<T>(url: string): { data: T | null; error: string; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.get<T>(url).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [url]);

  useEffect(load, [load]);
  return { data, error, loading };
}

function Frame({ loading, error, children }: {
  loading: boolean; error: string; children: React.ReactNode;
}) {
  if (loading) return <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>;
  if (error) return <Alert kind="error">{error}</Alert>;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------

function DayBook({ date }: { date: string }) {
  const { data, error, loading } = useReport<any>(`/reports/daybook?date=${date}`);

  return (
    <Frame loading={loading} error={error}>
      {data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Bills" value={data.bills.filter((b: any) => b.status === 'COMPLETED').length} />
            <Tile
              label="Collected"
              value={rupees(data.collections.reduce((s: number, c: any) => s + c.collected_paise, 0))}
            />
            <Tile label="Refunds" value={rupees(data.refunds.total_paise)}
              sub={`${data.refunds.count} credit notes`} tone={data.refunds.count > 0 ? 'warn' : 'default'} />
            <Tile label="On credit" value={rupees(data.credit.outstanding_paise)}
              sub={`${data.credit.bills} bills`} tone={data.credit.outstanding_paise > 0 ? 'warn' : 'default'} />
          </div>

          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Till reconciliation — {formatDate(date)}</h3>
            {data.collections.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">No collections on this date</p>
            ) : (
              <table className="w-full max-w-lg">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th">Mode</th>
                    <th className="th text-right">Bills</th>
                    <th className="th text-right">Billed</th>
                    <th className="th text-right">Collected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.collections.map((c: any) => (
                    <tr key={c.payment_mode}>
                      <td className="td font-medium">{c.payment_mode}</td>
                      <td className="td text-right tabular">{c.bills}</td>
                      <td className="td text-right tabular">{rupees(c.total_paise)}</td>
                      <td className="td text-right font-semibold tabular">{rupees(c.collected_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data.cancelled.count > 0 && (
              <p className="mt-3 text-xs text-amber-700">
                {data.cancelled.count} bill(s) cancelled on this date.
              </p>
            )}
          </div>
        </div>
      )}
    </Frame>
  );
}

function SalesReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useReport<any>(`/reports/sales?from=${from}&to=${to}`);

  return (
    <Frame loading={loading} error={error}>
      {data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Bills" value={data.summary.bills} />
            <Tile label="Taxable value" value={rupees(data.summary.taxable_paise)} />
            <Tile label="GST collected"
              value={rupees(data.summary.cgst_paise + data.summary.sgst_paise + data.summary.igst_paise)} />
            <Tile label="Total sales" value={rupees(data.summary.total_paise)} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="card p-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">Day by day</h3>
              {data.daily.length === 0 ? <EmptyState title="No sales in this period" icon="📈" /> : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="th">Date</th>
                      <th className="th text-right">Bills</th>
                      <th className="th text-right">Taxable</th>
                      <th className="th text-right">Tax</th>
                      <th className="th text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.daily.map((d: any) => (
                      <tr key={d.day}>
                        <td className="td whitespace-nowrap">{formatDate(d.day)}</td>
                        <td className="td text-right tabular">{d.bills}</td>
                        <td className="td text-right tabular">{rupees(d.taxable_paise)}</td>
                        <td className="td text-right tabular text-slate-500">{rupees(d.tax_paise)}</td>
                        <td className="td text-right font-medium tabular">{rupees(d.total_paise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card p-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">By staff member</h3>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th">Person</th>
                    <th className="th text-right">Bills</th>
                    <th className="th text-right">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.byUser.map((u: any) => (
                    <tr key={u.user_name}>
                      <td className="td">{u.user_name}</td>
                      <td className="td text-right tabular">{u.bills}</td>
                      <td className="td text-right font-medium tabular">{rupees(u.total_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Frame>
  );
}

function GstReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useReport<any>(`/reports/gst?from=${from}&to=${to}`);

  return (
    <Frame loading={loading} error={error}>
      {data && (
        <div className="space-y-5">
          <Alert kind="info">
            Working papers for GSTR-1 and GSTR-3B covering {formatDate(from)} to {formatDate(to)}.
            Credit notes are netted off the output tax. Have your accountant verify before filing.
          </Alert>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Output tax" value={rupees(data.liability.output_tax_paise)} />
            <Tile label="Less: credit notes" value={rupees(data.liability.credit_note_tax_paise)} />
            <Tile label="Input tax credit" value={rupees(data.liability.input_tax_credit_paise)} />
            <Tile
              label="Net payable"
              value={rupees(data.liability.net_payable_paise)}
              tone={data.liability.net_payable_paise > 0 ? 'warn' : 'good'}
              sub={data.liability.net_payable_paise <= 0 ? 'Credit carried forward' : undefined}
            />
          </div>

          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">
              Outward supplies — HSN summary (GSTR-1 Table 12)
            </h3>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="th">HSN</th>
                  <th className="th text-right">Rate</th>
                  <th className="th text-right">Qty</th>
                  <th className="th text-right">Taxable</th>
                  <th className="th text-right">CGST</th>
                  <th className="th text-right">SGST</th>
                  <th className="th text-right">IGST</th>
                  <th className="th text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.outward.map((r: any) => (
                  <tr key={`${r.hsn_code}-${r.gst_rate}`}>
                    <td className="td font-mono">{r.hsn_code}</td>
                    <td className="td text-right tabular">{r.gst_rate}%</td>
                    <td className="td text-right tabular">{r.qty_units}</td>
                    <td className="td text-right tabular">{rupees(r.taxable_paise)}</td>
                    <td className="td text-right tabular">{rupees(r.cgst_paise)}</td>
                    <td className="td text-right tabular">{rupees(r.sgst_paise)}</td>
                    <td className="td text-right tabular">{rupees(r.igst_paise)}</td>
                    <td className="td text-right font-semibold tabular">{rupees(r.total_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.b2b.length > 0 && (
            <div className="card p-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">
                B2B invoices (customer supplied a GSTIN)
              </h3>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th">Invoice</th>
                    <th className="th">Date</th>
                    <th className="th">Customer</th>
                    <th className="th">GSTIN</th>
                    <th className="th text-right">Taxable</th>
                    <th className="th text-right">Tax</th>
                    <th className="th text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.b2b.map((r: any) => (
                    <tr key={r.invoice_no}>
                      <td className="td font-mono text-xs">{r.invoice_no}</td>
                      <td className="td whitespace-nowrap">{formatDate(r.invoice_date)}</td>
                      <td className="td">{r.customer_name}</td>
                      <td className="td font-mono text-xs">{r.customer_gstin}</td>
                      <td className="td text-right tabular">{rupees(r.taxable_paise)}</td>
                      <td className="td text-right tabular">
                        {rupees(r.cgst_paise + r.sgst_paise + r.igst_paise)}
                      </td>
                      <td className="td text-right font-medium tabular">{rupees(r.total_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.inward.length > 0 && (
            <div className="card p-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">
                Inward supplies — input tax credit
              </h3>
              <table className="w-full max-w-2xl">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th text-right">Rate</th>
                    <th className="th text-right">Taxable</th>
                    <th className="th text-right">CGST</th>
                    <th className="th text-right">SGST</th>
                    <th className="th text-right">IGST</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.inward.map((r: any) => (
                    <tr key={r.gst_rate}>
                      <td className="td text-right tabular">{r.gst_rate}%</td>
                      <td className="td text-right tabular">{rupees(r.taxable_paise)}</td>
                      <td className="td text-right tabular">{rupees(r.cgst_paise)}</td>
                      <td className="td text-right tabular">{rupees(r.sgst_paise)}</td>
                      <td className="td text-right tabular">{rupees(r.igst_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Frame>
  );
}

function MovementReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useReport<any>(`/reports/product-movement?from=${from}&to=${to}&limit=40`);

  return (
    <Frame loading={loading} error={error}>
      {data && (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card p-5">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">Top sellers by value</h3>
            <p className="mb-3 text-xs text-slate-400">Keep these in stock — they pay the rent.</p>
            {data.top.length === 0 ? <EmptyState title="No sales in this period" icon="📊" /> : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th">Product</th>
                    <th className="th text-right">Qty</th>
                    <th className="th text-right">Revenue</th>
                    <th className="th text-right">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.top.map((p: any) => (
                    <tr key={p.product_id}>
                      <td className="td">
                        {p.product_name}
                        <span className="block text-xs text-slate-400">{p.manufacturer}</span>
                      </td>
                      <td className="td text-right tabular">{p.qty_units}</td>
                      <td className="td text-right tabular">{rupees(p.revenue_paise)}</td>
                      <td className={`td text-right tabular ${p.margin_paise > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {rupees(p.margin_paise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card p-5">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">Non-moving stock</h3>
            <p className="mb-3 text-xs text-slate-400">
              In stock but not sold once in this period — cash sitting on the shelf.
            </p>
            {data.nonMoving.length === 0 ? (
              <EmptyState title="Everything moved" icon="✅" hint="No dead stock in this period." />
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="th">Product</th>
                    <th className="th text-right">Stock</th>
                    <th className="th text-right">Tied-up cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.nonMoving.map((p: any) => (
                    <tr key={p.id}>
                      <td className="td">
                        {p.name}
                        <span className="block text-xs text-slate-400">{p.manufacturer}</span>
                      </td>
                      <td className="td text-right tabular">{p.stock_units} {p.unit}</td>
                      <td className="td text-right font-medium tabular text-amber-700">
                        {rupees(p.cost_paise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </Frame>
  );
}

function ExpiryReport() {
  const [months, setMonths] = useState(6);
  const { data, error, loading } = useReport<any>(`/reports/expiry?months=${months}`);

  return (
    <Frame loading={loading} error={error}>
      {data && (
        <div className="space-y-5">
          <div className="no-print flex items-center gap-2">
            <label className="text-sm text-slate-600" htmlFor="months">Look ahead</label>
            <select id="months" className="input w-32" value={months}
              onChange={(e) => setMonths(Number(e.target.value))}>
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </select>
          </div>

          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Expiry pipeline by month</h3>
            <table className="w-full max-w-3xl">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="th">Expiry month</th>
                  <th className="th text-right">Batches</th>
                  <th className="th text-right">Units</th>
                  <th className="th text-right">Cost at risk</th>
                  <th className="th text-right">MRP value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.buckets.map((b: any) => {
                  const expired = b.expiry < data.current_month;
                  return (
                    <tr key={b.expiry} className={expired ? 'bg-red-50' : ''}>
                      <td className={`td font-medium ${expired ? 'text-red-700' : ''}`}>
                        {formatExpiry(b.expiry)}
                        {expired && <span className="ml-2 chip border-red-200 bg-red-100 text-red-700">Expired</span>}
                      </td>
                      <td className="td text-right tabular">{b.batches}</td>
                      <td className="td text-right tabular">{b.qty_units}</td>
                      <td className="td text-right font-medium tabular text-amber-700">{rupees(b.cost_paise)}</td>
                      <td className="td text-right tabular text-slate-500">{rupees(b.mrp_paise)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card p-5">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">Batches to action</h3>
            <p className="mb-3 text-xs text-slate-400">
              Most distributors accept returns 3–6 months before expiry. Contact the supplier
              while the credit is still available.
            </p>
            <div className="max-h-[32rem] overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-slate-200">
                    <th className="th">Product</th>
                    <th className="th">Batch</th>
                    <th className="th">Expiry</th>
                    <th className="th text-right">Stock</th>
                    <th className="th text-right">Cost</th>
                    <th className="th">Rack</th>
                    <th className="th">Supplier</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.detail.map((d: any) => (
                    <tr key={d.id} className={d.status === 'EXPIRED' ? 'bg-red-50' : ''}>
                      <td className="td">
                        {d.product_name}
                        <span className="block text-xs text-slate-400">{d.manufacturer}</span>
                      </td>
                      <td className="td font-mono text-xs">{d.batch_no}</td>
                      <td className={`td ${d.status === 'EXPIRED' ? 'font-semibold text-red-600' : 'text-amber-600'}`}>
                        {formatExpiry(d.expiry)}
                      </td>
                      <td className="td text-right tabular">{d.qty_units}</td>
                      <td className="td text-right tabular">{rupees(d.cost_paise)}</td>
                      <td className="td text-xs text-slate-500">{d.rack || '—'}</td>
                      <td className="td text-xs text-slate-500">
                        {d.supplier_name ?? '—'}
                        {d.supplier_phone && <span className="block">{d.supplier_phone}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Frame>
  );
}

function ReorderReport() {
  const { data, error, loading } = useReport<any[]>('/inventory/reorder');

  return (
    <Frame loading={loading} error={error}>
      {data && (
        <div className="card p-5">
          <h3 className="mb-1 text-sm font-semibold text-slate-700">Products to reorder</h3>
          <p className="mb-3 text-xs text-slate-400">
            At or below reorder level. The 30-day sales column tells you how much to order.
          </p>
          {data.length === 0 ? (
            <EmptyState title="Nothing needs reordering" icon="✅"
              hint="Every product is above its reorder level." />
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="th">Product</th>
                  <th className="th text-right">In stock</th>
                  <th className="th text-right">Reorder at</th>
                  <th className="th text-right">Sold (30 days)</th>
                  <th className="th">Rack</th>
                  <th className="th">Usual supplier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.map((p) => (
                  <tr key={p.id}>
                    <td className="td">
                      {p.name}
                      <span className="block text-xs text-slate-400">
                        {p.generic_name} · {p.manufacturer}
                      </span>
                    </td>
                    <td className={`td text-right tabular ${p.stock_units === 0 ? 'font-semibold text-red-600' : 'text-amber-600'}`}>
                      {p.stock_units} {p.unit}
                    </td>
                    <td className="td text-right tabular text-slate-500">{p.reorder_level}</td>
                    <td className="td text-right tabular font-medium">{p.sold_30d}</td>
                    <td className="td text-xs text-slate-500">{p.rack || '—'}</td>
                    <td className="td text-xs text-slate-500">{p.last_supplier ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Frame>
  );
}
