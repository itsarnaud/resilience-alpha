import { Alert, Badge, Card } from '../components/ui';
import LedIndicator from '../components/LedIndicator';
import { authApi, remediationApi } from '../lib/api';
import { useLoad } from '../lib/useLoad';

const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

export default function OverviewPage() {
  const services = useLoad(remediationApi.services);
  const led = useLoad(authApi.led);

  return (
    <>
      <h1 className="text-lg font-semibold">Vue d'ensemble</h1>
      <p className="text-sm text-slate-500">
        État des services avant, pendant et après un incident. Rechargez la page pour une lecture à jour.
      </p>

      {services.error && <Alert kind="error">{services.error.detail ?? services.error.title}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        {services.data?.map((s) => (
          <Card key={s.name}>
            <div className="flex items-center justify-between">
              <p className="font-medium capitalize">{s.name}</p>
              <Badge tone={s.healthy ? 'ok' : 'ko'}>{s.healthy ? 'En ligne' : 'Indisponible'}</Badge>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {s.last_canary_ok_at
                ? `Dernière transaction de test réussie : ${date.format(new Date(s.last_canary_ok_at))}`
                : 'Aucune transaction de test réussie pour le moment'}
            </p>
          </Card>
        ))}
        {services.data?.length === 0 && <Alert kind="info">Aucun service supervisé.</Alert>}
      </div>

      <Card title="Back-office (caméra, LED)">
        {led.error && <Alert kind="error">{led.error.detail ?? led.error.title}</Alert>}
        {led.data && (
          <div className="space-y-1">
            <LedIndicator state={led.data.state} />
            {led.data.until && (
              <p className="text-xs text-slate-500">Retour à l'arrêt prévu à {date.format(new Date(led.data.until))}</p>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
