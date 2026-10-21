import { NavLink, Outlet, useNavigate } from 'react-router';
import { session } from '../lib/session';
import { Button } from './ui';

const links = [
  { to: '/', label: "Vue d'ensemble", end: true },
  { to: '/incidents', label: 'Incidents' },
  { to: '/blocages', label: 'IP bloquées' },
  { to: '/assistant', label: 'Assistant' },
];

export default function Layout() {
  const navigate = useNavigate();
  const logout = () => {
    session.clear();
    navigate('/login');
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold text-indigo-700">Supervision RESILIENCE</span>
          <nav className="flex gap-1" aria-label="Navigation principale">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <Button variant="secondary" onClick={logout}>
            Se déconnecter
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
