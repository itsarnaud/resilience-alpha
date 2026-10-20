import express from 'express';
import { requireRole } from '@resilience/shared';
import * as IncidentsController from '../controllers/IncidentsController.js';
import * as auth from '../middlewares/auth.js';

const router = express.Router();

router.use(auth.index);

// Seul le détecteur peut signaler un incident. Personne d'autre ne déclenche d'action.
router.post('/', requireRole('svc:detector'), IncidentsController.create);

// Lecture : opérateurs et dashboard. `/stream` avant `/:id`.
const readers = requireRole('operator', 'svc:dashboard');
router.get('/', readers, IncidentsController.list);
router.get('/stream', readers, IncidentsController.stream);
router.get('/:id', readers, IncidentsController.show);

export default router;
