import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { eurosToCents, formatEuros } from '../lib/money';
import { session } from '../lib/session';
import { uuid } from '../lib/uuid';

// --- Outils de test ---------------------------------------------------------------------

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = (payload: Record<string, unknown>) =>
  `${b64({ alg: 'RS256' })}.${b64(payload)}.signature`;
const inFifteenMinutes = () => Math.floor(Date.now() / 1000) + 900;
const customerToken = (over: Record<string, unknown> = {}) =>
  fakeJwt({ sub: 'user-1', roles: ['customer'], exp: inFifteenMinutes(), ...over });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

type Reply = Response | Error;
type Handler = (call: { body: any; headers: Headers }) => Reply | Promise<Reply>;

/** Remplace `fetch` : chaque route est « MÉTHODE /chemin » (préfixe accepté avec *). */
function mockFetch(routes: Record<string, Handler | Reply>) {
  const fn = vi.fn(async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${input}`;
    const route = Object.entries(routes).find(([k]) =>
      k.endsWith('*') ? key.startsWith(k.slice(0, -1)) : k === key,
    );
    if (!route) throw new Error(`requête inattendue : ${key}`);
    const handler = route[1];
    const reply =
      typeof handler === 'function'
        ? await handler({
            body: init.body ? JSON.parse(String(init.body)) : undefined,
            headers: new Headers(init.headers),
          })
        : handler;
    if (reply instanceof Error) throw reply;
    return reply.clone();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Les appels faits à une route, avec leur corps et leurs en-têtes. */
const callsTo = (fn: ReturnType<typeof mockFetch>, method: string, path: string) =>
  fn.mock.calls
    .filter(([url, init]) => url === path && (init?.method ?? 'GET') === method)
    .map(([, init]) => ({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    }));

const renderApp = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acc-1',
  owner_id: 'user-1',
  iban: 'FR7611112222333344445555666',
  balance_cents: 100_000,
  currency: 'EUR',
  ...over,
});

const transaction = (over: Record<string, unknown> = {}) => ({
  id: 't-1',
  from_account_id: 'acc-1',
  to_account_id: null,
  to_iban: 'FR7612345678901234567890123',
  amount_cents: 1250,
  label: null,
  status: 'COMPLETED',
  reject_reason: null,
  synthetic: false,
  created_at: '2026-10-20T09:00:00.000Z',
  ...over,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- Montants -----------------------------------------------------------------------------

describe('montants', () => {
  it('formate des centimes en euros', () => {
    expect(formatEuros(123456).replace(/[  ]/g, ' ')).toBe('1 234,56 €');
    expect(formatEuros(5).replace(/[  ]/g, ' ')).toBe('0,05 €');
  });

  it('convertit une saisie en centimes sans passer par un flottant', () => {
    expect(eurosToCents('12,50')).toBe(1250);
    expect(eurosToCents('12.5')).toBe(1250);
    expect(eurosToCents('0,1')).toBe(10);
    expect(eurosToCents('0,07')).toBe(7);
    expect(eurosToCents(' 3 ')).toBe(300);
  });

  it('refuse ce qui n’est pas un montant', () => {
    for (const bad of ['', 'abc', '-5', '1,234', '1,2,3', '12 €', '1e3']) {
      expect(eurosToCents(bad)).toBeNull();
    }
  });
});

describe('identifiants de requête', () => {
  it('produit un UUID v4 même sans crypto.randomUUID (page servie en HTTP sur le réseau du labo)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const a = uuid();
    const b = uuid();
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });
});

// --- Session ------------------------------------------------------------------------------

describe('session', () => {
  it('lit le sujet, les rôles et l’échéance du jeton', () => {
    session.set(customerToken({ sub: 'abc' }));
    expect(session.get()).toMatchObject({ sub: 'abc', roles: ['customer'] });
  });

  it('ignore un jeton expiré ou illisible', () => {
    session.set(customerToken({ exp: Math.floor(Date.now() / 1000) - 10 }));
    expect(session.get()).toBeNull();
    session.set('pas-un-jwt');
    expect(session.get()).toBeNull();
  });

  it('renvoie le même objet tant que rien ne change (requis par useSyncExternalStore)', () => {
    session.set(customerToken());
    expect(session.get()).toBe(session.get());
  });
});

// --- Connexion ----------------------------------------------------------------------------

describe('connexion', () => {
  it('renvoie vers la connexion quand on n’est pas connecté', () => {
    mockFetch({});
    renderApp('/virement');
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeInTheDocument();
  });

  it('connecte le client et affiche ses comptes', async () => {
    const token = customerToken();
    const fetchMock = mockFetch({
      'POST /auth/v1/login': json({ access_token: token }),
      'GET /api/v1/accounts': json([account()]),
    });
    const user = userEvent.setup();
    renderApp();

    await user.type(screen.getByLabelText('Adresse e-mail'), 'alice@example.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'un-mot-de-passe-long');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByText('Mes comptes')).toBeInTheDocument();
    expect(await screen.findByText(/1.?000,00.€/)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/auth/v1/login')[0]?.body).toEqual({
      email: 'alice@example.com',
      password: 'un-mot-de-passe-long',
    });
    // les appels suivants portent le jeton
    expect(callsTo(fetchMock, 'GET', '/api/v1/accounts')[0]?.headers.get('Authorization')).toBe(
      `Bearer ${token}`,
    );
  });

  it('affiche un message clair quand les identifiants sont refusés, sans connecter', async () => {
    mockFetch({ 'POST /auth/v1/login': json({ title: 'Non authentifié' }, 401) });
    const user = userEvent.setup();
    renderApp('/login');
    await user.type(screen.getByLabelText('Adresse e-mail'), 'alice@example.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'mauvais');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Identifiant ou mot de passe incorrect.',
    );
    expect(session.get()).toBeNull();
  });

  it('refuse un compte qui n’est pas un compte client (le back-office a sa propre connexion)', async () => {
    mockFetch({
      'POST /auth/v1/login': json({ access_token: customerToken({ roles: ['admin'] }) }),
    });
    const user = userEvent.setup();
    renderApp('/login');
    await user.type(screen.getByLabelText('Adresse e-mail'), 'admin@example.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'un-mot-de-passe-long');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("n'a pas accès à l'espace client");
    expect(session.get()).toBeNull();
  });

  it('crée un compte puis connecte', async () => {
    const fetchMock = mockFetch({
      'POST /auth/v1/register': json({ id: 'u' }, 201),
      'POST /auth/v1/login': json({ access_token: customerToken() }),
      'GET /api/v1/accounts': json([]),
    });
    const user = userEvent.setup();
    renderApp('/login');
    await user.click(screen.getByRole('button', { name: 'Créer un compte' }));
    await user.type(screen.getByLabelText('Adresse e-mail'), 'bob@example.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'un-mot-de-passe-long');
    await user.click(screen.getByRole('button', { name: 'Créer mon compte' }));
    expect(await screen.findByText('Mes comptes')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/auth/v1/register')).toHaveLength(1);
  });

  it('renvoie vers la connexion quand l’API répond 401 (session expirée)', async () => {
    session.set(customerToken());
    mockFetch({ 'GET /api/v1/accounts': json({ title: 'Non authentifié' }, 401) });
    renderApp('/');
    expect(await screen.findByRole('button', { name: 'Se connecter' })).toBeInTheDocument();
    expect(session.get()).toBeNull();
  });
});

// --- Comptes ------------------------------------------------------------------------------

describe('comptes', () => {
  beforeEach(() => session.set(customerToken()));

  it('ouvre un compte puis recharge la liste', async () => {
    let opened = false;
    mockFetch({
      'GET /api/v1/accounts': () => json(opened ? [account()] : []),
      'POST /api/v1/accounts': () => {
        opened = true;
        return json(account(), 201);
      },
    });
    const user = userEvent.setup();
    renderApp('/');
    expect(await screen.findByText(/pas encore de compte/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ouvrir un compte' }));
    expect(await screen.findByText(/1.?000,00.€/)).toBeInTheDocument();
  });

  it('explique pourquoi l’ouverture est refusée (nombre maximum de comptes)', async () => {
    mockFetch({
      'GET /api/v1/accounts': json([account()]),
      'POST /api/v1/accounts': json(
        { title: 'Conflit', detail: 'maximum 5 comptes par client' },
        409,
      ),
    });
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByText(/1.?000,00.€/);
    await user.click(screen.getByRole('button', { name: 'Ouvrir un compte' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('maximum 5 comptes par client');
  });
});

// --- Virement -----------------------------------------------------------------------------

describe('virement', () => {
  beforeEach(() => session.set(customerToken()));

  const base = {
    'GET /api/v1/accounts': () => json([account()]),
    'GET /api/v1/beneficiaries': () => json([]),
  };

  async function fill(
    user: ReturnType<typeof userEvent.setup>,
    iban = 'fr76 1234 5678 9012 3456 7890 123',
    amount = '12,50',
  ) {
    await screen.findByRole('option');
    await user.clear(screen.getByLabelText('IBAN du destinataire'));
    await user.type(screen.getByLabelText('IBAN du destinataire'), iban);
    await user.clear(screen.getByLabelText('Montant (€)'));
    await user.type(screen.getByLabelText('Montant (€)'), amount);
  }

  it('envoie le virement avec un IBAN normalisé, un montant en centimes et une clé d’idempotence', async () => {
    const fetchMock = mockFetch({
      ...base,
      'POST /api/v1/transactions': () => json(transaction(), 201),
    });
    const user = userEvent.setup();
    renderApp('/virement');
    await fill(user);
    await user.type(screen.getByLabelText('Libellé (facultatif)'), 'Loyer');
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));

    expect(await screen.findByText(/Virement de 12,50.€ effectué/)).toBeInTheDocument();
    const [call] = callsTo(fetchMock, 'POST', '/api/v1/transactions');
    expect(call?.body).toEqual({
      from_account_id: 'acc-1',
      to_iban: 'FR7612345678901234567890123',
      amount_cents: 1250,
      label: 'Loyer',
    });
    expect(call?.headers.get('Idempotency-Key')).toMatch(UUID);
  });

  it('affiche le refus anti-fraude en français quand le bénéficiaire est inconnu', async () => {
    mockFetch({
      ...base,
      'POST /api/v1/transactions': json(
        { title: 'Accès refusé', reason: 'unknown_beneficiary' },
        403,
      ),
    });
    const user = userEvent.setup();
    renderApp('/virement');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("n'est pas dans votre liste");
  });

  it('explique un solde insuffisant et un montant au-delà du plafond', async () => {
    const replies = [
      json({ title: 'Fonds insuffisants', reason: 'insufficient_funds' }, 402),
      json({ title: 'Accès refusé', reason: 'amount_over_limit' }, 403),
    ];
    mockFetch({ ...base, 'POST /api/v1/transactions': () => replies.shift()! });
    const user = userEvent.setup();
    renderApp('/virement');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Solde insuffisant');
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('plafond'));
  });

  it('rejoue la MÊME clé après une coupure réseau, puis en prend une nouvelle pour le virement suivant', async () => {
    const replies: Array<Response | Error> = [
      new TypeError('réseau coupé'),
      json(transaction(), 201),
      json(transaction({ id: 't-2' }), 201),
    ];
    const fetchMock = mockFetch({ ...base, 'POST /api/v1/transactions': () => replies.shift()! });
    const user = userEvent.setup();
    renderApp('/virement');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('sans risque de double débit');

    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    await screen.findByText(/Virement de 12,50.€ effectué/);

    await fill(user, 'FR7612345678901234567890123', '3');
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/v1/transactions')).toHaveLength(3));

    const keys = callsTo(fetchMock, 'POST', '/api/v1/transactions').map((c) =>
      c.headers.get('Idempotency-Key'),
    );
    expect(keys[0]).toBe(keys[1]); // même demande, même clé : jamais de double débit
    expect(keys[2]).not.toBe(keys[1]); // nouvelle demande, nouvelle clé
  });

  it('vérifie la saisie avant d’appeler l’API', async () => {
    const fetchMock = mockFetch(base);
    const user = userEvent.setup();
    renderApp('/virement');
    await fill(user, 'pas-un-iban', '12');
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "L'IBAN du destinataire est invalide",
    );

    await fill(user, 'FR7612345678901234567890123', 'abc');
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Montant invalide'));

    await fill(user, 'FR7612345678901234567890123', '10001');
    await user.click(screen.getByRole('button', { name: 'Envoyer le virement' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Montant maximum'));
    expect(callsTo(fetchMock, 'POST', '/api/v1/transactions')).toHaveLength(0);
  });

  it('propose les bénéficiaires connus comme destinataires', async () => {
    mockFetch({
      ...base,
      'GET /api/v1/beneficiaries': () =>
        json([
          {
            id: 'b-1',
            iban: 'FR7612345678901234567890123',
            label: 'Propriétaire',
            created_at: '2026-10-20T09:00:00Z',
          },
        ]),
    });
    renderApp('/virement');
    await waitFor(() => expect(document.querySelector('#known-ibans option')).not.toBeNull());
    expect(document.querySelector('#known-ibans option')?.getAttribute('value')).toBe(
      'FR7612345678901234567890123',
    );
  });
});

// --- Bénéficiaires et historique --------------------------------------------------------------

describe('bénéficiaires', () => {
  beforeEach(() => session.set(customerToken()));

  it('ajoute un bénéficiaire et rafraîchit la liste', async () => {
    const list: unknown[] = [];
    const fetchMock = mockFetch({
      'GET /api/v1/beneficiaries': () => json(list),
      'POST /api/v1/beneficiaries': ({ body }) => {
        list.push({
          id: 'b-1',
          iban: 'FR7612345678901234567890123',
          label: body.label,
          created_at: '2026-10-20T09:00:00Z',
        });
        return json(list[0], 201);
      },
    });
    const user = userEvent.setup();
    renderApp('/beneficiaires');
    await screen.findByText('Aucun bénéficiaire pour le moment.');
    await user.type(screen.getByLabelText('IBAN'), 'FR76 1234 5678 9012 3456 7890 123');
    await user.type(screen.getByLabelText('Nom du bénéficiaire'), 'Propriétaire');
    await user.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByText('Propriétaire')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/v1/beneficiaries')[0]?.body).toEqual({
      iban: 'FR76 1234 5678 9012 3456 7890 123',
      label: 'Propriétaire',
    });
  });

  it('signale un doublon', async () => {
    mockFetch({
      'GET /api/v1/beneficiaries': json([]),
      'POST /api/v1/beneficiaries': json({ title: 'Conflit' }, 409),
    });
    const user = userEvent.setup();
    renderApp('/beneficiaires');
    await screen.findByText('Aucun bénéficiaire pour le moment.');
    await user.type(screen.getByLabelText('IBAN'), 'FR7612345678901234567890123');
    await user.type(screen.getByLabelText('Nom du bénéficiaire'), 'X');
    await user.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('existe déjà');
  });
});

describe('historique', () => {
  beforeEach(() => session.set(customerToken()));

  it('distingue les virements émis, reçus et refusés', async () => {
    mockFetch({
      'GET /api/v1/accounts': json([account()]),
      'GET /api/v1/transactions*': json({
        items: [
          transaction({
            id: 't-3',
            amount_cents: 9000,
            status: 'REJECTED',
            reject_reason: 'unknown_beneficiary',
          }),
          transaction({
            id: 't-2',
            from_account_id: 'autre',
            to_account_id: 'acc-1',
            amount_cents: 500,
            label: 'Remboursement',
          }),
          transaction({ id: 't-1', amount_cents: 1250, label: 'Loyer' }),
        ],
        next_cursor: null,
      }),
    });
    renderApp('/historique');
    const refused = (await screen.findByText(/n'est pas dans votre liste/)).closest('li')!;
    expect(within(refused).getByText('Refusé')).toBeInTheDocument();
    expect(within(refused).getByText(/−90,00.€/)).toBeInTheDocument();

    const received = screen.getByText('Remboursement').closest('li')!;
    expect(within(received).getByText(/\+5,00.€/)).toBeInTheDocument();
    const sent = screen.getByText('Loyer').closest('li')!;
    expect(within(sent).getByText(/−12,50.€/)).toBeInTheDocument();
    expect(within(sent).getByText('Exécuté')).toBeInTheDocument();
  });

  it('charge la page suivante avec le curseur', async () => {
    const fetchMock = mockFetch({
      'GET /api/v1/accounts': json([account()]),
      'GET /api/v1/transactions?limit=20': json({
        items: [transaction({ id: 't-2', label: 'Page 1' })],
        next_cursor: 'curseur-1',
      }),
      'GET /api/v1/transactions?limit=20&cursor=curseur-1': json({
        items: [transaction({ id: 't-1', label: 'Page 2' })],
        next_cursor: null,
      }),
    });
    const user = userEvent.setup();
    renderApp('/historique');
    await screen.findByText('Page 1');
    await user.click(screen.getByRole('button', { name: 'Voir plus' }));
    expect(await screen.findByText('Page 2')).toBeInTheDocument();
    expect(screen.getByText('Page 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Voir plus' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/transactions?limit=20&cursor=curseur-1',
      expect.anything(),
    );
  });
});
