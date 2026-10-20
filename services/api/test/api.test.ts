/**
 * Tests d'intégration : nécessitent la base `payments_test` migrée (TEST_DATABASE_URL).
 * Sans cette variable, la suite est ignorée.
 *
 *   npm run db:up && npm run db:init     (à la racine)
 *   cd services/api && DATABASE_URL=<TEST_DATABASE_URL> npx prisma migrate deploy
 *   npm test -w services/api
 *
 * Les jetons sont signés avec une clé de test ; un petit serveur HTTP sert son JWKS, ce qui exerce
 * la vraie vérification de jeton de l'API (clés récupérées à distance).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@resilience/shared';

type LogEntry = { level: string; obj: Record<string, unknown>; msg?: string };

// Le logger est un singleton du service : on le remplace pour lire ce qui est journalisé.
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
const ISSUER = 'resilience-auth';
const AUDIENCE = 'resilience-platform';
// La configuration est lue à l'import des modules : à définir avant l'import dynamique de l'app.
process.env.DATABASE_URL = DB_URL ?? 'postgresql://inutilise';
process.env.EXTERNAL_TRANSFER_LIMIT_CENTS = '50000';
process.env.INITIAL_BALANCE_CENTS = '100000';

/** Valeur courante d'une série Prometheus (0 si elle n'existe pas encore). */
function metricValue(text: string, series: string): number {
  const line = text.split('\n').find((l) => l.startsWith(series));
  return line ? Number(line.split(' ').pop()) : 0;
}

describe.skipIf(!DB_URL)('service api (base de données)', () => {
  let app: typeof import('../src/app.js').default;
  let prisma: typeof import('../src/lib/prisma.js').prisma;
  let jwksServer: Server;
  let privateKey: CryptoKey;

  const token = (sub: string, roles: Role[]) =>
    new SignJWT({ roles })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);

  const as = async (sub: string, roles: Role[] = ['customer']) =>
    `Bearer ${await token(sub, roles)}`;
  const key = () => crypto.randomUUID();

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
    jwksServer = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
    process.env.AUTH_JWKS_URL = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks.json`;

    app = (await import('../src/app.js')).default;
    prisma = (await import('../src/lib/prisma.js')).prisma;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    jwksServer.close();
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany();
    await prisma.beneficiary.deleteMany();
    await prisma.account.deleteMany();
    logs.length = 0;
  });

  /** Ouvre un compte pour `sub` avec un solde donné (par défaut : le solde initial). */
  async function openAccount(sub: string, balanceCents?: number) {
    const res = await request(app)
      .post('/v1/accounts')
      .set('Authorization', await as(sub));
    expect(res.status).toBe(201);
    if (balanceCents !== undefined) {
      await prisma.account.update({ where: { id: res.body.id }, data: { balanceCents } });
    }
    return res.body as { id: string; iban: string; balance_cents: number };
  }

  async function transfer(
    sub: string,
    body: Record<string, unknown>,
    opts: { key?: string; roles?: Role[]; synthetic?: boolean } = {},
  ) {
    const req = request(app)
      .post('/v1/transactions')
      .set('Authorization', await as(sub, opts.roles))
      .set('Idempotency-Key', opts.key ?? key());
    if (opts.synthetic) req.set('X-Synthetic', 'true');
    return req.send(body);
  }

  const balanceOf = async (id: string) =>
    (await prisma.account.findUniqueOrThrow({ where: { id } })).balanceCents;

  describe('santé', () => {
    it('/healthz, /readyz et /metrics répondent sans authentification', async () => {
      expect((await request(app).get('/healthz')).status).toBe(200);
      expect((await request(app).get('/readyz')).status).toBe(200);
      const metrics = await request(app).get('/metrics');
      expect(metrics.status).toBe(200);
      expect(metrics.text).toContain('payments_transactions_total');
    });
  });

  describe('authentification', () => {
    it('401 sans jeton, et sur toutes les routes métier', async () => {
      for (const path of ['/v1/accounts', '/v1/transactions', '/v1/beneficiaries']) {
        expect((await request(app).get(path)).status).toBe(401);
      }
    });

    it('403 pour un rôle non autorisé (operator)', async () => {
      const res = await request(app)
        .get('/v1/accounts')
        .set('Authorization', await as('op-1', ['operator']));
      expect(res.status).toBe(403);
    });
  });

  describe('comptes', () => {
    it('ouvre un compte avec le solde initial et un IBAN fictif, et liste seulement les siens', async () => {
      const mine = await openAccount('user-a');
      await openAccount('user-b');
      expect(mine.balance_cents).toBe(100_000);
      expect(mine.iban).toMatch(/^FR76\d{23}$/);

      const list = await request(app)
        .get('/v1/accounts')
        .set('Authorization', await as('user-a'));
      expect(list.body).toHaveLength(1);
      expect(list.body[0].id).toBe(mine.id);
    });

    it("traite le compte d'un autre comme inexistant (404)", async () => {
      const theirs = await openAccount('user-b');
      const res = await request(app)
        .get(`/v1/accounts/${theirs.id}`)
        .set('Authorization', await as('user-a'));
      expect(res.status).toBe(404);
    });

    it('limite le nombre de comptes par client', async () => {
      for (let i = 0; i < 5; i++) await openAccount('user-a');
      const res = await request(app)
        .post('/v1/accounts')
        .set('Authorization', await as('user-a'));
      expect(res.status).toBe(409);
    });

    it('le canari peut lire ses comptes mais pas en ouvrir', async () => {
      const res = await request(app)
        .post('/v1/accounts')
        .set('Authorization', await as('svc:svc-remediation', ['svc:remediation-canary']));
      expect(res.status).toBe(403);
    });
  });

  describe('virements internes', () => {
    it('débite et crédite de façon cohérente', async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const res = await transfer('user-a', {
        from_account_id: a.id,
        to_account_id: b.id,
        amount_cents: 25_000,
        label: 'loyer',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'COMPLETED',
        amount_cents: 25_000,
        synthetic: false,
      });
      expect(await balanceOf(a.id)).toBe(75_000);
      expect(await balanceOf(b.id)).toBe(125_000);
    });

    it('rejoue sans doublon avec la même Idempotency-Key (200 et un seul débit)', async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const k = key();
      const body = { from_account_id: a.id, to_account_id: b.id, amount_cents: 10_000 };
      const first = await transfer('user-a', body, { key: k });
      const second = await transfer('user-a', body, { key: k });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(await balanceOf(a.id)).toBe(90_000);
    });

    it('refuse (409) une Idempotency-Key réutilisée avec un autre montant', async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const k = key();
      await transfer(
        'user-a',
        { from_account_id: a.id, to_account_id: b.id, amount_cents: 100 },
        { key: k },
      );
      const res = await transfer(
        'user-a',
        { from_account_id: a.id, to_account_id: b.id, amount_cents: 999 },
        { key: k },
      );
      expect(res.status).toBe(409);
      expect(await balanceOf(a.id)).toBe(99_900);
    });

    it("exige l'en-tête Idempotency-Key", async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const res = await request(app)
        .post('/v1/transactions')
        .set('Authorization', await as('user-a'))
        .send({ from_account_id: a.id, to_account_id: b.id, amount_cents: 100 });
      expect(res.status).toBe(400);
    });

    it('402 si le solde est insuffisant : rien ne bouge, le refus est enregistré', async () => {
      const a = await openAccount('user-a', 1_000);
      const b = await openAccount('user-b');
      const res = await transfer('user-a', {
        from_account_id: a.id,
        to_account_id: b.id,
        amount_cents: 5_000,
      });
      expect(res.status).toBe(402);
      expect(res.body.reason).toBe('insufficient_funds');
      expect(await balanceOf(a.id)).toBe(1_000);
      expect(await balanceOf(b.id)).toBe(100_000);
      const rejected = await prisma.transaction.findMany({ where: { status: 'REJECTED' } });
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.rejectReason).toBe('insufficient_funds');
    });

    it('refuse un montant nul, négatif ou décimal (422)', async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      for (const amount_cents of [0, -5, 10.5]) {
        const res = await transfer('user-a', {
          from_account_id: a.id,
          to_account_id: b.id,
          amount_cents,
        });
        expect(res.status).toBe(422);
      }
    });

    it("ne permet pas de débiter le compte d'un autre (404) ni de virer vers soi-même (400)", async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const stolen = await transfer('user-a', {
        from_account_id: b.id,
        to_account_id: a.id,
        amount_cents: 100,
      });
      expect(stolen.status).toBe(404);
      const self = await transfer('user-a', {
        from_account_id: a.id,
        to_account_id: a.id,
        amount_cents: 100,
      });
      expect(self.status).toBe(400);
      expect(await balanceOf(b.id)).toBe(100_000);
    });

    it("n'accepte jamais plus que le solde, même avec des virements simultanés", async () => {
      const a = await openAccount('user-a', 100_000);
      const b = await openAccount('user-b', 0);
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          transfer('user-a', { from_account_id: a.id, to_account_id: b.id, amount_cents: 30_000 }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(3);
      expect(statuses.filter((s) => s === 402)).toHaveLength(3);
      expect(await balanceOf(a.id)).toBe(10_000);
      expect(await balanceOf(b.id)).toBe(90_000);
    });

    it('garde la somme des soldes constante sur des virements croisés simultanés', async () => {
      const a = await openAccount('user-a', 50_000);
      const b = await openAccount('user-b', 50_000);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          i % 2 === 0
            ? transfer('user-a', {
                from_account_id: a.id,
                to_account_id: b.id,
                amount_cents: 1_000,
              })
            : transfer('user-b', {
                from_account_id: b.id,
                to_account_id: a.id,
                amount_cents: 1_000,
              }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true); // jamais de 500 (interblocage)
      expect((await balanceOf(a.id)) + (await balanceOf(b.id))).toBe(100_000);
    });

    it("ne produit jamais d'erreur serveur sous une charge croisée (virements, refus de solde, refus anti-fraude)", async () => {
      // Les refus enregistrent aussi une ligne qui touche les comptes : ils ne doivent pas se
      // bloquer avec les virements. Régression d'un interblocage qui dépendait de l'ordre des UUID.
      const a = await openAccount('user-a', 20_000);
      const b = await openAccount('user-b', 20_000);
      const calls = Array.from({ length: 24 }, (_, i) => {
        switch (i % 4) {
          case 0: // souvent refusé : solde insuffisant
            return transfer('user-a', {
              from_account_id: a.id,
              to_account_id: b.id,
              amount_cents: 15_000,
            });
          case 1:
            return transfer('user-b', {
              from_account_id: b.id,
              to_account_id: a.id,
              amount_cents: 15_000,
            });
          case 2: // refusé : IBAN d'un compte interne qui n'est pas un bénéficiaire
            return transfer('user-a', {
              from_account_id: a.id,
              to_iban: b.iban,
              amount_cents: 100,
            });
          default:
            return transfer('user-b', {
              from_account_id: b.id,
              to_iban: a.iban,
              amount_cents: 100,
            });
        }
      });
      const statuses = (await Promise.all(calls)).map((r) => r.status);
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
      expect(statuses.every((s) => [201, 402, 403].includes(s))).toBe(true);
      expect((await balanceOf(a.id)) + (await balanceOf(b.id))).toBe(40_000);
    });

    it('renvoie la même idempotence quand deux requêtes identiques arrivent en même temps', async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const k = key();
      const body = { from_account_id: a.id, to_account_id: b.id, amount_cents: 1_000 };
      const [r1, r2] = await Promise.all([
        transfer('user-a', body, { key: k }),
        transfer('user-a', body, { key: k }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 201]);
      expect(r1.body.id).toBe(r2.body.id);
      expect(await balanceOf(a.id)).toBe(99_000);
    });
  });

  describe('règle anti-fraude (virement par IBAN)', () => {
    const EXTERNAL = 'FR7612345678901234567890123';

    it('refuse (403) un virement vers un bénéficiaire inconnu, journalise et compte le refus', async () => {
      const a = await openAccount('victime');
      const before = (await request(app).get('/metrics')).text;
      const series = 'payments_fraud_blocked_total{reason="unknown_beneficiary",service="api"}';

      const res = await transfer('victime', {
        from_account_id: a.id,
        to_iban: EXTERNAL,
        amount_cents: 10_000,
      });

      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.reason).toBe('unknown_beneficiary');
      expect(await balanceOf(a.id)).toBe(100_000);

      const blocked = logs.find((l) => l.obj.event === 'fraud_blocked');
      expect(blocked?.obj).toMatchObject({
        reason: 'unknown_beneficiary',
        user: 'victime',
        to_iban: EXTERNAL,
        amount_cents: 10_000,
      });
      const rejected = await prisma.transaction.findFirstOrThrow({ where: { status: 'REJECTED' } });
      expect(rejected).toMatchObject({ rejectReason: 'unknown_beneficiary', toIban: EXTERNAL });

      const after = (await request(app).get('/metrics')).text;
      expect(metricValue(after, series) - metricValue(before, series)).toBe(1);
    });

    it("journalise l'IP réelle de l'attaquant (X-Forwarded-For du WAF)", async () => {
      const a = await openAccount('victime');
      await request(app)
        .post('/v1/transactions')
        .set('Authorization', await as('victime'))
        .set('Idempotency-Key', key())
        .set('X-Forwarded-For', '192.168.137.50')
        .send({ from_account_id: a.id, to_iban: EXTERNAL, amount_cents: 100 });
      expect(logs.find((l) => l.obj.event === 'fraud_blocked')?.obj.ip).toBe('192.168.137.50');
    });

    it('autorise un bénéficiaire connu, et refuse au-delà du plafond', async () => {
      const a = await openAccount('client', 1_000_000);
      const add = await request(app)
        .post('/v1/beneficiaries')
        .set('Authorization', await as('client'))
        .send({ iban: 'fr76 1234 5678 9012 3456 7890 123', label: 'Propriétaire' });
      expect(add.status).toBe(201);
      expect(add.body.iban).toBe(EXTERNAL);

      const ok = await transfer('client', {
        from_account_id: a.id,
        to_iban: EXTERNAL,
        amount_cents: 20_000,
      });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ to_iban: EXTERNAL, to_account_id: null });
      expect(await balanceOf(a.id)).toBe(980_000);

      const tooMuch = await transfer('client', {
        from_account_id: a.id,
        to_iban: EXTERNAL,
        amount_cents: 60_000,
      });
      expect(tooMuch.status).toBe(403);
      expect(tooMuch.body.reason).toBe('amount_over_limit');
      expect(await balanceOf(a.id)).toBe(980_000);
    });

    it("un bénéficiaire ajouté par quelqu'un d'autre ne compte pas", async () => {
      await request(app)
        .post('/v1/beneficiaries')
        .set('Authorization', await as('autre'))
        .send({ iban: EXTERNAL, label: 'x' });
      const a = await openAccount('victime');
      const res = await transfer('victime', {
        from_account_id: a.id,
        to_iban: EXTERNAL,
        amount_cents: 100,
      });
      expect(res.status).toBe(403);
    });

    it('un IBAN qui désigne un compte interne crédite ce compte', async () => {
      const a = await openAccount('client');
      const b = await openAccount('ami');
      await request(app)
        .post('/v1/beneficiaries')
        .set('Authorization', await as('client'))
        .send({ iban: b.iban, label: 'Ami' });
      const res = await transfer('client', {
        from_account_id: a.id,
        to_iban: b.iban,
        amount_cents: 5_000,
      });
      expect(res.status).toBe(201);
      expect(res.body.to_account_id).toBe(b.id);
      expect(await balanceOf(b.id)).toBe(105_000);
    });

    it('refuse un IBAN mal formé et un doublon de bénéficiaire', async () => {
      const bad = await request(app)
        .post('/v1/beneficiaries')
        .set('Authorization', await as('client'))
        .send({ iban: 'pas-un-iban', label: 'x' });
      expect(bad.status).toBe(422);
      const body = { iban: EXTERNAL, label: 'x' };
      await request(app)
        .post('/v1/beneficiaries')
        .set('Authorization', await as('client'))
        .send(body);
      const dup = await request(app)
        .post('/v1/beneficiaries')
        .set('Authorization', await as('client'))
        .send(body);
      expect(dup.status).toBe(409);
    });
  });

  describe('transaction canari (remédiation)', () => {
    const CANARY = 'svc:svc-remediation';
    const canaryRoles: Role[] = ['svc:remediation-canary'];

    async function canaryAccounts() {
      const a = await prisma.account.create({
        data: { ownerId: CANARY, iban: 'FR7699990000000000000000001', balanceCents: 1_000_000 },
      });
      const b = await prisma.account.create({
        data: { ownerId: CANARY, iban: 'FR7699990000000000000000002', balanceCents: 1_000_000 },
      });
      return { a, b };
    }

    it('virement de test entre ses deux comptes, marqué synthétique', async () => {
      const { a, b } = await canaryAccounts();
      const list = await request(app)
        .get('/v1/accounts')
        .set('Authorization', await as(CANARY, canaryRoles));
      expect(list.body).toHaveLength(2);

      const res = await transfer(
        CANARY,
        { from_account_id: a.id, to_account_id: b.id, amount_cents: 1 },
        {
          roles: canaryRoles,
          synthetic: true,
        },
      );
      expect(res.status).toBe(201);
      expect(res.body.synthetic).toBe(true);
      expect(await balanceOf(a.id)).toBe(999_999);
    });

    it('un client ne peut pas se déclarer synthétique', async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const res = await transfer(
        'user-a',
        { from_account_id: a.id, to_account_id: b.id, amount_cents: 1 },
        { synthetic: true },
      );
      expect(res.status).toBe(403);
    });

    it('le canari doit être synthétique et ne peut pas virer vers un IBAN', async () => {
      const { a, b } = await canaryAccounts();
      const noHeader = await transfer(
        CANARY,
        { from_account_id: a.id, to_account_id: b.id, amount_cents: 1 },
        { roles: canaryRoles },
      );
      expect(noHeader.status).toBe(403);
      const external = await transfer(
        CANARY,
        { from_account_id: a.id, to_iban: 'FR7612345678901234567890123', amount_cents: 1 },
        { roles: canaryRoles, synthetic: true },
      );
      expect(external.status).toBe(403);
    });
  });

  describe('historique', () => {
    it('pagine par curseur et ne montre que ses propres virements', async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const c = await openAccount('user-c');
      for (let i = 1; i <= 3; i++) {
        await transfer('user-a', { from_account_id: a.id, to_account_id: b.id, amount_cents: i });
      }
      await transfer('user-c', { from_account_id: c.id, to_account_id: b.id, amount_cents: 7 });

      const page1 = await request(app)
        .get('/v1/transactions?limit=2')
        .set('Authorization', await as('user-a'));
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.items.map((t: { amount_cents: number }) => t.amount_cents)).toEqual([3, 2]);
      expect(page1.body.next_cursor).toBeTruthy();

      const page2 = await request(app)
        .get(`/v1/transactions?limit=2&cursor=${page1.body.next_cursor}`)
        .set('Authorization', await as('user-a'));
      expect(page2.body.items.map((t: { amount_cents: number }) => t.amount_cents)).toEqual([1]);
      expect(page2.body.next_cursor).toBeNull();
    });

    it('un tiers ne peut pas lire une transaction qui ne le concerne pas', async () => {
      const a = await openAccount('user-a');
      const b = await openAccount('user-b');
      const created = await transfer('user-a', {
        from_account_id: a.id,
        to_account_id: b.id,
        amount_cents: 100,
      });
      const asOther = await request(app)
        .get(`/v1/transactions/${created.body.id}`)
        .set('Authorization', await as('intrus'));
      expect(asOther.status).toBe(404);
      const asRecipient = await request(app)
        .get(`/v1/transactions/${created.body.id}`)
        .set('Authorization', await as('user-b'));
      expect(asRecipient.status).toBe(200);
    });
  });
});
