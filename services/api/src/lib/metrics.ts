import { createMetrics } from '@resilience/shared';
import { Counter } from 'prom-client';

export const metrics = createMetrics('api');

export const transactionsTotal = new Counter({
  name: 'payments_transactions_total',
  help: 'Virements traités',
  labelNames: ['status', 'kind'] as const,
  registers: [metrics.registry],
});

export const fraudBlocked = new Counter({
  name: 'payments_fraud_blocked_total',
  help: 'Virements refusés par la règle anti-fraude',
  labelNames: ['reason'] as const,
  registers: [metrics.registry],
});
