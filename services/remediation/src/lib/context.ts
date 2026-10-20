import type { Request } from 'express';

/** Qui fait la requête et d'où, sans dépendre d'Express dans les services. */
export interface Actor {
  sub: string;
  ip: string;
  requestId: string;
}

/** À utiliser après le middleware d'authentification. */
export function actorOf(req: Request): Actor {
  return { sub: req.auth!.sub, ip: req.ip ?? 'inconnue', requestId: req.id };
}
