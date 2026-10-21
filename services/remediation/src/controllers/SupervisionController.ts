import type { Request, Response } from 'express';
import { PLAYBOOKS } from '../lib/playbooks.js';
import { actorOf } from '../lib/context.js';
import { BlockIdParamSchema } from '../schemas/supervision.schema.js';
import * as BlocksServices from '../services/BlocksServices.js';
import * as ServicesStatus from '../services/ServicesStatus.js';

export const playbooks = (_req: Request, res: Response) => {
  res.json(PLAYBOOKS);
};

export const services = async (_req: Request, res: Response) => {
  res.json(await ServicesStatus.list());
};

export const blocks = async (_req: Request, res: Response) => {
  const active = await BlocksServices.listActive();
  res.json(
    active.map((b) => ({
      id: b.id,
      ip: b.ip,
      incident_id: b.incidentId,
      created_at: b.createdAt.toISOString(),
      expires_at: b.expiresAt.toISOString(),
    })),
  );
};

/** Lève un blocage avant son échéance, à la demande d'un opérateur. */
export const unblock = async (req: Request, res: Response) => {
  const { id } = BlockIdParamSchema.parse(req.params);
  await BlocksServices.releaseOne(id, actorOf(req).sub);
  res.status(204).end();
};
