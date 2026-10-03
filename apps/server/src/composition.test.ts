import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServices } from './composition.js';
import { configFromEnv } from './config.js';
import { openDaemonStorage } from './persisted-records.js';
import { FastTestPasswordHasher, testDataRoot } from './test-support.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('service composition', () => {
  it('composes the planning, auth and execution services', async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-composition-'));
    directories.push(directory);
    const storage = openDaemonStorage(join(directory, 'state.sqlite'));
    try {
      const services = await createServices(
        storage,
        configFromEnv({ CRAFTINGTABLE_DATA_DIR: directory }),
        { passwordHasher: new FastTestPasswordHasher(), gitOperations: null },
      );
      expect(services.authService).toBeDefined();
      expect(services.planningQueryService).toBeDefined();
      expect(services.workCycleService).toBeDefined();
      await services.daemonDrain.drain(0);
    } finally {
      storage.close();
    }
  });

  it("saves the production storage defaults on a daemon's first start (TS-H8)", async () => {
    // Test daemons start with a smaller reserve; a daemon without one keeps the production
    // defaults, saved before anything else reads them.
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-composition-'));
    directories.push(directory);
    const storage = openDaemonStorage(join(directory, 'state.sqlite'));
    try {
      expect(storage.maintenance.settings()).toBeFalsy();
      const services = await createServices(
        storage,
        configFromEnv({ CRAFTINGTABLE_DATA_DIR: directory }),
        { passwordHasher: new FastTestPasswordHasher(), gitOperations: null },
      );
      expect(storage.maintenance.settings()).toMatchObject({
        version: 1,
        policy: {
          worktreeRoot: join(directory, 'worktrees'),
          runsRoot: join(directory, 'runs'),
          backupRoot: join(directory, 'backups'),
          autoCleanBuildCaches: true,
          scratchRetentionDays: 30,
          minimumFreeGiB: 5,
          dailyBackups: true,
          backupsToKeep: 7,
        },
      });
      await services.daemonDrain.drain(0);
    } finally {
      storage.close();
    }
  });
});
