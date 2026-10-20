import { authenticate, createJwtVerifier, remoteKeys } from '@resilience/shared';
import { config } from '../lib/config.js';

const verify = createJwtVerifier({
  getKey: remoteKeys(config.AUTH_JWKS_URL),
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
});

export const index = authenticate(verify);
