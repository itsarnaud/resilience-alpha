import express from 'express';
import health from './routes/health.js';
import incidents from './routes/incidents.js';
import supervision from './routes/supervision.js';

const router = express.Router();

router.use('/', health);
router.use('/v1/incidents', incidents);
router.use('/v1', supervision);

export default router;
