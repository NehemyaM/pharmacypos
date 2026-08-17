import { useState } from 'react';
import { api, setSession, getToken, type SessionUser } from '../lib/api';
import { Modal, Alert, Spinner } from './ui';

/**
 * Shown when the account still has the password it was created with.
 *
 * A fresh install has to ship a known password so the first person can get in;
 * this is what stops it quietly staying `admin123` on a machine holding patient
 * records and a statutory register.
 */
export default function ForcePasswordChange({ user, onDone }: {
  user: SessionUser;
  onDone: (u: SessionUser) => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const tooShort = next.length > 0 && next.length < 6;
  const mismatch = confirm.length > 0 && next !== confirm;
  const stillDefault = next === 'admin123';
  const canSubmit = current && next.length >= 6 && next === confirm && !stillDefault && !busy;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      const updated = { ...user, must_change_password: false };
      setSession(getToken()!, updated);
      onDone(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => undefined} title="Choose a password before you start">
      <div className="space-y-4">
        <Alert kind="warning">
          This account still uses the password it was installed with. Anyone who knows it
          can open your billing, your customers' details and the Schedule H1 register.
        </Alert>

        {error && <Alert kind="error">{error}</Alert>}

        <div>
          <label className="label" htmlFor="cur">Current password</label>
          <input id="cur" type="password" className="input" value={current} autoFocus
            onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="new">New password</label>
          <input id="new" type="password" className="input" value={next}
            onChange={(e) => setNext(e.target.value)} />
          {tooShort && <p className="mt-1 text-xs text-amber-700">At least 6 characters.</p>}
          {stillDefault && (
            <p className="mt-1 text-xs text-red-600">Choose something other than the default.</p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="conf">Repeat the new password</label>
          <input id="conf" type="password" className="input" value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }} />
          {mismatch && <p className="mt-1 text-xs text-red-600">The two do not match.</p>}
        </div>

        <button className="btn-primary w-full" disabled={!canSubmit} onClick={() => void submit()}>
          {busy && <Spinner />} Set password and continue
        </button>
      </div>
    </Modal>
  );
}

