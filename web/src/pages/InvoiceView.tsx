import { useEffect, useState, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api, type SessionUser } from '../lib/api';
import { rupees, formatExpiry, formatDate, formatDateTime } from '../lib/format';
import { Alert, Spinner, Modal } from '../components/ui';

type Item = {
  id: number; product_name: string; manufacturer: string; hsn_code: string;
  schedule_type: string; batch_no: string; expiry: string; pack_size: number;
  qty_units: number; mrp_paise: number; rate_paise: number; gross_paise: number;
  discount_pct: number; discount_paise: number; taxable_paise: number; gst_rate: number;
  cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number;
  returned_units: number;
};

type Sale = {
  id: number; invoice_no: string; invoice_date: string; customer_name: string;
  customer_phone: string; customer_gstin: string; prescription_no: string;
  patient_name: string; patient_address: string; place_of_supply: string;
  is_interstate: number; gross_paise: number; discount_paise: number; taxable_paise: number;
  cgst_paise: number; sgst_paise: number; igst_paise: number; round_off_paise: number;
  total_paise: number; payment_mode: string; payment_ref: string; status: string;
  cancel_reason: string; pharmacist_name: string; served_by_name: string;
  doctor_name: string | null; doctor_qualification: string | null; doctor_reg_no: string | null;
  items: Item[];
  returns: Array<{ id: number; return_no: string; return_date: string; total_paise: number; reason: string }>;
  settings: Settings;
};

type Settings = {
  shop_name: string; legal_name: string; address_line1: string; address_line2: string;
  city: string; state: string; state_code: string; pincode: string; phone: string;
  email: string; gstin: string; dl_no_form20: string; dl_no_form21: string;
  fssai_no: string; pharmacist_name: string; pharmacist_reg_no: string;
  invoice_footer: string;
};

export default function InvoiceView({ user }: { user: SessionUser }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [sale, setSale] = useState<Sale | null>(null);
  const [error, setError] = useState('');
  const [showReturn, setShowReturn] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  useEffect(() => {
    api.get<Sale>(`/sales/${id}`).then(setSale).catch((e) => setError(e.message));
  }, [id]);

  // Auto-print when arriving straight from the billing screen.
  useEffect(() => {
    if (sale && params.get('print') === '1') {
      const timer = setTimeout(() => window.print(), 350);
      return () => clearTimeout(timer);
    }
  }, [sale, params]);

  const hsnSummary = useMemo(() => {
    if (!sale) return [];
    const map = new Map<string, {
      hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number;
    }>();
    for (const it of sale.items) {
      const key = `${it.hsn_code}-${it.gst_rate}`;
      const row = map.get(key) ?? {
        hsn: it.hsn_code, rate: it.gst_rate, taxable: 0, cgst: 0, sgst: 0, igst: 0,
      };
      row.taxable += it.taxable_paise;
      row.cgst += it.cgst_paise;
      row.sgst += it.sgst_paise;
      row.igst += it.igst_paise;
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => a.rate - b.rate);
  }, [sale]);

  if (error) {
    return <div className="p-6"><Alert kind="error">{error}</Alert></div>;
  }
  if (!sale) {
    return <div className="flex h-screen items-center justify-center"><Spinner className="h-6 w-6 text-slate-400" /></div>;
  }

  const s = sale.settings;
  const cancelled = sale.status === 'CANCELLED';
  const canManage = user.role === 'admin' || user.role === 'pharmacist';
  const returnedTotal = sale.returns.reduce((sum, r) => sum + r.total_paise, 0);
  const fullyReturned = sale.items.every((i) => i.returned_units >= i.qty_units);

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Toolbar */}
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-5 py-3">
        <button onClick={() => navigate(-1)} className="btn-ghost">← Back</button>
        <div className="flex-1" />
        {cancelled && <span className="chip border-red-200 bg-red-100 text-red-700">Cancelled</span>}
        {!cancelled && returnedTotal > 0 && (
          <span className="chip border-amber-200 bg-amber-100 text-amber-800">
            {fullyReturned ? 'Fully returned' : 'Partly returned'}
          </span>
        )}
        <Link to="/billing" className="btn-secondary">New bill</Link>
        {canManage && !cancelled && !fullyReturned && (
          <button onClick={() => setShowReturn(true)} className="btn-secondary">Return items</button>
        )}
        {canManage && !cancelled && sale.returns.length === 0 && (
          <button onClick={() => setShowCancel(true)} className="btn-secondary !text-red-600">Cancel bill</button>
        )}
        <button onClick={() => window.print()} className="btn-primary">Print</button>
      </div>

      {/* ------------------------------ Invoice ------------------------------ */}
      <div className="print-area mx-auto my-6 max-w-4xl bg-white p-8 shadow-sm print:my-0 print:max-w-none print:shadow-none">
        {cancelled && (
          <div className="mb-4 rounded border-2 border-red-500 px-4 py-2 text-center">
            <p className="text-lg font-bold uppercase tracking-widest text-red-600">Cancelled</p>
            {sale.cancel_reason && <p className="text-xs text-red-500">{sale.cancel_reason}</p>}
          </div>
        )}

        {/* Header */}
        <div className="border-b-2 border-slate-800 pb-3">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <h1 className="text-xl font-bold uppercase tracking-tight text-slate-900">{s.shop_name}</h1>
              <p className="text-xs leading-relaxed text-slate-600">
                {s.address_line1}{s.address_line2 && <>, {s.address_line2}</>}<br />
                {s.city} — {s.pincode}, {s.state}<br />
                Ph: {s.phone}{s.email && <> · {s.email}</>}
              </p>
            </div>
            <div className="shrink-0 text-right text-xs text-slate-700">
              <p><span className="font-semibold">GSTIN:</span> {s.gstin}</p>
              <p><span className="font-semibold">D.L. No.:</span> {s.dl_no_form20}</p>
              <p className="pl-[4.4rem]">{s.dl_no_form21}</p>
              {s.fssai_no && <p><span className="font-semibold">FSSAI:</span> {s.fssai_no}</p>}
            </div>
          </div>
          <p className="mt-2 text-center text-sm font-bold uppercase tracking-widest text-slate-800">
            Tax Invoice
          </p>
        </div>

        {/* Parties */}
        <div className="grid grid-cols-2 gap-6 border-b border-slate-300 py-3 text-xs">
          <div>
            <p className="mb-1 font-semibold uppercase tracking-wide text-slate-500">Billed to</p>
            <p className="text-sm font-semibold text-slate-900">{sale.customer_name}</p>
            {sale.customer_phone && <p className="text-slate-600">Ph: {sale.customer_phone}</p>}
            {sale.customer_gstin && <p className="text-slate-600">GSTIN: {sale.customer_gstin}</p>}
            <p className="text-slate-600">
              Place of supply: {sale.place_of_supply} — {sale.is_interstate ? 'Inter-state' : 'Intra-state'}
            </p>
            {sale.doctor_name && (
              <p className="mt-1 text-slate-600">
                <span className="font-semibold">Prescriber:</span> {sale.doctor_name}
                {sale.doctor_qualification && `, ${sale.doctor_qualification}`}
                {sale.doctor_reg_no && ` (Reg. ${sale.doctor_reg_no})`}
              </p>
            )}
            {sale.patient_name && (
              <p className="text-slate-600"><span className="font-semibold">Patient:</span> {sale.patient_name}</p>
            )}
          </div>
          <div className="text-right">
            <table className="ml-auto text-xs">
              <tbody>
                <tr>
                  <td className="pr-3 text-slate-500">Invoice No.</td>
                  <td className="font-mono font-semibold text-slate-900">{sale.invoice_no}</td>
                </tr>
                <tr>
                  <td className="pr-3 text-slate-500">Date</td>
                  <td className="text-slate-800">{formatDateTime(sale.invoice_date)}</td>
                </tr>
                {sale.prescription_no && (
                  <tr>
                    <td className="pr-3 text-slate-500">Rx No.</td>
                    <td className="text-slate-800">{sale.prescription_no}</td>
                  </tr>
                )}
                <tr>
                  <td className="pr-3 text-slate-500">Payment</td>
                  <td className="text-slate-800">
                    {sale.payment_mode}{sale.payment_ref && ` · ${sale.payment_ref}`}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Lines — batch no. and expiry are statutory on every line */}
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              <th className="px-1 py-1.5 text-left font-semibold">#</th>
              <th className="px-1 py-1.5 text-left font-semibold">Particulars</th>
              <th className="px-1 py-1.5 text-left font-semibold">HSN</th>
              <th className="px-1 py-1.5 text-left font-semibold">Batch</th>
              <th className="px-1 py-1.5 text-left font-semibold">Exp.</th>
              <th className="px-1 py-1.5 text-right font-semibold">Qty</th>
              <th className="px-1 py-1.5 text-right font-semibold">MRP</th>
              <th className="px-1 py-1.5 text-right font-semibold">Rate</th>
              <th className="px-1 py-1.5 text-right font-semibold">Disc</th>
              <th className="px-1 py-1.5 text-right font-semibold">GST%</th>
              <th className="px-1 py-1.5 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((it, i) => (
              <tr key={it.id} className="border-b border-slate-100">
                <td className="px-1 py-1.5 text-slate-500">{i + 1}</td>
                <td className="px-1 py-1.5">
                  <span className="font-medium text-slate-900">{it.product_name}</span>
                  {it.schedule_type !== 'OTC' && (
                    <span className="ml-1 rounded bg-slate-200 px-1 text-[9px] font-bold">
                      {it.schedule_type}
                    </span>
                  )}
                  <span className="block text-[10px] text-slate-500">{it.manufacturer}</span>
                  {it.returned_units > 0 && (
                    <span className="block text-[10px] font-medium text-amber-600">
                      {it.returned_units} returned
                    </span>
                  )}
                </td>
                <td className="px-1 py-1.5 text-slate-600">{it.hsn_code}</td>
                <td className="px-1 py-1.5 font-mono text-slate-700">{it.batch_no}</td>
                <td className="px-1 py-1.5 text-slate-700">{formatExpiry(it.expiry)}</td>
                <td className="px-1 py-1.5 text-right tabular">{it.qty_units}</td>
                <td className="px-1 py-1.5 text-right tabular text-slate-600">
                  {rupees(it.mrp_paise)}
                </td>
                <td className="px-1 py-1.5 text-right tabular">{rupees(it.rate_paise)}</td>
                <td className="px-1 py-1.5 text-right tabular text-slate-600">
                  {it.discount_paise > 0 ? rupees(it.discount_paise) : '—'}
                </td>
                <td className="px-1 py-1.5 text-right tabular text-slate-600">{it.gst_rate}%</td>
                <td className="px-1 py-1.5 text-right font-semibold tabular">
                  {rupees(it.total_paise)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Tax summary + totals */}
        <div className="mt-4 grid grid-cols-2 gap-6">
          <div>
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-slate-300 bg-slate-50">
                  <th className="px-1 py-1 text-left font-semibold">HSN</th>
                  <th className="px-1 py-1 text-right font-semibold">Taxable</th>
                  {sale.is_interstate ? (
                    <th className="px-1 py-1 text-right font-semibold">IGST</th>
                  ) : (
                    <>
                      <th className="px-1 py-1 text-right font-semibold">CGST</th>
                      <th className="px-1 py-1 text-right font-semibold">SGST</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {hsnSummary.map((r) => (
                  <tr key={`${r.hsn}-${r.rate}`} className="border-b border-slate-100">
                    <td className="px-1 py-1">{r.hsn} @ {r.rate}%</td>
                    <td className="px-1 py-1 text-right tabular">{rupees(r.taxable)}</td>
                    {sale.is_interstate ? (
                      <td className="px-1 py-1 text-right tabular">{rupees(r.igst)}</td>
                    ) : (
                      <>
                        <td className="px-1 py-1 text-right tabular">{rupees(r.cgst)}</td>
                        <td className="px-1 py-1 text-right tabular">{rupees(r.sgst)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
              <span className="font-semibold">Amount in words:</span> {amountInWords(sale.total_paise)}
            </p>
          </div>

          <div>
            <table className="ml-auto w-full max-w-xs text-xs">
              <tbody>
                <tr>
                  <td className="py-0.5 text-slate-600">Gross value</td>
                  <td className="py-0.5 text-right tabular">{rupees(sale.gross_paise)}</td>
                </tr>
                {sale.discount_paise > 0 && (
                  <tr>
                    <td className="py-0.5 text-slate-600">Less: discount</td>
                    <td className="py-0.5 text-right tabular">− {rupees(sale.discount_paise)}</td>
                  </tr>
                )}
                <tr>
                  <td className="py-0.5 text-slate-600">Taxable value</td>
                  <td className="py-0.5 text-right tabular">{rupees(sale.taxable_paise)}</td>
                </tr>
                {sale.is_interstate ? (
                  <tr>
                    <td className="py-0.5 text-slate-600">IGST</td>
                    <td className="py-0.5 text-right tabular">{rupees(sale.igst_paise)}</td>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <td className="py-0.5 text-slate-600">CGST</td>
                      <td className="py-0.5 text-right tabular">{rupees(sale.cgst_paise)}</td>
                    </tr>
                    <tr>
                      <td className="py-0.5 text-slate-600">SGST</td>
                      <td className="py-0.5 text-right tabular">{rupees(sale.sgst_paise)}</td>
                    </tr>
                  </>
                )}
                {sale.round_off_paise !== 0 && (
                  <tr>
                    <td className="py-0.5 text-slate-600">Round off</td>
                    <td className="py-0.5 text-right tabular">{rupees(sale.round_off_paise)}</td>
                  </tr>
                )}
                <tr className="border-t-2 border-slate-800">
                  <td className="py-1.5 text-sm font-bold">Total payable</td>
                  <td className="py-1.5 text-right text-base font-bold tabular">
                    {rupees(sale.total_paise)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-end justify-between gap-6 border-t border-slate-300 pt-3">
          <div className="max-w-md text-[10px] leading-relaxed text-slate-600">
            {s.invoice_footer && <p>{s.invoice_footer}</p>}
            <p className="mt-1">
              Prescription-only medicines dispensed against a valid prescription.
              Schedule H1 supplies are recorded in the statutory register.
            </p>
            <p className="mt-1 text-slate-400">Billed by {sale.served_by_name}</p>
          </div>
          <div className="shrink-0 text-center text-[10px]">
            <div className="h-10" />
            <p className="border-t border-slate-400 px-6 pt-1 font-semibold text-slate-700">
              {sale.pharmacist_name || s.pharmacist_name}
            </p>
            <p className="text-slate-500">Registered Pharmacist</p>
            {s.pharmacist_reg_no && <p className="text-slate-500">Reg. {s.pharmacist_reg_no}</p>}
          </div>
        </div>

        {sale.returns.length > 0 && (
          <div className="no-print mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-900">Credit notes against this invoice</p>
            <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
              {sale.returns.map((r) => (
                <li key={r.id}>
                  {r.return_no} · {formatDate(r.return_date)} · {rupees(r.total_paise)} · {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <ReturnModal
        open={showReturn} onClose={() => setShowReturn(false)} sale={sale}
        onDone={() => { setShowReturn(false); api.get<Sale>(`/sales/${id}`).then(setSale); }}
      />
      <CancelModal
        open={showCancel} onClose={() => setShowCancel(false)} saleId={sale.id}
        onDone={() => { setShowCancel(false); api.get<Sale>(`/sales/${id}`).then(setSale); }}
      />
    </div>
  );
}

function ReturnModal({ open, onClose, sale, onDone }: {
  open: boolean; onClose: () => void; sale: Sale; onDone: () => void;
}) {
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) { setQty({}); setReason(''); setRestock(true); setError(''); }
  }, [open]);

  const selected = Object.entries(qty).filter(([, q]) => q > 0);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post('/returns', {
        sale_id: sale.id, reason, restock,
        items: selected.map(([itemId, q]) => ({ sale_item_id: Number(itemId), qty_units: q })),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not process the return');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Return items — ${sale.invoice_no}`} width="max-w-2xl">
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="th">Item</th>
              <th className="th">Batch</th>
              <th className="th text-right">Billed</th>
              <th className="th text-right">Returnable</th>
              <th className="th text-right">Return qty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sale.items.map((it) => {
              const returnable = it.qty_units - it.returned_units;
              return (
                <tr key={it.id}>
                  <td className="td">{it.product_name}</td>
                  <td className="td font-mono text-xs">
                    {it.batch_no}
                    <span className="block text-slate-400">{formatExpiry(it.expiry)}</span>
                  </td>
                  <td className="td text-right tabular">{it.qty_units}</td>
                  <td className="td text-right tabular">{returnable}</td>
                  <td className="td text-right">
                    <input
                      type="number" min={0} max={returnable} disabled={returnable === 0}
                      className="input w-20 py-1 text-right tabular"
                      value={qty[it.id] ?? 0}
                      onChange={(e) => setQty((prev) => ({
                        ...prev,
                        [it.id]: Math.min(returnable, Math.max(0, Number(e.target.value) || 0)),
                      }))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div>
          <label className="label" htmlFor="ret-reason">Reason for return</label>
          <input
            id="ret-reason" className="input" value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Wrong medicine dispensed, patient reaction, doctor changed prescription"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
          Goods are saleable — return them to stock
        </label>
        {!restock && (
          <p className="text-xs text-amber-700">
            The refund is issued but the stock is written off. Use this when the strip is opened,
            damaged or has been out of the shop's temperature control.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary" disabled={selected.length === 0 || !reason.trim() || busy}
            onClick={() => void submit()}
          >
            {busy && <Spinner />} Issue credit note
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CancelModal({ open, onClose, saleId, onDone }: {
  open: boolean; onClose: () => void; saleId: number; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/sales/${saleId}/cancel`, { reason });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the bill');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Cancel this bill">
      <div className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}
        <Alert kind="warning">
          All dispensed stock returns to its original batch. The invoice number is retained and
          the bill is marked cancelled — it is never deleted.
        </Alert>
        <div>
          <label className="label" htmlFor="cancel-reason">Reason</label>
          <input
            id="cancel-reason" className="input" value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Billed in error, customer walked away"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Keep bill</button>
          <button className="btn-danger" disabled={!reason.trim() || busy} onClick={() => void submit()}>
            {busy && <Spinner />} Cancel bill
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Amount in words (Indian system) ---------------------------------------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return ONES[n % 10] ? `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}` : TENS[Math.floor(n / 10)];
}

function toWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = Math.floor(n / 100); n %= 100;

  if (crore) parts.push(`${toWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (n) parts.push(twoDigits(n));
  return parts.join(' ');
}

function amountInWords(paise: number): string {
  const rupeePart = Math.floor(Math.abs(paise) / 100);
  const paisePart = Math.abs(paise) % 100;
  let out = `Rupees ${toWords(rupeePart)}`;
  if (paisePart) out += ` and ${twoDigits(paisePart)} Paise`;
  return `${out} Only`;
}
