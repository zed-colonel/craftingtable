import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Resolve workspace packages to TypeScript source so unit tests do not
// require a prior `tsc -b`.
const alias = {
  '@craftingtable/domain': fromHere('./packages/domain/src/index.ts'),
  '@craftingtable/contracts': fromHere('./packages/contracts/src/index.ts'),
  '@craftingtable/planning': fromHere('./packages/planning/src/index.ts'),
  '@craftingtable/storage': fromHere('./packages/storage/src/index.ts'),
  '@craftingtable/agents': fromHere('./packages/agents/src/index.ts'),
  '@craftingtable/git': fromHere('./packages/git/src/index.ts'),
  '@craftingtable/testing': fromHere('./packages/testing/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // Two environments in one run: the daemon and its packages stay on `node`,
    // and only the browser components pay for a DOM (ADR-015).
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/server/src/**/*.test.ts',
            'apps/web/src/**/*.test.ts',
            'scripts/**/*.test.mjs',
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.tsx'],
        },
      },
    ],
  },
});
