import express from 'express';
import * as HealthController from '../controllers/HealthController.js';
import { metrics } from '../lib/metrics.js';

const router = express.Router();

router.get('/healthz', HealthController.healthz);
router.get('/readyz', HealthController.readyz);
router.get('/metrics', metrics.handler);

export default router;
