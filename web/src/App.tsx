import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { getUser, clearSession, type SessionUser, type Role } from './lib/api';
import Login from './pages/Login';
import Billing from './pages/Billing';
import Dashboard from './pages/Dashboard';
import Inventory from './pages/Inventory';
import Products from './pages/Products';
import Purchases from './pages/Purchases';
import Invoices from './pages/Invoices';
import InvoiceView from './pages/InvoiceView';
import Reports from './pages/Reports';
import H1Register from './pages/H1Register';
import Contacts from './pages/Contacts';
import ImportPage from './pages/Import';
import SettingsPage from './pages/Settings';
import ExitGuard from './components/ExitGuard';
import ForcePasswordChange from './components/ForcePasswordChange';

type NavItem = { to: string; label: string; icon: string; roles?: Role[]; hint?: string };

const NAV: NavItem[] = [
  { to: '/billing', label: 'New Bill', icon: '🧾', hint: 'F2' },
  { to: '/dashboard', label: 'Dashboard', icon: '📊' },
  { to: '/invoices', label: 'Invoices', icon: '📄' },
  { to: '/inventory', label: 'Stock', icon: '📦' },
  { to: '/products', label: 'Products', icon: '💊' },
  { to: '/purchases', label: 'Purchases', icon: '🚚', roles: ['admin', 'pharmacist'] },
  { to: '/h1-register', label: 'H1 Register', icon: '📕', roles: ['admin', 'pharmacist'] },
  { to: '/reports', label: 'Reports', icon: '📈' },
  { to: '/contacts', label: 'Contacts', icon: '👥' },
  { to: '/import', label: 'Import', icon: '⭱', roles: ['admin'] },
  { to: '/settings', label: 'Settings', icon: '⚙️', roles: ['admin'] },
];

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(getUser());
  const navigate = useNavigate();
  const location = useLocation();

  // F2 anywhere jumps to a new bill — the single most-used action in a shop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        navigate('/billing');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onSignedIn={setUser} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // A fresh install ships with a known password; this blocks everything else
  // until it has been changed.
  if (user.must_change_password) {
    return <ForcePasswordChange user={user} onDone={setUser} />;
  }

  const visible = NAV.filter((n) => !n.roles || n.roles.includes(user.role));
  const isPrintView = location.pathname.includes('/invoices/');

  function signOut() {
    clearSession();
    setUser(null);
    navigate('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className={`w-56 shrink-0 border-r border-slate-200 bg-white ${isPrintView ? 'no-print' : ''}`}>
        <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
          <span className="text-lg">💊</span>
          <span className="text-sm font-bold tracking-tight text-slate-800">PharmacyPOS</span>
        </div>

        <nav className="flex flex-col gap-0.5 p-2">
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-brand-50 font-semibold text-brand-800'
                    : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              <span className="w-5 text-center text-base">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="kbd">{item.hint}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto" />
        <div className="border-t border-slate-200 p-3">
          <p className="truncate text-sm font-medium text-slate-700">{user.full_name}</p>
          <p className="text-xs capitalize text-slate-400">{user.role}</p>
          <button onClick={signOut} className="btn-ghost mt-2 w-full justify-start !px-2 text-xs">
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/billing" replace />} />
          <Route path="/login" element={<Navigate to="/billing" replace />} />
          <Route path="/billing" element={<Billing user={user} />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/:id" element={<InvoiceView user={user} />} />
          <Route path="/inventory" element={<Inventory user={user} />} />
          <Route path="/products" element={<Products user={user} />} />
          <Route path="/purchases" element={<Purchases />} />
          <Route path="/h1-register" element={<H1Register />} />
          <Route path="/reports" element={<Reports user={user} />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/billing" replace />} />
        </Routes>
      </main>

      {/* Renders nothing in a browser; in the desktop build it is the way out
          of kiosk mode. */}
      <ExitGuard />
    </div>
  );
}
