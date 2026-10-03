import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { copyRows, imageOf, preservationProblems } from './migration-preservation.js';
import { discoverMigrations, runMigrations } from '../src/migrations.js';
import { seedPlan, seedWorkspace } from './planning-test-support.js';
import { acceptAnyRecord } from '../src/records.js';
import { openCraftingTableStorage } from '../src/storage.js';
import { temporaryStorage, testDataRoot } from './test-support.js';

/**
 * Migration 0029 (R-B3): roadmap control rows keep only their definition revision, cycles
 * record their owning attempt, and the work-item admission trigger reads the stored revision.
 */
const OWNED = randomUUID();
const RUNNING = randomUUID();
const DRAFT = randomUUID();

function definition(roadmapId: string, revision: number, items: readonly string[]) {
  return {
    roadmapId,
    revision,
    name: `Roadmap ${revision}`,
    entries: items.map((workItemId, index) => ({ id: `entry-${index}`, workItemId })),
    createdAt: '2026-09-01T00:00:00.000Z',
    createdByUserId: 'user-a',
  };
}

function roadmapState(
  id: string,
  status: string,
  embedded: ReturnType<typeof definition>,
  attempts: readonly object[] = [],
) {
  return JSON.stringify({
    id,
    workspaceId: 'workspace-a',
    version: 3,
    status,
    attempts,
    definition: embedded,
  });
}

function schema28(path: string, drift = false): Database.Database {
  const fixture = temporaryStorage();
  const source = new Database(fixture.databasePath);
  const database = openDatabase(path);
  try {
    seedPlan(fixture.storage, seedWorkspace(fixture.storage));
    runMigrations(database, discoverMigrations().slice(0, 28));
    database.pragma('foreign_keys = OFF');
    copyRows(source, database, [
      'users',
      'workspaces',
      'projects',
      'plan_bundles',
      'plan_versions',
      'work_items',
    ]);
    database.pragma('foreign_keys = ON');
  } finally {
    source.close();
    fixture.cleanup();
  }
  const attempt = {
    id: randomUUID(),
    entryId: 'entry-0',
    definitionRevision: 2,
    worktreeId: 'wt-owned',
    cycleId: OWNED,
    status: 'active',
    createdAt: '2026-09-02T00:00:00.000Z',
  };
  const running = definition(RUNNING, 2, ['item-root-a', 'item-leaf-a']);
  const insert = database.prepare(
    'INSERT INTO roadmaps (id, workspace_id, status, version, state_json) VALUES (?, ?, ?, 3, ?)',
  );
  const addDefinition = database.prepare(
    'INSERT INTO roadmap_definitions (roadmap_id, revision, definition_json) VALUES (?, ?, ?)',
  );
  insert.run(
    RUNNING,
    'workspace-a',
    'running',
    roadmapState(RUNNING, 'running', running, [attempt]),
  );
  addDefinition.run(RUNNING, 1, JSON.stringify(definition(RUNNING, 1, ['item-root-a'])));
  addDefinition.run(
    RUNNING,
    2,
    JSON.stringify(drift ? { ...running, name: 'Stored differently' } : running),
  );
  // A draft whose current revision was never stored as a row: the migration stores it.
  insert.run(
    DRAFT,
    'workspace-a',
    'draft',
    roadmapState(DRAFT, 'draft', definition(DRAFT, 1, ['item-middle-a'])),
  );
  database.exec(`
    INSERT INTO source_repositories (id,workspace_id,display_name,root_path,default_branch,registered_head_sha,status,registered_at,registered_by_user_id)
    VALUES ('repo','workspace-a','Repo','/repo','main','1234567','active','2026-09-01','user-a');
    INSERT INTO worktrees (id,workspace_id,repository_id,project_id,work_item_id,branch_name,base_sha,base_branch,path,status,created_at,created_by_user_id)
    VALUES ('wt-owned','workspace-a','repo','project-a','item-root-a','b1','1234567','main','/wt/1','active','2026-09-02','user-a'),
           ('wt-manual','workspace-a','repo','project-a','item-middle-a','b2','1234567','main','/wt/2','active','2026-09-02','user-a');
  `);
  const cycle = database.prepare(
    'INSERT INTO work_cycles (id, workspace_id, work_item_id, worktree_id, status, version, state_json) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  for (const [id, item, tree] of [
    [OWNED, 'item-root-a', 'wt-owned'],
    ['manual-cycle', 'item-middle-a', 'wt-manual'],
  ] as const)
    cycle.run(
      id,
      'workspace-a',
      item,
      tree,
      'running',
      JSON.stringify({
        id,
        workspaceId: 'workspace-a',
        workItemId: item,
        worktreeId: tree,
        status: 'running',
        version: 1,
      }),
    );
  // The leaf item is admitted and part of the running roadmap.
  database
    .prepare(
      "UPDATE work_items SET status = 'admitted', admitted_at = '2026-09-02', admitted_by_user_id = 'user-a', version = version + 1 WHERE id = 'item-leaf-a'",
    )
    .run();
  return database;
}

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0029-'));
  return {
    path: join(directory, 'state.sqlite'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('migration 0029: roadmap definition revisions and cycle owners (R-B3)', () => {
  it('moves each embedded definition to its revision, records owners, and keeps the admission guard', () => {
    const file = temporaryPath();
    const database = schema28(file.path);
    try {
      const embedded = Object.fromEntries(
        (
          database.prepare('SELECT id, state_json FROM roadmaps').all() as {
            id: string;
            state_json: string;
          }[]
        ).map((row) => [row.id, JSON.parse(row.state_json)]),
      );
      const before = imageOf(database);
      runMigrations(database, discoverMigrations());

      // Everything outside the two rewritten tables and the new definition row is untouched.
      const after = imageOf(database);
      expect(
        preservationProblems(before, after, {
          tables: ['roadmaps', 'work_cycles', 'roadmap_definitions'],
        }),
      ).toEqual([]);
      const rows = database
        .prepare('SELECT id, length(state_json) AS bytes, state_json FROM roadmaps')
        .all() as {
        id: string;
        bytes: number;
        state_json: string;
      }[];
      for (const row of rows) {
        const state = JSON.parse(row.state_json);
        expect(state.definition).toBeUndefined();
        expect(state.definitionRevision).toBe(embedded[row.id].definition.revision);
      }
      expect(
        database
          .prepare(
            'SELECT revision FROM roadmap_definitions WHERE roadmap_id = ? ORDER BY revision',
          )
          .all(DRAFT),
      ).toEqual([{ revision: 1 }]);

      const owners = Object.fromEntries(
        (
          database
            .prepare("SELECT id, json_extract(state_json, '$.owner') AS owner FROM work_cycles")
            .all() as {
            id: string;
            owner: string | null;
          }[]
        ).map((row) => [row.id, row.owner === null ? null : JSON.parse(row.owner)]),
      );
      expect(owners).toEqual({
        [OWNED]: {
          roadmapId: RUNNING,
          attemptId: embedded[RUNNING].attempts[0].id,
          entryId: 'entry-0',
          definitionRevision: 2,
        },
        'manual-cycle': null,
      });

      // The admission trigger still sees the running roadmap's entries through the stored revision.
      const unadmit = database.prepare(
        "UPDATE work_items SET status = 'proposed', admitted_at = NULL, admitted_by_user_id = NULL, version = version + 1 WHERE id = 'item-leaf-a'",
      );
      expect(() => unadmit.run()).toThrow(/guarded return to proposed/);
      database
        .prepare(
          "UPDATE roadmaps SET status = 'completed', state_json = json_set(state_json, '$.status', 'completed') WHERE id = ?",
        )
        .run(RUNNING);
      expect(unadmit.run().changes).toBe(1);
    } finally {
      database.close();
    }

    // Storage reads each roadmap back with the definition it had embedded.
    const storage = openCraftingTableStorage(file.path, acceptAnyRecord);
    try {
      const draft = storage.roadmaps.find('workspace-a' as never, DRAFT);
      expect(draft?.definition).toEqual(definition(DRAFT, 1, ['item-middle-a']));
    } finally {
      storage.close();
      file.cleanup();
    }
  });

  it('aborts rather than drop an embedded definition that differs from its stored revision', () => {
    const file = temporaryPath();
    const database = schema28(file.path, true);
    try {
      const before = imageOf(database);
      expect(() => runMigrations(database, discoverMigrations())).toThrow(
        /CHECK constraint failed/,
      );
      expect(preservationProblems(before, imageOf(database))).toEqual([]);
      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({
        version: 28,
      });
    } finally {
      database.close();
      file.cleanup();
    }
  });
});
