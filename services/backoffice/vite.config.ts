import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// En développement, le navigateur appelle `/auth/...` : Vite le redirige vers `auth` en retirant le
// préfixe. En démo, c'est le WAF qui fait ce travail. La caméra exige un contexte sécurisé
// (HTTPS ou localhost) : cette page doit être ouverte depuis le navigateur du PC Hôte.
const AUTH_URL = process.env.AUTH_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    proxy: {
      '/auth': { target: AUTH_URL, changeOrigin: true, rewrite: (p) => p.replace(/^\/auth/, '') },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
