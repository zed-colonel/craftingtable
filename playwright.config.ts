import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/** The daemon under test launches this scripted stand-in instead of Claude Code. */
const FAKE_CODEX = fileURLToPath(new URL('./e2e/fake-codex.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./e2e/fake-claude.mjs', import.meta.url));
const SERVER_DIRECTORY = fileURLToPath(new URL('./apps/server/', import.meta.url));

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

/**
 * One scalable timeout for the suite (TS-M15), as `vitest.config.ts` has for the unit tests
 * (R-I2, TS-H1). Specs wait on state with Playwright's retrying `expect` (the deep-links
 * spec's settle sleeps are E2E F7, still open), and they pass no `timeout:` of their own: a
 * number sized on an idle machine fails under load, which slows each step of a run, not the
 * number of steps. Every wait gets one bound, a step, and a test gets a fixed number of steps;
 * both are hang guards, not budgets. A slower or busier host raises them all with
 * `CRAFTINGTABLE_TEST_TIMEOUT_SCALE` (a positive factor, default 1), the variable the unit
 * tests read. Its parsing repeats `vitest.config.ts`'s.
 */
const TIME_SCALE = (() => {
  const raw = process.env.CRAFTINGTABLE_TEST_TIMEOUT_SCALE;
  if (raw === undefined || raw === '') return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error(`CRAFTINGTABLE_TEST_TIMEOUT_SCALE must be a positive number, not "${raw}"`);
  return scale;
})();
/**
 * One wait: an assertion, an action or a navigation. The longest is a whole agent run or
 * cycle stage under load (at load 34-37, waits for run progress sized at 20-30 s failed).
 */
const STEP_TIMEOUT_MS = Math.round(60_000 * TIME_SCALE);
/** One spec. The longest, package imports and finalization, took 35-65 s at load 4. */
const TEST_TIMEOUT_MS = 5 * STEP_TIMEOUT_MS;
/** The walkthrough is one test that seeds and visits every page: about 3 minutes at load 4-29. */
const WALKTHROUGH_TIMEOUT_MS = 15 * STEP_TIMEOUT_MS;

export default defineConfig({
  testDir: './e2e',
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: STEP_TIMEOUT_MS },
  // Every spec works in its own workspace (R-I9, `openOwnWorkspace` in e2e/support.ts), so
  // specs and their tests run in parallel. They still share one daemon, whose workstation
  // capacity is raised below so parallel specs do not queue behind each other's cycles.
  fullyParallel: true,
  workers: Math.max(1, Number.parseInt(process.env.CRAFTINGTABLE_E2E_WORKERS ?? '', 10) || 4),
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    screenshot: 'only-on-failure',
    // Also the default for contexts a spec opens itself (the walkthrough's phone).
    actionTimeout: STEP_TIMEOUT_MS,
    navigationTimeout: STEP_TIMEOUT_MS,
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
        '**/roadmaps.spec.ts',
        '**/finalization.spec.ts',
      ],
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
            timeout: WALKTHROUGH_TIMEOUT_MS,
            use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
          },
        ]
      : []),
  ],
  webServer: [
    {
      // `exec` makes the daemon the process Playwright waits for. Started through pnpm, pnpm
      // left at the stop signal, Playwright took the command as finished and killed the group,
      // and the daemon died partway through removing its data directory (R-I5, R-I9).
      command: 'exec node --import tsx test/e2e/e2e-entry.ts',
      cwd: SERVER_DIRECTORY,
      url: SERVER_HEALTH_URL,
      reuseExistingServer: false,
      timeout: STEP_TIMEOUT_MS,
      // Playwright otherwise SIGKILLs the group, and the daemon's temporary data directory,
      // which only its signal handlers remove, stays behind on every run. Closing takes
      // milliseconds when idle; the bound is scaled with the rest for a slower host.
      gracefulShutdown: { signal: 'SIGTERM', timeout: Math.round(10_000 * TIME_SCALE) },
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
      timeout: STEP_TIMEOUT_MS,
      env: { CRAFTINGTABLE_DEV_API_TARGET: SERVER_ORIGIN },
    },
  ],
});
