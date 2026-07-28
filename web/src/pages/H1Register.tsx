import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate, formatExpiry, todayIso, addMonths } from '../lib/format';
import { Alert, Spinner, EmptyState, PageHeader } from '../components/ui';

type Entry = {
  id: number; serial_no: number; supply_date: string; sale_id: number; invoice_no: string;
  prescriber_name: string; prescriber_address: string; prescriber_reg_no: string;
  patient_name: string; patient_address: string; drug_name: string; quantity: string;
  manufacturer: string; batch_no: string; expiry: string;
  pharmacist_name: string; pharmacist_reg_no: string;
};

export default function H1Register() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [retention, setRetention] = useState<{ oldest_entry: string | null; total_entries: number } | null>(null);
  const [from, setFrom] = useState(`${addMonths(todayIso().slice(0, 7), -1)}-01`);
  const [to, setTo] = useState(todayIso());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ from, to });
    if (query.trim()) params.set('q', query.trim());
    api.get<{ rows: Entry[]; retention: typeof retention }>(`/reports/h1-register?${params}`)
      .then((d) => { setRows(d.rows); setRetention(d.retention); })
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
        title="Schedule H1 Register"
        subtitle="Statutory record of every Schedule H1 and X supply"
        actions={<button className="btn-secondary no-print" onClick={() => window.print()}>Print register</button>}
      />

      <div className="no-print mb-4">
        <Alert kind="info">
          The Drugs &amp; Cosmetics Rules require a separate register recording, at the time of
          supply, the prescriber's name and address, the patient's name and address, the drug and
          quantity, the manufacturer, batch number and expiry, and the signature of the registered
          pharmacist. <strong>These records must be kept for three years</strong> and produced for
          inspection by the drug control authorities.
          {retention?.oldest_entry && (
            <> Oldest entry on file: <strong>{formatDate(retention.oldest_entry)}</strong>
              {' '}({retention.total_entries} entries in total).</>
          )}
        </Alert>
      </div>

      <div className="no-print mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="from">From</label>
          <input id="from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="to">To</label>
          <input id="to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="min-w-[18rem] flex-1">
          <label className="label" htmlFor="q">Search</label>
          <input id="q" className="input" placeholder="Drug, patient, prescriber or invoice…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <p className="pb-2 text-sm text-slate-500">
          <strong className="tabular">{rows.length}</strong> entries
        </p>
      </div>

      {error && <div className="mb-4"><Alert kind="error" onDismiss={() => setError('')}>{error}</Alert></div>}

      <div className="print-area card overflow-hidden">
        <div className="print-only border-b border-slate-800 px-4 py-2 text-center">
          <h2 className="text-sm font-bold uppercase tracking-widest">Schedule H1 Register</h2>
          <p className="text-xs">{formatDate(from)} to {formatDate(to)}</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-slate-400" /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="No Schedule H1 supplies in this period" icon="📕"
            hint="Entries appear automatically when an H1 or X medicine is billed." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-slate-300 bg-slate-50">
                <tr>
                  <th className="th !text-[10px]">S.No.</th>
                  <th className="th !text-[10px]">Date</th>
                  <th className="th !text-[10px]">Prescriber (name &amp; address)</th>
                  <th className="th !text-[10px]">Patient (name &amp; address)</th>
                  <th className="th !text-[10px]">Drug &amp; quantity</th>
                  <th className="th !text-[10px]">Manufacturer</th>
                  <th className="th !text-[10px]">Batch / Expiry</th>
                  <th className="th !text-[10px]">Pharmacist</th>
                  <th className="th !text-[10px] no-print">Invoice</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="td !text-xs tabular">{e.serial_no}</td>
                    <td className="td !text-xs whitespace-nowrap">{formatDate(e.supply_date)}</td>
                    <td className="td !text-xs">
                      <span className="font-medium">{e.prescriber_name || '—'}</span>
                      {e.prescriber_reg_no && (
                        <span className="block text-slate-400">Reg. {e.prescriber_reg_no}</span>
                      )}
                      <span className="block text-slate-500">{e.prescriber_address}</span>
                    </td>
                    <td className="td !text-xs">
                      <span className="font-medium">{e.patient_name}</span>
                      <span className="block text-slate-500">{e.patient_address}</span>
                    </td>
                    <td className="td !text-xs">
                      <span className="font-medium">{e.drug_name}</span>
                      <span className="block text-slate-500">{e.quantity}</span>
                    </td>
                    <td className="td !text-xs text-slate-600">{e.manufacturer}</td>
                    <td className="td !text-xs">
                      <span className="font-mono">{e.batch_no}</span>
                      <span className="block text-slate-500">{formatExpiry(e.expiry)}</span>
                    </td>
                    <td className="td !text-xs">
                      {e.pharmacist_name}
                      {e.pharmacist_reg_no && (
                        <span className="block text-slate-400">{e.pharmacist_reg_no}</span>
                      )}
                    </td>
                    <td className="td !text-xs no-print">
                      <Link to={`/invoices/${e.sale_id}`} className="font-mono text-brand-700 hover:underline">
                        {e.invoice_no}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
