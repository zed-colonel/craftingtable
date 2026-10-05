import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemon, createServices } from '../src/composition.js';
import { configFromEnv } from '../src/config.js';
import { openDaemonStorage } from '../src/persisted-records.js';
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

  it("never asks the workstation's agent CLIs unless the runtime names them (R-G15)", async () => {
    // A daemon reads its backends' model catalogs at start; a test daemon must not reach the
    // operator's Claude Code or Codex for that, so only `createRuntime` finds the host's.
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-composition-'));
    directories.push(directory);
    const storage = openDaemonStorage(join(directory, 'state.sqlite'));
    const daemon = await createDaemon(
      storage,
      configFromEnv({ CRAFTINGTABLE_DATA_DIR: directory }),
      {
        overrides: { passwordHasher: new FastTestPasswordHasher(), gitOperations: null },
        server: { logger: false, startWorkers: false },
      },
    );
    try {
      expect(daemon.services.executionStatus().backends.map((b) => b.available)).toEqual([
        false,
        false,
      ]);
    } finally {
      await daemon.close();
    }
  });

  it("closes a daemon's checks and storage even when its server fails to close (TS-M14)", async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-composition-'));
    directories.push(directory);
    const storage = openDaemonStorage(join(directory, 'state.sqlite'));
    let checked = false;
    const daemon = await createDaemon(
      storage,
      configFromEnv({ CRAFTINGTABLE_DATA_DIR: directory }),
      {
        overrides: { passwordHasher: new FastTestPasswordHasher(), gitOperations: null },
        server: { logger: false, startWorkers: false },
        beforeStorageCloses: () => {
          checked = true;
        },
      },
    );
    let checksClosed = false;
    const closeAll = daemon.services.checkRequestService.closeAll.bind(
      daemon.services.checkRequestService,
    );
    daemon.services.checkRequestService.closeAll = async () => {
      await closeAll();
      checksClosed = true;
    };
    daemon.app.addHook('onClose', async () => {
      throw new Error('a hook failed');
    });

    await expect(daemon.close()).rejects.toThrow('a hook failed');
    // The steps after the failed one still ran: no check outlives the daemon, and the storage
    // a test then removes is closed.
    expect(checksClosed).toBe(true);
    expect(checked).toBe(true);
    expect(() => storage.users.findByNormalizedUsername('nobody')).toThrow();
  });
});
