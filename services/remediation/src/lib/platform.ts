import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const timeout = () => AbortSignal.timeout(config.HTTP_TIMEOUT_MS);

interface CachedToken {
  value: string;
  expiresAt: number;
}
let cached: CachedToken | undefined;
let inFlight: Promise<string> | undefined;

/** Jeton de service obtenu auprès d'`auth`, mis en cache jusqu'à peu avant son expiration. */
export async function getServiceToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
  inFlight ??= (async () => {
    const res = await fetch(`${config.AUTH_URL}/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.REMEDIATION_CLIENT_ID,
        client_secret: config.REMEDIATION_CLIENT_SECRET,
      }),
      signal: timeout(),
    });
    if (!res.ok) throw new Error(`auth a refusé notre jeton de service (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/** Appel authentifié à l'API. Si le jeton est refusé (clé tournée, expiration), un seul nouvel essai. */
async function apiFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const call = async () =>
    fetch(`${config.API_URL}${pathname}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${await getServiceToken()}`,
      },
      signal: timeout(),
    });
  const res = await call();
  if (res.status !== 401) return res;
  cached = undefined;
  return call();
}

/** `GET <url>/readyz` : le service répond-il et sa base aussi ? */
export async function isReady(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/readyz`, { signal: timeout() });
    return res.ok;
  } catch {
    return false;
  }
}

interface AccountDto {
  id: string;
  balance_cents: number;
}

/**
 * Transaction de test : un virement de 1 centime entre les deux comptes du canari, marqué
 * synthétique. C'est la preuve que le service métier fonctionne de bout en bout, pas seulement
 * qu'un conteneur a redémarré. Lève une erreur expliquant l'échec.
 */
export async function runCanaryTransaction(): Promise<string> {
  const listRes = await apiFetch('/v1/accounts');
  if (!listRes.ok) throw new Error(`liste des comptes canari : HTTP ${listRes.status}`);
  const accounts = (await listRes.json()) as AccountDto[];
  if (accounts.length < 2) {
    throw new Error("moins de deux comptes canari (le seed de l'API n'a pas été lancé ?)");
  }
  const [from, to] = [...accounts].sort((a, b) => b.balance_cents - a.balance_cents);

  const res = await apiFetch('/v1/transactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      'X-Synthetic': 'true',
    },
    body: JSON.stringify({
      from_account_id: from!.id,
      to_account_id: to!.id,
      amount_cents: 1,
      label: 'canari',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string };
  if (res.status !== 201 || body.status !== 'COMPLETED') {
    throw new Error(`transaction de test refusée : HTTP ${res.status}`);
  }
  return `transaction ${body.id} exécutée`;
}
