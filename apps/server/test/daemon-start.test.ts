import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configFromEnv } from '../src/config.js';
import { type StartedDaemon, startDaemon } from '../src/daemon-start.js';
import { acquireDaemonLocks, InstanceLockedError } from '../src/instance-lock.js';
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

/** No agent CLI of the host's: a daemon reads each backend's model catalog at start (R-G15). */
const quiet = { logger: false, overrides: { agentBackends: new Map() } } as const;

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
  const first = await startDaemon(daemonConfig(root), quiet);
  started.push(first);
  // The first daemon's live run directory: the second's start sweep would remove it.
  const live = join(root, '0123456789ab');
  mkdirSync(live);
  const second = daemonConfig(root);
  const refused: StartedDaemon | unknown = await startDaemon(second, quiet).catch(
    (error: unknown) => error,
  );
  // Had it started, its sweep's removals would run in the background: wait for them before
  // looking at the first daemon's run directory (R-G5 review).
  if (!(refused instanceof Error)) {
    const daemon = refused as StartedDaemon;
    started.push(daemon);
    await daemon.runtime.services.agentRunService.quiesce();
  }
  expect(existsSync(live)).toBe(true);
  expect(refused).toBeInstanceOf(InstanceLockedError);
  expect((refused as InstanceLockedError).resource).toBe('agents-temporary-root');
  // Refused before any database work, and holding nothing afterwards.
  expect(existsSync(second.databasePath)).toBe(false);
  const retried = await startDaemon(
    { ...second, execution: { ...second.execution, agentTemporaryRoot: directory('cta-') } },
    quiet,
  );
  started.push(retried);
});

it("starts two daemons whose agents' temporary roots differ (R-G5)", async () => {
  started.push(await startDaemon(daemonConfig(directory('cta-')), quiet));
  started.push(await startDaemon(daemonConfig(directory('cta-')), quiet));
  for (const daemon of started) {
    const health = await daemon.runtime.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  }
});

it('releases both locks when the runtime fails to start (R-G5)', async () => {
  const config = daemonConfig(directory('cta-'));
  // A database path the storage cannot open: the start fails after taking its locks.
  mkdirSync(config.databasePath, { recursive: true });
  // Refused by the storage, after the locks were taken: not by a lock.
  const failed = await startDaemon(config, quiet).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(Error);
  expect(failed).not.toBeInstanceOf(InstanceLockedError);
  const lock = await acquireDaemonLocks(config);
  await lock.release();
});

it("names the agents' temporary root when it cannot be created (R-G5)", async () => {
  const base = directory('cta-');
  // A link to a directory that does not exist yet: the configuration accepts it.
  symlinkSync(join(base, 'not-yet'), join(base, 'root'));
  const config = daemonConfig(join(base, 'root'));
  await expect(startDaemon(config, quiet)).rejects.toThrow(
    `CRAFTINGTABLE_AGENT_TMP_ROOT ${join(base, 'root')} could not be created: ENOENT`,
  );
  expect(existsSync(config.databasePath)).toBe(false);
});
