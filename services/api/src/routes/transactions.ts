import express from 'express';
import { requireRole } from '@resilience/shared';
import * as TransactionsController from '../controllers/TransactionsController.js';
import * as auth from '../middlewares/auth.js';

const router = express.Router();

router.use(auth.index);
router.use(requireRole('customer', 'svc:remediation-canary'));

router.post('/', TransactionsController.create);
router.get('/', TransactionsController.list);
router.get('/:id', TransactionsController.show);

export default router;
