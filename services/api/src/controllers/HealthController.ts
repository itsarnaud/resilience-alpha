import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export const healthz = (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
};

/**
 * Prêt = la base répond ET une écriture dans une transaction annulée réussit.
 * C'est ce que la remédiation vérifie après une reprise, avant la transaction canari.
 */
export const readyz = async (_req: Request, res: Response) => {
  try {
    await prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT 1`;
      await db.account.count();
    });
    res.json({ status: 'ready' });
  } catch (err) {
    logger.error({ err }, 'base de données injoignable');
    res.status(503).json({ status: 'not_ready' });
  }
};
