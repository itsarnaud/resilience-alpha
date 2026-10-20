import type { Request } from 'express';

export interface RequestContext {
  ip: string;
  requestId: string;
}

export function requestContext(req: Request): RequestContext {
  return { ip: req.ip ?? 'inconnue', requestId: req.id };
}
