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
    // This is deliberately an opt-in frontend-only development server. The
    // supported local product is `npm run local` at :8080.
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      // Dev-only: reach the hosted Polygraph product server. Production is
      // same-origin because `polygraph serve` serves app/dist itself.
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
