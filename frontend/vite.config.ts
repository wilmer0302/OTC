import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dos páginas: la demo anterior en / (API /api) y la consola nueva en /consola/ (API /api/v1).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        consola: resolve(import.meta.dirname, 'consola/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' },
  },
});
