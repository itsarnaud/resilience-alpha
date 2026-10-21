import { createServer, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Aedes } from 'aedes';
import { createLocalJWKSet, jwtVerify } from 'jose';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Service de reconnaissance faciale simulé : on choisit sa réponse et on note qui a été comparé.
const faceControl = vi.hoisted(() => ({
  result: { match: true, distance: 0.31 } as { match: boolean; distance?: number } | 'down',
  calls: [] as string[],
}));
vi.mock('../src/lib/face.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/face.js')>();
  return {
    ...original,
    face: {
      verify: async (userId: string) => {
        faceControl.calls.push(userId);
        if (faceControl.result === 'down') throw new original.FaceServiceError('service arrêté');
        return faceControl.result;
      },
    },
  };
});

const DB_URL = process.env.TEST_DATABASE_URL;
const MQTT_USER = 'auth';
const MQTT_PASS = 'mot-de-passe-du-broker-de-test';
const ADMIN = 'admin@lab.local';
const ADMIN_PASSWORD = 'mot-de-passe-solide-admin';

Object.assign(process.env, {
  FACE_MIN_DELAY_MS: '150',
  LED_GREEN_SOLID_SECONDS: '0.3',
  LED_RED_SOLID_SECONDS: '0.3',
  LED_RED_BLINK_SECONDS: '0.3',
  MQTT_USERNAME: MQTT_USER,
  MQTT_PASSWORD: MQTT_PASS,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const photo = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);

async function until(condition: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition jamais remplie');
    await wait(10);
  }
}

describe.skipIf(!DB_URL)('connexion du back-office', () => {
  let app: typeof import('../src/app.js').default;
  let prisma: typeof import('../src/lib/prisma.js').prisma;
  let signer: typeof import('../src/lib/keys.js').signer;
  let hashPassword: typeof import('../src/lib/password.js').hashPassword;
  let LedServices: typeof import('../src/services/LedServices.js');
  let broker: Aedes;
  let brokerServer: Server;
  let subscriber: MqttClient;
  let rejectedConnections = 0;
  const ledMessages: string[] = [];

  beforeAll(async () => {
    broker = await Aedes.createBroker();
    // Le broker n'accepte que `auth` avec son mot de passe : un client anonyme est refusé.
    broker.authenticate = (_client, username, password, callback) => {
      const ok = username === MQTT_USER && password?.toString() === MQTT_PASS;
      if (!ok) rejectedConnections++;
      callback(null, ok);
    };
    brokerServer = createServer(broker.handle);
    await new Promise<void>((r) => brokerServer.listen(0, '127.0.0.1', r));
    process.env.MQTT_URL = `mqtt://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`;

    subscriber = await mqtt.connectAsync(process.env.MQTT_URL, {
      username: MQTT_USER,
      password: MQTT_PASS,
    });
    await subscriber.subscribeAsync('resilience/led');
    subscriber.on('message', (_topic, payload) => ledMessages.push(payload.toString()));

    // Les modules lisent la configuration à l'import : ils ne sont importés qu'ici, une fois le broker prêt.
    hashPassword = (await import('../src/lib/password.js')).hashPassword;
    app = (await import('../src/app.js')).default;
    prisma = (await import('../src/lib/prisma.js')).prisma;
    signer = (await import('../src/lib/keys.js')).signer;
    LedServices = await import('../src/services/LedServices.js');
    // Le client MQTT d'auth se connecte à l'import : attendre qu'il le soit.
    await until(() => logs.some((l) => l.obj.event === 'mqtt_connected'));
  });

  afterAll(async () => {
    LedServices.stop();
    await (await import('../src/lib/mqtt.js')).publisher.close();
    await subscriber.endAsync(true);
    await new Promise((r) => broker.close(() => r(null)));
    brokerServer.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.backofficeLogin.deleteMany();
    await prisma.backofficeLockout.deleteMany();
    await prisma.loginAttempt.deleteMany();
    await prisma.user.deleteMany();
    await prisma.user.create({
      data: { email: ADMIN, passwordHash: await hashPassword(ADMIN_PASSWORD), roles: ['admin'] },
    });
    faceControl.result = { match: true, distance: 0.31 };
    faceControl.calls.length = 0;
    await LedServices.set('off', { reason: 'test' });
    await wait(50);
    ledMessages.length = 0;
    logs.length = 0;
  });

  // --- Outils -----------------------------------------------------------------------------

  const start = (identifier: string) =>
    request(app).post('/v1/backoffice/login').send({ identifier });
  const sendFace = (id: string, body: Buffer = photo(), type = 'image/jpeg') =>
    request(app).post(`/v1/backoffice/login/${id}/face`).set('Content-Type', type).send(body);
  const sendPassword = (id: string, password: string) =>
    request(app).post(`/v1/backoffice/login/${id}/password`).send({ password });

  /** Ouvre une tentative et passe l'étape du visage avec le résultat choisi. */
  async function faceStep(identifier = ADMIN, match = true) {
    faceControl.result = { match, distance: match ? 0.31 : 0.82 };
    const started = await start(identifier);
    expect(started.status).toBe(201);
    return { id: started.body.session_id as string, face: await sendFace(started.body.session_id) };
  }

  /** Simule le temps qui passe : lève le délai et le verrouillage d'un identifiant. */
  const letTimePass = (identifier = ADMIN) =>
    prisma.backofficeLockout.updateMany({
      where: { identifier },
      data: { cooldownUntil: null, lockedUntil: null },
    });

  const failFace = async (identifier = ADMIN) => {
    const { face } = await faceStep(identifier, false);
    expect(face.status).toBe(401);
    return face;
  };
  const failPassword = async (identifier = ADMIN) => {
    const { id } = await faceStep(identifier, true);
    const res = await sendPassword(id, 'mauvais-mot-de-passe');
    expect(res.status).toBe(401);
    return res;
  };

  // --- Le parcours qui réussit ----------------------------------------------------------------

  describe('parcours nominal', () => {
    it('identifiant, visage, mot de passe : jeton admin, et la LED suit chaque étape', async () => {
      const started = await start(ADMIN);
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ state: 'IDENTIFIED' });
      expect(Date.parse(started.body.expires_at)).toBeGreaterThan(Date.now());
      const id = started.body.session_id;
      expect(ledMessages).toEqual([]); // rien tant que le visage n'est pas reconnu

      const faceRes = await sendFace(id);
      expect(faceRes.status).toBe(200);
      expect(faceRes.body.state).toBe('PASSWORD_PENDING');
      await until(() => ledMessages.includes('green-blink'));
      // le visage est comparé sous l'identifiant du compte (la clé sous laquelle il a été enregistré)
      expect(faceControl.calls).toEqual([ADMIN]);

      const granted = await sendPassword(id, ADMIN_PASSWORD);
      expect(granted.status).toBe(200);
      expect(granted.body).toMatchObject({ token_type: 'Bearer', state: 'GRANTED' });
      await until(() => ledMessages.includes('green-solid'));
      await until(() => ledMessages.at(-1) === 'off'); // éteinte à l'échéance
      expect(ledMessages).toEqual(['green-blink', 'green-solid', 'off']);

      // Le jeton dit qui est connecté, avec quels rôles, et comment (visage puis mot de passe).
      const { payload } = await jwtVerify(
        granted.body.access_token,
        createLocalJWKSet(signer.jwks),
        {
          issuer: 'resilience-auth',
          audience: 'resilience-platform',
        },
      );
      expect(payload).toMatchObject({ roles: ['admin'], amr: ['face', 'pwd'] });
      expect((await request(app).get(`/v1/backoffice/login/${id}`)).body.state).toBe('GRANTED');
    });

    it('journalise chaque étape pour l'observabilité, sans mot de passe ni photo', async () => {
      const { id } = await faceStep();
      await sendPassword(id, ADMIN_PASSWORD);
      const events = logs.map((l) => l.obj.event);
      expect(events).toEqual(
        expect.arrayContaining([
          'backoffice_login_started',
          'backoffice_face_result',
          'backoffice_login_succeeded',
        ]),
      );
      const faceLog = logs.find((l) => l.obj.event === 'backoffice_face_result');
      expect(faceLog?.obj).toMatchObject({ identifier: ADMIN, matched: true, distance: 0.31 });
      expect(JSON.stringify(logs)).not.toContain(ADMIN_PASSWORD);
    });

    it('un identifiant en majuscules ou avec des espaces désigne le même compte', async () => {
      const { face } = await faceStep('  Admin@LAB.local ');
      expect(face.status).toBe(200);
    });

    it("les identifiants MQTT sont bien utilisés : le broker n'a refusé personne", () => {
      expect(rejectedConnections).toBe(0);
    });
  });

  // --- Les refus ------------------------------------------------------------------------------

  describe('visage refusé', () => {
    it('401, LED rouge fixe puis éteinte, mot de passe impossible, délai avant de recommencer', async () => {
      const { id, face } = await faceStep(ADMIN, false);
      expect(face.status).toBe(401);
      expect(face.headers['content-type']).toContain('application/problem+json');
      expect(face.body).toMatchObject({
        reason: 'face_not_recognized',
        locked: false,
        retry_after_seconds: 30,
      });
      await until(() => ledMessages.join() === 'red-solid,off');

      // Le mot de passe n'est jamais accepté sans visage reconnu, même le bon.
      const pwd = await sendPassword(id, ADMIN_PASSWORD);
      expect(pwd.status).toBe(409);
      expect(
        await prisma.backofficeLockout.findUnique({ where: { identifier: ADMIN } }),
      ).toMatchObject({
        consecutiveFailures: 1,
      });

      // Avant la fin du délai, impossible de ressaisir l'identifiant.
      const again = await start(ADMIN);
      expect(again.status).toBe(423);
      expect(again.body).toMatchObject({ reason: 'cooldown' });
      expect(again.body.retry_after_seconds).toBeLessThanOrEqual(30);
      expect(again.headers['content-type']).toContain('application/problem+json');

      await letTimePass();
      expect((await start(ADMIN)).status).toBe(201);
    });

    it("n'enregistre aucun succès et journalise l'échec avec l'IP et la distance", async () => {
      await request(app)
        .post('/v1/backoffice/login')
        .set('X-Forwarded-For', '192.168.137.50')
        .send({ identifier: ADMIN })
        .then(async (res) => {
          faceControl.result = { match: false, distance: 0.82 };
          await sendFace(res.body.session_id).set('X-Forwarded-For', '192.168.137.50');
        });
      const failure = logs.find((l) => l.obj.event === 'backoffice_login_failed');
      expect(failure?.obj).toMatchObject({
        stage: 'face',
        identifier: ADMIN,
        ip: '192.168.137.50',
        distance: 0.82,
      });
    });
  });

  describe('mot de passe refusé', () => {
    it('401, LED rouge clignotante puis éteinte, et la tentative est terminée (il faut tout recommencer)', async () => {
      const { id } = await faceStep();
      const res = await sendPassword(id, 'mauvais-mot-de-passe');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        reason: 'wrong_password',
        locked: false,
        retry_after_seconds: 6,
      });
      await until(() => ledMessages.join() === 'green-blink,red-blink,off');

      // Pas de deuxième essai de mot de passe sur la même tentative, même avec le bon.
      const retry = await sendPassword(id, ADMIN_PASSWORD);
      expect(retry.status).toBe(409);
      expect(retry.body.access_token).toBeUndefined();
      expect((await request(app).get(`/v1/backoffice/login/${id}`)).body.state).toBe(
        'PASSWORD_REFUSED',
      );
    });
  });

  // --- Verrouillage ---------------------------------------------------------------------------

  describe('verrouillage côté serveur', () => {
    it('un échec, un nouvel essai, puis blocage de 5 minutes (visage et mot de passe comptent ensemble)', async () => {
      const first = await failFace();
      expect(first.body.locked).toBe(false);
      await letTimePass();

      const second = await failPassword();
      expect(second.body).toMatchObject({ locked: true, retry_after_seconds: 300 });

      const blocked = await start(ADMIN);
      expect(blocked.status).toBe(423);
      expect(blocked.body).toMatchObject({ reason: 'locked' });
      expect(blocked.body.retry_after_seconds).toBeGreaterThan(290);
      expect(logs.some((l) => l.obj.event === 'backoffice_login_blocked')).toBe(true);
    });

    it('le bon mot de passe ne débloque pas un identifiant verrouillé', async () => {
      await failFace();
      await letTimePass();
      await failFace();
      const blocked = await start(ADMIN);
      expect(blocked.status).toBe(423);
      expect(faceControl.calls.length).toBe(2); // aucune comparaison tant qu'il est verrouillé
    });

    it('la durée double à chaque verrouillage, avec un plafond', async () => {
      const lockSeconds = async () => {
        await failFace();
        await letTimePass();
        const res = await failFace();
        return res.body.retry_after_seconds as number;
      };
      expect(await lockSeconds()).toBe(300);
      await letTimePass();
      expect(await lockSeconds()).toBe(600);
      await letTimePass();
      expect(await lockSeconds()).toBe(1200);

      // plafonné à une heure
      await prisma.backofficeLockout.update({
        where: { identifier: ADMIN },
        data: { lockLevel: 6 },
      });
      await letTimePass();
      expect(await lockSeconds()).toBe(3600);
    });

    it('repart de zéro après une connexion réussie', async () => {
      await failFace();
      await letTimePass();
      const { id } = await faceStep();
      await sendPassword(id, ADMIN_PASSWORD);
      expect(
        await prisma.backofficeLockout.findUnique({ where: { identifier: ADMIN } }),
      ).toBeNull();
    });

    it('repart de zéro quand le dernier échec est ancien', async () => {
      await prisma.backofficeLockout.create({
        data: {
          identifier: ADMIN,
          lockLevel: 4,
          consecutiveFailures: 1,
          lastFailureAt: new Date(Date.now() - 2 * 3600 * 1000),
        },
      });
      const res = await failFace();
      expect(res.body).toMatchObject({ locked: false }); // 1 seul échec comptabilisé, niveau remis à zéro
    });

    it('des échecs simultanés ne se perdent pas (la ligne est verrouillée pendant le calcul)', async () => {
      const ids = await Promise.all(
        Array.from({ length: 6 }, async () => (await start(ADMIN)).body.session_id as string),
      );
      faceControl.result = { match: false, distance: 0.9 };
      await Promise.all(ids.map((id) => sendFace(id)));
      // 6 échecs, 2 par verrouillage : exactement 3 verrouillages, aucun échec perdu.
      expect(
        await prisma.backofficeLockout.findUniqueOrThrow({ where: { identifier: ADMIN } }),
      ).toMatchObject({
        lockLevel: 3,
        consecutiveFailures: 0,
      });
    });
  });

  // --- Ce qu'on ne doit pas révéler -----------------------------------------------------------------

  describe('identifiants inconnus et comptes non autorisés', () => {
    it('un identifiant inconnu suit le même parcours et échoue au visage, sans appeler le service', async () => {
      const started = await start('inconnu@lab.local');
      expect(started.status).toBe(201);
      expect(started.body.state).toBe('IDENTIFIED');
      const res = await sendFace(started.body.session_id);
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('face_not_recognized');
      expect(faceControl.calls).toEqual([]);
    });

    it('un identifiant inconnu se verrouille exactement comme un compte réel', async () => {
      await failFace('inconnu@lab.local');
      await letTimePass('inconnu@lab.local');
      const res = await failFace('inconnu@lab.local');
      expect(res.body).toMatchObject({ locked: true, retry_after_seconds: 300 });
    });

    it("la réponse met le même temps, que l'identifiant existe ou non (pas de fuite par le chronomètre)", async () => {
      const timed = async (identifier: string) => {
        const started = await start(identifier);
        const t0 = Date.now();
        await sendFace(started.body.session_id);
        return Date.now() - t0;
      };
      faceControl.result = { match: false, distance: 1 };
      const real = await timed(ADMIN);
      await letTimePass();
      const unknown = await timed('inconnu@lab.local');
      expect(real).toBeGreaterThanOrEqual(140);
      expect(unknown).toBeGreaterThanOrEqual(140);
    });

    it('un client ordinaire et un compte désactivé sont traités comme des inconnus', async () => {
      await prisma.user.create({
        data: {
          email: 'client@lab.local',
          passwordHash: await hashPassword('mot-de-passe-client-1'),
          roles: ['customer'],
        },
      });
      await prisma.user.create({
        data: {
          email: 'ancien@lab.local',
          passwordHash: await hashPassword('mot-de-passe-ancien-1'),
          roles: ['admin'],
          active: false,
        },
      });
      for (const identifier of ['client@lab.local', 'ancien@lab.local']) {
        const { face } = await faceStep(identifier, true);
        expect(face.status).toBe(401);
      }
      expect(faceControl.calls).toEqual([]); // le visage n'a même pas été comparé
    });

    it('un compte désactivé entre la photo et le mot de passe est refusé', async () => {
      const { id } = await faceStep();
      await prisma.user.update({ where: { email: ADMIN }, data: { active: false } });
      const res = await sendPassword(id, ADMIN_PASSWORD);
      expect(res.status).toBe(401);
      expect(res.body.access_token).toBeUndefined();
    });

    it('la connexion des clients refuse un compte admin, même avec le bon mot de passe', async () => {
      const res = await request(app)
        .post('/v1/login')
        .send({ email: ADMIN, password: ADMIN_PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body.access_token).toBeUndefined();
      expect(logs.find((l) => l.obj.event === 'login_failed')?.obj.reason).toBe(
        'backoffice_account',
      );
    });

    it('et refuse un compte client désactivé', async () => {
      await prisma.user.create({
        data: {
          email: 'gele@lab.local',
          passwordHash: await hashPassword('mot-de-passe-gele-1'),
          roles: ['customer'],
          active: false,
        },
      });
      const res = await request(app)
        .post('/v1/login')
        .send({ email: 'gele@lab.local', password: 'mot-de-passe-gele-1' });
      expect(res.status).toBe(401);
    });
  });

  // --- Ordre des étapes, expiration, photo ----------------------------------------------------------

  describe('ordre des étapes et robustesse', () => {
    it('refuse le mot de passe avant la photo, et une deuxième photo', async () => {
      const started = await start(ADMIN);
      const id = started.body.session_id;
      expect((await sendPassword(id, ADMIN_PASSWORD)).status).toBe(409);
      expect((await sendFace(id)).status).toBe(200);
      expect((await sendFace(id)).status).toBe(409);
    });

    it('404 pour une tentative inconnue, 422 pour un identifiant mal formé', async () => {
      expect((await sendFace('11111111-1111-4111-8111-111111111111')).status).toBe(404);
      expect((await request(app).get('/v1/backoffice/login/pas-un-uuid')).status).toBe(422);
      expect((await request(app).post('/v1/backoffice/login').send({})).status).toBe(422);
    });

    it('une tentative expirée est refusée (410) sans compter comme un échec, et éteint la LED', async () => {
      const { id } = await faceStep();
      await until(() => ledMessages.includes('green-blink'));
      await prisma.backofficeLogin.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await sendPassword(id, ADMIN_PASSWORD);
      expect(res.status).toBe(410);
      expect(res.body.reason).toBe('expired');
      expect(
        await prisma.backofficeLockout.findUnique({ where: { identifier: ADMIN } }),
      ).toBeNull();
    });

    it('la LED clignote en vert jusqu’à l’expiration de la tentative, puis s’éteint toute seule', async () => {
      process.env.BACKOFFICE_SESSION_TTL_SECONDS = '0.5';
      // La durée est lue à l'import : on vérifie plutôt l'échéance enregistrée.
      const { id } = await faceStep();
      const login = await prisma.backofficeLogin.findUniqueOrThrow({ where: { id } });
      const snapshot = LedServices.get();
      expect(snapshot.state).toBe('green-blink');
      expect(snapshot.until!.getTime()).toBeLessThanOrEqual(login.expiresAt.getTime() + 1500);
    });

    it('refuse une photo qui n’en est pas une : type, signature, taille', async () => {
      const id = (await start(ADMIN)).body.session_id;
      expect((await sendFace(id, photo(), 'text/plain')).status).toBe(415);
      expect((await sendFace(id, Buffer.from('<?php echo 1; ?>'), 'image/jpeg')).status).toBe(422);
      expect((await sendFace(id, Buffer.alloc(0), 'image/jpeg')).status).toBe(400);
      const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]);
      expect((await sendFace(id, huge, 'image/jpeg')).status).toBe(413);
      // Rien de tout cela n'a consommé la tentative.
      expect((await sendFace(id)).status).toBe(200);
    });

    it('accepte une photo PNG', async () => {
      const id = (await start(ADMIN)).body.session_id;
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        randomBytes(32),
      ]);
      expect((await sendFace(id, png, 'image/png')).status).toBe(200);
    });

    it("une panne du service de visage renvoie 503, sans compter d'échec ni verrouiller", async () => {
      faceControl.result = 'down';
      const id = (await start(ADMIN)).body.session_id;
      const res = await sendFace(id);
      expect(res.status).toBe(503);
      expect(res.body.reason).toBe('face_service_unavailable');
      expect(
        await prisma.backofficeLockout.findUnique({ where: { identifier: ADMIN } }),
      ).toBeNull();
      expect(ledMessages).toEqual([]);
      // la tentative reste utilisable quand le service revient
      faceControl.result = { match: true, distance: 0.4 };
      expect((await sendFace(id)).status).toBe(200);
    });

    it('deux photos simultanées pour la même tentative : une seule est traitée', async () => {
      const id = (await start(ADMIN)).body.session_id;
      const [a, b] = await Promise.all([sendFace(id), sendFace(id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });
  });

  // --- LED -------------------------------------------------------------------------------------------

  describe('LED', () => {
    it("l'état courant est lisible par le dashboard, les opérateurs et les admins, pas par les clients", async () => {
      await LedServices.set('red-solid', { holdSeconds: 5, reason: 'test' });
      const asOperator = await signer.sign('op-1', ['operator']);
      const res = await request(app)
        .get('/v1/devices/led')
        .set('Authorization', `Bearer ${asOperator}`);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('red-solid');
      expect(Date.parse(res.body.until)).toBeGreaterThan(Date.now());

      const asCustomer = await signer.sign('c-1', ['customer']);
      expect(
        (await request(app).get('/v1/devices/led').set('Authorization', `Bearer ${asCustomer}`))
          .status,
      ).toBe(403);
      expect((await request(app).get('/v1/devices/led')).status).toBe(401);
    });

    it("un nouvel état annule l'échéance de l'ancien (pas d'extinction fantôme)", async () => {
      await LedServices.set('red-solid', { holdSeconds: 0.2, reason: 'test' });
      await LedServices.set('green-blink', { holdSeconds: 5, reason: 'test' });
      await wait(400);
      expect(LedServices.get().state).toBe('green-blink');
      expect(ledMessages).toEqual(['red-solid', 'green-blink']);
    });

    it('au démarrage, la LED est éteinte', async () => {
      await LedServices.set('green-solid', { reason: 'test' });
      await LedServices.reset();
      await until(() => ledMessages.at(-1) === 'off');
    });

    it('une panne du broker ne casse pas la connexion : elle est journalisée et comptée', async () => {
      const { publisher } = await import('../src/lib/mqtt.js');
      const spy = vi.spyOn(publisher, 'publish').mockRejectedValue(new Error('broker injoignable'));
      const { id } = await faceStep();
      const granted = await sendPassword(id, ADMIN_PASSWORD);
      expect(granted.status).toBe(200);
      expect(logs.some((l) => l.obj.event === 'led_publish_failed')).toBe(true);
      const metrics = (await request(app).get('/metrics')).text;
      expect(metrics).toMatch(/auth_led_publish_total\{result="failed",service="auth"\} [1-9]/);
      spy.mockRestore();
    });
  });

  describe('LED lente ou injoignable', () => {
    it('une publication MQTT lente ne retarde jamais la réponse de la connexion', async () => {
      const { publisher } = await import('../src/lib/mqtt.js');
      const spy = vi
        .spyOn(publisher, 'publish')
        .mockImplementation(
          () =>
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('lent')), 2000)),
        );
      const { id } = await faceStep();
      const t0 = Date.now();
      const granted = await sendPassword(id, ADMIN_PASSWORD);
      expect(granted.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(1000);
      spy.mockRestore();
    });
  });

  describe('métriques', () => {
    it('comptent les étapes de la connexion', async () => {
      const before = (await request(app).get('/metrics')).text;
      const value = (text: string, result: string) =>
        Number(
          new RegExp(
            `auth_backoffice_logins_total\\{result="${result}",service="auth"\\} (\\d+)`,
          ).exec(text)?.[1] ?? 0,
        );
      await failFace();
      await letTimePass();
      const { id } = await faceStep();
      await sendPassword(id, ADMIN_PASSWORD);
      const after = (await request(app).get('/metrics')).text;
      expect(value(after, 'started') - value(before, 'started')).toBe(2);
      expect(value(after, 'face_refused') - value(before, 'face_refused')).toBe(1);
      expect(value(after, 'face_ok') - value(before, 'face_ok')).toBe(1);
      expect(value(after, 'granted') - value(before, 'granted')).toBe(1);
    });
  });
});
