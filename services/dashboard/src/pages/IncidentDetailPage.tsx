import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import StateBadge from '../components/StateBadge';
import { Alert, Card } from '../components/ui';
import { useIncidentStream } from '../lib/useIncidentStream';

const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
const time = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'medium' });

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Même flux que la liste : la chronologie se complète en direct pendant que le jury regarde.
  const { incidents } = useIncidentStream();
  const incident = useMemo(() => incidents.find((i) => i.id === id), [incidents, id]);

  if (!incident) {
    return <Alert kind="info">Incident introuvable, ou pas encore reçu par ce flux.</Alert>;
  }

  return (
    <>
      <Link to="/incidents" className="text-sm text-indigo-700 underline">
        ← Retour aux incidents
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{incident.type}</h1>
        <StateBadge state={incident.state} />
      </div>

      <Card>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">Détecté à</dt>
            <dd>{date.format(new Date(incident.detected_at))}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">IP source</dt>
            <dd className="font-mono">{incident.source_ip ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Service visé</dt>
            <dd>{incident.target_service ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Score</dt>
            <dd>{incident.score.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Playbook</dt>
            <dd>{incident.playbook ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Reprise en</dt>
            <dd>{incident.time_to_recover_seconds !== null ? `${incident.time_to_recover_seconds} s` : '—'}</dd>
          </div>
        </dl>
        {incident.targets.length > 0 && (
          <p className="mt-3 text-sm">
            <span className="text-xs text-slate-500">Comptes visés : </span>
            {incident.targets.join(', ')}
          </p>
        )}
        {incident.failure_reason && (
          <div className="mt-3">
            <Alert kind="error">{incident.failure_reason}</Alert>
          </div>
        )}
      </Card>

      <Card title="Chronologie">
        <ol className="space-y-2">
          {incident.timeline.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 w-20 shrink-0 text-xs text-slate-400">{time.format(new Date(step.at))}</span>
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${step.ok ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden />
              <span>
                <span className="font-medium">{step.step}</span>
                <span className="text-slate-500"> — {step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
