import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { chooseTestDataRoot } from './apps/server/src/test-data-root.ts';

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
 * One scalable test timeout per project (R-I2, TS-H1), not per-test numbers. It is a hang
 * guard, never a budget: tests are bounded by what they assert and by controller steps, not by
 * time sized on an idle machine. Each project's base covers its slowest legitimate test with
 * room to spare (the node project: a real Cargo build or a whole roadmap at load 40). A slower
 * or busier host raises every guard with `CRAFTINGTABLE_TEST_TIMEOUT_SCALE` (a positive factor,
 * default 1). Tests read the scaled values through `inject`.
 */
const testTimeScale = (() => {
  const raw = process.env.CRAFTINGTABLE_TEST_TIMEOUT_SCALE;
  if (raw === undefined || raw === '') return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error(`CRAFTINGTABLE_TEST_TIMEOUT_SCALE must be a positive number, not "${raw}"`);
  return scale;
})();
// Where test daemons keep their data (TS-H8): decided once for the whole run, and said when it
// is not the runtime tmpfs. Tests read it with `testDataRoot()`.
const testDataRoot = chooseTestDataRoot();
/**
 * One guard per project from one mechanism: a base scaled by `testTimeScale`. `expect.poll`
 * waits get half of it, so they name their assertion before the test is timed out.
 */
const timeouts = (baseMs: number) => {
  const testTimeoutMs = Math.round(baseMs * testTimeScale);
  return {
    testTimeout: testTimeoutMs,
    hookTimeout: testTimeoutMs,
    expect: { poll: { timeout: testTimeoutMs / 2 } },
    provide: { testTimeoutMs, testTimeScale, testDataRoot },
  };
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
          // The daemon's tests: real repositories, real checks and whole maps.
          ...timeouts(240_000),
          // One migrated template database for the run, which test daemons copy (TS-M13).
          globalSetup: ['packages/storage/src/test-template-setup.ts'],
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
          // Components in jsdom. The slowest, request-budget, took 12-15 s at load 8-13 and
          // 81 s at load 60-75 (the web project under 48 CPU burners).
          ...timeouts(120_000),
          include: ['apps/web/src/**/*.test.tsx'],
          // Nothing a query store caches outlives its test (R-D4).
          setupFiles: ['apps/web/src/test-setup.ts'],
        },
      },
    ],
  },
});
