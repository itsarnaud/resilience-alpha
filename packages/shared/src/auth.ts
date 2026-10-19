import type { RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpError } from './errors.js';
import { RoleSchema, type Role } from './schemas.js';

/** Identité extraite d'un jeton valide. */
export interface AuthContext {
  sub: string;
  roles: Role[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export interface JwtVerifierOptions {
  /** Résolution de la clé publique (voir `remoteKeys`). */
  getKey: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}

export type JwtVerifier = (token: string) => Promise<AuthContext>;

/** Récupère les clés publiques de `auth` via son endpoint JWKS (mis en cache). */
export function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 5_000 });
}

/** Vérifie signature (RS256 uniquement), émetteur, audience et expiration. */
export function createJwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  return async (token) => {
    const { payload } = await jwtVerify(token, options.getKey, {
      algorithms: ['RS256'],
      issuer: options.issuer,
      audience: options.audience,
    });
    if (!payload.sub) throw new Error('jeton sans sujet');
    const roles = (Array.isArray(payload.roles) ? payload.roles : []).filter(
      (r): r is Role => RoleSchema.safeParse(r).success,
    );
    return { sub: payload.sub, roles };
  };
}

/** Exige un jeton `Authorization: Bearer ...` valide et remplit `req.auth`. */
export function authenticate(verify: JwtVerifier): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('authorization');
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) {
      next(HttpError.unauthorized('jeton manquant'));
      return;
    }
    try {
      req.auth = await verify(match[1]);
      next();
    } catch {
      next(HttpError.unauthorized('jeton invalide ou expiré'));
    }
  };
}

/** Exige au moins un des rôles donnés (à placer après `authenticate`). */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(HttpError.unauthorized());
      return;
    }
    if (!req.auth.roles.some((r) => allowed.includes(r))) {
      next(HttpError.forbidden('rôle insuffisant'));
      return;
    }
    next();
  };
}
