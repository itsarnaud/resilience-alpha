import { createMetrics } from '@resilience/shared';
import { Counter, Gauge, Histogram } from 'prom-client';

export const metrics = createMetrics('remediation');

export const incidentsTotal = new Counter({
  name: 'remediation_incidents_total',
  help: 'Incidents par type et par état atteint',
  labelNames: ['type', 'state'] as const,
  registers: [metrics.registry],
});

export const actionsTotal = new Counter({
  name: 'remediation_actions_total',
  help: 'Étapes exécutées par la remédiation',
  labelNames: ['step', 'ok'] as const,
  registers: [metrics.registry],
});

export const canaryTotal = new Counter({
  name: 'remediation_canary_total',
  help: 'Transactions de test (canari)',
  labelNames: ['result'] as const,
  registers: [metrics.registry],
});

/** Temps entre la détection et la reprise confirmée : l'indicateur de résilience du projet. */
export const recoverySeconds = new Histogram({
  name: 'remediation_recovery_seconds',
  help: 'Durée entre la détection et la reprise confirmée',
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [metrics.registry],
});

export const activeBlocks = new Gauge({
  name: 'remediation_active_ip_blocks',
  help: 'IP actuellement bloquées dans le WAF',
  registers: [metrics.registry],
});
