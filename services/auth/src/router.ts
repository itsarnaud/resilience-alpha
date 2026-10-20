import express from 'express';
import auth from './routes/auth.js';
import backoffice from './routes/backoffice.js';
import devices from './routes/devices.js';
import health from './routes/health.js';
import users from './routes/users.js';

const router = express.Router();

router.use('/', health);
router.use('/v1', auth);
router.use('/v1', users);
router.use('/v1/backoffice', backoffice);
router.use('/v1/devices', devices);

export default router;
