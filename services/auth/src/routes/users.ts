import express from 'express';
import * as UsersController from '../controllers/UsersController.js';
import * as auth from '../middlewares/auth.js';

const router = express.Router();

router.post('/register', UsersController.register);
router.get('/me', auth.index, UsersController.me);

export default router;
