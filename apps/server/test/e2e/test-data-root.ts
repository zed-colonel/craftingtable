import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';

/**
 * Where test daemons keep their data directories (TS-H8, operator decision 2026-10-02):
 * `$XDG_RUNTIME_DIR`, the user's tmpfs, when it names a directory this user can write. A
 * daemon commits with `synchronous=FULL`, and with its data directory on a disk TMPDIR each
 * fsync stalled it for up to seconds under load. Only daemon data directories move: TMPDIR
 * stays on disk for everything else (fixture repositories, scratch files), and the production
 * pragmas are unchanged. The tmpfs is small, so test daemons take a small free-space reserve
 * (`test-daemon-storage.ts`).
 *
 * Decided once per run, never per daemon: `vitest.config.ts` provides it to every test
 * (`testDataRoot()` in the test supports), and the e2e daemon decides it once at start. A
 * fallback to TMPDIR is said, not silent.
 */
export function chooseTestDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): string {
  const runtime = env.XDG_RUNTIME_DIR;
  let problem = 'is not set';
  if (runtime !== undefined && runtime !== '') {
    problem = `(${runtime}) is not an absolute directory this user can write`;
    if (isAbsolute(runtime))
      try {
        accessSync(runtime, constants.W_OK | constants.X_OK);
        if (statSync(runtime).isDirectory()) return runtime;
      } catch {
        /* not a directory this user can use */
      }
  }
  const fallback = tmpdir();
  warn(
    `Test daemon data directories go to ${fallback}, not tmpfs: XDG_RUNTIME_DIR ${problem} (TS-H8).`,
  );
  return fallback;
}
