import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemon, createRuntime, createServices } from '../src/composition.js';
import { configFromEnv } from '../src/config.js';
import { openDaemonStorage } from '../src/persisted-records.js';
import { RequestGate } from '../src/server.js';
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
        configFromEnv({
          CRAFTINGTABLE_DATA_DIR: directory,
          CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
        }),
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

  it("gives the daemon's Git the configured command timeout (R-G10 D1)", async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-composition-'));
    directories.push(directory);
    // A Git whose `rev-parse` outlasts the 10 s timeout but not the 60 s default.
    const slowGit = join(directory, 'slow-git');
    writeFileSync(
      slowGit,
      `#!${process.execPath}\nif (process.argv.includes('version')) process.stdout.write('git version 2.55.0\\n');\nelse if (process.argv.includes('rev-parse')) setTimeout(() => {}, 30_000);\nelse process.exit(1);\n`,
      { mode: 0o755 },
    );
    const storage = openDaemonStorage(join(directory, 'state.sqlite'));
    try {
      const services = await createServices(
        storage,
        configFromEnv({
          CRAFTINGTABLE_DATA_DIR: directory,
          CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
          CRAFTINGTABLE_GIT_EXECUTABLE: slowGit,
          CRAFTINGTABLE_GIT_COMMAND_TIMEOUT_MS: '10000',
        }),
        { passwordHasher: new FastTestPasswordHasher() },
      );
      const git = (services.executionService as unknown as { git: GitOperations }).git;
      const started = Date.now();
      const inspected = await git.inspectRepository(directory);
      expect(!inspected.ok && inspected.failure.kind).toBe('timed-out');
      expect(Date.now() - started).toBeLessThan(25_000);
      await services.daemonDrain.drain(0);
    } finally {
      storage.close();
    }
  });

  it('refuses to start with a Git older than 2.43.0, naming both versions (R-G10, operator decision 2026-10-07)', async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-composition-'));
    directories.push(directory);
    // A fake that reports an old version: no old Git is built or run.
    const oldGit = join(directory, 'old-git');
    writeFileSync(
      oldGit,
      `#!${process.execPath}\nif (process.argv.includes('version')) process.stdout.write('git version 2.42.0\\n');\nelse process.exit(1);\n`,
      { mode: 0o755 },
    );
    const storage = openDaemonStorage(join(directory, 'state.sqlite'));
    try {
      await expect(
        createServices(
          storage,
          configFromEnv({
            CRAFTINGTABLE_DATA_DIR: directory,
            CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
            CRAFTINGTABLE_GIT_EXECUTABLE: oldGit,
          }),
          { passwordHasher: new FastTestPasswordHasher() },
        ),
      ).rejects.toThrow(/Git 2\.42\.0; CraftingTable needs Git 2\.43\.0 or newer/);
    } finally {
      storage.close();
    }
  });

  it('refuses an old Git before opening the database, so the refused release migrates nothing (R-I7, operator decision 2026-10-12)', async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-composition-'));
    directories.push(directory);
    const oldGit = join(directory, 'old-git');
    writeFileSync(
      oldGit,
      `#!${process.execPath}\nif (process.argv.includes('version')) process.stdout.write('git version 2.42.0\\n');\nelse process.exit(1);\n`,
      { mode: 0o755 },
    );
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: directory,
      CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
      CRAFTINGTABLE_GIT_EXECUTABLE: oldGit,
      // No copy of the operator's Cargo caches into the test's data directory.
      CRAFTINGTABLE_CARGO_SEED_FROM: '',
    });
    await expect(createRuntime(config, { logger: false })).rejects.toThrow(
      /Git 2\.42\.0; CraftingTable needs Git 2\.43\.0 or newer/,
    );
    // Opening the database would have created and migrated it; the deploy's rollback could then
    // not reopen it with the previous release.
    expect(existsSync(config.databasePath)).toBe(false);
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
        configFromEnv({
          CRAFTINGTABLE_DATA_DIR: directory,
          CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
        }),
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
      configFromEnv({
        CRAFTINGTABLE_DATA_DIR: directory,
        CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
      }),
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
      configFromEnv({
        CRAFTINGTABLE_DATA_DIR: directory,
        CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
      }),
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

  it('stops its workers and drains before its server closes, and closes the rest when the drain fails (R-B9 live finding 2026-10-13)', async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-composition-'));
    directories.push(directory);
    const storage = openDaemonStorage(join(directory, 'state.sqlite'));
    const daemon = await createDaemon(
      storage,
      configFromEnv({
        CRAFTINGTABLE_DATA_DIR: directory,
        CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
      }),
      {
        overrides: { passwordHasher: new FastTestPasswordHasher(), gitOperations: null },
        server: { logger: false, startWorkers: false },
      },
    );
    const { daemonDrain, storageService, notificationService, checkRequestService } =
      daemon.services;
    const order: string[] = [];
    const record = <T extends (...args: never[]) => unknown>(name: string, run: T) =>
      ((...args: Parameters<T>) => {
        order.push(name);
        return run(...args);
      }) as T;
    daemonDrain.stopWatching = record('stop watching', daemonDrain.stopWatching.bind(daemonDrain));
    // The drain holds admissions and refuses launches at once, not after storage maintenance's
    // running operation ends (R-B9 review L-6): this shutdown waits for the drain to begin.
    let drainBegun = () => {};
    const begun = new Promise<void>((resolve) => {
      drainBegun = resolve;
    });
    const shutdown = storageService.shutdown.bind(storageService);
    storageService.shutdown = record('storage', async () => {
      await Promise.race([
        begun,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('the drain had not begun')), 2_000),
        ),
      ]);
      await shutdown();
    });
    daemonDrain.drain = record('drain', async () => {
      drainBegun();
      throw new Error('the drain failed');
    });
    // The daemon's own server carries the gate: once it has closed, before the server closes,
    // a request that changes state is refused.
    const closeGate = RequestGate.prototype.close;
    const gateClose = vi.spyOn(RequestGate.prototype, 'close');
    let refused: number | undefined;
    gateClose.mockImplementation(async function (this: RequestGate) {
      order.push('requests');
      await closeGate.call(this, 0);
      refused = (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'content-type': 'application/json' },
          payload: {},
        })
      ).statusCode;
    });
    notificationService.shutdown = record(
      'notifications',
      notificationService.shutdown.bind(notificationService),
    );
    checkRequestService.closeAll = record(
      'checks',
      checkRequestService.closeAll.bind(checkRequestService),
    );
    daemon.app.addHook('onClose', async () => {
      order.push('server');
    });

    try {
      await expect(daemon.close()).rejects.toThrow('the drain failed');
    } finally {
      gateClose.mockRestore();
    }
    // No Fastify close hook waits on the drain, and every step after the failed one ran.
    expect(order).toEqual([
      'stop watching',
      'storage',
      'drain',
      'notifications',
      'requests',
      'server',
      'checks',
    ]);
    expect(refused).toBe(503);
    expect(() => storage.users.findByNormalizedUsername('nobody')).toThrow();
  });
});
