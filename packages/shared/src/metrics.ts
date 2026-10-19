import type { RequestHandler } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  /** Mesure durée et statut de chaque requête. */
  middleware: RequestHandler;
  /** Handler pour `GET /metrics` (format Prometheus). */
  handler: RequestHandler;
  httpRequests: Counter<'method' | 'route' | 'status'>;
}

/**
 * Métriques HTTP + métriques process Node pour un service.
 * Le label `route` utilise le motif de la route (ex. `/v1/accounts/:id`), pas l'URL réelle,
 * pour éviter une explosion du nombre de séries.
 */
export function createMetrics(service: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'Nombre de requêtes HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Durée des requêtes HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const middleware: RequestHandler = (req, res, next) => {
    const end = duration.startTimer();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'non_routee';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequests.inc(labels);
      end(labels);
    });
    next();
  };

  const handler: RequestHandler = async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  };

  return { registry, middleware, handler, httpRequests };
}
