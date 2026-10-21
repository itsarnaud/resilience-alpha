import { session } from './session';

export type BackofficeState =
  'IDENTIFIED' | 'PASSWORD_PENDING' | 'GRANTED' | 'FACE_REFUSED' | 'PASSWORD_REFUSED' | 'EXPIRED';

export interface BackofficeLogin {
  session_id: string;
  state: BackofficeState;
  expires_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  state: 'GRANTED';
}

export interface UserSummary {
  id: string;
  email: string;
  roles: string[];
  active: boolean;
  created_at: string;
}

/** Erreur du serveur, avec les champs propres aux refus de connexion (voir docs/api/auth.openapi.yaml). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly reason?: string,
    readonly retryAfterSeconds?: number,
    readonly locked?: boolean,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }
}

interface Options {
  method?: string;
  body?: unknown;
  /** Corps binaire (la photo) : envoyé tel quel, avec ce type de contenu. */
  binary?: { blob: Blob; contentType: string };
  /** `false` pour les étapes de connexion, qui n'ont pas encore de jeton. */
  auth?: boolean;
}

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.binary) headers['Content-Type'] = options.binary.contentType;
  else if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const authenticated = options.auth !== false;
  const current = authenticated ? session.get() : null;
  if (current) headers.Authorization = `Bearer ${current.token}`;

  let res: Response;
  try {
    res = await fetch(`/auth${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.binary
        ? options.binary.blob
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    });
  } catch {
    throw new ApiError(0, 'Service injoignable', 'Vérifiez la connexion puis réessayez.');
  }

  if (res.status === 401 && authenticated) session.clear();

  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as {
      title?: string;
      detail?: string;
      reason?: string;
      retry_after_seconds?: number;
      locked?: boolean;
    };
    throw new ApiError(
      res.status,
      problem.title ?? 'Erreur',
      problem.detail,
      problem.reason,
      problem.retry_after_seconds,
      problem.locked,
    );
  }
  return (await res.json()) as T;
}

export const loginApi = {
  start: (identifier: string) =>
    request<BackofficeLogin>('/v1/backoffice/login', {
      method: 'POST',
      body: { identifier },
      auth: false,
    }),
  get: (id: string) => request<BackofficeLogin>(`/v1/backoffice/login/${id}`, { auth: false }),
  face: (id: string, blob: Blob) =>
    request<BackofficeLogin>(`/v1/backoffice/login/${id}/face`, {
      method: 'POST',
      binary: { blob, contentType: 'image/jpeg' },
      auth: false,
    }),
  password: (id: string, password: string) =>
    request<TokenResponse>(`/v1/backoffice/login/${id}/password`, {
      method: 'POST',
      body: { password },
      auth: false,
    }),
};

export const adminApi = {
  users: () => request<UserSummary[]>('/v1/admin/users'),
  createUser: (email: string, password: string, roles: string[]) =>
    request<UserSummary>('/v1/admin/users', { method: 'POST', body: { email, password, roles } }),
  updateUser: (id: string, patch: { roles?: string[]; active?: boolean }) =>
    request<UserSummary>(`/v1/admin/users/${id}`, { method: 'PATCH', body: patch }),
  enrollFace: (id: string, blob: Blob) =>
    request<{ samples: number }>(`/v1/admin/users/${id}/face`, {
      method: 'POST',
      binary: { blob, contentType: 'image/jpeg' },
    }),
  unlock: (identifier: string) =>
    request<void>(`/v1/admin/lockouts/${encodeURIComponent(identifier)}`, { method: 'DELETE' }),
};
