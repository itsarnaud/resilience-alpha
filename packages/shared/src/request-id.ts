import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Identifiant de requête, repris de `X-Request-Id` ou généré. */
      id: string;
    }
  }
}

const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Attribue un identifiant à chaque requête et le renvoie dans la réponse. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    req.id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}
