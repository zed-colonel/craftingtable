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

/**
 * Installation-wide settings (storage, workstation capacity) are shared by every workspace, so
 * the specs that change them run alone, after the rest (R-I9).
 */
const INSTALLATION_SPECS = ['**/storage.spec.ts'];
const WALKTHROUGH = !!process.env.CRAFTINGTABLE_WALKTHROUGH;

export default defineConfig({
  testDir: './e2e',
  // Every spec works in its own workspace (R-I9, `openOwnWorkspace` in e2e/support.ts), so
  // specs and their tests run in parallel. They still share one daemon, whose workstation
  // capacity is raised below so parallel specs do not queue behind each other's cycles.
  fullyParallel: true,
  workers: Number(process.env.CRAFTINGTABLE_E2E_WORKERS ?? 4),
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/mobile.spec.ts', '**/walkthrough.spec.ts', ...INSTALLATION_SPECS],
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
      testIgnore: INSTALLATION_SPECS,
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
      },
    },
    ...(WALKTHROUGH
      ? []
      : [
          {
            name: 'installation-chromium',
            testMatch: INSTALLATION_SPECS,
            dependencies: ['chromium', 'mobile-chromium'],
            use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
          },
          {
            name: 'installation-mobile-chromium',
            testMatch: INSTALLATION_SPECS,
            dependencies: ['installation-chromium'],
            use: { ...devices['iPhone 13'], browserName: 'chromium' as const },
          },
        ]),
    // The UI walkthrough photographs every page into a store outside the repository
    // (`pnpm ui:walkthrough`, CRAFTINGTABLE_WALKTHROUGH=1). The test gate rehearses it without
    // screenshots in a run of its own (CRAFTINGTABLE_WALKTHROUGH=rehearse) on a fresh daemon,
    // so its seeding cannot interfere with the other specs.
    ...(process.env.CRAFTINGTABLE_WALKTHROUGH
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
      // Playwright otherwise SIGKILLs the group, and the daemon's temporary data directory,
      // which only its signal handlers remove, stays behind on every run.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      env: {
        CRAFTINGTABLE_CLAUDE_EXECUTABLE: FAKE_CLAUDE,
        CRAFTINGTABLE_CODEX_EXECUTABLE: FAKE_CODEX,
        CRAFTINGTABLE_PORT: String(SERVER_PORT),
        CRAFTINGTABLE_PUBLIC_ORIGIN: WEB_URL,
        // The walkthrough photographs the default slots; the gate's parallel specs need more.
        ...(WALKTHROUGH
          ? {}
          : { CRAFTINGTABLE_DEVELOPMENT_CAPACITY: '8', CRAFTINGTABLE_VERIFICATION_CAPACITY: '4' }),
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
