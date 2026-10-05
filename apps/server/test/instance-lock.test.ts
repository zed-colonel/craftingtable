import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireDaemonLocks,
  AGENTS_ROOT_LOCK_FILE,
  acquireInstanceLock,
  type InstanceLock,
  InstanceLockedError,
} from '../src/instance-lock.js';
import { testDataRoot } from './test-support.js';
/**
 * Where these tests make their directories: a short base, since the socket-file lock lives in
 * them and a Unix socket's path holds 107 bytes; no daemon keeps data here (R-I2 review).
 */
const SOCKET_BASE = '/tmp';

describe('instance lock', () => {
  const held: InstanceLock[] = [];
  const directories: string[] = [];
  const dataDir = (): string => {
    const path = mkdtempSync(join(SOCKET_BASE, 'ctl-'));
    directories.push(path);
    return path;
  };

  afterEach(async () => {
    for (const lock of held.splice(0)) await lock.release();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  for (const platform of ['linux', 'darwin'] as const) {
    describe(platform === 'linux' ? 'abstract socket' : 'socket file', () => {
      it('refuses a second process on the same data directory and names the holder', async () => {
        const dir = dataDir();
        held.push(await acquireInstanceLock(dir, platform));
        const second = acquireInstanceLock(dir, platform);
        await expect(second).rejects.toBeInstanceOf(InstanceLockedError);
        await expect(second).rejects.toThrow(`pid ${process.pid}`);
      });

      it('treats the same directory reached through another path as the same lock', async () => {
        const dir = dataDir();
        held.push(await acquireInstanceLock(dir, platform));
        await expect(acquireInstanceLock(join(dir, '.'), platform)).rejects.toBeInstanceOf(
          InstanceLockedError,
        );
      });

      it('lets different data directories run side by side', async () => {
        held.push(await acquireInstanceLock(dataDir(), platform));
        held.push(await acquireInstanceLock(dataDir(), platform));
        expect(held).toHaveLength(2);
      });

      it('is free again once released', async () => {
        const dir = dataDir();
        const first = await acquireInstanceLock(dir, platform);
        await first.release();
        held.push(await acquireInstanceLock(dir, platform));
      });
    });
  }
});

describe("the agents' temporary root lock (R-G5)", () => {
  const held: InstanceLock[] = [];
  const directories: string[] = [];
  const directory = (prefix: string): string => {
    const path = mkdtempSync(join(SOCKET_BASE, prefix));
    directories.push(path);
    return path;
  };
  const daemon = (agentRoot?: string) => ({
    dataDir: directory('ctl-'),
    execution: { agentTemporaryRoot: agentRoot ?? '' },
  });
  const withDefaultRoot = () => {
    const config = daemon();
    return { ...config, execution: { agentTemporaryRoot: join(config.dataDir, 't') } };
  };

  afterEach(async () => {
    for (const lock of held.splice(0)) await lock.release();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  for (const platform of ['linux', 'darwin'] as const) {
    describe(platform === 'linux' ? 'abstract socket' : 'socket file', () => {
      it('refuses a second daemon on the same root, names the root, and frees its data directory', async () => {
        const root = directory('cta-');
        held.push(await acquireDaemonLocks(daemon(root), platform));
        const second = daemon(root);
        const refused = await acquireDaemonLocks(second, platform).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(InstanceLockedError);
        expect((refused as InstanceLockedError).resource).toBe('agents-temporary-root');
        expect((refused as InstanceLockedError).message).toContain(`pid ${process.pid}`);
        expect((refused as InstanceLockedError).message).toContain(
          `the agents' temporary root ${realpathSync(root)}`,
        );
        // The refused daemon holds nothing: its data directory is free for the next start.
        held.push(await acquireInstanceLock(second.dataDir, platform));
      });

      it('treats the same root reached through a link as the same lock', async () => {
        const root = directory('cta-');
        const link = join(directory('cta-link-'), 'root');
        symlinkSync(root, link);
        held.push(await acquireDaemonLocks(daemon(root), platform));
        await expect(acquireDaemonLocks(daemon(link), platform)).rejects.toMatchObject({
          resource: 'agents-temporary-root',
        });
      });

      it('lets daemons on different roots, and on their default roots, run side by side', async () => {
        held.push(await acquireDaemonLocks(daemon(directory('cta-')), platform));
        held.push(await acquireDaemonLocks(daemon(directory('cta-')), platform));
        held.push(await acquireDaemonLocks(withDefaultRoot(), platform));
        held.push(await acquireDaemonLocks(withDefaultRoot(), platform));
        expect(held).toHaveLength(4);
      });

      it('still refuses a second daemon on the data directory first, and releases both locks', async () => {
        const first = daemon(directory('cta-'));
        const lock = await acquireDaemonLocks(first, platform);
        await expect(
          acquireDaemonLocks(
            { ...first, execution: { agentTemporaryRoot: directory('cta-') } },
            platform,
          ),
        ).rejects.toMatchObject({ resource: 'data-directory' });
        await lock.release();
        held.push(await acquireDaemonLocks(first, platform));
      });
    });
  }
});

/**
 * The locks across network namespaces (operator decision 2026-10-05, R-G5): an abstract socket
 * is scoped to one, so on Linux each lock is also a socket file in the directory it locks,
 * which a process in any namespace that sees the directory finds.
 */
describe.skipIf(process.platform !== 'linux')('the locks across network namespaces (R-G5)', () => {
  const held: InstanceLock[] = [];
  const directories: string[] = [];
  const directory = (prefix: string, base = testDataRoot()): string => {
    const path = mkdtempSync(join(base, prefix));
    directories.push(path);
    return path;
  };
  afterEach(async () => {
    for (const lock of held.splice(0)) await lock.release();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  const unshare = spawnSync('unshare', ['-rn', 'true']).status === 0;
  const SERVER = fileURLToPath(new URL('..', import.meta.url));
  const LOCK_MODULE = fileURLToPath(new URL('../src/instance-lock.ts', import.meta.url));

  /** Tries the daemon's locks from a process in a network namespace of its own. */
  function fromAnotherNamespace(dataDir: string, agentRoot: string) {
    const script = `
      import { acquireDaemonLocks } from ${JSON.stringify(LOCK_MODULE)};
      try {
        const lock = await acquireDaemonLocks({ dataDir: ${JSON.stringify(dataDir)}, execution: { agentTemporaryRoot: ${JSON.stringify(agentRoot)} } });
        console.log('acquired'); await lock.release();
      } catch (error) { console.log('refused', error.resource ?? error.message); }
    `;
    return spawnSync(
      'unshare',
      ['-rn', process.execPath, '--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: SERVER, encoding: 'utf8' },
    );
  }

  it.skipIf(!unshare)(
    'refuses a daemon in another network namespace on the same data directory or root',
    async () => {
      const dataDir = directory('ctd-');
      const root = directory('cta-');
      held.push(await acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }));
      const sameData = fromAnotherNamespace(dataDir, directory('cta-'));
      expect(sameData.stdout.trim(), sameData.stderr).toBe('refused data-directory');
      const sameRoot = fromAnotherNamespace(directory('ctd-'), root);
      expect(sameRoot.stdout.trim(), sameRoot.stderr).toBe('refused agents-temporary-root');
      // With nothing held, the same process starts.
      await held.splice(0)[0]!.release();
      const free = fromAnotherNamespace(dataDir, root);
      expect(free.stdout.trim(), free.stderr).toBe('acquired');
    },
  );

  it('holds a socket file in each locked directory, however long its path, and removes it on release', async () => {
    // Past the 107 bytes a socket's path holds.
    const dataDir = directory(`ctd-${'x'.repeat(100)}-`);
    const root = directory(`cta-${'y'.repeat(100)}-`);
    const lock = await acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } });
    const files = [join(dataDir, 'state', 'daemon.lock'), join(root, AGENTS_ROOT_LOCK_FILE)];
    for (const file of files) expect(lstatSync(file).isSocket(), file).toBe(true);
    await lock.release();
    for (const file of files) expect(existsSync(file), file).toBe(false);
  });

  it('reclaims a socket file a killed daemon left, and still refuses a live holder', async () => {
    const dataDir = directory('ctd-');
    const root = directory('cta-');
    // A process that took the locks and was killed: its socket files stay, nobody answers.
    const killed = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { acquireDaemonLocks } from ${JSON.stringify(LOCK_MODULE)};
         await acquireDaemonLocks({ dataDir: ${JSON.stringify(dataDir)}, execution: { agentTemporaryRoot: ${JSON.stringify(root)} } });
         console.log('held'); setInterval(() => {}, 1000);`,
      ],
      { cwd: SERVER, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => killed.stdout.once('data', () => resolve()));
    await expect(
      acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }),
    ).rejects.toBeInstanceOf(InstanceLockedError);
    killed.kill('SIGKILL');
    await new Promise((resolve) => killed.once('close', resolve));
    expect(lstatSync(join(root, AGENTS_ROOT_LOCK_FILE)).isSocket()).toBe(true);
    held.push(await acquireDaemonLocks({ dataDir, execution: { agentTemporaryRoot: root } }));
  });
});
