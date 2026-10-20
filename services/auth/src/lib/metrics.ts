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

export const backofficeLogins = new Counter({
  name: 'auth_backoffice_logins_total',
  help: 'Étapes de la connexion du back-office',
  // started | face_ok | face_refused | password_refused | granted | blocked | expired
  labelNames: ['result'] as const,
  registers: [metrics.registry],
});

export const backofficeLockouts = new Counter({
  name: 'auth_backoffice_lockouts_total',
  help: 'Identifiants verrouillés après des échecs consécutifs',
  registers: [metrics.registry],
});

export const ledPublish = new Counter({
  name: 'auth_led_publish_total',
  help: "Publications de l'état de la LED sur MQTT",
  labelNames: ['result'] as const,
  registers: [metrics.registry],
});
