import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { session } from '../lib/session';

// --- Outils de test ---------------------------------------------------------------------

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = (payload: Record<string, unknown>) =>
  `${b64({ alg: 'RS256' })}.${b64(payload)}.signature`;
const inFifteenMinutes = () => Math.floor(Date.now() / 1000) + 900;
const adminToken = (over: Record<string, unknown> = {}) =>
  fakeJwt({ sub: 'admin-1', roles: ['admin'], exp: inFifteenMinutes(), ...over });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

type Handler = (call: { body: unknown; headers: Headers }) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Handler | Response>) {
  const fn = vi.fn(async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${input}`;
    const route = routes[key];
    if (!route) throw new Error(`requête inattendue : ${key}`);
    const call = {
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers: new Headers(init.headers),
    };
    return typeof route === 'function' ? route(call) : route;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const calls = (fn: ReturnType<typeof mockFetch>, method: string, path: string) =>
  fn.mock.calls.filter(([url, init]) => url === path && (init?.method ?? 'GET') === method);

// Caméra et capture d'image simulées : jsdom ne sait ni filmer ni encoder d'image.
const FAKE_PHOTO = new Blob(['photo'], { type: 'image/jpeg' });
function mockCamera() {
  const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (cb: (b: Blob | null) => void) => cb(FAKE_PHOTO),
  });
  // jsdom ne sait pas dessiner : un faux contexte 2D suffit pour que la capture s'exécute.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ drawImage: vi.fn() }),
  });
}

const renderApp = (path = '/login') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

/**
 * `userEvent` sous minuteurs factices : ses propres délais internes doivent avancer avec la même
 * horloge, sinon un clic reste bloqué indéfiniment (voir la doc de `@testing-library/user-event`).
 */
const fakeTimerUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

const user_ = (over: Record<string, unknown> = {}) => ({
  id: 'u-1',
  email: 'operateur@lab.local',
  roles: ['operator'],
  active: true,
  created_at: '2026-10-20T09:00:00.000Z',
  ...over,
});

beforeEach(() => {
  sessionStorage.clear();
  mockCamera();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers(); // au cas où un test interrompu aurait laissé les minuteurs figés
});

// --- Parcours de connexion -----------------------------------------------------------------

describe('connexion (identifiant, visage, mot de passe)', () => {
  it('parcours complet : la caméra démarre, la photo est envoyée, puis le mot de passe, jeton obtenu', async () => {
    const fetchMock = mockFetch({
      'POST /auth/v1/backoffice/login': json(
        { session_id: 's-1', state: 'IDENTIFIED', expires_at: '2026-10-20T09:02:00Z' },
        201,
      ),
      'POST /auth/v1/backoffice/login/s-1/face': json({
        session_id: 's-1',
        state: 'PASSWORD_PENDING',
        expires_at: '2026-10-20T09:02:00Z',
      }),
      'POST /auth/v1/backoffice/login/s-1/password': json({
        access_token: adminToken(),
        token_type: 'Bearer',
        expires_in: 900,
        state: 'GRANTED',
      }),
    });
    const user = userEvent.setup();
    renderApp();

    await user.type(screen.getByLabelText('Identifiant'), 'admin@lab.local');
    await user.click(screen.getByRole('button', { name: 'Continuer' }));

    await screen.findByText(/Regardez la caméra/);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: true });
    await user.click(screen.getByRole('button', { name: 'Vérifier mon visage' }));

    await screen.findByText('Visage reconnu.');
    expect(screen.getByText('LED : verte clignotante')).toBeInTheDocument();
    const faceCall = calls(fetchMock, 'POST', '/auth/v1/backoffice/login/s-1/face')[0]!;
    expect(faceCall[1]?.headers).toMatchObject({ 'Content-Type': 'image/jpeg' });

    await user.type(screen.getByLabelText('Mot de passe'), 'un-mot-de-passe-solide');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    await waitFor(() => expect(session.get()?.roles).toEqual(['admin']));
    expect(screen.getByText('LED : verte fixe')).toBeInTheDocument();
    expect(calls(fetchMock, 'POST', '/auth/v1/backoffice/login')[0]?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
  });

  it('un identifiant verrouillé affiche le délai et bloque un nouvel essai', async () => {
    mockFetch({
      'POST /auth/v1/backoffice/login': json(
        { title: 'Identifiant bloqué', reason: 'locked', retry_after_seconds: 300 },
        423,
      ),
    });
    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText('Identifiant'), 'admin@lab.local');
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    expect(await screen.findByText(/bloqué 5 min/)).toBeInTheDocument();
    expect(screen.getByLabelText('Identifiant')).toBeDisabled();
  });

  it("un visage non reconnu : LED rouge fixe, caméra coupée, puis retour à l'identifiant vidé", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stopTrack = vi.fn();
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream),
      },
    });
    mockFetch({
      'POST /auth/v1/backoffice/login': json(
        { session_id: 's-2', state: 'IDENTIFIED', expires_at: '2026-10-20T09:02:00Z' },
        201,
      ),
      'POST /auth/v1/backoffice/login/s-2/face': json(
        {
          title: 'Visage non reconnu',
          reason: 'face_not_recognized',
          retry_after_seconds: 30,
          locked: false,
        },
        401,
      ),
    });
    const user = fakeTimerUser();
    renderApp();
    await user.type(screen.getByLabelText('Identifiant'), 'admin@lab.local');
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    await screen.findByRole('button', { name: 'Vérifier mon visage' });
    await user.click(screen.getByRole('button', { name: 'Vérifier mon visage' }));

    expect(await screen.findByText('Visage non reconnu.')).toBeInTheDocument();
    expect(screen.getByText('LED : rouge fixe')).toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalled(); // la caméra est coupée

    await vi.advanceTimersByTimeAsync(30_000);
    expect(await screen.findByLabelText('Identifiant')).toHaveValue(''); // identifiant vidé
    expect(screen.getByText('LED : éteinte')).toBeInTheDocument();
  });

  it("un visage reconnu mais verrouillé (2e échec) l'indique", async () => {
    mockFetch({
      'POST /auth/v1/backoffice/login': json(
        { session_id: 's-3', state: 'IDENTIFIED', expires_at: '2026-10-20T09:02:00Z' },
        201,
      ),
      'POST /auth/v1/backoffice/login/s-3/face': json(
        { title: 'x', reason: 'face_not_recognized', retry_after_seconds: 300, locked: true },
        401,
      ),
    });
    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText('Identifiant'), 'admin@lab.local');
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    await user.click(await screen.findByRole('button', { name: 'Vérifier mon visage' }));
    expect(await screen.findByText(/bloqué 5 min/)).toBeInTheDocument();
  });

  it("un mot de passe refusé : LED rouge clignotante, puis on recommence toute l'identification", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch({
      'POST /auth/v1/backoffice/login': json(
        { session_id: 's-4', state: 'IDENTIFIED', expires_at: '2026-10-20T09:02:00Z' },
        201,
      ),
      'POST /auth/v1/backoffice/login/s-4/face': json({
        session_id: 's-4',
        state: 'PASSWORD_PENDING',
        expires_at: '2026-10-20T09:02:00Z',
      }),
      'POST /auth/v1/backoffice/login/s-4/password': json(
        { title: 'x', reason: 'wrong_password', retry_after_seconds: 6, locked: false },
        401,
      ),
    });
    const user = fakeTimerUser();
    renderApp();
    await user.type(screen.getByLabelText('Identifiant'), 'admin@lab.local');
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    await user.click(await screen.findByRole('button', { name: 'Vérifier mon visage' }));
    await user.type(await screen.findByLabelText('Mot de passe'), 'mauvais-mot-de-passe-x');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByText(/On recommence l'identification/)).toBeInTheDocument();
    expect(screen.getByText('LED : rouge clignotante')).toBeInTheDocument();
    expect(session.get()).toBeNull();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(await screen.findByLabelText('Identifiant')).toBeInTheDocument();
  });

  it("une tentative expirée (410) ramène à l'identifiant, à n'importe quelle étape", async () => {
    mockFetch({
      'POST /auth/v1/backoffice/login': json(
        { session_id: 's-5', state: 'IDENTIFIED', expires_at: '2020-01-01T00:00:00Z' },
        201,
      ),
      'POST /auth/v1/backoffice/login/s-5/face': json(
        { title: 'Connexion expirée', reason: 'expired' },
        410,
      ),
    });
    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText('Identifiant'), 'admin@lab.local');
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    await user.click(await screen.findByRole('button', { name: 'Vérifier mon visage' }));
    expect(await screen.findByLabelText('Identifiant')).toBeInTheDocument();
  });

  it("refuse un compte qui n'a pas le rôle admin (le front et le dashboard ont leur propre connexion)", async () => {
    mockFetch({
      'POST /auth/v1/backoffice/login': json(
        { session_id: 's-6', state: 'IDENTIFIED', expires_at: '2026-10-20T09:02:00Z' },
        201,
      ),
      'POST /auth/v1/backoffice/login/s-6/face': json({
        session_id: 's-6',
        state: 'PASSWORD_PENDING',
        expires_at: '2026-10-20T09:02:00Z',
      }),
      'POST /auth/v1/backoffice/login/s-6/password': json({
        access_token: adminToken({ roles: ['operator'] }),
        token_type: 'Bearer',
        expires_in: 900,
        state: 'GRANTED',
      }),
    });
    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText('Identifiant'), 'operateur@lab.local');
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    await user.click(await screen.findByRole('button', { name: 'Vérifier mon visage' }));
    await user.type(await screen.findByLabelText('Mot de passe'), 'mot-de-passe-operateur');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByText(/n'a pas accès au back-office/)).toBeInTheDocument();
    expect(session.get()).toBeNull();
  });
});

describe('garde d’accès', () => {
  it('renvoie vers la connexion sans jeton admin', async () => {
    mockFetch({});
    renderApp('/');
    expect(await screen.findByText('Back-office RESILIENCE')).toBeInTheDocument();
    expect(screen.getByLabelText('Identifiant')).toBeInTheDocument();
  });

  it('refuse un jeton non-admin posé directement (contournement de la connexion)', async () => {
    session.set(adminToken({ roles: ['operator'] }));
    mockFetch({});
    renderApp('/');
    expect(await screen.findByLabelText('Identifiant')).toBeInTheDocument();
  });
});

// --- Habilitations ------------------------------------------------------------------------

describe('habilitations', () => {
  beforeEach(() => session.set(adminToken()));

  it('liste les comptes et crée un nouvel opérateur', async () => {
    let created: ReturnType<typeof user_> | null = null;
    const fetchMock = mockFetch({
      'GET /auth/v1/admin/users': () => json(created ? [user_(), created] : [user_()]),
      'POST /auth/v1/admin/users': ({ body }) => {
        created = user_({
          id: 'u-2',
          email: (body as { email: string }).email,
          roles: (body as { roles: string[] }).roles,
        });
        return json(created, 201);
      },
    });
    const user = userEvent.setup();
    renderApp('/');
    expect(await screen.findByText('operateur@lab.local')).toBeInTheDocument();

    await user.type(screen.getByLabelText('E-mail'), 'nouveau@lab.local');
    await user.type(screen.getByLabelText('Mot de passe'), 'un-mot-de-passe-solide');
    await user.click(screen.getByRole('button', { name: 'Créer le compte' }));
    expect(await screen.findByText('nouveau@lab.local')).toBeInTheDocument();
    expect(calls(fetchMock, 'POST', '/auth/v1/admin/users')[0]?.[1]).toBeTruthy();
  });

  it('désactive un compte, puis le réactive', async () => {
    let active = true;
    mockFetch({
      'GET /auth/v1/admin/users': () => json([user_({ active })]),
      'PATCH /auth/v1/admin/users/u-1': ({ body }) => {
        active = (body as { active: boolean }).active;
        return json(user_({ active }));
      },
    });
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByText('operateur@lab.local');
    expect(screen.getByText('Actif')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Désactiver' }));
    await waitFor(() => expect(screen.getByText('Désactivé')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Réactiver' }));
    await waitFor(() => expect(screen.getByText('Actif')).toBeInTheDocument());
  });

  it('affiche une erreur si on tente de retirer le dernier administrateur', async () => {
    mockFetch({
      'GET /auth/v1/admin/users': () => json([user_({ id: 'u-9', roles: ['admin'] })]),
      'PATCH /auth/v1/admin/users/u-9': json(
        { title: 'Conflit', detail: 'impossible : ce serait le dernier administrateur actif' },
        409,
      ),
    });
    const user = userEvent.setup();
    renderApp('/');
    const row = (await screen.findByText('operateur@lab.local')).closest('li')!;
    await user.click(within(row).getByRole('checkbox', { name: 'Opérateur' }));
    expect(await screen.findByText(/dernier administrateur actif/)).toBeInTheDocument();
  });

  it('enrôle un visage pour un compte, avec le bon type de contenu', async () => {
    const fetchMock = mockFetch({
      'GET /auth/v1/admin/users': json([user_()]),
      'POST /auth/v1/admin/users/u-1/face': json({ samples: 2 }, 201),
    });
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByText('operateur@lab.local');
    await user.click(screen.getByRole('button', { name: 'Enrôler un visage' }));
    await screen.findByText('Enrôler un visage', { selector: 'h2' });
    await user.click(screen.getByRole('button', { name: 'Capturer' }));
    expect(await screen.findByText(/2 échantillons/)).toBeInTheDocument();
    const call = calls(fetchMock, 'POST', '/auth/v1/admin/users/u-1/face')[0]!;
    expect(call[1]?.headers).toMatchObject({ 'Content-Type': 'image/jpeg' });
  });

  it("explique un refus sans visage détecté, sans casser l'écran", async () => {
    mockFetch({
      'GET /auth/v1/admin/users': json([user_()]),
      'POST /auth/v1/admin/users/u-1/face': json({ title: 'Aucun visage détecté' }, 422),
    });
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByText('operateur@lab.local');
    await user.click(screen.getByRole('button', { name: 'Enrôler un visage' }));
    await user.click(await screen.findByRole('button', { name: 'Capturer' }));
    expect(await screen.findByText(/Aucun visage détecté/)).toBeInTheDocument();
  });

  it('débloque un identifiant', async () => {
    const fetchMock = mockFetch({
      'GET /auth/v1/admin/users': json([]),
      'DELETE /auth/v1/admin/lockouts/victime%40lab.local': new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    renderApp('/');
    await user.type(screen.getByLabelText('Identifiant bloqué'), 'victime@lab.local');
    await user.click(screen.getByRole('button', { name: 'Débloquer' }));
    expect(await screen.findByText('victime@lab.local débloqué.')).toBeInTheDocument();
    expect(calls(fetchMock, 'DELETE', '/auth/v1/admin/lockouts/victime%40lab.local')).toHaveLength(
      1,
    );
  });
});
