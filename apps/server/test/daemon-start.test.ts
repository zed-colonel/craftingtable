import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configFromEnv } from '../src/config.js';
import { type StartedDaemon, startDaemon } from '../src/daemon-start.js';
import { InstanceLockedError } from '../src/instance-lock.js';
import { testDataRoot } from './test-support.js';

const started: StartedDaemon[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const daemon of started.splice(0)) {
    await daemon.runtime.close();
    await daemon.lock.release();
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const directory = (prefix: string): string => {
  const path = mkdtempSync(join(testDataRoot(), prefix));
  directories.push(path);
  return path;
};

/** A daemon's configuration as the operator's unit gives it, with its own data directory. */
const daemonConfig = (agentRoot: string) =>
  configFromEnv({
    CRAFTINGTABLE_DATA_DIR: directory('craftingtable-start-'),
    CRAFTINGTABLE_AGENT_TMP_ROOT: agentRoot,
    CRAFTINGTABLE_LOG_LEVEL: 'silent',
    CRAFTINGTABLE_WEB_DIST: '',
    CRAFTINGTABLE_CHECK_CONFINEMENT: 'none',
  });

it("refuses a second daemon on another daemon's agents' temporary root before its start sweeps it (R-G5)", async () => {
  const root = directory('cta-');
  const first = await startDaemon(daemonConfig(root), { logger: false });
  started.push(first);
  // The first daemon's live run directory: the second's start sweep would remove it.
  const live = join(root, '0123456789ab');
  mkdirSync(live);
  const second = daemonConfig(root);
  const refused = await startDaemon(second, { logger: false }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(InstanceLockedError);
  expect((refused as InstanceLockedError).resource).toBe('agents-temporary-root');
  expect(existsSync(live)).toBe(true);
  // Refused before any database work, and holding nothing afterwards.
  expect(existsSync(second.databasePath)).toBe(false);
  const retried = await startDaemon(
    { ...second, execution: { ...second.execution, agentTemporaryRoot: directory('cta-') } },
    { logger: false },
  );
  started.push(retried);
});

it("starts two daemons whose agents' temporary roots differ (R-G5)", async () => {
  started.push(await startDaemon(daemonConfig(directory('cta-')), { logger: false }));
  started.push(await startDaemon(daemonConfig(directory('cta-')), { logger: false }));
  for (const daemon of started) {
    const health = await daemon.runtime.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  }
});
