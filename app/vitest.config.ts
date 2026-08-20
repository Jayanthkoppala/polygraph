import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deliberately does NOT load @tailwindcss/vite: the token smoke test drives
// @tailwindcss/postcss directly against src/app.css so it exercises the
// same compiler Vite uses without needing a full Vite dev pipeline inside
// the test runner. React components in later tasks use this config as-is.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
