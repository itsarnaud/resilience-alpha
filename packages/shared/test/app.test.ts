import express from 'express';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  HttpError,
  authenticate,
  createJwtVerifier,
  createLogger,
  createMetrics,
  errorHandler,
  loadConfig,
  notFoundHandler,
  requestId,
  requireRole,
  IncidentReportSchema,
  TransactionRequestSchema,
  type Role,
} from '../src/index.js';

const ISSUER = 'resilience-auth';
const AUDIENCE = 'resilience-platform';
const logger = createLogger('test', 'silent');

let privateKey: CryptoKey;
let verify: ReturnType<typeof createJwtVerifier>;

async function token(opts: { roles: Role[]; sub?: string; expiresIn?: string; aud?: string }) {
  return new SignJWT({ roles: opts.roles })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setSubject(opts.sub ?? 'user-1')
    .setIssuer(ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  verify = createJwtVerifier({
    getKey: createLocalJWKSet({ keys: [jwk] }),
    issuer: ISSUER,
    audience: AUDIENCE,
  });
});

function buildApp() {
  const metrics = createMetrics('test');
  const app = express();
  app.use(requestId());
  app.use(metrics.middleware);
  app.use(express.json());
  app.get('/metrics', metrics.handler);
  app.get('/public', (_req, res) => res.json({ ok: true }));
  app.get('/me', authenticate(verify), (req, res) => res.json(req.auth));
  app.post('/incidents', authenticate(verify), requireRole('svc:detector'), (req, res) =>
    res.status(202).json(IncidentReportSchema.parse(req.body)),
  );
  app.get('/boom', () => {
    throw new Error('secret interne');
  });
  app.get('/teapot', () => {
    throw new HttpError(418, 'Théière');
  });
  app.use(notFoundHandler());
  app.use(errorHandler(logger));
  return app;
}

describe('request id', () => {
  it('génère un identifiant si absent', async () => {
    const res = await request(buildApp()).get('/public');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reprend un identifiant valide et rejette un identifiant douteux', async () => {
    const app = buildApp();
    const ok = await request(app).get('/public').set('X-Request-Id', 'abc-123');
    expect(ok.headers['x-request-id']).toBe('abc-123');
    const bad = await request(app).get('/public').set('X-Request-Id', 'a b<script>');
    expect(bad.headers['x-request-id']).not.toContain('<');
  });
});

describe('erreurs problem+json', () => {
  it('404 sur route inconnue', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.request_id).toBeTruthy();
  });

  it('HttpError renvoie son statut', async () => {
    const res = await request(buildApp()).get('/teapot');
    expect(res.status).toBe(418);
    expect(res.body.title).toBe('Théière');
  });

  it('500 sans fuite du message interne', async () => {
    const res = await request(buildApp()).get('/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret interne');
  });

  it('400 sur JSON mal formé', async () => {
    const token_ = await token({ roles: ['svc:detector'] });
    const res = await request(buildApp())
      .post('/incidents')
      .set('Authorization', `Bearer ${token_}`)
      .set('Content-Type', 'application/json')
      .send('{pas du json');
    expect(res.status).toBe(400);
  });

  it('422 sur corps invalide (zod)', async () => {
    const token_ = await token({ roles: ['svc:detector'] });
    const res = await request(buildApp())
      .post('/incidents')
      .set('Authorization', `Bearer ${token_}`)
      .send({ type: 'BRUTE_FORCE' });
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain('dedup_key');
  });
});

describe('authentification', () => {
  it('401 sans jeton', async () => {
    const res = await request(buildApp()).get('/me');
    expect(res.status).toBe(401);
  });

  it('401 avec un jeton expiré', async () => {
    const expired = await token({ roles: ['customer'], expiresIn: '-1m' });
    const res = await request(buildApp()).get('/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('401 avec une mauvaise audience', async () => {
    const t = await token({ roles: ['customer'], aud: 'autre' });
    const res = await request(buildApp()).get('/me').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(401);
  });

  it('401 avec un jeton signé par une autre clé', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ roles: ['operator'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('pirate')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(other.privateKey);
    const res = await request(buildApp()).get('/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('expose sujet et rôles, en ignorant les rôles inconnus', async () => {
    const t = await new SignJWT({ roles: ['customer', 'root'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('user-9')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);
    const res = await request(buildApp()).get('/me').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: 'user-9', roles: ['customer'] });
  });

  it('403 si le rôle est insuffisant, 202 pour svc:detector', async () => {
    const app = buildApp();
    const body = {
      dedup_key: 'BRUTE_FORCE:auth:203.0.113.5',
      type: 'BRUTE_FORCE',
      score: 0.93,
      detected_at: new Date().toISOString(),
    };
    const customer = await token({ roles: ['customer'] });
    const denied = await request(app)
      .post('/incidents')
      .set('Authorization', `Bearer ${customer}`)
      .send(body);
    expect(denied.status).toBe(403);

    const detector = await token({ roles: ['svc:detector'] });
    const accepted = await request(app)
      .post('/incidents')
      .set('Authorization', `Bearer ${detector}`)
      .send(body);
    expect(accepted.status).toBe(202);
    expect(accepted.body.evidence).toEqual([]);
  });
});

describe('métriques', () => {
  it('expose le format Prometheus avec le motif de route', async () => {
    const app = buildApp();
    await request(app).get('/public');
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total{method="GET",route="/public",status="200"');
    expect(res.text).toContain('service="test"');
  });
});

describe('schémas', () => {
  const base = { from_account_id: crypto.randomUUID(), amount_cents: 1500 };

  it('accepte un compte interne ou un IBAN externe, pas les deux ni aucun', () => {
    expect(
      TransactionRequestSchema.safeParse({ ...base, to_account_id: crypto.randomUUID() }).success,
    ).toBe(true);
    expect(
      TransactionRequestSchema.safeParse({ ...base, to_iban: 'FR7612345678901234567890123' })
        .success,
    ).toBe(true);
    expect(TransactionRequestSchema.safeParse(base).success).toBe(false);
    expect(
      TransactionRequestSchema.safeParse({
        ...base,
        to_account_id: crypto.randomUUID(),
        to_iban: 'FR7612345678901234567890123',
      }).success,
    ).toBe(false);
  });

  it('refuse un montant nul, négatif ou décimal', () => {
    const to = { to_account_id: crypto.randomUUID() };
    for (const amount_cents of [0, -5, 10.5]) {
      expect(TransactionRequestSchema.safeParse({ ...base, ...to, amount_cents }).success).toBe(
        false,
      );
    }
  });
});

describe('config', () => {
  const schema = z.object({
    PORT: z.coerce.number().int().default(3000),
    DATABASE_URL: z.string().url(),
  });

  it('applique les valeurs par défaut et convertit', () => {
    expect(loadConfig(schema, { DATABASE_URL: 'postgres://u:p@db:5432/x' })).toEqual({
      PORT: 3000,
      DATABASE_URL: 'postgres://u:p@db:5432/x',
    });
  });

  it('échoue avec un message lisible', () => {
    expect(() => loadConfig(schema, {})).toThrow(/DATABASE_URL/);
  });
});
