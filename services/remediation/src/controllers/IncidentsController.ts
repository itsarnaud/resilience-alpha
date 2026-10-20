import type { Request, Response } from 'express';
import { IncidentReportSchema } from '@resilience/shared';
import { actorOf } from '../lib/context.js';
import { incidentDto } from '../lib/dto.js';
import { incidentEvents } from '../lib/events.js';
import { IncidentIdParamSchema, ListIncidentsQuerySchema } from '../schemas/incidents.schema.js';
import * as EngineServices from '../services/EngineServices.js';
import * as IncidentsServices from '../services/IncidentsServices.js';

/** Appelé par le détecteur. Répond tout de suite : la remédiation se poursuit en arrière-plan. */
export const create = async (req: Request, res: Response) => {
  const report = IncidentReportSchema.parse(req.body);
  const { incident, created } = await IncidentsServices.create(report, actorOf(req));

  // 202 : accepté, traitement lancé. 200 : même incident déjà connu (dédoublonné).
  res.status(created ? 202 : 200).json(incidentDto(incident));
  if (created && incident.state === 'DETECTED') EngineServices.start(incident.id);
};

export const list = async (req: Request, res: Response) => {
  const query = ListIncidentsQuerySchema.parse(req.query);
  const incidents = await IncidentsServices.list(query);
  res.json(incidents.map(incidentDto));
};

export const show = async (req: Request, res: Response) => {
  const { id } = IncidentIdParamSchema.parse(req.params);
  res.json(incidentDto(await IncidentsServices.get(id)));
};

/**
 * Flux temps réel (Server-Sent Events) : un instantané des derniers incidents à la connexion, puis
 * un événement `incident` à chaque changement d'état ou nouvelle étape.
 * `EventSource` ne sait pas envoyer d'en-tête `Authorization` : le dashboard lit ce flux avec `fetch`.
 */
export const stream = async (req: Request, res: Response) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const onIncident = (dto: unknown) => send('incident', dto);
  incidentEvents.on('incident', onIncident);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    incidentEvents.off('incident', onIncident);
  });

  const recent = await IncidentsServices.list({ limit: 20 });
  send('snapshot', recent.map(incidentDto));
};
