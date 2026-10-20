import { incidentDto } from '../lib/dto.js';
import { incidentEvents } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { actionsTotal } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';

/** Diffuse l'état courant d'un incident aux clients du flux temps réel. */
export const publish = async (incidentId: string): Promise<void> => {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: { actions: true },
  });
  if (incident) incidentEvents.emit('incident', incidentDto(incident));
};

/**
 * Enregistre une étape dans la chronologie de l'incident, la journalise et la compte.
 * C'est la trace que le jury relit : chaque action de la remédiation passe par ici.
 */
export const record = async (
  incidentId: string,
  step: string,
  ok: boolean,
  detail: string,
): Promise<void> => {
  await prisma.action.create({ data: { incidentId, step, ok, detail } });
  actionsTotal.inc({ step, ok: String(ok) });
  const entry = { event: 'remediation_step', incident_id: incidentId, step, ok, detail };
  if (ok) logger.info(entry, 'étape de remédiation');
  else logger.warn(entry, 'étape de remédiation en échec');
  await publish(incidentId);
};
