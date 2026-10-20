import express from 'express';
import * as BackofficeController from '../controllers/BackofficeController.js';

const router = express.Router();

router.post('/login', BackofficeController.start);
router.get('/login/:id', BackofficeController.show);
router.post(
  '/login/:id/face',
  express.raw({ type: ['image/jpeg', 'image/png'], limit: '1mb' }),
  BackofficeController.face,
);
router.post('/login/:id/password', BackofficeController.password);

export default router;
