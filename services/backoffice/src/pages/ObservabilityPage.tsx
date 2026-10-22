import { useState } from 'react';
import { Card } from '../components/ui';

// URLs dérivées de l'hôte courant : fonctionne en localhost comme derrière l'IP de démo.
const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const GRAFANA = `http://${host}:3000`;
const MAILPIT = `http://${host}:8025`;
const PROMETHEUS = `http://${host}:9090`;

type Panel = { id: string; label: string; src: string; open: string; note: string };

const PANELS: Panel[] = [
  {
    id: 'securite',
    label: 'Sécurité — WAF',
    src: `${GRAFANA}/d/securite-waf?kiosk&refresh=10s`,
    open: `${GRAFANA}/d/securite-waf`,
    note: 'Blocages 403, volume de journaux par conteneur, journaux WAF en direct.',
  },
  {
    id: 'remediation',
    label: 'Remédiation',
    src: `${GRAFANA}/d/remediation?kiosk&refresh=10s`,
    open: `${GRAFANA}/d/remediation`,
    note: 'MTTR, incidents et journal du moteur de reprise autonome.',
  },
  {
    id: 'sante',
    label: 'Santé plateforme',
    src: `${GRAFANA}/d/plateforme-sante?kiosk&refresh=10s`,
    open: `${GRAFANA}/d/plateforme-sante`,
    note: 'État et disponibilité des services de la plateforme.',
  },
  {
    id: 'mails',
    label: 'Notifications SOC',
    src: MAILPIT,
    open: MAILPIT,
    note: 'Alertes e-mail (intrusion, incidents) envoyées au SOC via Mailpit.',
  },
];

export default function ObservabilityPage() {
  const [active, setActive] = useState(PANELS[0].id);
  const panel = PANELS.find((p) => p.id === active) ?? PANELS[0];

  return (
    <div className="space-y-4">
      <Card title="Observabilité">
        <p className="text-sm text-slate-600">
          Le cockpit de supervision au même endroit : métriques, journaux et notifications,
          sans quitter le back-office.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {PANELS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setActive(p.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                p.id === active
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {p.label}
            </button>
          ))}
          <a
            href={PROMETHEUS}
            target="_blank"
            rel="noreferrer"
            className="ml-auto rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200"
          >
            Prometheus ↗
          </a>
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm text-slate-600">{panel.note}</p>
          <a
            href={panel.open}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-sm text-indigo-700 underline"
          >
            Ouvrir en plein écran ↗
          </a>
        </div>
        <iframe
          key={panel.id}
          title={panel.label}
          src={panel.src}
          className="h-[70vh] w-full rounded-md border border-slate-200 bg-white"
        />
        <p className="mt-2 text-xs text-slate-400">
          Cadre vide ? L'outil bloque peut-être l'affichage intégré — utilise « Ouvrir en plein écran ».
        </p>
      </Card>
    </div>
  );
}
