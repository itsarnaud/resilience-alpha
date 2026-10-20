import express from 'express';
import { requireRole } from '@resilience/shared';
import * as AccountsController from '../controllers/AccountsController.js';
import * as auth from '../middlewares/auth.js';

const router = express.Router();

router.use(auth.index);

// Le canari de la remédiation lit ses propres comptes pour choisir la source et la destination.
router.get('/', requireRole('customer', 'svc:remediation-canary'), AccountsController.list);
router.get('/:id', requireRole('customer', 'svc:remediation-canary'), AccountsController.show);
router.post('/', requireRole('customer'), AccountsController.open);

export default router;
