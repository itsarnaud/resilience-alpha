import express from 'express';
import { requireRole } from '@resilience/shared';
import * as SupervisionController from '../controllers/SupervisionController.js';
import * as auth from '../middlewares/auth.js';

const router = express.Router();

router.use(auth.index);
router.use(requireRole('operator', 'svc:dashboard'));

router.get('/playbooks', SupervisionController.playbooks);
router.get('/services', SupervisionController.services);
router.get('/blocks', SupervisionController.blocks);

export default router;
