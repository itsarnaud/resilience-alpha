import { loadConfig } from '@resilience/shared';
import { z } from 'zod';

/** `a, b ,c` devient `['a', 'b', 'c']` */
const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** `auth=http://auth:3000,api=http://api:3000` devient `{ auth: '...', api: '...' }` */
const namedUrls = (v: string): Record<string, string> =>
  Object.fromEntries(
    csv(v).map((pair) => {
      const [name, ...url] = pair.split('=');
      return [name!.trim(), url.join('=').trim()];
    }),
  );

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),

  /** Clés publiques d'`auth` pour vérifier les JWT de ceux qui nous appellent. */
  AUTH_JWKS_URL: z.string().url().default('http://auth:3000/.well-known/jwks.json'),
  JWT_ISSUER: z.string().default('resilience-auth'),
  JWT_AUDIENCE: z.string().default('resilience-platform'),

  /** Notre propre identité auprès d'`auth` (flux client credentials), pour la transaction de test. */
  AUTH_URL: z.string().url().default('http://auth:3000'),
  API_URL: z.string().url().default('http://api:3000'),
  REMEDIATION_CLIENT_ID: z.string().default('svc-remediation'),
  REMEDIATION_CLIENT_SECRET: z.string().min(1),

  /** Services dont on contrôle la disponibilité (`GET <url>/readyz`) : `nom=url,nom=url`. */
  SUPERVISED_SERVICES: z
    .string()
    .default('auth=http://auth:3000,api=http://api:3000')
    .transform(namedUrls),

  /** Liste de blocage lue par le WAF. Le mécanisme exact reste à confirmer avec la cyber. */
  WAF_DENYLIST_FILE: z.string().default('/waf/denylist.conf'),
  /** Conteneur du WAF à recharger (signal HUP) après chaque modification de la liste. Facultatif. */
  WAF_RELOAD_CONTAINER: z.string().optional(),
  BLOCK_DURATION_SECONDS: z.coerce.number().int().positive().default(300),
  /** IP qu'on ne bloque jamais (nous-mêmes, la passerelle) : un faux positif ne doit pas nous couper. */
  PROTECTED_IPS: z.string().default('127.0.0.1,::1,192.168.137.1').transform(csv),

  /** Politique : en dessous, le détecteur signale mais on n'agit pas (un score n'est pas une preuve). */
  MIN_SCORE: z.coerce.number().min(0).max(1).default(0.6),
  /** Pour un brute force avec statistiques : nombre minimal d'échecs observés. */
  MIN_FAILURES: z.coerce.number().int().nonnegative().default(5),
  /** Un incident résolu depuis moins longtemps que ça n'est pas recréé pour la même clé. */
  DEDUP_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),

  /** Vérification de la reprise : nombre d'essais de la transaction de test, et délai entre deux. */
  VERIFY_ATTEMPTS: z.coerce.number().int().positive().default(5),
  VERIFY_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  /** Accès à Docker via le proxy filtré (par exemple `tcp://socket-proxy:2375`). Jamais le socket brut. */
  DOCKER_HOST: z.string().optional(),
  /** Seuls ces conteneurs peuvent être redémarrés. Vide = aucun. */
  ALLOWED_CONTAINERS: z.string().default('').transform(csv),

  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
});

export const config = loadConfig(ConfigSchema);
