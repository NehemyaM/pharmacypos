import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, type SessionUser } from '../lib/api';
import { Alert, Spinner, useAutoFocus } from '../components/ui';

export default function Login({ onSignedIn }: { onSignedIn: (u: SessionUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const userRef = useAutoFocus<HTMLInputElement>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(username.trim(), password);
      onSignedIn(user);
      navigate('/billing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-4xl">💊</div>
          <h1 className="mt-2 text-xl font-bold tracking-tight text-slate-800">PharmacyPOS</h1>
          <p className="text-sm text-slate-500">Billing &amp; inventory for your medical store</p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          {error && <Alert kind="error">{error}</Alert>}

          <div>
            <label className="label" htmlFor="username">Username</label>
            <input
              id="username" ref={userRef} className="input" value={username} autoComplete="username"
              onChange={(e) => setUsername(e.target.value)} required
            />
          </div>

          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password" className="input" type="password" value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} required
            />
          </div>

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy && <Spinner />} Sign in
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          Demo logins — admin/admin123 · pharmacist/pharma123 · cashier/cash123
        </p>
      </div>
    </div>
  );
}
