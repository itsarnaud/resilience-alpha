import express from 'express';
import { requireRole } from '@resilience/shared';
import * as DevicesController from '../controllers/DevicesController.js';
import * as auth from '../middlewares/auth.js';

const router = express.Router();

router.use(auth.index);
router.use(requireRole('operator', 'svc:dashboard', 'admin'));

router.get('/led', DevicesController.led);

export default router;
