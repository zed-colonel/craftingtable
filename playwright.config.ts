import { defineConfig, devices } from '@playwright/test';

const WEB_URL = 'http://127.0.0.1:5173';
const SERVER_HEALTH_URL = 'http://127.0.0.1:4600/api/health';

// The quality gate must always test freshly started servers built from the
// current source (CT01-R2). Reuse of already-running dev servers is an
// explicit opt-in for the interactive loop only:
//   CRAFTINGTABLE_E2E_REUSE=1 pnpm test:e2e
const reuseExistingServer = process.env.CRAFTINGTABLE_E2E_REUSE === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Typical MacBook browser viewport (acceptance criterion 5).
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @craftingtable/server start',
      url: SERVER_HEALTH_URL,
      reuseExistingServer,
      timeout: 30_000,
    },
    {
      command:
        'pnpm --filter @craftingtable/web exec vite --host 127.0.0.1 --port 5173 --strictPort',
      url: WEB_URL,
      reuseExistingServer,
      timeout: 30_000,
    },
  ],
});
