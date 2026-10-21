import { session } from './session';

export type IncidentState = 'DETECTED' | 'REMEDIATING' | 'VERIFYING' | 'RESOLVED' | 'FAILED' | 'IGNORED';

export interface IncidentStep {
  at: string;
  step: string;
  ok: boolean;
  detail: string;
}

export interface Incident {
  id: string;
  type: string;
  state: IncidentState;
  score: number;
  target_service: string | null;
  source_ip: string | null;
  targets: string[];
  stats: { attempts?: number; failures?: number; window_seconds?: number } | null;
  playbook: string | null;
  failure_reason: string | null;
  detected_at: string;
  resolved_at: string | null;
  time_to_recover_seconds: number | null;
  timeline: IncidentStep[];
}

export interface ServiceStatus {
  name: string;
  healthy: boolean;
  last_check_at: string;
  last_canary_ok_at: string | null;
}

export interface IpBlock {
  id: string;
  ip: string;
  incident_id: string;
  created_at: string;
  expires_at: string;
}

export interface Playbook {
  name: string;
  description: string;
  handles: string[];
  steps: string[];
}

export type LedState = 'off' | 'green-blink' | 'green-solid' | 'red-blink' | 'red-solid';

export interface LedSnapshot {
  state: LedState;
  since: string;
  until: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }
}

interface Options {
  method?: string;
  body?: unknown;
  /** `false` pour la connexion : pas de jeton à envoyer, et un 401 n'est pas une session expirée. */
  auth?: boolean;
}

// Le WAF aiguille `/auth/*` vers auth, `/remediation/*` vers la remédiation et `/assistant/*` vers
// l'assistant RAG (IA), en retirant le préfixe.
async function request<T>(
  base: '/auth' | '/remediation' | '/assistant',
  path: string,
  options: Options = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
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

  if (res.status === 401 && authenticated) session.clear();

  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, problem.title ?? 'Erreur', problem.detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const authApi = {
  login: (email: string, password: string) =>
    request<{ access_token: string }>('/auth', '/v1/login', { method: 'POST', body: { email, password }, auth: false }),
  led: () => request<LedSnapshot>('/auth', '/v1/devices/led'),
};

export const remediationApi = {
  incidents: (state?: IncidentState) =>
    request<Incident[]>('/remediation', `/v1/incidents${state ? `?state=${state}` : ''}`),
  incident: (id: string) => request<Incident>('/remediation', `/v1/incidents/${id}`),
  services: () => request<ServiceStatus[]>('/remediation', '/v1/services'),
  blocks: () => request<IpBlock[]>('/remediation', '/v1/blocks'),
  unblock: (id: string) =>
    request<void>('/remediation', `/v1/blocks/${id}`, { method: 'DELETE' }),
  playbooks: () => request<Playbook[]>('/remediation', '/v1/playbooks'),
};

export interface AssistantSource {
  file: string;
  excerpt: string;
  page: number | null;
}

export interface AssistantAnswer {
  answer: string;
  sources: AssistantSource[];
}

export const assistantApi = {
  chat: (question: string) =>
    request<AssistantAnswer>('/assistant', '/v1/chat', { method: 'POST', body: { question } }),
};
