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
};

/**
 * The suite's one test timeout (R-I2, TS-H1). It is a hang guard, never a budget: tests are
 * bounded by what they assert and by controller steps, not by time sized on an idle machine.
 * It covers the slowest legitimate test, a real Cargo build or a whole roadmap at load 40,
 * with room to spare. A slower or busier host raises it with
 * `CRAFTINGTABLE_TEST_TIMEOUT_SCALE` (a positive factor, default 1). Tests read the scaled
 * values through `inject`.
 */
const testTimeScale = (() => {
  const raw = process.env.CRAFTINGTABLE_TEST_TIMEOUT_SCALE;
  if (raw === undefined || raw === '') return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error(`CRAFTINGTABLE_TEST_TIMEOUT_SCALE must be a positive number, not "${raw}"`);
  return scale;
})();
const testTimeoutMs = Math.round(240_000 * testTimeScale);
const timeouts = {
  testTimeout: testTimeoutMs,
  hookTimeout: testTimeoutMs,
  // `expect.poll` waits on a real process: a hang guard too, half the test's, so it names its
  // assertion before the test is timed out.
  expect: { poll: { timeout: testTimeoutMs / 2 } },
  provide: { testTimeoutMs, testTimeScale },
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
          ...timeouts,
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
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
          ...timeouts,
          include: ['apps/web/src/**/*.test.tsx'],
          // Nothing a query store caches outlives its test (R-D4).
          setupFiles: ['apps/web/src/test-setup.ts'],
        },
      },
    ],
  },
});
