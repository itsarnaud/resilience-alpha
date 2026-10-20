import express from 'express';
import * as AuthController from '../controllers/AuthController.js';

const router = express.Router();

router.post('/login', AuthController.login);
router.post('/token', AuthController.clientToken);

export default router;
