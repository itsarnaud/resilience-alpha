import { NavLink, Outlet, useNavigate } from 'react-router';
import { session } from '../lib/session';
import { Button } from './ui';

const links = [
  { to: '/', label: 'Comptes', end: true },
  { to: '/virement', label: 'Virement' },
  { to: '/beneficiaires', label: 'Bénéficiaires' },
  { to: '/historique', label: 'Historique' },
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
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold text-indigo-700">Banque RESILIENCE</span>
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
      <main className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <Outlet />
      </main>
      <footer className="pb-6 text-center text-xs text-slate-400">
        Plateforme de démonstration : toutes les données sont fictives.
      </footer>
    </div>
  );
}
