import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from './composition.js';
import { configFromEnv } from './config.js';
import { e2eEnvironment } from './e2e-environment.js';
import { testDataRoot } from './test-data-root.js';

const E2E_USERNAME = 'e2e-admin';
const E2E_PASSWORD = 'correct horse battery staple';
// On tmpfs (TS-H8): a commit's fsync on a disk TMPDIR stalled this daemon for seconds.
const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-e2e-'));
// Agents' own short temporary directories (LIVE-31): the data directory's path is too long.
const agents = mkdtempSync('/tmp/cte-');
const config = configFromEnv({
  ...e2eEnvironment(directory, process.env),
  CRAFTINGTABLE_AGENT_TMP_ROOT: agents,
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
  rmSync(agents, { recursive: true, force: true });
}

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.once('exit', () => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(agents, { recursive: true, force: true });
});

await runtime.app.listen({ host: config.host, port: config.port });
