import { defineConfig } from 'prisma/config';

// Prisma 7 ne charge pas les fichiers .env : la variable doit être dans l'environnement
// (compose, shell, ou `node --env-file=.env`). `process.env` plutôt que `env()` pour que
// `prisma generate` fonctionne sans base (build Docker, CI).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
