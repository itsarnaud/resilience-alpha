import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// En développement, le navigateur appelle `/auth/...` et `/api/...` : Vite les redirige vers les
// services locaux en retirant le préfixe. En démo, c'est le WAF qui fait ce travail.
const AUTH_URL = process.env.AUTH_URL ?? 'http://localhost:3000';
const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: AUTH_URL, changeOrigin: true, rewrite: (p) => p.replace(/^\/auth/, '') },
      '/api': { target: API_URL, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
