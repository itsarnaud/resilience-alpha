import { createLocalJWKSet } from 'jose';
import { authenticate, createJwtVerifier } from '@resilience/shared';
import { config } from '../lib/config.js';
import { signer } from '../lib/keys.js';

// `auth` vérifie ses propres jetons avec ses clés locales (pas d'appel réseau).
const verify = createJwtVerifier({
  getKey: createLocalJWKSet(signer.jwks),
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
});

/** Exige un jeton valide ; remplit `req.auth`. */
export const index = authenticate(verify);
