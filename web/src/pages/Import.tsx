import { useRef, useState } from 'react';
import { api, downloadFile } from '../lib/api';
import { rupees, formatExpiry } from '../lib/format';
import { Alert, Spinner, PageHeader, Tile, EmptyState } from '../components/ui';

type Message = { level: 'error' | 'warning'; text: string };

type Row = {
  line: number;
  action: 'create' | 'update' | 'skip';
  product: {
    name: string; manufacturer: string; schedule_type: string;
    gst_rate: number; pack_size: number; unit: string;
  };
  stock: {
    batch_no: string; expiry: string; mrp_paise: number;
    qty_units: number; already_present: boolean;
  } | null;
  messages: Message[];
};

type Preview = {
  committed: boolean;
  headers: string[];
  rows: Row[];
  summary: {
    rows: number;
    products_new: number;
    products_updated: number;
    batches_new: number;
    batches_already_present: number;
    units: number;
    stock_value_paise: number;
    errors: number;
    warnings: number;
  };
  written?: { created: number; updated: number; batches: number; units: number };
};

const ACTION_STYLE: Record<Row['action'], string> = {
  create: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  update: 'border-sky-200 bg-sky-50 text-sky-700',
  skip: 'border-red-200 bg-red-50 text-red-700',
};

/**
 * How big the chosen file is, in words that always mean something.
 *
 * Rounding to whole kilobytes printed "0 KB" for a short file, which reads as
 * "nothing was loaded" at the exact moment the user is checking whether the
 * upload worked. The row count is what they actually want anyway.
 */
function describeSize(csv: string): string {
  const rows = csv.trim() ? csv.trim().split(/\r?\n/).length - 1 : 0;
  const bytes = new Blob([csv]).size;
  const size = bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
  return `${rows} row${rows === 1 ? '' : 's'}, ${size}`;
}

export default function ImportPage() {
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'commit'>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<Preview['written'] | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pickFile(file: File) {
    setError('');
    setPreview(null);
    setDone(null);
    setFilename(file.name);
    setCsv(await file.text());
  }

  async function run(commit: boolean) {
    setBusy(commit ? 'commit' : 'preview');
    setError('');
    try {
      const result = await api.post<Preview>('/import/products', { csv, commit });
      setPreview(result);
      if (result.committed) {
        setDone(result.written ?? null);
        setCsv('');
        setFilename('');
        if (fileRef.current) fileRef.current.value = '';
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy('');
    }
  }

  const summary = preview?.summary;
  const blocked = (summary?.errors ?? 0) > 0;
  const shown = preview
    ? onlyProblems ? preview.rows.filter((r) => r.messages.length > 0) : preview.rows
    : [];

  return (
    <div className="p-6">
      <PageHeader
        title="Import products & opening stock"
        subtitle="Load the whole catalogue from a spreadsheet instead of typing it in"
        actions={
          <button
            className="btn-secondary"
            onClick={() => void downloadFile('/import/products/template', 'product-import-template.csv')}
          >
            <span aria-hidden>⭳</span> Download template
          </button>
        }
      />

      {done && (
        <Alert kind="success" onDismiss={() => setDone(null)}>
          Imported {done.created} new product{done.created === 1 ? '' : 's'}, updated {done.updated},
          and took {done.units.toLocaleString('en-IN')} units into stock across {done.batches} batch
          {done.batches === 1 ? '' : 'es'}. Check the Stock screen.
        </Alert>
      )}

      <div className="card mb-4 p-4">
        <h2 className="mb-1 text-sm font-semibold text-slate-800">1. Prepare the file</h2>
        <p className="mb-3 text-sm text-slate-600">
          Any spreadsheet saved as CSV will do — your distributor's price list, or an export from
          the software you use now. Only <span className="font-mono text-xs">name</span> is
          required. Add <span className="font-mono text-xs">batch_no</span>,{' '}
          <span className="font-mono text-xs">expiry</span>,{' '}
          <span className="font-mono text-xs">mrp</span> and{' '}
          <span className="font-mono text-xs">qty_packs</span> to bring stock in at the same time.
          Column names are matched loosely, so <span className="font-mono text-xs">Pack Size</span>,{' '}
          <span className="font-mono text-xs">pack_size</span> and{' '}
          <span className="font-mono text-xs">PACKSIZE</span> are all understood.
        </p>

        <h2 className="mb-1 mt-4 text-sm font-semibold text-slate-800">2. Choose it</h2>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            id="csvfile"
            type="file"
            accept=".csv,text/csv,text/plain"
            className="text-sm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void pickFile(file);
            }}
          />
          {filename && (
            <span className="text-xs text-slate-500">
              {filename} — {describeSize(csv)}
            </span>
          )}
        </div>

        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
            …or paste the rows instead
          </summary>
          <textarea
            id="csvtext"
            className="input mt-2 h-32 font-mono text-xs"
            placeholder="name,manufacturer,pack_size,mrp,batch_no,expiry,qty_packs&#10;Dolo 650 Tablet,Micro Labs Ltd,15,34.50,DL24A17,2028-06,20"
            value={csv}
            onChange={(e) => { setCsv(e.target.value); setPreview(null); setDone(null); }}
          />
        </details>

        <div className="mt-4 flex items-center gap-2">
          <button
            className="btn-primary"
            disabled={!csv.trim() || busy !== ''}
            onClick={() => void run(false)}
          >
            {busy === 'preview' ? <Spinner /> : null} Check the file
          </button>
          <span className="text-xs text-slate-500">Nothing is saved until you confirm.</span>
        </div>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert>}

      {summary && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
            <Tile label="Rows read" value={String(summary.rows)} />
            <Tile label="New products" value={String(summary.products_new)} tone="good" />
            <Tile label="Existing updated" value={String(summary.products_updated)} />
            <Tile
              label="Stock to add"
              value={summary.units.toLocaleString('en-IN')}
              sub={`${summary.batches_new} batches`}
            />
            <Tile label="Value at cost" value={rupees(summary.stock_value_paise)} />
            <Tile
              label="Problems"
              value={String(summary.errors)}
              sub={summary.warnings ? `${summary.warnings} to check` : 'none'}
              tone={summary.errors ? 'bad' : 'good'}
            />
          </div>

          {blocked ? (
            <Alert kind="error">
              {summary.errors} problem{summary.errors === 1 ? '' : 's'} in this file. Nothing has
              been imported. Fix the rows marked below in your spreadsheet and choose the file
              again — the whole file is imported together, or not at all, so a half-loaded
              catalogue can never happen.
            </Alert>
          ) : preview?.committed ? null : (
            <div className="card mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="text-sm text-slate-700">
                Ready. This will create {summary.products_new} product
                {summary.products_new === 1 ? '' : 's'}, update {summary.products_updated}, and take{' '}
                {summary.units.toLocaleString('en-IN')} units into stock.
                {summary.batches_already_present > 0 && (
                  <> {summary.batches_already_present} batch
                    {summary.batches_already_present === 1 ? ' is' : 'es are'} already in stock and
                    will be left alone.</>
                )}
              </div>
              <button
                className="btn-primary"
                disabled={busy !== ''}
                onClick={() => void run(true)}
              >
                {busy === 'commit' ? <Spinner /> : null}{' '}
                Import {summary.rows} {summary.rows === 1 ? 'row' : 'rows'}
              </button>
            </div>
          )}

          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">Row by row</h2>
            {summary.errors + summary.warnings > 0 && (
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={onlyProblems}
                  onChange={(e) => setOnlyProblems(e.target.checked)}
                />
                Show only the {summary.errors + summary.warnings} rows needing attention
              </label>
            )}
          </div>

          <div className="card overflow-hidden">
            {shown.length === 0 ? (
              <EmptyState title="Nothing to show" icon="✅" />
            ) : (
              <div className="max-h-[32rem] overflow-auto">
                <table className="w-full">
                  <thead className="sticky top-0 border-b border-slate-200 bg-slate-50">
                    <tr>
                      <th className="th w-14">Line</th>
                      <th className="th w-20">Action</th>
                      <th className="th">Product</th>
                      <th className="th">Batch</th>
                      <th className="th text-right">MRP</th>
                      <th className="th text-right">Qty</th>
                      <th className="th">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shown.slice(0, 500).map((r) => (
                      <tr key={r.line} className={r.action === 'skip' ? 'bg-red-50/40' : ''}>
                        <td className="td tabular text-xs text-slate-500">{r.line}</td>
                        <td className="td">
                          <span className={`chip ${ACTION_STYLE[r.action]}`}>
                            {r.action === 'create' ? 'New' : r.action === 'update' ? 'Update' : 'Error'}
                          </span>
                        </td>
                        <td className="td">
                          <div className="font-medium text-slate-800">{r.product.name || '—'}</div>
                          <div className="text-xs text-slate-500">
                            {[r.product.manufacturer, r.product.schedule_type,
                              `${r.product.pack_size} ${r.product.unit}`,
                              `GST ${r.product.gst_rate}%`].filter(Boolean).join(' · ')}
                          </div>
                        </td>
                        <td className="td text-xs">
                          {r.stock ? (
                            <>
                              <span className="font-mono">{r.stock.batch_no || '—'}</span>
                              <div className="text-slate-500">{formatExpiry(r.stock.expiry)}</div>
                            </>
                          ) : <span className="text-slate-400">no stock</span>}
                        </td>
                        <td className="td tabular text-right text-xs">
                          {r.stock ? rupees(r.stock.mrp_paise) : ''}
                        </td>
                        <td className="td tabular text-right text-xs">
                          {r.stock ? r.stock.qty_units.toLocaleString('en-IN') : ''}
                        </td>
                        <td className="td">
                          {r.messages.length === 0 ? (
                            <span className="text-xs text-slate-300">—</span>
                          ) : (
                            <ul className="space-y-0.5">
                              {r.messages.map((m, i) => (
                                <li
                                  key={i}
                                  className={`text-xs ${
                                    m.level === 'error' ? 'text-red-700' : 'text-amber-700'
                                  }`}
                                >
                                  {m.level === 'error' ? '✕' : '⚠'} {m.text}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shown.length > 500 && (
                  <p className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
                    Showing the first 500 of {shown.length} rows. All {summary.rows} are checked and
                    will be imported.
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
