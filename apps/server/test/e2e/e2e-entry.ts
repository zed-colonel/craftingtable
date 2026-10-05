import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '../../src/composition.js';
import { configFromEnv } from '../../src/config.js';
import { e2eEnvironment } from './e2e-environment.js';
import { openDaemonStorage } from '../../src/persisted-records.js';
import { seedTestDaemonStorage } from './test-daemon-storage.js';
import {
  RUN_PREFIXES,
  runDirectoryPrefix,
  sweepEndedRuns,
} from '../../../../packages/storage/test/test-run-directory.js';
import { chooseTestDataRoot } from './test-data-root.js';

const E2E_USERNAME = 'e2e-admin';
const E2E_PASSWORD = 'correct horse battery staple';
// The run's test data root (R-I2): a disk directory a confined check can see, beside the live
// data directory, or the runtime tmpfs when none is named. The daemon's directory there names
// its PID namespace and process, so a later run removes it if this one is killed before it can
// (R-I2 review); that sweep runs first.
const root = chooseTestDataRoot();
sweepEndedRuns(root);
const directory = mkdtempSync(join(root, runDirectoryPrefix(RUN_PREFIXES.e2e)));
// Agents' own short temporary directories (LIVE-31): the data directory's path is too long.
const agents = mkdtempSync('/tmp/cte-');
// Claude Code's account configuration, holding only the fixture model catalog (R-G15): the
// daemon reads it at start, and never the operator's own.
const claudeConfig = join(directory, 'claude-config');
mkdirSync(join(claudeConfig, 'cache', 'model-catalog'), { recursive: true });
copyFileSync(
  new URL('../../../../fixtures/model-catalogs/claude-cc-v2.json', import.meta.url),
  join(claudeConfig, 'cache', 'model-catalog', 'e2e-cc.json'),
);
process.env.CLAUDE_CONFIG_DIR = claudeConfig;
const config = configFromEnv({
  ...e2eEnvironment(directory, process.env),
  CRAFTINGTABLE_AGENT_TMP_ROOT: agents,
});
// The e2e daemon takes the test daemons' reserve, not the production 5 GiB.
const seeding = openDaemonStorage(config.databasePath);
seedTestDaemonStorage(seeding, config);
seeding.close();
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
