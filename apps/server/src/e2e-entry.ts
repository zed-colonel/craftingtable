import { mkdtempSync, rmSync } from 'node:fs';
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
  // Run directories written while the daemon closed made one removal stop partway (R-I5,
  // seen at load average 14 to 20); retrying lets it finish.
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));

await runtime.app.listen({ host: config.host, port: config.port });
