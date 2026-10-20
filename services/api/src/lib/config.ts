import { loadConfig } from '@resilience/shared';
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),

  AUTH_JWKS_URL: z.url().default('http://auth:3000/.well-known/jwks.json'),
  JWT_ISSUER: z.string().default('resilience-auth'),
  JWT_AUDIENCE: z.string().default('resilience-platform'),

  EXTERNAL_TRANSFER_LIMIT_CENTS: z.coerce.number().int().positive().default(50_000),
  INITIAL_BALANCE_CENTS: z.coerce.number().int().nonnegative().default(100_000),
  MAX_ACCOUNTS_PER_USER: z.coerce.number().int().positive().default(5),

  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
});

export const config = loadConfig(ConfigSchema);
