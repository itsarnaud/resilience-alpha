import express from 'express';
import { requireRole } from '@resilience/shared';
import * as BeneficiariesController from '../controllers/BeneficiariesController.js';
import * as auth from '../middlewares/auth.js';

const router = express.Router();

router.use(auth.index);
router.use(requireRole('customer'));

router.get('/', BeneficiariesController.list);
router.post('/', BeneficiariesController.create);

export default router;
