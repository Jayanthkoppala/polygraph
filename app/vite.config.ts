import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // The Node server (src/http/static.ts) serves this dist as the dashboard SPA.
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Dev-only: reach a local `polygraph watch` (default port 4141).
      // Production is same-origin, so no proxy there.
      '/api': {
        target: 'http://localhost:4141',
        changeOrigin: true,
      },
    },
  },
});
