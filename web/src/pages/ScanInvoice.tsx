import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiUrl, getToken, ApiError } from '../lib/api';
import { Alert, Spinner, PageHeader } from '../components/ui';

type ReviewLine = {
  line_no: number;
  raw: string;
  product_name: string;
  product_id: number | null;
  matched_name: string;
  match: 'exact' | 'likely' | 'none';
  pack_size: number | null;
  batch_no: string;
  expiry: string;
  qty_packs: number | null;
  free_packs: number | null;
  mrp_paise: number | null;
  purchase_rate_paise: number | null;
  gst_rate: number | null;
  confidence: number;
  field_confidence: Record<string, number>;
  warnings: string[];
};

type Scan = {
  scan_id: string;
  source: 'pdf-text' | 'ocr';
  attempt: string;
  confidence: number;
  took_ms: number;
  supplier_id: number | null;
  supplier_name: string;
  supplier_gstin: string;
  invoice_no: string;
  invoice_date: string;
  lines: ReviewLine[];
  skipped: string[];
};

type Product = { id: number; name: string; pack_size: number; gst_rate: number };
type Supplier = { id: number; name: string };

const rupees = (paise: number | null) => (paise === null ? '' : (paise / 100).toFixed(2));
const toPaise = (s: string) => {
  const n = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && s.trim() !== '' ? Math.round(n * 100) : null;
};

/** Below this the engine was guessing, and the reviewer should look. */
const SHAKY = 70;

export default function ScanInvoice() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [busy, setBusy] = useState<'read' | 'commit' | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<{ data: Product[] } | Product[]>('/products?limit=1000')
      .then((r) => setProducts(Array.isArray(r) ? r : r.data)).catch(() => undefined);
    api.get<Supplier[]>('/suppliers').then(setSuppliers).catch(() => undefined);
  }, []);

  async function upload(file: File) {
    setBusy('read');
    setError('');
    setScan(null);
    setLines([]);
    setChecked(new Set());
    try {
      const res = await fetch(apiUrl('/invoice-scan'), {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          Authorization: `Bearer ${getToken()}`,
        },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new ApiError(res.status, body.error ?? 'That file could not be read');

      const s = body as Scan;
      setScan(s);
      setLines(s.lines);
      setSupplierId(s.supplier_id);
      setInvoiceNo(s.invoice_no);
      setInvoiceDate(s.invoice_date || new Date().toISOString().slice(0, 10));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be read');
    } finally {
      setBusy(null);
    }
  }

  function edit(i: number, patch: Partial<ReviewLine>) {
    setLines((prev) => prev.map((l, n) => (n === i ? { ...l, ...patch } : l)));
    // Touching a line means it has been looked at, which is the whole point of
    // the exercise — so the confirmation follows the correction automatically.
    setChecked((prev) => new Set(prev).add(i));
  }

  function drop(i: number) {
    setLines((prev) => prev.filter((_, n) => n !== i));
    setChecked(new Set());
  }

  /** Everything that would stop this being recorded. */
  const problems = useMemo(() => {
    const out: string[] = [];
    if (!supplierId) out.push('Choose the distributor this invoice came from.');
    if (!invoiceNo.trim()) out.push('The distributor\'s invoice number is needed.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) out.push('The invoice date is needed.');
    if (lines.length === 0) out.push('There are no lines to record.');

    lines.forEach((l, i) => {
      const at = `Line ${i + 1}`;
      if (!l.product_id) out.push(`${at}: pick which product "${l.product_name}" is.`);
      if (!l.batch_no.trim()) out.push(`${at}: a batch number is required.`);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(l.expiry)) out.push(`${at}: expiry must be YYYY-MM.`);
      if (!l.qty_packs || l.qty_packs < 1) out.push(`${at}: quantity is required.`);
      if (!l.mrp_paise) out.push(`${at}: MRP is required.`);
      if (!checked.has(i)) out.push(`${at}: confirm the batch and expiry against the invoice.`);
    });
    return out;
  }, [lines, supplierId, invoiceNo, invoiceDate, checked]);

  async function commit() {
    if (!scan) return;
    setBusy('commit');
    setError('');
    try {
      const purchase = await api.post<{ id: number }>('/purchases', {
        supplier_id: supplierId,
        invoice_no: invoiceNo.trim(),
        invoice_date: invoiceDate,
        scan_id: scan.scan_id,
        items: lines.map((l) => ({
          product_id: l.product_id,
          batch_no: l.batch_no.trim(),
          expiry: l.expiry,
          qty_packs: l.qty_packs,
          free_packs: l.free_packs ?? 0,
          purchase_rate_paise: l.purchase_rate_paise ?? 0,
          mrp_paise: l.mrp_paise,
        })),
      });
      navigate(`/purchases?highlight=${purchase.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the purchase');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Read an invoice"
        subtitle="Photograph or upload a distributor's bill instead of typing it in"
      />

      {error && <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert>}

      {!scan && (
        <div className="card mt-4 max-w-3xl p-5">
          <h3 className="text-sm font-semibold text-slate-800">Choose the invoice</h3>
          <p className="mt-1 text-xs text-slate-500">
            A PDF from your distributor's software reads exactly, because the text is already
            in the file. A photograph is read by eye and needs checking — lay the page flat,
            fill the frame, and take it straight on in good light.
          </p>

          <input
            ref={fileRef}
            id="scanfile"
            type="file"
            accept="image/*,application/pdf"
            className="mt-4 text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />

          {busy === 'read' && (
            <p className="mt-4 flex items-center gap-2 text-sm text-slate-600">
              <Spinner className="h-4 w-4" /> Reading the invoice…
            </p>
          )}

          <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-400">
            Nothing is added to stock until you have checked it, line by line.
          </p>
        </div>
      )}

      {scan && (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
          <div className="min-w-0 space-y-4">
            <div className="card p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className={`chip ${scan.source === 'pdf-text'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-amber-200 bg-amber-50 text-amber-700'}`}
                >
                  {scan.source === 'pdf-text' ? 'Read exactly from the PDF' : 'Read from a picture'}
                </span>
                <span className="text-xs text-slate-500">
                  {lines.length} line{lines.length === 1 ? '' : 's'} · {(scan.took_ms / 1000).toFixed(1)}s
                  {scan.source === 'ocr' && ` · ${scan.confidence}% confidence`}
                </span>
                <button className="btn-ghost ml-auto !text-xs" onClick={() => { setScan(null); setLines([]); }}>
                  Start again
                </button>
              </div>

              {scan.source === 'ocr' && (
                <Alert kind="warning">
                  This was read from a picture, so treat every figure as a suggestion. Batch numbers
                  and expiry dates are the ones worth your attention — a misread expiry would put
                  expired stock at the front of the queue.
                </Alert>
              )}

              <div className="mt-3 grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Distributor</label>
                  <select
                    id="supplier" className="input" value={supplierId ?? ''}
                    onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">Choose…</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {scan.supplier_name && (
                    <p className="mt-1 truncate text-xs text-slate-400">Read: {scan.supplier_name}</p>
                  )}
                </div>
                <div>
                  <label className="label">Invoice number</label>
                  <input id="invno" className="input font-mono" value={invoiceNo}
                    onChange={(e) => setInvoiceNo(e.target.value)} />
                </div>
                <div>
                  <label className="label">Invoice date</label>
                  <input id="invdate" type="date" className="input" value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
                <h3 className="text-sm font-semibold text-slate-800">Line by line</h3>
                <span className="text-xs text-slate-500">
                  {checked.size} of {lines.length} checked
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2">✓</th>
                      <th className="px-3 py-2">Product</th>
                      <th className="px-3 py-2">Batch</th>
                      <th className="px-3 py-2">Expiry</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Free</th>
                      <th className="px-3 py-2 text-right">MRP</th>
                      <th className="px-3 py-2 text-right">Rate</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} className={`border-b border-slate-50 align-top ${
                        checked.has(i) ? '' : 'bg-amber-50/40'
                      }`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Line ${i + 1} checked`}
                            checked={checked.has(i)}
                            onChange={(e) => setChecked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(i); else next.delete(i);
                              return next;
                            })}
                          />
                        </td>

                        <td className="min-w-56 px-3 py-2">
                          <select
                            className={`input !py-1 !text-xs ${l.product_id ? '' : '!border-red-300'}`}
                            value={l.product_id ?? ''}
                            onChange={(e) => edit(i, {
                              product_id: e.target.value ? Number(e.target.value) : null,
                            })}
                          >
                            <option value="">— which product? —</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                          <p className="mt-1 text-xs text-slate-400">
                            Read: <span className="font-mono">{l.product_name}</span>
                            {l.match === 'likely' && <span className="ml-1 text-amber-600">· matched by name</span>}
                          </p>
                        </td>

                        <td className="px-3 py-2">
                          <input
                            className={`input !w-28 !py-1 font-mono !text-xs ${
                              (l.field_confidence.batch_no ?? 100) < SHAKY ? '!border-amber-400 !bg-amber-50' : ''
                            }`}
                            value={l.batch_no}
                            onChange={(e) => edit(i, { batch_no: e.target.value.toUpperCase() })}
                          />
                        </td>

                        <td className="px-3 py-2">
                          <input
                            className={`input !w-24 !py-1 font-mono !text-xs ${
                              /^\d{4}-(0[1-9]|1[0-2])$/.test(l.expiry) ? '' : '!border-red-300'
                            }`}
                            placeholder="YYYY-MM"
                            value={l.expiry}
                            onChange={(e) => edit(i, { expiry: e.target.value })}
                          />
                        </td>

                        <td className="px-3 py-2 text-right">
                          <input
                            className="input !w-16 !py-1 !text-right !text-xs"
                            value={l.qty_packs ?? ''}
                            onChange={(e) => edit(i, { qty_packs: Number(e.target.value) || null })}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            className="input !w-14 !py-1 !text-right !text-xs"
                            value={l.free_packs ?? 0}
                            onChange={(e) => edit(i, { free_packs: Number(e.target.value) || 0 })}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            className="input !w-20 !py-1 !text-right !text-xs"
                            value={rupees(l.mrp_paise)}
                            onChange={(e) => edit(i, { mrp_paise: toPaise(e.target.value) })}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            className="input !w-20 !py-1 !text-right !text-xs"
                            value={rupees(l.purchase_rate_paise)}
                            onChange={(e) => edit(i, { purchase_rate_paise: toPaise(e.target.value) })}
                          />
                        </td>

                        <td className="px-3 py-2">
                          <button
                            className="text-xs text-slate-400 hover:text-red-600"
                            title="Not on this invoice"
                            onClick={() => drop(i)}
                          >
                            ✕
                          </button>
                          {l.warnings.length > 0 && (
                            <p className="mt-1 max-w-48 text-xs text-amber-700">{l.warnings[0]}</p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {scan.skipped.length > 0 && (
                <details className="border-t border-slate-100 px-4 py-2">
                  <summary className="cursor-pointer text-xs text-slate-500">
                    {scan.skipped.length} row{scan.skipped.length === 1 ? '' : 's'} on the page
                    were not read as stock — check nothing is missing
                  </summary>
                  <ul className="mt-2 space-y-0.5 font-mono text-xs text-slate-400">
                    {scan.skipped.slice(0, 20).map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </details>
              )}
            </div>

            <div className="card p-4">
              {problems.length > 0 ? (
                <>
                  <p className="text-sm font-medium text-slate-800">
                    {problems.length} thing{problems.length === 1 ? '' : 's'} to settle before this
                    goes into stock
                  </p>
                  <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs text-amber-700">
                    {problems.slice(0, 12).map((p, i) => <li key={i}>• {p}</li>)}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-emerald-700">
                  Every line has been checked against the invoice.
                </p>
              )}
              <button
                className="btn-primary mt-3"
                disabled={problems.length > 0 || busy === 'commit'}
                onClick={() => void commit()}
              >
                {busy === 'commit' ? <Spinner /> : null} Add {lines.length} line
                {lines.length === 1 ? '' : 's'} to stock
              </button>
            </div>
          </div>

          {/* The original, kept beside the figures. Reviewing numbers against a
              picture you cannot see is not reviewing. */}
          <div className="xl:sticky xl:top-4 xl:self-start">
            <div
              className="card overflow-hidden"
              data-testid="scan-original"
              data-scan-file={apiUrl(`/invoice-scan/${scan.scan_id}/file`)}
            >
              <div className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-800">
                The invoice as supplied
              </div>
              {scan.source === 'pdf-text' ? (
                <object
                  data={apiUrl(`/invoice-scan/${scan.scan_id}/file`)}
                  type="application/pdf"
                  className="h-[70vh] w-full"
                >
                  <p className="p-4 text-sm text-slate-500">
                    <a className="underline" href={apiUrl(`/invoice-scan/${scan.scan_id}/file`)}>
                      Open the PDF
                    </a>
                  </p>
                </object>
              ) : (
                <img
                  src={apiUrl(`/invoice-scan/${scan.scan_id}/file`)}
                  alt="The uploaded invoice"
                  className="max-h-[70vh] w-full object-contain"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
