import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';

/**
 * Where test daemons keep their data directories (TS-H8, operator decision 2026-10-02):
 * `$XDG_RUNTIME_DIR`, the user's tmpfs, when it names a directory this user can write;
 * otherwise the temporary directory. A daemon commits with `synchronous=FULL`, and with its
 * data directory on a disk TMPDIR each fsync stalled it for up to seconds under load. Only
 * daemon data directories move: TMPDIR stays on disk for everything else (fixture
 * repositories, scratch files), and the production pragmas are unchanged.
 *
 * Used by the vitest daemons (`test-support.ts` and the tests that open a daemon database
 * themselves) and by the e2e daemon (`e2e-entry.ts`). `packages/storage/src/test-support.ts`
 * keeps its own copy: the storage package exports only its built entry point, so the server
 * cannot import its test support, and test code does not belong in that entry point.
 */
export function testDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && isAbsolute(runtime))
    try {
      accessSync(runtime, constants.W_OK | constants.X_OK);
      if (statSync(runtime).isDirectory()) return runtime;
    } catch {
      /* not a directory this user can use */
    }
  return tmpdir();
}
