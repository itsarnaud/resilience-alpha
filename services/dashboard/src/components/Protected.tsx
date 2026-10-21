import { useSyncExternalStore } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { session } from '../lib/session';

/** Réserve le dashboard aux comptes `operator`. Une session expirée renvoie vers la connexion. */
export default function Protected() {
  const current = useSyncExternalStore(session.subscribe, session.get);
  const location = useLocation();
  if (!current || !current.roles.includes('operator')) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
