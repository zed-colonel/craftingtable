import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { dataDirectory } from '../../src/config.js';

/** Names the directory test daemons keep their data in (R-I2), set outside the repository. */
export const TEST_DATA_ROOT_VARIABLE = 'CRAFTINGTABLE_TEST_DATA_ROOT';

/**
 * Where test daemons (vitest and e2e) keep their data directories.
 *
 * - `CRAFTINGTABLE_TEST_DATA_ROOT` when it is set (R-I2, operator decision 2026-10-05): a
 *   dedicated directory on a disk, beside the live data directory and never inside it. A
 *   confined check sees no tmpfs (it gets a private /tmp, an empty /dev/shm and an empty
 *   read-only runtime directory), so only a disk root lets an e2e daemon's checks reach its
 *   worktrees. The operator named it, so a root that is unusable, or that overlaps a daemon's
 *   data directory (compared through links), stops the run instead of moving it elsewhere.
 * - Otherwise `$XDG_RUNTIME_DIR`, the user's tmpfs (TS-H8, operator decision 2026-10-02): a
 *   daemon commits with `synchronous=FULL`, and the encrypted btrfs TMPDIR stalled those
 *   commits. Then TMPDIR when that is unusable too. Either fallback is said, not silent.
 *
 * Only daemon data directories use it: TMPDIR stays on disk for everything else (fixture
 * repositories, scratch files), and the production pragmas are unchanged. Test daemons take a
 * small free-space reserve (`test-daemon-storage.ts`).
 *
 * Decided once per run, never per daemon: `vitest.config.ts` provides it to every test
 * (`testDataRoot()` in the test supports), and the e2e daemon decides it once at start.
 */
export function chooseTestDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): string {
  const named = env[TEST_DATA_ROOT_VARIABLE];
  if (named !== undefined && named !== '') {
    if (!usableDirectory(named))
      throw new Error(
        `${TEST_DATA_ROOT_VARIABLE} (${named}) is not an absolute directory this user can write.`,
      );
    const daemon = dataDirectory(env);
    if (overlaps(resolvedPath(named), resolvedPath(daemon)))
      throw new Error(
        `${TEST_DATA_ROOT_VARIABLE} (${named}) overlaps the daemon data directory ${daemon}: name a directory of its own beside it.`,
      );
    return named;
  }
  const runtime = env.XDG_RUNTIME_DIR;
  let root = tmpdir();
  let reason = 'XDG_RUNTIME_DIR is not set';
  if (runtime !== undefined && runtime !== '') {
    if (usableDirectory(runtime)) {
      root = runtime;
      reason = 'the runtime tmpfs, where a confined check cannot see them';
    } else reason = `XDG_RUNTIME_DIR (${runtime}) is not an absolute directory this user can write`;
  }
  warn(
    `${TEST_DATA_ROOT_VARIABLE} is not set: test daemon data directories go to ${root} (${reason}; R-I2).`,
  );
  return root;
}

function usableDirectory(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, constants.W_OK | constants.X_OK);
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `path` with the links of its deepest existing part resolved. */
function resolvedPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(resolvedPath(parent), basename(absolute));
  }
}

function overlaps(left: string, right: string): boolean {
  const within = (child: string, parent: string) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  return within(left, right) || within(right, left);
}
