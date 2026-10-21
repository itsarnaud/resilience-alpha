import type { IncidentState } from '../lib/api';

const STYLES: Record<IncidentState, string> = {
  DETECTED: 'bg-amber-100 text-amber-800',
  REMEDIATING: 'bg-sky-100 text-sky-800',
  VERIFYING: 'bg-sky-100 text-sky-800',
  RESOLVED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-red-100 text-red-800',
  IGNORED: 'bg-slate-100 text-slate-600',
};

const LABELS: Record<IncidentState, string> = {
  DETECTED: 'Détecté',
  REMEDIATING: 'Remédiation',
  VERIFYING: 'Vérification',
  RESOLVED: 'Résolu',
  FAILED: 'Échec',
  IGNORED: 'Ignoré',
};

export default function StateBadge({ state }: { state: IncidentState }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[state]}`}>{LABELS[state]}</span>
  );
}
