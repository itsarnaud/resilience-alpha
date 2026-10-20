import { defineConfig } from 'vitest/config';

// Vitest ne charge pas .env dans process.env : on le fait ici (sans effet si le fichier manque).
try {
  process.loadEnvFile('.env');
} catch {
  /* pas de .env : les tests d'intégration seront ignorés sans TEST_DATABASE_URL */
}

// Les tests ne doivent JAMAIS toucher la base de développement : ils vident leurs tables.
// 1. On refuse une TEST_DATABASE_URL dont la base ne finit pas par `_test`.
// 2. On remplace DATABASE_URL (celle du développement) par la base de test, avant tout import :
//    la configuration du service est lue à l'import, et un module importé trop tôt la figerait.
const testDb = process.env.TEST_DATABASE_URL;
if (testDb) {
  const name = new URL(testDb).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL doit viser une base de test (nom finissant par _test), pas « ${name} »`,
    );
  }
}
process.env.DATABASE_URL = testDb ?? 'postgresql://inutilise';

export default defineConfig({});
