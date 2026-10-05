import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireDaemonLocks,
  acquireInstanceLock,
  type InstanceLock,
  InstanceLockedError,
} from '../src/instance-lock.js';
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
