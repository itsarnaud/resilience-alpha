import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// En développement, le navigateur appelle `/auth/...`, `/remediation/...` et `/assistant/...` :
// Vite les redirige vers les services locaux en retirant le préfixe. En démo, c'est le WAF qui
// fait ce travail. L'assistant (IA, `ml/ai-runtime`) n'est pas dans le compose dev : adresse par
// défaut alignée sur son propre guide de déploiement (port 8012).
const AUTH_URL = process.env.AUTH_URL ?? 'http://localhost:3000';
const REMEDIATION_URL = process.env.REMEDIATION_URL ?? 'http://localhost:3002';
const ASSISTANT_URL = process.env.ASSISTANT_URL ?? 'http://localhost:8012';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/auth': { target: AUTH_URL, changeOrigin: true, rewrite: (p) => p.replace(/^\/auth/, '') },
      '/remediation': {
        target: REMEDIATION_URL,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/remediation/, ''),
      },
      // Contrairement à /auth et /remediation, l'assistant sert déjà ses routes sous /assistant/...
      // (voir ml/ai-runtime) : pas de préfixe à retirer.
      '/assistant': { target: ASSISTANT_URL, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
