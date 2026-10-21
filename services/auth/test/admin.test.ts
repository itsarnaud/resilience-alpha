/**
 * Habilitations du back-office : lister, créer, modifier les rôles/l'activation, enrôler un visage,
 * débloquer un identifiant. Le service de reconnaissance faciale est simulé (comme pour la connexion).
 */
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@resilience/shared';

type LogEntry = { level: string; obj: Record<string, unknown>; msg?: string };
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

const faceControl = vi.hoisted(() => ({
  enrollResult: { samples: 1 } as { samples: number } | 'no_face' | 'down',
  enrollCalls: [] as string[],
}));
vi.mock('../src/lib/face.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/face.js')>();
  return {
    ...original,
    face: {
      verify: async () => ({ match: false }),
      enroll: async (user: string) => {
        faceControl.enrollCalls.push(user);
        if (faceControl.enrollResult === 'down') throw new original.FaceServiceError('arrêté');
        if (faceControl.enrollResult === 'no_face')
          throw new original.NoFaceDetectedError('aucun visage');
        return faceControl.enrollResult;
      },
    },
  };
});

const DB_URL = process.env.TEST_DATABASE_URL;
const ISSUER = 'resilience-auth';
const AUDIENCE = 'resilience-platform';
process.env.DATABASE_URL = DB_URL ?? 'postgresql://inutilise';

const photo = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(32)]);

describe.skipIf(!DB_URL)('habilitations du back-office', () => {
  let app: typeof import('../src/app.js').default;
  let prisma: typeof import('../src/lib/prisma.js').prisma;
  let signer: typeof import('../src/lib/keys.js').signer;
  let hashPassword: typeof import('../src/lib/password.js').hashPassword;
  let first: { id: string; email: string };

  const asAdmin = async (id: string) => `Bearer ${await signer.sign(id, ['admin'])}`;

  beforeAll(async () => {
    app = (await import('../src/app.js')).default;
    prisma = (await import('../src/lib/prisma.js')).prisma;
    signer = (await import('../src/lib/keys.js')).signer;
    hashPassword = (await import('../src/lib/password.js')).hashPassword;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.backofficeLockout.deleteMany();
    await prisma.backofficeLogin.deleteMany();
    await prisma.user.deleteMany();
    first = await prisma.user.create({
      data: {
        email: 'premier.admin@lab.local',
        passwordHash: await hashPassword('mot-de-passe-du-premier'),
        roles: ['admin'],
      },
    });
    faceControl.enrollResult = { samples: 1 };
    faceControl.enrollCalls.length = 0;
    logs.length = 0;
  });

  const get = (path: string, auth: string) => request(app).get(path).set('Authorization', auth);
  const post = (path: string, auth: string, body?: unknown) =>
    request(app).post(path).set('Authorization', auth).send(body);
  const patch = (path: string, auth: string, body: unknown) =>
    request(app).patch(path).set('Authorization', auth).send(body);

  describe("contrôle d'accès", () => {
    it('401 sans jeton, 403 pour un opérateur ou un client', async () => {
      expect((await request(app).get('/v1/admin/users')).status).toBe(401);
      const operator = `Bearer ${await signer.sign('op-1', ['operator'])}`;
      const customer = `Bearer ${await signer.sign('c-1', ['customer'])}`;
      expect((await get('/v1/admin/users', operator)).status).toBe(403);
      expect((await get('/v1/admin/users', customer)).status).toBe(403);
    });

    it('un administrateur peut lister, consulter et modifier', async () => {
      const admin = await asAdmin(first.id);
      const res = await get('/v1/admin/users', admin);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        email: 'premier.admin@lab.local',
        roles: ['admin'],
        active: true,
      });
      expect(res.body[0]).not.toHaveProperty('passwordHash');
    });
  });

  describe('création de comptes', () => {
    it('crée un compte opérateur, journalise, sans secret dans le journal', async () => {
      const admin = await asAdmin(first.id);
      const res = await post('/v1/admin/users', admin, {
        email: 'nouvel.operateur@lab.local',
        password: 'un-mot-de-passe-solide',
        roles: ['operator'],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        email: 'nouvel.operateur@lab.local',
        roles: ['operator'],
        active: true,
      });
      expect(await prisma.user.count()).toBe(2);
      expect(logs.find((l) => l.obj.event === 'admin_user_created')).toBeTruthy();
      expect(JSON.stringify(logs)).not.toContain('un-mot-de-passe-solide');
    });

    it('refuse un doublon, un rôle de service, un mot de passe trop court', async () => {
      const admin = await asAdmin(first.id);
      const dup = await post('/v1/admin/users', admin, {
        email: 'premier.admin@lab.local',
        password: 'un-mot-de-passe-solide',
        roles: ['operator'],
      });
      expect(dup.status).toBe(409);
      const serviceRole = await post('/v1/admin/users', admin, {
        email: 'x@lab.local',
        password: 'un-mot-de-passe-solide',
        roles: ['svc:detector'],
      });
      expect(serviceRole.status).toBe(422);
      const shortPwd = await post('/v1/admin/users', admin, {
        email: 'y@lab.local',
        password: 'court',
        roles: ['operator'],
      });
      expect(shortPwd.status).toBe(422);
    });
  });

  describe('modification des habilitations', () => {
    it('désactive un compte, et un compte désactivé ne peut plus se connecter', async () => {
      const admin = await asAdmin(first.id);
      const operator = await prisma.user.create({
        data: {
          email: 'op@lab.local',
          passwordHash: await hashPassword('mot-de-passe-operateur'),
          roles: ['operator'],
        },
      });
      const res = await patch(`/v1/admin/users/${operator.id}`, admin, { active: false });
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);

      const login = await request(app)
        .post('/v1/login')
        .send({ email: 'op@lab.local', password: 'mot-de-passe-operateur' });
      expect(login.status).toBe(401);
    });

    it('refuse de retirer le dernier administrateur actif (rôle ou désactivation)', async () => {
      const admin = await asAdmin(first.id);
      const byRole = await patch(`/v1/admin/users/${first.id}`, admin, { roles: ['operator'] });
      expect(byRole.status).toBe(409);
      const byDeactivation = await patch(`/v1/admin/users/${first.id}`, admin, { active: false });
      expect(byDeactivation.status).toBe(409);
    });

    it('un administrateur ne peut pas modifier ses propres habilitations', async () => {
      const second = await prisma.user.create({
        data: {
          email: 'second.admin@lab.local',
          passwordHash: await hashPassword('mot-de-passe-du-second'),
          roles: ['admin'],
        },
      });
      const admin = await asAdmin(second.id);
      const res = await patch(`/v1/admin/users/${second.id}`, admin, { active: false });
      expect(res.status).toBe(403);
    });

    it('permet de retirer le rôle admin quand un autre administrateur reste actif', async () => {
      const second = await prisma.user.create({
        data: {
          email: 'second.admin@lab.local',
          passwordHash: await hashPassword('mot-de-passe-du-second'),
          roles: ['admin'],
        },
      });
      const admin = await asAdmin(first.id);
      const res = await patch(`/v1/admin/users/${second.id}`, admin, { roles: ['operator'] });
      expect(res.status).toBe(200);
      expect(res.body.roles).toEqual(['operator']);
    });

    it('404 sur un compte inconnu, 422 sur un corps vide', async () => {
      const admin = await asAdmin(first.id);
      expect(
        (
          await patch('/v1/admin/users/11111111-1111-4111-8111-111111111111', admin, {
            active: false,
          })
        ).status,
      ).toBe(404);
      expect((await patch(`/v1/admin/users/${first.id}`, admin, {})).status).toBe(422);
    });
  });

  describe('enrôlement du visage', () => {
    it("enrôle un visage sous l'email du compte, avec le bon type de contenu", async () => {
      const admin = await asAdmin(first.id);
      const res = await request(app)
        .post(`/v1/admin/users/${first.id}/face`)
        .set('Authorization', admin)
        .set('Content-Type', 'image/jpeg')
        .send(photo());
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ samples: 1 });
      expect(faceControl.enrollCalls).toEqual(['premier.admin@lab.local']);
      expect(logs.find((l) => l.obj.event === 'admin_face_enrolled')).toMatchObject({
        obj: { user_id: first.id, samples: 1 },
      });
    });

    it('renvoie un refus propre quand la photo ne contient aucun visage (pas une panne)', async () => {
      faceControl.enrollResult = 'no_face';
      const admin = await asAdmin(first.id);
      const res = await request(app)
        .post(`/v1/admin/users/${first.id}/face`)
        .set('Authorization', admin)
        .set('Content-Type', 'image/jpeg')
        .send(photo());
      expect(res.status).toBe(422);
    });

    it('une panne du service renvoie 503', async () => {
      faceControl.enrollResult = 'down';
      const admin = await asAdmin(first.id);
      const res = await request(app)
        .post(`/v1/admin/users/${first.id}/face`)
        .set('Authorization', admin)
        .set('Content-Type', 'image/jpeg')
        .send(photo());
      expect(res.status).toBe(503);
    });

    it('refuse une photo dont la signature ne correspond pas', async () => {
      const admin = await asAdmin(first.id);
      const res = await request(app)
        .post(`/v1/admin/users/${first.id}/face`)
        .set('Authorization', admin)
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.from('pas-une-photo'));
      expect(res.status).toBe(422);
      expect(faceControl.enrollCalls).toEqual([]);
    });
  });

  describe('déblocage', () => {
    it('débloque un identifiant verrouillé', async () => {
      await prisma.backofficeLockout.create({
        data: {
          identifier: 'bloque@lab.local',
          lockedUntil: new Date(Date.now() + 300_000),
          lockLevel: 1,
        },
      });
      const admin = await asAdmin(first.id);
      const res = await request(app)
        .delete('/v1/admin/lockouts/bloque@lab.local')
        .set('Authorization', admin);
      expect(res.status).toBe(204);
      expect(
        await prisma.backofficeLockout.findUnique({ where: { identifier: 'bloque@lab.local' } }),
      ).toBeNull();
    });
  });
});
