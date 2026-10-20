import { session } from './session';

export interface Account {
  id: string;
  iban: string;
  balance_cents: number;
  currency: string;
}

export interface Beneficiary {
  id: string;
  iban: string;
  label: string;
  created_at: string;
}

export interface Transaction {
  id: string;
  from_account_id: string;
  to_account_id: string | null;
  to_iban: string | null;
  amount_cents: number;
  label: string | null;
  status: 'COMPLETED' | 'REJECTED';
  reject_reason: string | null;
  synthetic: boolean;
  created_at: string;
}

export interface TransactionPage {
  items: Transaction[];
  next_cursor: string | null;
}

/** Erreur renvoyée par un service (format problem+json), ou `status: 0` si le service ne répond pas. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    /** Motif lisible par une machine, par exemple `unknown_beneficiary`. */
    readonly reason?: string,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }
}

interface Options {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `false` pour la connexion : pas de jeton à envoyer, et un 401 n'est pas une session expirée. */
  auth?: boolean;
}

// Le WAF aiguille `/auth/*` vers le service auth et `/api/*` vers l'API, en retirant le préfixe.
async function request<T>(base: '/auth' | '/api', path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const authenticated = options.auth !== false;
  const current = authenticated ? session.get() : null;
  if (current) headers.Authorization = `Bearer ${current.token}`;

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Service injoignable', 'Vérifiez la connexion puis réessayez.');
  }

  // Jeton refusé : la session a expiré ou a été révoquée, retour à la page de connexion.
  if (res.status === 401 && authenticated) session.clear();

  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as {
      title?: string;
      detail?: string;
      reason?: string;
    };
    throw new ApiError(res.status, problem.title ?? 'Erreur', problem.detail, problem.reason);
  }
  return (await res.json()) as T;
}

export const authApi = {
  login: (email: string, password: string) =>
    request<{ access_token: string }>('/auth', '/v1/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  register: (email: string, password: string) =>
    request<{ id: string }>('/auth', '/v1/register', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
};

export const paymentsApi = {
  accounts: () => request<Account[]>('/api', '/v1/accounts'),
  openAccount: () => request<Account>('/api', '/v1/accounts', { method: 'POST' }),
  beneficiaries: () => request<Beneficiary[]>('/api', '/v1/beneficiaries'),
  addBeneficiary: (iban: string, label: string) =>
    request<Beneficiary>('/api', '/v1/beneficiaries', { method: 'POST', body: { iban, label } }),
  transactions: (cursor?: string) =>
    request<TransactionPage>(
      '/api',
      `/v1/transactions?limit=20${cursor ? `&cursor=${cursor}` : ''}`,
    ),
  /** La même `Idempotency-Key` rejouée ne débite jamais deux fois : sûr à réessayer. */
  transfer: (
    body: { from_account_id: string; to_iban: string; amount_cents: number; label?: string },
    idempotencyKey: string,
  ) =>
    request<Transaction>('/api', '/v1/transactions', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
};
