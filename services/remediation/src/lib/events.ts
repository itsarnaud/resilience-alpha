import { EventEmitter } from 'node:events';

/** Diffuse chaque changement d'incident aux clients du flux temps réel (SSE). */
export const incidentEvents = new EventEmitter();
incidentEvents.setMaxListeners(100);
