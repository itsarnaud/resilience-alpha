import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile('.env');
} catch {}

export default defineConfig({});
