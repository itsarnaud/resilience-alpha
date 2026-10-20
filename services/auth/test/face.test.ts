/**
 * Adaptateur du service de reconnaissance faciale (ml/face), face à un faux serveur qui imite sa vraie API :
 * `POST /recognize` avec `{ user, image }` en JSON, réponse `{ ok, recognized, distance, threshold }`.
 * Pas de base de données nécessaire.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API_KEY = 'cle-de-test-du-service-de-visage';

interface Received {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: { user?: string; image?: string };
}

describe('adaptateur du service de reconnaissance faciale', () => {
  let server: Server;
  let face: typeof import('../src/lib/face.js').face;
  let FaceServiceError: typeof import('../src/lib/face.js').FaceServiceError;
  const received: Received[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      received.push({ method: req.method, url: req.url, headers: req.headers, body });

      const json = (status: number, payload: unknown) =>
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
      switch (body.user) {
        case 'alice@lab.local':
          return json(200, { ok: true, recognized: true, distance: 0.312, threshold: 0.6 });
        case 'bob@lab.local': // visage différent
          return json(200, { ok: true, recognized: false, distance: 0.91, threshold: 0.6 });
        case 'nouveau@lab.local': // jamais enregistré : un refus, pas une panne
          return json(200, { ok: true, recognized: false, reason: 'utilisateur non enrole' });
        case 'panne@lab.local':
          return json(500, { error: 'boom' });
        case 'illisible@lab.local':
          return res.writeHead(200).end('<html>pas du json</html>');
        case 'incomplet@lab.local':
          return json(200, { ok: true });
        case 'lent@lab.local':
          return setTimeout(() => json(200, { recognized: true }), 1000);
        default:
          return json(400, { ok: false, error: 'user et image requis' });
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

    Object.assign(process.env, {
      FACE_VERIFIER: 'http',
      FACE_SERVICE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      FACE_SERVICE_KEY: API_KEY,
      FACE_TIMEOUT_MS: '300',
    });
    const module = await import('../src/lib/face.js');
    face = module.face;
    FaceServiceError = module.FaceServiceError;
  });

  afterAll(() => {
    server.close();
  });

  const photo = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('contenu-de-la-photo'),
  ]);

  it("envoie l'identifiant et la photo en base64 (sans préfixe) à /recognize, avec la clé", async () => {
    await face.verify('alice@lab.local', photo);
    const request = received.at(-1)!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/recognize');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-api-key']).toBe(API_KEY);
    expect(request.body.user).toBe('alice@lab.local');
    expect(request.body.image).toBe(photo.toString('base64'));
    expect(request.body.image).not.toContain(',');
  });

  it('un visage reconnu renvoie la distance', async () => {
    expect(await face.verify('alice@lab.local', photo)).toEqual({ match: true, distance: 0.312 });
  });

  it('un visage différent, ou un utilisateur non enregistré, sont des refus (pas des pannes)', async () => {
    expect(await face.verify('bob@lab.local', photo)).toEqual({ match: false, distance: 0.91 });
    expect(await face.verify('nouveau@lab.local', photo)).toEqual({
      match: false,
      distance: undefined,
    });
  });

  it.each([
    ['une erreur serveur', 'panne@lab.local'],
    ['une réponse qui n’est pas du JSON', 'illisible@lab.local'],
    ['une réponse sans verdict', 'incomplet@lab.local'],
    ['un refus de la requête (400)', 'inconnu-du-faux-serveur@lab.local'],
    ['un service trop lent', 'lent@lab.local'],
  ])(
    '%s est une panne du service : elle ne doit pas verrouiller un compte',
    async (_name, user) => {
      await expect(face.verify(user, photo)).rejects.toBeInstanceOf(FaceServiceError);
    },
  );

  it('un service arrêté est une panne (ce test coupe le faux serveur : il doit rester le dernier)', async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await expect(face.verify('alice@lab.local', photo)).rejects.toBeInstanceOf(FaceServiceError);
  });
});
