import { Link } from 'react-router';
import StateBadge from '../components/StateBadge';
import { Alert, Card } from '../components/ui';
import { useIncidentStream } from '../lib/useIncidentStream';

const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

export default function IncidentsPage() {
  const { incidents, connected } = useIncidentStream();

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Incidents</h1>
        <span className="flex items-center gap-2 text-xs text-slate-500">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden />
          {connected ? 'temps réel' : 'reconnexion…'}
        </span>
      </div>

      {incidents.length === 0 && <Alert kind="info">Aucun incident pour le moment.</Alert>}
      <Card>
        <ul className="divide-y divide-slate-100">
          {incidents.map((incident) => (
            <li key={incident.id}>
              <Link
                to={`/incidents/${incident.id}`}
                className="flex items-center justify-between gap-4 py-3 hover:bg-slate-50"
              >
                <div>
                  <p className="text-sm font-medium">
                    {incident.type}
                    {incident.source_ip && <span className="ml-2 font-mono text-xs text-slate-500">{incident.source_ip}</span>}
                  </p>
                  <p className="text-xs text-slate-500">{date.format(new Date(incident.detected_at))}</p>
                </div>
                <StateBadge state={incident.state} />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
