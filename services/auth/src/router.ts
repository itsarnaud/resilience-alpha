import express from 'express';
import auth from './routes/auth.js';
import health from './routes/health.js';
import users from './routes/users.js';

const router = express.Router();

router.use('/', health);
router.use('/v1', auth);
router.use('/v1', users);

export default router;
