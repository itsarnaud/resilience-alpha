import express from 'express';
import accounts from './routes/accounts.js';
import beneficiaries from './routes/beneficiaries.js';
import health from './routes/health.js';
import transactions from './routes/transactions.js';

const router = express.Router();

router.use('/', health);
router.use('/v1/accounts', accounts);
router.use('/v1/beneficiaries', beneficiaries);
router.use('/v1/transactions', transactions);

export default router;
