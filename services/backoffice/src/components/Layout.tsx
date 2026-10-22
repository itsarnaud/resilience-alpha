import { NavLink, Outlet, useNavigate } from 'react-router';
import { session } from '../lib/session';
import { Button } from './ui';

export default function Layout() {
  const navigate = useNavigate();
  const logout = () => {
    session.clear();
    navigate('/login');
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="font-semibold text-indigo-700">Back-office RESILIENCE</span>
            <nav className="flex gap-1" aria-label="Navigation principale">
              {[
                { to: '/', label: 'Utilisateurs', end: true },
                { to: '/observabilite', label: 'Observabilité', end: false },
              ].map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.end}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 text-sm font-medium ${
                      isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
                    }`
                  }
                >
                  {l.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <Button variant="secondary" onClick={logout}>
            Se déconnecter
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
