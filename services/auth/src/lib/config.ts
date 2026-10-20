import { loadConfig } from '@resilience/shared';
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PRIVATE_KEY_FILE: z.string().optional(),
  JWT_ISSUER: z.string().default('resilience-auth'),
  JWT_AUDIENCE: z.string().default('resilience-platform'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
});

export const config = loadConfig(ConfigSchema);
