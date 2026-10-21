import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { parseSse } from '../lib/sse';
import { session } from '../lib/session';

// --- Outils de test ---------------------------------------------------------------------

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = (payload: Record<string, unknown>) =>
  `${b64({ alg: 'RS256' })}.${b64(payload)}.signature`;
const inFifteenMinutes = () => Math.floor(Date.now() / 1000) + 900;
const operatorToken = (over: Record<string, unknown> = {}) =>
  fakeJwt({ sub: 'op-1', roles: ['operator'], exp: inFifteenMinutes(), ...over });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

/** Un flux SSE à partir des blocs `event: ...\ndata: ...\n\n` donnés, livrés un par un. */
function sseResponse(blocks: string[], { hang = false }: { hang?: boolean } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      if (!hang) controller.close();
      // `hang: true` : le flux reste ouvert (simule une connexion qui ne se ferme jamais toute seule).
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

type Handler = (call: { url: string; headers: Headers }) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Handler | Response>) {
  const fn = vi.fn(async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${input}`;
    const route = routes[key];
    if (!route) throw new Error(`requête inattendue : ${key}`);
    return typeof route === 'function'
      ? route({ url: input, headers: new Headers(init.headers) })
      : route;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const renderApp = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

const incident = (over: Record<string, unknown> = {}) => ({
  id: 'inc-1',
  type: 'BRUTE_FORCE',
  state: 'RESOLVED',
  score: 0.93,
  target_service: 'auth',
  source_ip: '203.0.113.9',
  targets: ['victime@lab.local'],
  stats: { attempts: 40, failures: 38, window_seconds: 120 },
  playbook: 'block_source',
  failure_reason: null,
  detected_at: '2026-10-20T09:00:00.000Z',
  resolved_at: '2026-10-20T09:00:05.000Z',
  time_to_recover_seconds: 5.2,
  timeline: [{ at: '2026-10-20T09:00:01.000Z', step: 'block_ip', ok: true, detail: 'IP bloquée' }],
  ...over,
});

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

// --- Flux SSE (hors interface) --------------------------------------------------------------

describe('analyse du flux SSE', () => {
  const toStream = (chunks: string[]) => {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
  };

  it('découpe un événement en un seul bloc', async () => {
    const events = [];
    for await (const e of parseSse(toStream(['event: snapshot\ndata: [1,2,3]\n\n'])))
      events.push(e);
    expect(events).toEqual([{ event: 'snapshot', data: [1, 2, 3] }]);
  });

  it('reconstitue un événement découpé sur plusieurs paquets réseau', async () => {
    const events = [];
    for await (const e of parseSse(toStream(['event: incid', 'ent\ndata: {"id":1}', '\n\n'])))
      events.push(e);
    expect(events).toEqual([{ event: 'incident', data: { id: 1 } }]);
  });

  it('ignore les commentaires (ping) sans les faire planter', async () => {
    const events = [];
    for await (const e of parseSse(toStream([': ping\n\nevent: incident\ndata: {"id":1}\n\n'])))
      events.push(e);
    expect(events).toEqual([{ event: 'incident', data: { id: 1 } }]);
  });

  it('ignore un bloc de données illisible et continue sur le suivant', async () => {
    const events = [];
    for await (const e of parseSse(
      toStream(['event: incident\ndata: {pas du json}\n\nevent: incident\ndata: {"id":2}\n\n']),
    ))
      events.push(e);
    expect(events).toEqual([{ event: 'incident', data: { id: 2 } }]);
  });

  it('lit plusieurs événements accumulés dans un seul paquet', async () => {
    const events = [];
    for await (const e of parseSse(toStream(['event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'])))
      events.push(e);
    expect(events.map((e) => e.event)).toEqual(['a', 'b']);
  });
});

// --- Connexion ----------------------------------------------------------------------------

describe('connexion', () => {
  it('renvoie vers la connexion sans session', async () => {
    mockFetch({});
    renderApp('/incidents');
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeInTheDocument();
  });

  it("refuse un compte qui n'est pas opérateur", async () => {
    mockFetch({
      'POST /auth/v1/login': json({ access_token: operatorToken({ roles: ['svc:dashboard'] }) }),
    });
    const user = userEvent.setup();
    renderApp('/login');
    await user.type(screen.getByLabelText('Adresse e-mail'), 'svc@lab.local');
    await user.type(screen.getByLabelText('Mot de passe'), 'peu-importe');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("n'a pas accès à la supervision");
    expect(session.get()).toBeNull();
  });

  it("la garde d'accès (Protected) refuse un jeton non-opérateur posé directement, sans passer par la connexion", async () => {
    // Contourne la page de connexion : un jeton `svc:dashboard` est posé directement en session.
    session.set(operatorToken({ roles: ['svc:dashboard'] }));
    mockFetch({});
    renderApp('/incidents');
    expect(await screen.findByRole('button', { name: 'Se connecter' })).toBeInTheDocument();
  });

  it('connecte un opérateur et affiche la vue d’ensemble', async () => {
    const fetchMock = mockFetch({
      'POST /auth/v1/login': json({ access_token: operatorToken() }),
      'GET /remediation/v1/services': json([
        {
          name: 'api',
          healthy: true,
          last_check_at: '2026-10-20T09:00:00Z',
          last_canary_ok_at: null,
        },
      ]),
      'GET /auth/v1/devices/led': json({
        state: 'off',
        since: '2026-10-20T09:00:00Z',
        until: null,
      }),
    });
    const user = userEvent.setup();
    renderApp('/login');
    await user.type(screen.getByLabelText('Adresse e-mail'), 'op@lab.local');
    await user.type(screen.getByLabelText('Mot de passe'), 'mot-de-passe-operateur');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('heading', { name: "Vue d'ensemble" })).toBeInTheDocument();
    expect(await screen.findByText('En ligne')).toBeInTheDocument();
    const servicesCall = fetchMock.mock.calls.find(([url]) => url === '/remediation/v1/services');
    expect(new Headers(servicesCall?.[1]?.headers).get('Authorization')).toMatch(/^Bearer /);
  });
});

// --- Incidents en temps réel ------------------------------------------------------------------

describe('incidents (flux temps réel)', () => {
  beforeEach(() => session.set(operatorToken()));

  it('affiche les incidents reçus en instantané, et leur état', async () => {
    mockFetch({
      'GET /remediation/v1/incidents/stream': () =>
        sseResponse(['event: snapshot\ndata: ' + JSON.stringify([incident()]) + '\n\n'], {
          hang: true,
        }),
    });
    renderApp('/incidents');
    expect(await screen.findByText('BRUTE_FORCE')).toBeInTheDocument();
    expect(await screen.findByText('Résolu')).toBeInTheDocument();
    expect(screen.getByText('temps réel')).toBeInTheDocument();
  });

  it('met à jour un incident déjà affiché quand un nouvel événement arrive (même ligne, pas de doublon)', async () => {
    let send: ((chunk: string) => void) | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: snapshot\ndata: ' + JSON.stringify([incident({ state: 'DETECTED' })]) + '\n\n',
          ),
        );
        send = (chunk) => controller.enqueue(encoder.encode(chunk));
      },
    });
    mockFetch({
      'GET /remediation/v1/incidents/stream': () =>
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    });
    renderApp('/incidents');
    expect(await screen.findByText('Détecté')).toBeInTheDocument();

    send!('event: incident\ndata: ' + JSON.stringify(incident({ state: 'RESOLVED' })) + '\n\n');
    expect(await screen.findByText('Résolu')).toBeInTheDocument();
    expect(screen.getAllByText('BRUTE_FORCE')).toHaveLength(1); // toujours une seule ligne
  });

  it("l'en-tête Authorization est envoyé (le flux ne peut pas passer par EventSource)", async () => {
    const fetchMock = mockFetch({
      'GET /remediation/v1/incidents/stream': () =>
        sseResponse(['event: snapshot\ndata: []\n\n'], { hang: true }),
    });
    renderApp('/incidents');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${session.get()!.token}`);
  });

  it('indique "reconnexion…" puis revient à "temps réel" après une coupure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let call = 0;
    mockFetch({
      'GET /remediation/v1/incidents/stream': () => {
        call++;
        if (call === 1) return sseResponse(['event: snapshot\ndata: []\n\n']); // se termine tout de suite : coupure
        return sseResponse(['event: snapshot\ndata: []\n\n'], { hang: true });
      },
    });
    renderApp('/incidents');
    await screen.findByText('reconnexion…');
    await vi.advanceTimersByTimeAsync(2500);
    await screen.findByText('temps réel');
    expect(call).toBe(2);
    vi.useRealTimers();
  });

  it('un 401 sur le flux ferme la session', async () => {
    mockFetch({ 'GET /remediation/v1/incidents/stream': json({ title: 'Non authentifié' }, 401) });
    renderApp('/incidents');
    await waitFor(() => expect(session.get()).toBeNull());
  });

  it('ouvre le détail avec la chronologie de l’incident', async () => {
    mockFetch({
      'GET /remediation/v1/incidents/stream': () =>
        sseResponse(['event: snapshot\ndata: ' + JSON.stringify([incident()]) + '\n\n'], {
          hang: true,
        }),
    });
    const user = userEvent.setup();
    renderApp('/incidents');
    await user.click(await screen.findByText('BRUTE_FORCE'));
    expect(await screen.findByText('block_ip')).toBeInTheDocument();
    expect(screen.getByText(/— IP bloquée/)).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9', { selector: 'dd' })).toBeInTheDocument();
  });

  it("affiche la raison d'un échec", async () => {
    mockFetch({
      'GET /remediation/v1/incidents/stream': () =>
        sseResponse(
          [
            'event: snapshot\ndata: ' +
              JSON.stringify([
                incident({
                  state: 'FAILED',
                  failure_reason: 'reprise non confirmée après tous les playbooks',
                }),
              ]) +
              '\n\n',
          ],
          { hang: true },
        ),
    });
    renderApp('/incidents/inc-1');
    expect(await screen.findByText(/reprise non confirmée/)).toBeInTheDocument();
  });
});

// --- Blocages ------------------------------------------------------------------------------

describe('IP bloquées', () => {
  beforeEach(() => session.set(operatorToken()));

  it('liste les blocages actifs avec un lien vers l’incident', async () => {
    mockFetch({
      'GET /remediation/v1/blocks': json([
        {
          id: 'b-1',
          ip: '203.0.113.9',
          incident_id: 'inc-1',
          created_at: '2026-10-20T09:00:00Z',
          expires_at: '2026-10-20T09:05:00Z',
        },
      ]),
    });
    renderApp('/blocages');
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "voir l'incident" })).toHaveAttribute(
      'href',
      '/incidents/inc-1',
    );
  });

  it('indique quand il n’y a aucun blocage', async () => {
    mockFetch({ 'GET /remediation/v1/blocks': json([]) });
    renderApp('/blocages');
    expect(await screen.findByText('Aucune IP bloquée actuellement.')).toBeInTheDocument();
  });
});

// --- Assistant -------------------------------------------------------------------------------

describe('assistant', () => {
  beforeEach(() => session.set(operatorToken()));

  it('affiche la réponse et les sources', async () => {
    const fetch = mockFetch({
      'POST /assistant/v1/chat': json({
        answer: "Le WAF retire le préfixe avant de transmettre à l'service visé.",
        sources: [{ file: 'docs/architecture.md', excerpt: 'routage par préfixe', page: null }],
      }),
    });
    renderApp('/assistant');
    await userEvent.type(screen.getByLabelText('Question'), 'Comment le WAF route les requêtes ?');
    await userEvent.click(screen.getByRole('button', { name: 'Demander' }));
    expect(await screen.findByText(/retire le préfixe/)).toBeInTheDocument();
    expect(screen.getByText('docs/architecture.md')).toBeInTheDocument();
    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    expect(JSON.parse(call![1]!.body as string)).toEqual({
      question: 'Comment le WAF route les requêtes ?',
    });
  });

  it('affiche l’erreur sans planter la page', async () => {
    mockFetch({ 'POST /assistant/v1/chat': json({ title: 'Service injoignable' }, 503) });
    renderApp('/assistant');
    await userEvent.type(screen.getByLabelText('Question'), 'test');
    await userEvent.click(screen.getByRole('button', { name: 'Demander' }));
    expect(await screen.findByText('Service injoignable')).toBeInTheDocument();
  });
});
