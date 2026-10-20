import { createMetrics } from '@resilience/shared';
import { Counter } from 'prom-client';

export const metrics = createMetrics('auth');

// Pas de label IP ni email : cardinalité maîtrisée. Le détail est dans les logs et la table.
export const loginFailures = new Counter({
  name: 'auth_login_failures_total',
  help: 'Échecs de connexion utilisateur',
  labelNames: ['reason'] as const,
  registers: [metrics.registry],
});

export const loginSuccesses = new Counter({
  name: 'auth_login_successes_total',
  help: 'Connexions utilisateur réussies',
  registers: [metrics.registry],
});

export const clientFailures = new Counter({
  name: 'auth_client_failures_total',
  help: "Échecs d'authentification de services",
  registers: [metrics.registry],
});
