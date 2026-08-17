import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';

export type Doctor = {
  id: number;
  name: string;
  qualification: string;
  hospital: string;
  address: string;
};

/**
 * Choose the prescribing doctor, or name one who is not on file yet.
 *
 * This was a plain dropdown of saved doctors, which meant a prescription from a
 * doctor the shop had never seen could not be billed at all — the customer is at
 * the counter, the medicine is on the shelf, and the software says no. Since
 * every new customer arrives holding a prescription from someone, that is not a
 * rare case; it is most of them.
 *
 * So the name is typed. Anyone already on file is offered while typing, and a
 * name that matches nobody is added to the register on the spot. Only the name
 * is asked for here — qualification, hospital and address are filled in later
 * under Contacts, because the counter is not the place for a data-entry form.
 */
export default function DoctorPicker({
  value,
  onChange,
  autoFocus = false,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  autoFocus?: boolean;
}) {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<Doctor[]>('/doctors').then(setDoctors).catch(() => undefined);
  }, []);

  // Clicking elsewhere closes the list without choosing anything.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const selected = doctors.find((d) => d.id === value) ?? null;

  const typed = query.trim();
  const matches = useMemo(() => {
    if (!typed) return doctors.slice(0, 8);
    const q = typed.toLowerCase();
    return doctors.filter((d) =>
      d.name.toLowerCase().includes(q) || d.hospital.toLowerCase().includes(q),
    ).slice(0, 8);
  }, [doctors, typed]);

  // Offering "add" for a name that is already on file would create a duplicate.
  const exactExists = doctors.some(
    (d) => d.name.trim().toLowerCase() === typed.toLowerCase(),
  );
  const canAdd = typed.length >= 3 && !exactExists;
  const options = canAdd ? matches.length : matches.length - 1;

  async function addDoctor(name: string) {
    setSaving(true);
    setError('');
    try {
      const { id } = await api.post<{ id: number }>('/doctors', { name: name.trim() });
      const created: Doctor = {
        id, name: name.trim(), qualification: '', hospital: '', address: '',
      };
      setDoctors((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      choose(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that doctor');
    } finally {
      setSaving(false);
    }
  }

  function choose(id: number) {
    onChange(id);
    setQuery('');
    setOpen(false);
    setHighlight(0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, options));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight < matches.length) choose(matches[highlight].id);
      else if (canAdd) void addDoctor(typed);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <span className="min-w-0 truncate text-sm">
          <span className="font-medium text-slate-800">{selected.name}</span>
          {selected.hospital && (
            <span className="text-slate-500"> — {selected.hospital}</span>
          )}
        </span>
        <button
          type="button"
          className="shrink-0 text-xs text-slate-500 underline hover:text-slate-700"
          onClick={() => { onChange(null); setQuery(''); }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        id="doctor"
        className="input"
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder="Prescribing doctor — type the name"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {open && (matches.length > 0 || canAdd) && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {matches.map((d, i) => (
            <button
              key={d.id}
              type="button"
              data-active={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(d.id)}
              className={`block w-full px-3 py-2 text-left text-sm ${
                i === highlight ? 'bg-brand-50' : 'hover:bg-slate-50'
              }`}
            >
              <span className="font-medium text-slate-800">{d.name}</span>
              {(d.qualification || d.hospital) && (
                <span className="block text-xs text-slate-500">
                  {[d.qualification, d.hospital].filter(Boolean).join(' · ')}
                </span>
              )}
            </button>
          ))}

          {canAdd && (
            <button
              type="button"
              data-active={highlight === matches.length}
              onMouseEnter={() => setHighlight(matches.length)}
              onClick={() => void addDoctor(typed)}
              disabled={saving}
              className={`block w-full border-t border-slate-100 px-3 py-2 text-left text-sm ${
                highlight === matches.length ? 'bg-brand-50' : 'hover:bg-slate-50'
              }`}
            >
              <span className="font-medium text-brand-700">
                {saving ? 'Adding…' : `Add "${typed}" as a new doctor`}
              </span>
              <span className="block text-xs text-slate-500">
                Their details can be filled in later under Contacts.
              </span>
            </button>
          )}
        </div>
      )}

      {typed.length > 0 && typed.length < 3 && (
        <p className="mt-1 text-xs text-slate-400">
          Keep typing — three letters before a new doctor can be added.
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
