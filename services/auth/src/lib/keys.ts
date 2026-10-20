import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import type { Role } from '@resilience/shared';
import { config } from './config.js';
import { logger } from './logger.js';

async function loadSigner() {
  const pem = config.JWT_PRIVATE_KEY_FILE
    ? readFileSync(config.JWT_PRIVATE_KEY_FILE, 'utf8')
    : config.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');

  let privateKey: KeyObject | CryptoKey;
  let publicKey: KeyObject | CryptoKey;
  if (pem) {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('la clé JWT doit être une clé RSA');
    privateKey = key;
    publicKey = createPublicKey(key);
  } else {
    if (config.NODE_ENV === 'production') {
      throw new Error('JWT_PRIVATE_KEY ou JWT_PRIVATE_KEY_FILE est obligatoire en production');
    }
    // Développement et tests : clé éphémère, les jetons ne survivent pas à un redémarrage.
    logger.warn('aucune clé JWT configurée : clé éphémère générée (développement uniquement)');
    ({ privateKey, publicKey } = await generateKeyPair('RS256'));
  }

  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);

  return {
    /** JWKS public, publié sur `/.well-known/jwks.json`. */
    jwks: { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] },
    ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    /** Émet un jeton d'accès RS256. */
    sign: (subject: string, roles: Role[], claims: Record<string, unknown> = {}) =>
      new SignJWT({ roles, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setSubject(subject)
        .setIssuer(config.JWT_ISSUER)
        .setAudience(config.JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
        .sign(privateKey),
  };
}

export const signer = await loadSigner();
