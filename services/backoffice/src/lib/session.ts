/**
 * Session du client : le JWT est gardé dans `sessionStorage` (il disparaît à la fermeture de
 * l'onglet) et décodé pour connaître son échéance. La vraie vérification est faite par les services.
 */
const KEY = 'resilience.token';

export interface Session {
  token: string;
  sub: string;
  roles: string[];
  /** Échéance, en secondes depuis 1970. */
  exp: number;
}

function decode(token: string): Session | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof json.sub !== 'string' || typeof json.exp !== 'number') return null;
    return {
      token,
      sub: json.sub,
      roles: Array.isArray(json.roles)
        ? json.roles.filter((r: unknown) => typeof r === 'string')
        : [],
      exp: json.exp,
    };
  } catch {
    return null;
  }
}

// sessionStorage peut être indisponible (navigation privée stricte) : repli en mémoire.
let memory: string | null = null;
const read = (): string | null => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return memory;
  }
};
const write = (value: string | null) => {
  memory = value;
  try {
    if (value === null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, value);
  } catch {
    /* repli en mémoire */
  }
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

// `useSyncExternalStore` exige le même objet tant que rien ne change.
let lastRaw: string | null = null;
let lastSession: Session | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

export const session = {
  get(): Session | null {
    const raw = read();
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastSession = raw ? decode(raw) : null;
    }
    if (lastSession && lastSession.exp * 1000 <= Date.now()) {
      write(null);
      lastRaw = null;
      lastSession = null;
    }
    return lastSession;
  },

  set(token: string) {
    write(token);
    const current = this.get();
    clearTimeout(expiryTimer);
    if (current) {
      // À l'échéance du jeton, prévenir l'interface pour qu'elle renvoie vers la connexion.
      expiryTimer = setTimeout(emit, Math.max(0, current.exp * 1000 - Date.now()) + 50);
    }
    emit();
  },

  clear() {
    clearTimeout(expiryTimer);
    write(null);
    emit();
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
