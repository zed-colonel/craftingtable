import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Roadmap, RoadmapWindDown } from '@craftingtable/domain';
import { asRoadmapId, asRoadmapWindDownId } from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_NOW, seedWorkspace } from '../../../packages/storage/test/planning-test-support.js';
import { copyMigratedTemplate } from '../../../packages/storage/test/test-support.js';
import { InvalidRecordError, openDaemonStorage } from '../src/persisted-records.js';
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

/** Row counts of the tables the test writes, read on a connection of their own. */
function counts(databasePath: string) {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM audit_events) AS audit,
                (SELECT COUNT(*) FROM roadmaps) AS roadmaps,
                (SELECT COUNT(*) FROM roadmap_definitions) AS definitions`,
      )
      .get() as { audit: number; roadmaps: number; definitions: number };
  } finally {
    database.close();
  }
}

describe("the daemon's record guard (R-H3, TS-M5)", () => {
  it('refuses an out-of-contract record and rolls back the whole transaction', () => {
    const { databasePath, storage, seed } = daemonStorage();
    try {
      const id = asRoadmapId(randomUUID());
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
      const before = counts(databasePath);

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
      expect(counts(databasePath)).toEqual(before);

      // The same transaction within the bound commits, so the refusal above is the guard's.
      write(granted(20));
      expect(storage.roadmaps.find(seed.workspaceId, id)).toEqual(granted(20));
      expect(counts(databasePath)).toEqual({
        audit: before.audit + 1,
        roadmaps: before.roadmaps + 1,
        definitions: before.definitions + 1,
      });
    } finally {
      storage.close();
    }
  });

  it('refuses a roadmap or an entry hold that needs attention without its code (R-B4b)', () => {
    // Readers take the stored code and never the reason (increment 3; its review's MEDIUM-1).
    const { storage, seed } = daemonStorage();
    try {
      const id = asRoadmapId(randomUUID());
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
      expect(storage.roadmaps.save(draft, 0)).toBe(true);
      const attention = { code: 'legacy-attention', owner: 'operator' } as const;
      const entry = randomUUID();
      const refused = (update: Partial<Roadmap>) =>
        expect(() => storage.roadmaps.save({ ...draft, version: 2, ...update }, 1)).toThrow(
          InvalidRecordError,
        );
      refused({ status: 'needs-attention', reason: 'Stopped.' });
      refused({
        status: 'running',
        entryHolds: { [entry]: { status: 'needs-attention', reason: 'Held.' } },
      });
      expect(storage.roadmaps.find(seed.workspaceId, id)).toEqual(draft);
      // With their codes they are stored; a paused hold needs none.
      const coded: Roadmap = {
        ...draft,
        version: 2,
        status: 'needs-attention',
        reason: 'Stopped.',
        attention,
        entryHolds: {
          [entry]: { status: 'needs-attention', reason: 'Held.', attention },
          [randomUUID()]: { status: 'paused', reason: 'Item paused by operator.' },
        },
      };
      expect(storage.roadmaps.save(coded, 1)).toBe(true);
      expect(storage.roadmaps.find(seed.workspaceId, id)).toEqual(coded);
    } finally {
      storage.close();
    }
  });

  it('refuses a wind-down whose status and settled time disagree (R-B11)', () => {
    const { storage, seed } = daemonStorage();
    try {
      const id = asRoadmapId(randomUUID());
      storage.transaction((tx) =>
        tx.roadmaps.save(
          {
            id,
            workspaceId: seed.workspaceId,
            version: 1,
            status: 'stopped',
            reason: 'Stopped',
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
          },
          0,
        ),
      );
      const record: RoadmapWindDown = {
        id: asRoadmapWindDownId(randomUUID()),
        workspaceId: seed.workspaceId,
        roadmapId: id,
        version: 1,
        status: 'settled',
        retire: [],
        abandonResolutions: [],
        previewDigest: 'c'.repeat(64),
        requestedAt: SEED_NOW,
        requestedByUserId: seed.userId,
        startedAt: SEED_NOW,
      };
      expect(() => storage.transaction((tx) => tx.windDowns.insert(record))).toThrow(
        InvalidRecordError,
      );
      expect(storage.windDowns.find(seed.workspaceId, id)).toBeUndefined();
      storage.transaction((tx) => tx.windDowns.insert({ ...record, settledAt: SEED_NOW }));
      expect(storage.windDowns.find(seed.workspaceId, id)?.status).toBe('settled');
    } finally {
      storage.close();
    }
  });
});
