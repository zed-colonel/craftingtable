import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'vitest';
import { acceptAnyRecord } from './records.js';
import { openCraftingTableStorage } from './storage.js';
import type { CraftingTableStorage } from './types.js';

export interface TemporaryStorage {
  readonly directory: string;
  readonly databasePath: string;
  readonly storage: CraftingTableStorage;
  cleanup(): void;
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** Where test daemons keep their data (`apps/server/src/test-data-root.ts`, TS-H8). */
    testDataRoot: string;
  }
}

/**
 * Where test databases live (TS-H8): the root `vitest.config.ts` chose for the run, on tmpfs
 * when the user's runtime directory can hold it. Every commit fsyncs (`synchronous=FULL`,
 * unchanged), which on a disk TMPDIR stalls for up to seconds under load.
 */
export function testDataRoot(): string {
  const root = inject('testDataRoot');
  if (typeof root !== 'string') throw new Error('vitest.config.ts provides no testDataRoot');
  return root;
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
