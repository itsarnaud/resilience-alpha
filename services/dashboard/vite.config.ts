import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// En développement, le navigateur appelle `/auth/...` et `/remediation/...` : Vite les redirige
// vers les services locaux en retirant le préfixe. En démo, c'est le WAF qui fait ce travail.
const AUTH_URL = process.env.AUTH_URL ?? 'http://localhost:3000';
const REMEDIATION_URL = process.env.REMEDIATION_URL ?? 'http://localhost:3002';

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
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
