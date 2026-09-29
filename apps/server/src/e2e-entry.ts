import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './composition.js';
import { configFromEnv } from './config.js';

const E2E_USERNAME = 'e2e-admin';
const E2E_PASSWORD = 'correct horse battery staple';
const directory = mkdtempSync(join(tmpdir(), 'craftingtable-e2e-'));
const config = configFromEnv({
  CRAFTINGTABLE_DATA_DIR: directory,
  CRAFTINGTABLE_HOST: '127.0.0.1',
  // Defaults match `playwright.config.ts`, away from the 4600/5173 an operator
  // daemon or `pnpm dev` uses; Playwright passes both explicitly.
  CRAFTINGTABLE_PORT: process.env.CRAFTINGTABLE_PORT ?? '4610',
  CRAFTINGTABLE_PUBLIC_ORIGIN: process.env.CRAFTINGTABLE_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5183',
  CRAFTINGTABLE_LOG_LEVEL: 'warn',
  CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '0',
  ...(process.env.CRAFTINGTABLE_CLAUDE_EXECUTABLE === undefined
    ? {}
    : { CRAFTINGTABLE_CLAUDE_EXECUTABLE: process.env.CRAFTINGTABLE_CLAUDE_EXECUTABLE }),
  ...(process.env.CRAFTINGTABLE_CODEX_EXECUTABLE === undefined
    ? {}
    : { CRAFTINGTABLE_CODEX_EXECUTABLE: process.env.CRAFTINGTABLE_CODEX_EXECUTABLE }),
  ...(process.env.CRAFTINGTABLE_GIT_EXECUTABLE === undefined
    ? {}
    : { CRAFTINGTABLE_GIT_EXECUTABLE: process.env.CRAFTINGTABLE_GIT_EXECUTABLE }),
});
const runtime = await createRuntime(config, {
  logger: true,
  overrides: { notificationTransport: { send: async () => ({ status: 'accepted' }) } },
});
await runtime.services.bootstrapService.bootstrap(E2E_USERNAME, E2E_PASSWORD);

let closing = false;
async function close(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  await runtime.close();
  // A launch already under way when the stop came can still create its run directory for a
  // moment after the runtime closes: roadmaps the specs leave running keep launching until
  // then. One removal raced it and left `backups` and `runs` behind on every parallel run
  // (R-I5, R-I9), so remove until the directory stays gone.
  for (let attempt = 0; attempt < 20 && existsSync(directory); attempt++) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));

await runtime.app.listen({ host: config.host, port: config.port });
