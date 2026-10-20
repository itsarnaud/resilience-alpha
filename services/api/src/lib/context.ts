import type { Request } from 'express';
import type { Role } from '@resilience/shared';

/** Qui fait la requête et d'où, sans dépendre d'Express dans les services. */
export interface Actor {
  sub: string;
  roles: Role[];
  ip: string;
  requestId: string;
}

export function actorOf(req: Request): Actor {
  const { sub, roles } = req.auth!;
  return { sub, roles, ip: req.ip ?? 'inconnue', requestId: req.id };
}
