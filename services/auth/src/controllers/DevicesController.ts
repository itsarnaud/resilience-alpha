import type { Request, Response } from 'express';
import * as LedServices from '../services/LedServices.js';

export const led = (_req: Request, res: Response) => {
  const { state, since, until } = LedServices.get();
  res.json({ state, since: since.toISOString(), until: until?.toISOString() ?? null });
};
