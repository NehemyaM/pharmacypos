import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { desktop, isDesktop, type DesktopInfo } from '../lib/desktop';
import { Modal, Alert, Spinner } from './ui';

/**
 * The way out of kiosk mode.
 *
 * "Nobody can exit" is the right default for a shop counter and the wrong
 * behaviour when the application wedges — a counter that cannot be closed is a
 * counter that cannot be fixed. So exiting is gated on an admin password rather
 * than being impossible: staff cannot wander off into a browser, and the owner
 * is never locked out.
 *
 * Renders nothing in a browser.
 */
export default function ExitGuard() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<DesktopInfo | null>(null);

  useEffect(() => {
    if (!desktop) return;
    desktop.info().then(setInfo).catch(() => undefined);
    return desktop.onExitRequested(() => {
      setPassword('');
      setError('');
      setOpen(true);
    });
  }, []);

  if (!isDesktop) return null;

  async function confirm(action: 'exit' | 'unlock') {
    setBusy(true);
    setError('');
    try {
      // Verified against the real admin account, not a PIN stored on the machine.
      const me = await api.get<{ role: string }>('/auth/me');
      if (me.role !== 'admin') {
        setError('Only the owner account can do this. Sign in as an admin first.');
        return;
      }
      // Re-check the password so an unattended, already-signed-in counter is
      // not a way out.
      await api.post('/auth/verify-password', { password });

      if (action === 'exit') await desktop!.exit();
      else {
        await desktop!.leaveKiosk();
        setOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Close PharmacyPOS">
      <div className="space-y-4">
        <Alert kind="warning">
          The counter cannot bill while this is closed. Only do this to update or
          shut down the shop.
        </Alert>

        {error && <Alert kind="error">{error}</Alert>}

        <div>
          <label className="label" htmlFor="exit-pw">Owner password</label>
          <input
            id="exit-pw" type="password" className="input" value={password}
            autoFocus autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && password) void confirm('exit'); }}
          />
        </div>

        {info && (
          <p className="text-xs text-slate-400">
            Version {info.version} · data in {info.dataDir}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setOpen(false)}>
            Keep billing
          </button>
          <button
            className="btn-secondary" disabled={!password || busy}
            onClick={() => void confirm('unlock')}
            title="Leave fullscreen but keep the app running"
          >
            Unlock screen
          </button>
          <button className="btn-danger" disabled={!password || busy}
            onClick={() => void confirm('exit')}>
            {busy && <Spinner />} Close application
          </button>
        </div>
      </div>
    </Modal>
  );
}
