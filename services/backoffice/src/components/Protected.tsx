import { useSyncExternalStore } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { session } from '../lib/session';

/** Réserve les habilitations aux comptes `admin`. */
export default function Protected() {
  const current = useSyncExternalStore(session.subscribe, session.get);
  const location = useLocation();
  if (!current || !current.roles.includes('admin')) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
