import { Outlet, useNavigate } from 'react-router';
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
          <span className="font-semibold text-indigo-700">Back-office RESILIENCE</span>
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
