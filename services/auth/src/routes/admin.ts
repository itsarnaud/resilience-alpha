import express from 'express';
import { requireRole } from '@resilience/shared';
import * as AdminController from '../controllers/AdminController.js';
import * as auth from '../middlewares/auth.js';

const router = express.Router();

router.use(auth.index);
router.use(requireRole('admin'));

router.get('/users', AdminController.list);
router.post('/users', AdminController.create);
router.patch('/users/:id', AdminController.update);
router.post(
  '/users/:id/face',
  express.raw({ type: ['image/jpeg', 'image/png'], limit: '1mb' }),
  AdminController.enrollFace,
);
router.delete('/lockouts/:identifier', AdminController.unlock);

export default router;
