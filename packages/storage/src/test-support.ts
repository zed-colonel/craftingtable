import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { acceptAnyRecord } from './records.js';
import { openCraftingTableStorage } from './storage.js';
import type { CraftingTableStorage } from './types.js';

export interface TemporaryStorage {
  readonly directory: string;
  readonly databasePath: string;
  readonly storage: CraftingTableStorage;
  cleanup(): void;
}

/**
 * Where test databases live (TS-H8, operator decision 2026-10-02): `$XDG_RUNTIME_DIR`, the
 * user's tmpfs, when it names a directory this user can write; otherwise the temporary
 * directory. Every commit fsyncs (`synchronous=FULL`, unchanged), which on a disk TMPDIR
 * stalls for up to seconds under load. A copy of `apps/server/src/test-data-root.ts`: this
 * package exports only its built entry point, so the two cannot share test code.
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

export function temporaryStorage(): TemporaryStorage {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-storage-test-'));
  const databasePath = join(directory, 'state', 'craftingtable.sqlite');
  const storage = openCraftingTableStorage(databasePath, acceptAnyRecord);
  return {
    directory,
    databasePath,
    storage,
    cleanup() {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
