import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Roadmap } from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_NOW, seedWorkspace } from '../../../packages/storage/src/planning-test-support.js';
import { copyMigratedTemplate } from '../../../packages/storage/src/test-support.js';
import { InvalidRecordError, openDaemonStorage } from './persisted-records.js';
import { testDataRoot } from './test-support.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** The daemon's storage on a copy of the run's migrated template, with one workspace. */
function daemonStorage() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-persisted-records-'));
  directories.push(directory);
  const databasePath = join(directory, 'state', 'craftingtable.sqlite');
  copyMigratedTemplate(databasePath);
  const storage = openDaemonStorage(databasePath);
  try {
    return { databasePath, storage, seed: seedWorkspace(storage) };
  } catch (error) {
    storage.close();
    throw error;
  }
}

function count(databasePath: string, table: 'audit_events' | 'roadmaps' | 'roadmap_definitions') {
  const database = openDatabase(databasePath);
  try {
    return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    database.close();
  }
}

describe("the daemon's record guard (R-H3, TS-M5)", () => {
  it('refuses an out-of-contract record and rolls back the whole transaction', () => {
    const { databasePath, storage, seed } = daemonStorage();
    try {
      const id = randomUUID();
      const draft: Roadmap = {
        id,
        workspaceId: seed.workspaceId,
        version: 1,
        status: 'draft',
        reason: 'Saved',
        createdAt: SEED_NOW,
        updatedAt: SEED_NOW,
        createdByUserId: seed.userId,
        attempts: [],
        definition: {
          roadmapId: id,
          revision: 1,
          name: 'Queue',
          entries: [],
          createdAt: SEED_NOW,
          createdByUserId: seed.userId,
        },
      };
      // A grant the contract bounds at 20 rounds and SQLite stores as JSON without a check:
      // only the guard stands between a daemon defect and a stored record that every later
      // strict read and `db:verify` refuses.
      const granted = (maxRoundsPerParent: number): Roadmap => ({
        ...draft,
        version: 2,
        reason: 'Scope recovery granted',
        scopeRecovery: {
          enabled: true,
          maxRoundsPerParent,
          grantedByUserId: seed.userId,
          grantedAt: SEED_NOW,
        },
      });
      // One transaction: a valid roadmap, a valid audit record (its own savepoint), then the
      // roadmap's update.
      const write = (update: Roadmap) =>
        storage.transaction((tx) => {
          expect(tx.roadmaps.save(draft, 0)).toBe(true);
          tx.audit.append({
            id: randomUUID(),
            occurredAt: SEED_NOW,
            actorKind: 'user',
            actorUserId: seed.userId,
            workspaceId: seed.workspaceId,
            action: 'roadmap.updated',
            targetType: 'roadmap',
            targetId: id,
            outcome: 'succeeded',
            metadata: {},
          });
          expect(tx.roadmaps.save(update, 1)).toBe(true);
        });
      const before = {
        audit: count(databasePath, 'audit_events'),
        roadmaps: count(databasePath, 'roadmaps'),
        definitions: count(databasePath, 'roadmap_definitions'),
      };

      let refused: unknown;
      try {
        write(granted(21));
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(InvalidRecordError);
      expect(refused).toMatchObject({ kind: 'roadmap' });
      expect((refused as Error).message).toMatch(
        /^Refused to store a roadmap that breaks its contract: .*scopeRecovery\.maxRoundsPerParent/,
      );
      // Nothing from the transaction persists: not the earlier roadmap, its definition or the
      // audit record.
      expect(storage.roadmaps.find(seed.workspaceId, id)).toBeUndefined();
      expect(storage.roadmaps.history(seed.workspaceId, id)).toEqual([]);
      expect({
        audit: count(databasePath, 'audit_events'),
        roadmaps: count(databasePath, 'roadmaps'),
        definitions: count(databasePath, 'roadmap_definitions'),
      }).toEqual(before);

      // The same transaction within the bound commits, so the refusal above is the guard's.
      write(granted(20));
      expect(storage.roadmaps.find(seed.workspaceId, id)).toEqual(granted(20));
      expect(count(databasePath, 'audit_events')).toBe(before.audit + 1);
    } finally {
      storage.close();
    }
  });
});
