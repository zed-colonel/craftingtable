import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, type InstanceLock, InstanceLockedError } from './instance-lock.js';
import { testDataRoot } from './test-data-root.js';

describe('instance lock', () => {
  const held: InstanceLock[] = [];
  const directories: string[] = [];
  const dataDir = (): string => {
    const path = mkdtempSync(join(testDataRoot(), 'craftingtable-lock-'));
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
