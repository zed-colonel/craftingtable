import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume workspace packages from TypeScript source so the web app needs
    // no prior `tsc -b` and gets HMR across package boundaries.
    alias: {
      '@craftingtable/contracts': fromHere('../../packages/contracts/src/index.ts'),
      '@craftingtable/domain': fromHere('../../packages/domain/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4600',
      },
    },
  },
});
