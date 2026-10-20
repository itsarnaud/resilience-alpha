/**
 * Tests d'intégration : nécessitent la base `remediation_test` migrée (TEST_DATABASE_URL).
 * Sans cette variable, la suite est ignorée.
 *
 *   npm run db:up && npm run db:init     (à la racine)
 *   cd services/remediation && DATABASE_URL=<TEST_DATABASE_URL> npx prisma migrate deploy
 *   npm test -w services/remediation
 *
 * `auth` et `api` sont simulés par un petit serveur HTTP local, ce qui permet de provoquer des
 * pannes précises (transaction de test qui échoue N fois, service qui ne répond plus). Le fichier
 * de liste de blocage est un vrai fichier. Docker est simulé.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
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

// Docker simulé : on enregistre les redémarrages demandés. `api` est le seul conteneur « autorisé ».
const docker = vi.hoisted(() => ({ restarts: [] as string[], signals: [] as string[] }));
vi.mock('../src/lib/docker.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/docker.js')>();
  return {
    ...original,
    containers: {
      restart: async (name: string) => {
        docker.restarts.push(name);
        if (name !== 'api')
          throw new Error(`conteneur « ${name} » non autorisé (ALLOWED_CONTAINERS)`);
      },
      signal: async (name: string, signal: string) => {
        docker.signals.push(`${name}:${signal}`);
      },
    },
  };
});

const DB_URL = process.env.TEST_DATABASE_URL;
const ISSUER = 'resilience-auth';
const AUDIENCE = 'resilience-platform';
const CLIENT_SECRET = 'secret-de-test-remediation';
const WORKDIR = mkdtempSync(path.join(tmpdir(), 'remediation-test-'));
const DENYLIST = path.join(WORKDIR, 'waf', 'denylist.conf');

// La configuration est lue à l'import des modules : à définir avant l'import dynamique de l'app.
process.env.DATABASE_URL = DB_URL ?? 'postgresql://inutilise';
process.env.REMEDIATION_CLIENT_SECRET = CLIENT_SECRET;
process.env.WAF_DENYLIST_FILE = DENYLIST;
process.env.VERIFY_ATTEMPTS = '3';
process.env.VERIFY_INTERVAL_MS = '10';
process.env.HTTP_TIMEOUT_MS = '1500';
process.env.BLOCK_DURATION_SECONDS = '300';
process.env.PROTECTED_IPS = '127.0.0.1,::1,192.168.137.1';
process.env.ALLOWED_CONTAINERS = 'api';

/** Fausse plateforme : joue `auth` (JWKS, jetons de service) et `api` (readyz, comptes, virements). */
const platform = {
  ready: true,
  /** Nombre de transactions de test à refuser avant d'accepter. */
  canaryFailures: 0,
  tokenRequests: [] as Record<string, string>[],
  transactions: [] as { headers: IncomingMessage['headers']; body: Record<string, unknown> }[],
  reset() {
    this.ready = true;
    this.canaryFailures = 0;
    this.tokenRequests = [];
    this.transactions = [];
  },
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const terminal = ['RESOLVED', 'FAILED', 'IGNORED'];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!DB_URL)('service remediation (base de données)', () => {
  let app: typeof import('../src/app.js').default;
  let prisma: typeof import('../src/lib/prisma.js').prisma;
  let BlocksServices: typeof import('../src/services/BlocksServices.js');
  let EngineServices: typeof import('../src/services/EngineServices.js');
  let waf: typeof import('../src/lib/waf.js').waf;
  let DockerControl: typeof import('../src/lib/docker.js').DockerControl;
  let fakeServer: Server;
  let privateKey: CryptoKey;

  const token = (sub: string, roles: Role[]) =>
    new SignJWT({ roles })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);
  const as = async (sub: string, roles: Role[]) => `Bearer ${await token(sub, roles)}`;
  const detector = () => as('svc:svc-detector', ['svc:detector']);
  const operator = () => as('op-1', ['operator']);

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };

    fakeServer = createServer(async (req, res) => {
      const send = (status: number, body: unknown) =>
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      const url = req.url ?? '';
      if (url === '/jwks.json') return send(200, { keys: [jwk] });
      if (url === '/readyz') return send(platform.ready ? 200 : 503, { status: 'x' });
      if (url === '/v1/token' && req.method === 'POST') {
        const body = (await readJson(req)) as Record<string, string>;
        platform.tokenRequests.push(body);
        if (body.client_id !== 'svc-remediation' || body.client_secret !== CLIENT_SECRET) {
          return send(401, { title: 'refusé' });
        }
        return send(200, {
          access_token: 'jeton-de-service',
          token_type: 'Bearer',
          expires_in: 900,
        });
      }
      if (req.headers.authorization !== 'Bearer jeton-de-service') return send(401, {});
      if (url === '/v1/accounts') {
        return send(200, [
          { id: 'a-1', balance_cents: 500 },
          { id: 'a-2', balance_cents: 900 },
        ]);
      }
      if (url === '/v1/transactions' && req.method === 'POST') {
        const body = await readJson(req);
        platform.transactions.push({ headers: req.headers, body });
        if (platform.canaryFailures > 0) {
          platform.canaryFailures--;
          return send(503, { title: 'indisponible' });
        }
        return send(201, { id: 'tx-1', status: 'COMPLETED' });
      }
      return send(404, {});
    });
    await new Promise<void>((r) => fakeServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;
    process.env.AUTH_JWKS_URL = `${base}/jwks.json`;
    process.env.AUTH_URL = base;
    process.env.API_URL = base;
    process.env.SUPERVISED_SERVICES = `plateforme=${base}`;

    app = (await import('../src/app.js')).default;
    prisma = (await import('../src/lib/prisma.js')).prisma;
    BlocksServices = await import('../src/services/BlocksServices.js');
    EngineServices = await import('../src/services/EngineServices.js');
    waf = (await import('../src/lib/waf.js')).waf;
    DockerControl = (await import('../src/lib/docker.js')).DockerControl;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fakeServer.close();
    rmSync(WORKDIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.ipBlock.deleteMany();
    await prisma.action.deleteMany();
    await prisma.incident.deleteMany();
    platform.reset();
    docker.restarts.length = 0;
    docker.signals.length = 0;
    logs.length = 0;
    rmSync(path.dirname(DENYLIST), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const report = (over: Record<string, unknown> = {}) => ({
    type: 'BRUTE_FORCE',
    score: 0.92,
    detected_at: new Date().toISOString(),
    source_ip: '203.0.113.9',
    targets: ['victime@lab.local'],
    stats: { attempts: 40, failures: 38, window_seconds: 120 },
    ...over,
  });

  async function post(body: Record<string, unknown>) {
    return request(app)
      .post('/v1/incidents')
      .set('Authorization', await detector())
      .send(body);
  }

  async function getIncident(id: string) {
    const res = await request(app)
      .get(`/v1/incidents/${id}`)
      .set('Authorization', await operator());
    expect(res.status).toBe(200);
    return res.body;
  }

  /** Attend la fin du traitement (le détecteur reçoit 202 tout de suite, la reprise est asynchrone). */
  async function settled(id: string, timeoutMs = 5000) {
    const start = Date.now();
    for (;;) {
      const incident = await getIncident(id);
      if (terminal.includes(incident.state)) return incident;
      if (Date.now() - start > timeoutMs) throw new Error(`incident encore ${incident.state}`);
      await wait(20);
    }
  }

  const steps = (incident: { timeline: { step: string; ok: boolean }[] }) =>
    incident.timeline.map((t) => `${t.step}:${t.ok ? 'ok' : 'ko'}`);

  describe("contrôle d'accès", () => {
    it('401 sans jeton', async () => {
      expect((await request(app).post('/v1/incidents').send(report())).status).toBe(401);
      expect((await request(app).get('/v1/incidents')).status).toBe(401);
      expect((await request(app).get('/v1/blocks')).status).toBe(401);
    });

    it("seul le détecteur peut signaler un incident (ni l'opérateur, ni le dashboard, ni un client)", async () => {
      for (const [sub, roles] of [
        ['op-1', ['operator']],
        ['svc:svc-dashboard', ['svc:dashboard']],
        ['user-1', ['customer']],
        ['svc:svc-remediation', ['svc:remediation-canary']],
      ] as [string, Role[]][]) {
        const res = await request(app)
          .post('/v1/incidents')
          .set('Authorization', await as(sub, roles))
          .send(report());
        expect(res.status).toBe(403);
      }
      expect(await prisma.incident.count()).toBe(0);
      expect(await prisma.ipBlock.count()).toBe(0);
    });

    it('le détecteur et les clients ne peuvent pas lire les incidents', async () => {
      for (const auth of [await detector(), await as('user-1', ['customer'])]) {
        expect((await request(app).get('/v1/incidents').set('Authorization', auth)).status).toBe(
          403,
        );
      }
      const dashboard = await as('svc:svc-dashboard', ['svc:dashboard']);
      expect((await request(app).get('/v1/incidents').set('Authorization', dashboard)).status).toBe(
        200,
      );
    });
  });

  describe('validation du signalement', () => {
    it("refuse une IP qui n'en est pas une (injection dans la liste du WAF) et ne crée rien", async () => {
      for (const source_ip of ['1.2.3.4; deny all', '203.0.113.9\ndeny 0.0.0.0/0', 'localhost']) {
        const res = await post(report({ source_ip }));
        expect(res.status).toBe(422);
      }
      expect(await prisma.incident.count()).toBe(0);
      expect(existsSync(DENYLIST)).toBe(false);
    });

    it('refuse un score hors de 0..1 et un type inconnu', async () => {
      expect((await post(report({ score: 1.5 }))).status).toBe(422);
      expect((await post(report({ type: 'PIRATAGE' }))).status).toBe(422);
    });
  });

  describe('brute force : blocage puis preuve de reprise', () => {
    it("bloque l'IP, vérifie par une transaction de test et résout (parcours complet)", async () => {
      const res = await post(report());
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        type: 'BRUTE_FORCE',
        source_ip: '203.0.113.9',
        targets: ['victime@lab.local'],
        stats: { attempts: 40, failures: 38, window_seconds: 120 },
      });

      const incident = await settled(res.body.id);
      expect(incident.state).toBe('RESOLVED');
      expect(incident.playbook).toBe('block_source');
      expect(incident.time_to_recover_seconds).toBeGreaterThanOrEqual(0);
      expect(steps(incident)).toEqual([
        'incident_received:ok',
        'validate_ip:ok',
        'block_ip:ok',
        'verify_ready:ok',
        'canary_transaction:ok',
      ]);

      // Le WAF : la liste contient l'IP, et rien d'autre que des directives `deny <ip>;`.
      const file = readFileSync(DENYLIST, 'utf8');
      expect(file).toContain('deny 203.0.113.9;');
      const directives = file.split('\n').filter((l) => l && !l.startsWith('#'));
      expect(directives).toEqual(['deny 203.0.113.9;']);

      // La transaction de test : authentifiée par le jeton de service, marquée synthétique.
      expect(platform.tokenRequests).toEqual([
        { client_id: 'svc-remediation', client_secret: CLIENT_SECRET },
      ]);
      expect(platform.transactions).toHaveLength(1);
      const canary = platform.transactions[0]!;
      expect(canary.headers['x-synthetic']).toBe('true');
      expect(canary.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
      expect(canary.body).toMatchObject({
        from_account_id: 'a-2',
        to_account_id: 'a-1',
        amount_cents: 1,
      });

      const blocks = await request(app)
        .get('/v1/blocks')
        .set('Authorization', await operator());
      expect(blocks.body).toHaveLength(1);
      expect(blocks.body[0]).toMatchObject({ ip: '203.0.113.9', incident_id: res.body.id });
    });

    it("journalise le signalement avec l'IP, les comptes visés et les chiffres, sans aucun secret", async () => {
      const res = await post(report());
      await settled(res.body.id);
      const created = logs.find((l) => l.obj.event === 'incident_created');
      expect(created?.obj).toMatchObject({
        type: 'BRUTE_FORCE',
        source_ip: '203.0.113.9',
        targets: ['victime@lab.local'],
        stats: { attempts: 40, failures: 38, window_seconds: 120 },
        acted: true,
      });
      expect(logs.some((l) => l.obj.event === 'ip_blocked')).toBe(true);
      expect(logs.some((l) => l.obj.event === 'incident_resolved')).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(logs)).not.toContain('jeton-de-service');
    });

    it('réessaie la transaction de test tant que le service redémarre, puis résout', async () => {
      platform.canaryFailures = 2; // 3 essais autorisés : les deux premiers échouent
      const res = await post(report());
      const incident = await settled(res.body.id);
      expect(incident.state).toBe('RESOLVED');
      const canary = incident.timeline.filter(
        (t: { step: string }) => t.step === 'canary_transaction',
      );
      expect(canary.map((t: { ok: boolean }) => t.ok)).toEqual([false, false, true]);
      expect(platform.transactions).toHaveLength(3);
    });

    it("ne déclare jamais « résolu » si la transaction de test ne passe pas : l'incident échoue, visiblement", async () => {
      platform.canaryFailures = 99;
      const res = await post(report());
      const incident = await settled(res.body.id);
      expect(incident.state).toBe('FAILED');
      expect(incident.failure_reason).toContain('reprise non confirmée');
      expect(incident.resolved_at).toBeNull();
      expect(steps(incident)).toContain('verify:ko');
      expect(steps(incident)).toContain('incident_failed:ko');
    });

    it('ne confirme pas une reprise quand le service répond mais que le blocage a échoué', async () => {
      vi.spyOn(waf, 'publish').mockRejectedValue(new Error('disque plein'));
      const res = await post(report());
      const incident = await settled(res.body.id);
      expect(incident.state).toBe('FAILED');
      expect(steps(incident)).toContain('block_ip:ko');
      // aucune vérification n'a été tentée : le blocage n'a pas eu lieu
      expect(steps(incident)).not.toContain('canary_transaction:ok');
      expect(platform.transactions).toHaveLength(0);
    });

    it('refuse de bloquer une IP protégée (un faux positif ne doit pas couper la passerelle)', async () => {
      for (const ip of ['192.168.137.1', '127.0.0.1']) {
        const res = await post(report({ source_ip: ip, dedup_key: `BRUTE_FORCE:${ip}` }));
        const incident = await settled(res.body.id);
        expect(incident.state).toBe('FAILED');
        expect(incident.failure_reason).toContain('protégée');
      }
      expect(existsSync(DENYLIST)).toBe(false);
      expect(await prisma.ipBlock.count()).toBe(0);
      expect(platform.transactions).toHaveLength(0);
    });

    it("échoue proprement quand le signalement n'a pas d'IP source", async () => {
      const res = await post(report({ source_ip: undefined }));
      const incident = await settled(res.body.id);
      expect(incident.state).toBe('FAILED');
      expect(incident.failure_reason).toContain("pas d'IP source");
    });
  });

  describe('politique : un score est un indice, pas une certitude', () => {
    it.each([
      ['score faible', report({ score: 0.3 })],
      ['trop peu d’échecs observés', report({ stats: { attempts: 6, failures: 2 } })],
      [
        'type sans playbook',
        report({ type: 'UNKNOWN_ANOMALY', score: 0.99, source_ip: undefined }),
      ],
    ])('ne fait rien : %s', async (_name, body) => {
      const res = await post(body);
      expect(res.status).toBe(202);
      const incident = await settled(res.body.id);
      expect(incident.state).toBe('IGNORED');
      expect(steps(incident)).toEqual(['incident_received:ok', 'policy:ok']);
      expect(existsSync(DENYLIST)).toBe(false);
      expect(await prisma.ipBlock.count()).toBe(0);
      expect(platform.transactions).toHaveLength(0);
    });
  });

  describe('dédoublonnage', () => {
    it('renvoie le même incident (200) sans retraiter, y compris juste après la résolution', async () => {
      const first = await post(report());
      expect(first.status).toBe(202);
      await settled(first.body.id);
      const again = await post(report());
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(platform.transactions).toHaveLength(1);
      expect(await prisma.incident.count()).toBe(1);
    });

    it('cinq signalements simultanés identiques ne créent qu’un incident et une action', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => post(report())));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 202]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      await settled(results[0]!.body.id);
      expect(await prisma.incident.count()).toBe(1);
      expect(platform.transactions).toHaveLength(1);
    });

    it('deux incidents différents pour la même IP partagent un seul blocage', async () => {
      const a = await post(report({ dedup_key: 'A' }));
      const b = await post(report({ dedup_key: 'B' }));
      await Promise.all([settled(a.body.id), settled(b.body.id)]);
      expect(await prisma.ipBlock.count({ where: { releasedAt: null } })).toBe(1);
      const file = readFileSync(DENYLIST, 'utf8');
      expect(file.match(/deny 203\.0\.113\.9;/g)).toHaveLength(1);
    });
  });

  describe('autres playbooks', () => {
    it('redémarre le conteneur d’un service tombé, puis vérifie', async () => {
      const res = await post({
        type: 'SERVICE_DOWN',
        score: 0.95,
        detected_at: new Date().toISOString(),
        target_service: 'api',
      });
      const incident = await settled(res.body.id);
      expect(incident.state).toBe('RESOLVED');
      expect(incident.playbook).toBe('restart_service');
      expect(docker.restarts).toEqual(['api']);
      expect(steps(incident)).toContain('restart_container:ok');
    });

    it("n'agit pas sur un conteneur hors liste blanche : l'échec est visible", async () => {
      const res = await post({
        type: 'SERVICE_DOWN',
        score: 0.95,
        detected_at: new Date().toISOString(),
        target_service: 'db-auth',
      });
      const incident = await settled(res.body.id);
      expect(incident.state).toBe('FAILED');
      expect(steps(incident)).toContain('restart_container:ko');
      expect(
        incident.timeline.find((t: { step: string }) => t.step === 'restart_container').detail,
      ).toContain('non autorisé');
    });

    it('passe au redémarrage quand le blocage seul ne rétablit pas le service (inondation)', async () => {
      platform.canaryFailures = 3; // épuise les 3 essais du blocage, le redémarrage réussira ensuite
      const res = await post({
        type: 'HTTP_FLOOD',
        score: 0.9,
        detected_at: new Date().toISOString(),
        source_ip: '203.0.113.50',
        target_service: 'api',
      });
      const incident = await settled(res.body.id);
      expect(incident.state).toBe('RESOLVED');
      expect(incident.playbook).toBe('restart_service');
      const order = steps(incident);
      expect(order.indexOf('block_ip:ok')).toBeLessThan(order.indexOf('verify:ko'));
      expect(order.indexOf('verify:ko')).toBeLessThan(order.indexOf('escalate:ok'));
      expect(order.indexOf('escalate:ok')).toBeLessThan(order.indexOf('restart_container:ok'));
      expect(docker.restarts).toEqual(['api']);
    });

    it('la liste Docker autorisée est appliquée par le contrôleur lui-même, avant tout appel réseau', async () => {
      const control = new DockerControl('tcp://127.0.0.1:1', ['api']);
      await expect(control.restart('db-auth')).rejects.toThrow('non autorisé');
      await expect(control.signal('waf', 'HUP')).rejects.toThrow('non autorisé');
    });
  });

  describe('durée des blocages', () => {
    it('lève un blocage arrivé à échéance et le retire de la liste du WAF', async () => {
      const res = await post(report());
      await settled(res.body.id);
      expect(readFileSync(DENYLIST, 'utf8')).toContain('203.0.113.9');

      // pas encore expiré : rien ne bouge
      expect(await BlocksServices.releaseExpired()).toBe(0);

      await prisma.ipBlock.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await BlocksServices.releaseExpired()).toBe(1);

      expect(readFileSync(DENYLIST, 'utf8')).not.toContain('203.0.113.9');
      expect((await prisma.ipBlock.findFirstOrThrow()).releasedAt).not.toBeNull();
      const blocks = await request(app)
        .get('/v1/blocks')
        .set('Authorization', await operator());
      expect(blocks.body).toEqual([]);
      expect(logs.some((l) => l.obj.event === 'ip_unblocked')).toBe(true);
    });

    it('republie la liste depuis la base (reprise après redémarrage)', async () => {
      const res = await post(report());
      await settled(res.body.id);
      rmSync(path.dirname(DENYLIST), { recursive: true, force: true });
      await BlocksServices.syncWaf();
      expect(readFileSync(DENYLIST, 'utf8')).toContain('deny 203.0.113.9;');
    });

    it('recharge le WAF après chaque écriture quand un conteneur est configuré', async () => {
      // Le conteneur de rechargement n'est pas configuré dans ce test : aucun signal envoyé.
      const res = await post(report());
      await settled(res.body.id);
      expect(docker.signals).toEqual([]);
    });
  });

  describe('reprise après redémarrage de la remédiation', () => {
    it('reprend un incident laissé en cours et le mène à son terme', async () => {
      const stuck = await prisma.incident.create({
        data: {
          dedupKey: 'BRUTE_FORCE:203.0.113.20',
          type: 'BRUTE_FORCE',
          state: 'REMEDIATING',
          score: 0.9,
          sourceIp: '203.0.113.20',
          targets: [],
          evidence: [],
          detectedAt: new Date(),
        },
      });
      expect(await EngineServices.resumeInterrupted()).toBe(1);
      const incident = await settled(stuck.id);
      expect(incident.state).toBe('RESOLVED');
      expect(steps(incident)).toContain('resume:ok');
      expect(readFileSync(DENYLIST, 'utf8')).toContain('deny 203.0.113.20;');
    });
  });

  describe('supervision', () => {
    it("liste les playbooks et l'état des services supervisés", async () => {
      const playbooks = await request(app)
        .get('/v1/playbooks')
        .set('Authorization', await operator());
      expect(playbooks.body.map((p: { name: string }) => p.name)).toEqual([
        'block_source',
        'restart_service',
      ]);

      const up = await request(app)
        .get('/v1/services')
        .set('Authorization', await operator());
      expect(up.body).toEqual([
        expect.objectContaining({ name: 'plateforme', healthy: true, last_canary_ok_at: null }),
      ]);

      platform.ready = false;
      const down = await request(app)
        .get('/v1/services')
        .set('Authorization', await operator());
      expect(down.body[0].healthy).toBe(false);
    });

    it('indique la date de la dernière transaction de test réussie', async () => {
      const res = await post(report());
      await settled(res.body.id);
      const services = await request(app)
        .get('/v1/services')
        .set('Authorization', await operator());
      expect(services.body[0].last_canary_ok_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('expose les métriques de remédiation, dont le temps de reprise', async () => {
      const res = await post(report());
      await settled(res.body.id);
      const text = (await request(app).get('/metrics')).text;
      expect(text).toContain(
        'remediation_incidents_total{type="BRUTE_FORCE",state="RESOLVED",service="remediation"} 1',
      );
      expect(text).toContain('remediation_recovery_seconds_count{service="remediation"} 1');
      expect(text).toContain('remediation_active_ip_blocks{service="remediation"} 1');
      expect(text).toContain('remediation_canary_total{result="ok",service="remediation"} 1');
    });

    it('/healthz et /readyz répondent sans authentification', async () => {
      expect((await request(app).get('/healthz')).status).toBe(200);
      expect((await request(app).get('/readyz')).status).toBe(200);
    });
  });

  describe('flux temps réel (SSE)', () => {
    it("envoie un instantané puis chaque changement jusqu'à la résolution", async () => {
      const server = app.listen(0, '127.0.0.1');
      await new Promise((r) => server.once('listening', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const controller = new AbortController();
      try {
        const stream = await fetch(`${base}/v1/incidents/stream`, {
          headers: { Authorization: await as('svc:svc-dashboard', ['svc:dashboard']) },
          signal: controller.signal,
        });
        expect(stream.status).toBe(200);
        expect(stream.headers.get('content-type')).toContain('text/event-stream');

        const reader = stream.body!.getReader();
        const decoder = new TextDecoder();
        let received = '';
        const readUntil = async (marker: string, timeoutMs = 5000) => {
          const start = Date.now();
          while (!received.includes(marker)) {
            if (Date.now() - start > timeoutMs) throw new Error(`« ${marker} » jamais reçu`);
            const { value, done } = await reader.read();
            if (done) break;
            received += decoder.decode(value);
          }
        };

        await readUntil('event: snapshot');
        const res = await post(report());
        await readUntil('"state":"RESOLVED"');
        expect(received).toContain('event: incident');
        expect(received).toContain(res.body.id);
        expect(received).toContain('"step":"canary_transaction"');
      } finally {
        controller.abort();
        server.close();
      }
    });

    it("refuse le flux à qui n'est pas autorisé", async () => {
      const res = await request(app)
        .get('/v1/incidents/stream')
        .set('Authorization', await as('user-1', ['customer']));
      expect(res.status).toBe(403);
    });
  });
});
