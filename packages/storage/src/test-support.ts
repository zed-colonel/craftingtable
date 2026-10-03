import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inject } from 'vitest';
import { acceptAnyRecord } from './records.js';
import { openCraftingTableStorage } from './storage.js';
import { migratedTemplate } from './test-template.js';
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

/**
 * Puts a copy of this run's migrated template at `databasePath` (TS-M13, R-I2), so the open
 * that follows finds the schema current and migrates nothing. The template is built once per
 * run by `test-template-setup.ts`, and again for a changed migration set. Tests of migrating
 * itself open a database that does not exist yet instead.
 */
export function copyMigratedTemplate(databasePath: string): void {
  const directory = inject('testTemplateDirectory');
  if (typeof directory !== 'string')
    throw new Error('vitest.config.ts runs no test-template-setup for this project');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  copyFileSync(migratedTemplate(directory), databasePath, constants.COPYFILE_EXCL);
}

/**
 * A storage on a temporary database: a copy of the run's migrated template, or with `fresh`
 * a new file the open migrates from schema 0.
 */
export function temporaryStorage(options: { readonly fresh?: boolean } = {}): TemporaryStorage {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-storage-test-'));
  const databasePath = join(directory, 'state', 'craftingtable.sqlite');
  if (!options.fresh) copyMigratedTemplate(databasePath);
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
