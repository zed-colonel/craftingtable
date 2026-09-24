import { randomUUID } from 'node:crypto';
import type { Roadmap } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { SEED_NOW, seedPlan, seedWorkspace } from './planning-test-support.js';
import {
  RECORD_TABLES,
  RELATIONAL_TABLES,
  RETIRED_TABLES,
  type ScannedRecord,
} from './record-scan.js';
import {
  acceptAnyRecord,
  observeUpcasts,
  type PersistedRecordKind,
  RECORD_UPCASTERS,
  type RecordGuard,
  readRecord,
} from './records.js';
import { openCraftingTableStorage } from './storage.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function fixture() {
  const f = temporaryStorage();
  fixtures.push(f);
  return f;
}

function tables(path: string): string[] {
  const database = openDatabase(path);
  try {
    return (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
  } finally {
    database.close();
  }
}

function roadmap(workspaceId: Roadmap['workspaceId'], userId: Roadmap['createdByUserId']) {
  const id = randomUUID();
  return {
    id,
    workspaceId,
    version: 1,
    status: 'draft',
    reason: 'Saved',
    createdAt: SEED_NOW,
    updatedAt: SEED_NOW,
    createdByUserId: userId,
    attempts: [],
    definition: {
      roadmapId: id,
      revision: 1,
      name: 'Queue',
      scheduling: {
        mode: 'sequential',
        maxInFlight: 1,
        maxPerRepository: 1,
        maxIntegrationRefreshes: 3,
      },
      entries: [],
      createdAt: SEED_NOW,
      createdByUserId: userId,
    },
  } satisfies Roadmap;
}

describe('persisted record registry (R-H3)', () => {
  it('classifies every table as a record source or a relational table, never both', () => {
    const f = fixture();
    const recordTables = new Set(Object.values(RECORD_TABLES));
    const present = tables(f.databasePath);
    const unclassified = present.filter(
      (table) => !recordTables.has(table) && !(table in RELATIONAL_TABLES),
    );
    expect(unclassified).toEqual([]);
    expect(
      present.filter((table) => recordTables.has(table) && table in RELATIONAL_TABLES),
    ).toEqual([]);
    // No stale entries: every classified table still exists.
    expect(
      [...recordTables, ...Object.keys(RELATIONAL_TABLES)].filter((t) => !present.includes(t)),
    ).toEqual([]);
    // Every record kind has a source, so db:verify reads all of them.
    expect(Object.keys(RECORD_TABLES).sort()).toEqual(Object.keys(RECORD_UPCASTERS).sort());
  });

  it('keeps JSON columns out of the relational tables', () => {
    const f = fixture();
    const database = openDatabase(f.databasePath);
    try {
      // The retired inspector tables keep their JSON columns until R-H6; they must stay empty.
      const live = Object.keys(RELATIONAL_TABLES).filter(
        (table) => !(RETIRED_TABLES as readonly string[]).includes(table),
      );
      const hiding = live.flatMap((table) =>
        (database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
          .filter((column) => column.name.endsWith('_json'))
          .map((column) => `${table}.${column.name}`),
      );
      expect(hiding).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('upcasts historical shapes on every read path and reports each upcast', () => {
    const f = fixture();
    const seed = seedPlan(f.storage, seedWorkspace(f.storage));
    const database = openDatabase(f.databasePath);
    try {
      // Schema-2 admission event naming the retired work-contract draft.
      database
        .prepare(
          `INSERT INTO workspace_events (id, schema_version, occurred_at, workspace_id, actor_user_id,
             project_id, work_item_id, kind, payload_json)
           VALUES (?, 1, ?, ?, ?, ?, ?, 'work-item-admitted', ?)`,
        )
        .run(
          'legacy-admission',
          SEED_NOW,
          seed.workspaceId,
          seed.userId,
          seed.projectId,
          seed.rootWorkItemId,
          JSON.stringify({
            projectId: seed.projectId,
            planVersionId: seed.planVersionId,
            workItemId: seed.rootWorkItemId,
            sourceWorkItemId: 'WI-1',
            workContractDraftId: 'draft-1',
          }),
        );
    } catch (error) {
      database.close();
      throw error;
    }
    database.close();
    const events = f.storage.workspaceEvents.listAfter({
      workspaceId: seed.workspaceId,
      after: 0,
      limit: 100,
    });
    const admission = events.find((event) => event.id === 'legacy-admission');
    expect(admission?.payload).toEqual({
      projectId: seed.projectId,
      planVersionId: seed.planVersionId,
      workItemId: seed.rootWorkItemId,
      sourceWorkItemId: 'WI-1',
    });

    const scanned: ScannedRecord[] = [];
    const upcasts: string[] = [];
    f.storage.scanRecords(
      (record) => scanned.push(record),
      (record) => {
        throw new Error(`unreadable ${record.kind} ${record.key}: ${record.error}`);
      },
      (kind, upcaster) => upcasts.push(`${kind}: ${upcaster.name}`),
    );
    expect(upcasts).toEqual([
      'workspace-event: work-item-admitted with the retired workContractDraftId',
    ]);
    expect(
      scanned.find(
        (record) => record.kind === 'workspace-event' && record.key === String(admission?.sequence),
      )?.record,
    ).toEqual(admission);
  });

  it('bounds a run summary stored in characters to the byte bound (73a606f5)', () => {
    // A 2026-09-05 review run stored 4,000 characters that are 4,014 UTF-8 bytes.
    const stored = `${'a'.repeat(3986)}${'→'.repeat(7)}`;
    expect(stored.length).toBeLessThanOrEqual(4000);
    const upcasts: string[] = [];
    const run = observeUpcasts(
      (kind, upcaster) => upcasts.push(`${kind}: ${upcaster.name}`),
      () => readRecord('agent-run', { id: 'run', outcomeSummary: stored } as never),
    );
    expect(new TextEncoder().encode(run.outcomeSummary).byteLength).toBeLessThanOrEqual(4000);
    expect(run.outcomeSummary?.endsWith('…')).toBe(true);
    expect(upcasts).toEqual([
      'agent-run: outcomeSummary bounded in characters (before 2026-09-05)',
    ]);
    // A summary within the bound is the same object, untouched.
    const current = { id: 'run', outcomeSummary: '→ done' };
    expect(readRecord('agent-run', current as never)).toBe(current);
  });

  it('refuses a write the guard rejects and leaves nothing behind', () => {
    const f = fixture();
    const seed = seedWorkspace(f.storage);
    f.storage.close();
    const refused: PersistedRecordKind[] = [];
    const guard: RecordGuard = (kind, record) => {
      refused.push(kind);
      if (kind === 'roadmap' && (record as Roadmap).status === 'paused')
        throw new Error('roadmap out of bounds');
    };
    const storage = openCraftingTableStorage(f.databasePath, guard);
    try {
      const value = roadmap(seed.workspaceId, seed.userId);
      expect(() =>
        storage.transaction((tx) => {
          tx.roadmaps.save({ ...value, status: 'paused' }, 0);
          tx.roadmaps.addDefinition(value.definition);
        }),
      ).toThrow('roadmap out of bounds');
      expect(refused).toEqual(['roadmap']);
      expect(storage.roadmaps.find(seed.workspaceId, value.id)).toBeUndefined();
      expect(storage.roadmaps.history(seed.workspaceId, value.id)).toEqual([]);
      // The same guard lets an in-bounds write through.
      storage.transaction((tx) => {
        tx.roadmaps.save(value, 0);
        tx.roadmaps.addDefinition(value.definition);
      });
      expect(refused).toEqual(['roadmap', 'roadmap', 'roadmap-definition']);
      expect(storage.roadmaps.find(seed.workspaceId, value.id)).toEqual(value);
    } finally {
      storage.close();
    }
    // Reopen for the fixture's cleanup.
    fixtures.splice(0, 1, {
      ...f,
      storage: openCraftingTableStorage(f.databasePath, acceptAnyRecord),
    });
  });

  it('reports a record its mapper refuses instead of stopping the scan', () => {
    const f = fixture();
    const seed = seedPlan(f.storage, seedWorkspace(f.storage));
    const database = openDatabase(f.databasePath);
    try {
      // A worktree event whose payload disagrees with its structural work item.
      database
        .prepare(
          `INSERT INTO workspace_events (id, schema_version, occurred_at, workspace_id, actor_user_id,
             project_id, work_item_id, kind, payload_json)
           VALUES ('contradiction', 1, ?, ?, ?, ?, ?, 'worktree-created', '{}')`,
        )
        .run(SEED_NOW, seed.workspaceId, seed.userId, seed.projectId, seed.rootWorkItemId);
    } finally {
      database.close();
    }
    const unreadable: string[] = [];
    let scanned = 0;
    f.storage.scanRecords(
      () => scanned++,
      (record) => unreadable.push(`${record.kind}`),
    );
    expect(unreadable).toEqual(['workspace-event']);
    expect(scanned).toBeGreaterThan(0);
    expect(f.storage.integrityProblems()).toEqual([]);
  });
});
