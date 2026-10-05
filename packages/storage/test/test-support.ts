import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inject } from 'vitest';
import { discoverMigrations, type MigrationDefinition } from '../src/migrations.js';
import { acceptAnyRecord } from '../src/records.js';
import { openCraftingTableStorage } from '../src/storage.js';
import { migratedTemplate } from './template-test-support.js';
import type { CraftingTableStorage } from '../src/types.js';

export interface TemporaryStorage {
  readonly directory: string;
  readonly databasePath: string;
  readonly storage: CraftingTableStorage;
  cleanup(): void;
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** Where test daemons keep their data (`apps/server/test/e2e/test-data-root.ts`, TS-H8). */
    testDataRoot: string;
  }
}

/**
 * Where test databases live (TS-H8, R-I2): the root `vitest.config.ts` chose for the run,
 * `CRAFTINGTABLE_TEST_DATA_ROOT` or else the user's runtime tmpfs. Every commit fsyncs
 * (`synchronous=FULL`, unchanged), which on the encrypted btrfs TMPDIR stalled for up to seconds
 * under load.
 */
export function testDataRoot(): string {
  const root = inject('testDataRoot');
  if (typeof root !== 'string') throw new Error('vitest.config.ts provides no testDataRoot');
  return root;
}

// The migration files, read once per test file: test modules are imported afresh for each
// file, so a migration changed during a watch-mode run is still seen by the next file.
let migrations: readonly MigrationDefinition[] | undefined;

/**
 * Puts a copy of this run's migrated template at `databasePath` (TS-M13, R-I2), so the open
 * that follows finds the schema current and migrates nothing. The template is built once per
 * run by `template-test-support-setup.ts`, and again for a changed migration set. Tests of
 * migrating itself open a database that does not exist yet instead.
 */
export function copyMigratedTemplate(databasePath: string): void {
  const directory = inject('testTemplateDirectory');
  if (typeof directory !== 'string')
    throw new Error('vitest.config.ts runs no template-test-support-setup for this project');
  migrations ??= discoverMigrations();
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  copyFileSync(migratedTemplate(directory, migrations), databasePath, constants.COPYFILE_EXCL);
}

/**
 * A storage on a temporary database: a copy of the run's migrated template, or with `fresh`
 * a new file the open migrates from schema 0.
 */
export function temporaryStorage(options: { readonly fresh?: boolean } = {}): TemporaryStorage {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-storage-test-'));
  const databasePath = join(directory, 'state', 'craftingtable.sqlite');
  let storage: CraftingTableStorage;
  try {
    if (!options.fresh) copyMigratedTemplate(databasePath);
    storage = openCraftingTableStorage(databasePath, acceptAnyRecord);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
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
