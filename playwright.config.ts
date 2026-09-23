import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/** The daemon under test launches this scripted stand-in instead of Claude Code. */
const FAKE_CODEX = fileURLToPath(new URL('./e2e/fake-codex.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./e2e/fake-claude.mjs', import.meta.url));

// The suite owns these ports so it runs alongside an operator daemon or `pnpm dev`
// on the usual 4600/5173. They must stay in step with the defaults in
// `apps/server/src/e2e-entry.ts`.
const SERVER_PORT = 4610;
const WEB_PORT = 5183;
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const SERVER_HEALTH_URL = `${SERVER_ORIGIN}/api/health`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // Browser scenarios share one SQLite daemon and run real Git/agent workflows.
  // Bound harness load so UI readiness checks measure behavior rather than contention.
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/mobile.spec.ts', '**/walkthrough.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        // Typical MacBook browser viewport (acceptance criterion 5).
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile-chromium',
      testMatch: [
        '**/mobile.spec.ts',
        '**/notifications.spec.ts',
        '**/package-imports.spec.ts',
        '**/storage.spec.ts',
        '**/roadmaps.spec.ts',
        '**/finalization.spec.ts',
      ],
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
      },
    },
    // The UI walkthrough photographs every page into a store outside the repository. It is
    // opted into by `pnpm ui:walkthrough` and never part of the test gate.
    ...(process.env.CRAFTINGTABLE_WALKTHROUGH === '1'
      ? [
          {
            name: 'walkthrough',
            testMatch: '**/walkthrough.spec.ts',
            use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: 'pnpm --filter @craftingtable/server e2e:start',
      url: SERVER_HEALTH_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        CRAFTINGTABLE_CLAUDE_EXECUTABLE: FAKE_CLAUDE,
        CRAFTINGTABLE_CODEX_EXECUTABLE: FAKE_CODEX,
        CRAFTINGTABLE_PORT: String(SERVER_PORT),
        CRAFTINGTABLE_PUBLIC_ORIGIN: WEB_URL,
      },
    },
    {
      command: `pnpm --filter @craftingtable/web exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { CRAFTINGTABLE_DEV_API_TARGET: SERVER_ORIGIN },
    },
  ],
});
