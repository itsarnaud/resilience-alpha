import { createLocalJWKSet } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJwtVerifier } from '@resilience/shared';
import { hashPassword, verifyPassword } from '../src/lib/password.js';

type LogEntry = { level: string; obj: Record<string, unknown>; msg?: string };

// Le logger est un singleton du service : on le remplace pour pouvoir lire ce qui est journalisé.
const logs = vi.hoisted(() => [] as LogEntry[]);
vi.mock('../src/lib/logger.js', () => {
  const make =
    (level: string) =>
    (obj: Record<string, unknown> | string, msg?: string): void => {
      logs.push(typeof obj === 'string' ? { level, obj: {}, msg: obj } : { level, obj, msg });
    };
  return {
    logger: { info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') },
  };
});

const DB_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = DB_URL ?? 'postgresql://inutilise';

const ISSUER = 'resilience-auth';
const AUDIENCE = 'resilience-platform';

function metricValue(text: string, series: string): number {
  const line = text.split('\n').find((l) => l.startsWith(series));
  return line ? Number(line.split(' ').pop()) : 0;
}

describe('hachage des mots de passe', () => {
  it('vérifie le bon mot de passe et rejette les autres', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('mauvais', hash)).toBe(false);
    expect(await verifyPassword('x', 'format-invalide')).toBe(false);
  });

  it('produit des empreintes différentes pour le même mot de passe (sel)', async () => {
    expect(await hashPassword('même')).not.toBe(await hashPassword('même'));
  });
});

describe.skipIf(!DB_URL)('service auth (base de données)', () => {
  let app: typeof import('../src/app.js').default;
  let prisma: typeof import('../src/lib/prisma.js').prisma;
  let signer: typeof import('../src/lib/keys.js').signer;

  beforeAll(async () => {
    app = (await import('../src/app.js')).default;
    prisma = (await import('../src/lib/prisma.js')).prisma;
    signer = (await import('../src/lib/keys.js')).signer;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.loginAttempt.deleteMany();
    await prisma.user.deleteMany();
    await prisma.serviceClient.deleteMany();
    logs.length = 0;
  });

  async function createUser(email: string, password: string, roles = ['customer']) {
    return prisma.user.create({
      data: { email, passwordHash: await hashPassword(password), roles },
    });
  }

  describe('santé et clés', () => {
    it('/healthz et /readyz répondent', async () => {
      expect((await request(app).get('/healthz')).status).toBe(200);
      expect((await request(app).get('/readyz')).status).toBe(200);
    });

    it('publie un JWKS sans aucune partie privée', async () => {
      const res = await request(app).get('/.well-known/jwks.json');
      expect(res.status).toBe(200);
      const [key] = res.body.keys;
      expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      expect(key.kid).toBeTruthy();
      for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi'])
        expect(key).not.toHaveProperty(secret);
    });
  });

  describe('inscription', () => {
    it('crée un compte customer et refuse un doublon (insensible à la casse)', async () => {
      const ok = await request(app)
        .post('/v1/register')
        .send({ email: 'Alice@Example.com', password: 'un-mot-de-passe-long' });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ email: 'alice@example.com', roles: ['customer'] });
      expect(ok.body).not.toHaveProperty('passwordHash');

      const dup = await request(app)
        .post('/v1/register')
        .send({ email: 'alice@example.com', password: 'un-mot-de-passe-long' });
      expect(dup.status).toBe(409);
    });

    it('refuse un mot de passe de plus de 72 octets (limite de bcrypt)', async () => {
      const res = await request(app)
        .post('/v1/register')
        .send({ email: 'long@example.com', password: 'é'.repeat(40) });
      expect(res.status).toBe(422);
      expect(res.body.detail).toContain('72 octets');
    });

    it('refuse un mot de passe de moins de 12 caractères', async () => {
      const res = await request(app)
        .post('/v1/register')
        .send({ email: 'bob@example.com', password: 'court' });
      expect(res.status).toBe(422);
    });
  });

  describe('connexion', () => {
    it('émet un JWT RS256 vérifiable avec le JWKS, et on peut lire /v1/me', async () => {
      const user = await createUser('carol@example.com', 'mot-de-passe-solide');
      const res = await request(app)
        .post('/v1/login')
        .send({ email: 'carol@example.com', password: 'mot-de-passe-solide' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });

      // Un autre service vérifie le jeton avec seulement la clé publique.
      const verify = createJwtVerifier({
        getKey: createLocalJWKSet(signer.jwks),
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      expect(await verify(res.body.access_token)).toEqual({ sub: user.id, roles: ['customer'] });

      const me = await request(app)
        .get('/v1/me')
        .set('Authorization', `Bearer ${res.body.access_token}`);
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ id: user.id, email: 'carol@example.com', roles: ['customer'] });
    });

    it('renvoie la même réponse pour un compte inconnu et un mauvais mot de passe', async () => {
      await createUser('dave@example.com', 'mot-de-passe-solide');
      const wrongPassword = await request(app)
        .post('/v1/login')
        .send({ email: 'dave@example.com', password: 'mauvais' });
      const unknown = await request(app)
        .post('/v1/login')
        .send({ email: 'fantome@example.com', password: 'mauvais' });
      expect(wrongPassword.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(unknown.body.detail).toBe(wrongPassword.body.detail);
    });

    it("n'insère jamais un rôle inconnu de la base dans le jeton", async () => {
      await createUser('eve@example.com', 'mot-de-passe-solide', ['customer', 'root']);
      const res = await request(app)
        .post('/v1/login')
        .send({ email: 'eve@example.com', password: 'mot-de-passe-solide' });
      const verify = createJwtVerifier({
        getKey: createLocalJWKSet(signer.jwks),
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      expect((await verify(res.body.access_token)).roles).toEqual(['customer']);
    });

    it("journalise chaque échec avec l'IP réelle (X-Forwarded-For), le compte visé et le motif", async () => {
      await createUser('frank@example.com', 'mot-de-passe-solide');
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/v1/login')
          .set('X-Forwarded-For', '203.0.113.7')
          .send({ email: 'frank@example.com', password: `essai-${i}` });
      }
      await request(app)
        .post('/v1/login')
        .set('X-Forwarded-For', '203.0.113.7')
        .send({ email: 'inconnu@example.com', password: 'x' });

      const failures = logs.filter((l) => l.obj.event === 'login_failed');
      expect(failures).toHaveLength(4);
      expect(failures[0]!.obj).toMatchObject({
        email: 'frank@example.com',
        ip: '203.0.113.7',
        reason: 'bad_password',
      });
      expect(failures[3]!.obj).toMatchObject({ reason: 'unknown_user' });
      // jamais de mot de passe dans les logs
      expect(JSON.stringify(logs)).not.toContain('essai-');

      const rows = await prisma.loginAttempt.findMany({ where: { ip: '203.0.113.7' } });
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => !r.success)).toBe(true);
    });

    it("ignore une adresse X-Forwarded-For forgée à gauche : seule l'IP ajoutée par le proxy compte", async () => {
      await request(app)
        .post('/v1/login')
        .set('X-Forwarded-For', '1.2.3.4, 203.0.113.9')
        .send({ email: 'pirate@example.com', password: 'x' });
      const failure = logs.find((l) => l.obj.event === 'login_failed');
      expect(failure?.obj.ip).toBe('203.0.113.9');
    });

    it('expose les compteurs de connexion pour Prometheus (sans label IP)', async () => {
      await createUser('gina@example.com', 'mot-de-passe-solide');
      const bad = 'auth_login_failures_total{reason="bad_password",service="auth"}';
      const unknown = 'auth_login_failures_total{reason="unknown_user",service="auth"}';
      const ok = 'auth_login_successes_total{service="auth"}';
      const before = (await request(app).get('/metrics')).text;

      await request(app).post('/v1/login').send({ email: 'gina@example.com', password: 'faux' });
      await request(app).post('/v1/login').send({ email: 'x@example.com', password: 'faux' });
      await request(app)
        .post('/v1/login')
        .send({ email: 'gina@example.com', password: 'mot-de-passe-solide' });

      const after = (await request(app).get('/metrics')).text;
      expect(metricValue(after, bad) - metricValue(before, bad)).toBe(1);
      expect(metricValue(after, unknown) - metricValue(before, unknown)).toBe(1);
      expect(metricValue(after, ok) - metricValue(before, ok)).toBe(1);
    });
  });

  describe('jetons de service', () => {
    beforeEach(async () => {
      await prisma.serviceClient.create({
        data: {
          clientId: 'svc-detector',
          secretHash: await hashPassword('secret-du-detecteur'),
          roles: ['svc:detector'],
        },
      });
    });

    it('émet un jeton avec le rôle du service', async () => {
      const res = await request(app)
        .post('/v1/token')
        .send({ client_id: 'svc-detector', client_secret: 'secret-du-detecteur' });
      expect(res.status).toBe(200);
      const verify = createJwtVerifier({
        getKey: createLocalJWKSet(signer.jwks),
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      expect(await verify(res.body.access_token)).toEqual({
        sub: 'svc:svc-detector',
        roles: ['svc:detector'],
      });
    });

    it('refuse un mauvais secret et un client inconnu, et journalise sans le secret', async () => {
      const bad = await request(app)
        .post('/v1/token')
        .send({ client_id: 'svc-detector', client_secret: 'faux-secret-123' });
      const unknown = await request(app)
        .post('/v1/token')
        .send({ client_id: 'svc-fantome', client_secret: 'faux-secret-123' });
      expect(bad.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(logs.filter((l) => l.obj.event === 'client_auth_failed')).toHaveLength(2);
      expect(JSON.stringify(logs)).not.toContain('faux-secret-123');
    });

    it("/v1/me répond pour un jeton de service sans chercher d'utilisateur", async () => {
      const token = (
        await request(app)
          .post('/v1/token')
          .send({ client_id: 'svc-detector', client_secret: 'secret-du-detecteur' })
      ).body.access_token;
      const me = await request(app).get('/v1/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ id: 'svc:svc-detector', roles: ['svc:detector'] });
    });
  });

  it('/v1/me exige un jeton', async () => {
    expect((await request(app).get('/v1/me')).status).toBe(401);
  });
});
