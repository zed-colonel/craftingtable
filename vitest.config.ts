import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to TypeScript source so unit tests do not
    // require a prior `tsc -b`.
    alias: {
      '@craftingtable/domain': fromHere('./packages/domain/src/index.ts'),
      '@craftingtable/contracts': fromHere('./packages/contracts/src/index.ts'),
      '@craftingtable/agents': fromHere('./packages/agents/src/index.ts'),
      '@craftingtable/git': fromHere('./packages/git/src/index.ts'),
      '@craftingtable/testing': fromHere('./packages/testing/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/server/src/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
  },
});
