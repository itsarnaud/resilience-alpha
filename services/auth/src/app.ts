import express from 'express';
import { errorHandler, notFoundHandler, requestId } from '@resilience/shared';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { metrics } from './lib/metrics.js';
import router from './router.js';

const app = express();

app.disable('x-powered-by');
// WAF : adresse réelle du client vient de X-Forwarded-For.
app.set(
  'trust proxy',
  config.TRUST_PROXY.split(',').map((s) => s.trim()),
);

app.use(requestId());
app.use(metrics.middleware);
app.use(express.json({ limit: '10kb' }));

app.use('/', router);

app.use(notFoundHandler());
app.use(errorHandler(logger));

export default app;
