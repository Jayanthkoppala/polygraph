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
    // Consumed by the existing Node server (src/server.ts), which currently
    // only serves web/index.html — a later integration task wires it to
    // serve this directory's contents too. See task-5-report.md.
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Dev-only convenience so `npm run dev` can hit a locally running
      // `polygraph watch` (default port 4141, see src/index.ts) without
      // duplicating API logic. Not used in the production build, which is
      // served same-origin by the Node server.
      '/api': {
        target: 'http://localhost:4141',
        changeOrigin: true,
      },
    },
  },
});
