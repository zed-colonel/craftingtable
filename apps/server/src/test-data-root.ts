import { accessSync, constants, statfsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';

/**
 * Free space the test data root must have: a daemon refuses to launch a run with less than its
 * default 5 GiB reserve free, so the root leaves 1 GiB beyond it for the tests' own data.
 */
export const TEST_DATA_MIN_FREE_BYTES = 6 * 1024 ** 3;

/**
 * Where test daemons keep their data directories (TS-H8, operator decision 2026-10-02):
 * `$XDG_RUNTIME_DIR`, the user's tmpfs, when it names a directory this user can write with
 * `TEST_DATA_MIN_FREE_BYTES` free; otherwise the temporary directory. A daemon commits with
 * `synchronous=FULL`, and with its data directory on a disk TMPDIR each fsync stalled it for up
 * to seconds under load. Only daemon data directories move: TMPDIR stays on disk for everything
 * else (fixture repositories, scratch files), and the production pragmas are unchanged.
 *
 * Used by the vitest daemons (`test-support.ts` and the tests that open a daemon database
 * themselves) and by the e2e daemon (`e2e-entry.ts`). `vitest.config.ts` provides its value to
 * `packages/storage`, whose test support cannot import this module.
 */
export function testDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  freeBytes: (path: string) => number = (path) => {
    const fs = statfsSync(path);
    return fs.bavail * fs.bsize;
  },
): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && isAbsolute(runtime))
    try {
      accessSync(runtime, constants.W_OK | constants.X_OK);
      if (statSync(runtime).isDirectory() && freeBytes(runtime) >= TEST_DATA_MIN_FREE_BYTES)
        return runtime;
    } catch {
      /* not a directory this user can use */
    }
  return tmpdir();
}
