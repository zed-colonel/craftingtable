import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptAnyRecord } from './records.js';
import { openCraftingTableStorage } from './storage.js';
import type { CraftingTableStorage } from './types.js';

export interface TemporaryStorage {
  readonly directory: string;
  readonly databasePath: string;
  readonly storage: CraftingTableStorage;
  cleanup(): void;
}

export function temporaryStorage(): TemporaryStorage {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-storage-test-'));
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
