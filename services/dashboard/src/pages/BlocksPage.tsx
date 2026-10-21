import { Link } from 'react-router';
import { Alert, Card } from '../components/ui';
import { useLoad } from '../lib/useLoad';
import { remediationApi } from '../lib/api';

const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

export default function BlocksPage() {
  const { data, error, loading, reload } = useLoad(remediationApi.blocks);

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">IP bloquées</h1>
        <button type="button" onClick={() => void reload()} className="text-sm text-indigo-700 underline">
          Actualiser
        </button>
      </div>
      {error && <Alert kind="error">{error.detail ?? error.title}</Alert>}
      {loading && !data && <p className="text-sm text-slate-500">Chargement…</p>}
      {data?.length === 0 && <Alert kind="info">Aucune IP bloquée actuellement.</Alert>}
      <Card>
        <ul className="divide-y divide-slate-100">
          {data?.map((b) => (
            <li key={b.id} className="flex items-center justify-between py-3 text-sm">
              <div>
                <p className="font-mono">{b.ip}</p>
                <Link to={`/incidents/${b.incident_id}`} className="text-xs text-indigo-700 underline">
                  voir l'incident
                </Link>
              </div>
              <p className="text-xs text-slate-500">jusqu'à {date.format(new Date(b.expires_at))}</p>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
