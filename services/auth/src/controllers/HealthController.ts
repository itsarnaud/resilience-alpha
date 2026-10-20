import type { Request, Response } from 'express';
import { signer } from '../lib/keys.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export const healthz = (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
};

/** Prêt = la base répond. C'est ce que la remédiation vérifie après une reprise. */
export const readyz = async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready' });
  } catch (err) {
    logger.error({ err }, 'base de données injoignable');
    res.status(503).json({ status: 'not_ready' });
  }
};

/** Clés publiques de vérification, consommées par les autres services. */
export const jwks = (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=300').json(signer.jwks);
};
