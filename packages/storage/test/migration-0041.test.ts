import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { discoverMigrations, runMigrations } from '../src/migrations.js';
import { copyRows, imageOf, preservationProblems } from './migration-preservation.js';
import { seedPlan, seedWorkspace } from './planning-test-support.js';
import { temporaryStorage, testDataRoot } from './test-support.js';

/**
 * Migration 0041 (R-B11, ADR-073): three new tables beside the records they describe, and four
 * audit actions and two event kinds in the catalogs. Nothing that existed changes; the new rows'
 * identities and histories are kept by triggers, and a count guard rolls the migration back
 * unless the catalogs gained exactly its rows.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const WS = 'workspace-a';
const OTHER = 'workspace-b';
const ROADMAP = '00000000-0000-4000-8000-000000000001';
const WIND_DOWN = '00000000-0000-4000-8000-000000000002';
const CLEANUP = '00000000-0000-4000-8000-000000000003';
const migrations = discoverMigrations();
const toSchema40 = migrations.slice(0, 40);

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0041-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

/** A database at schema 40 holding two workspaces' plans and a stopped roadmap. */
function schema40(path: string): Database.Database {
  const fixture = temporaryStorage();
  const source = new Database(fixture.databasePath);
  const database = openDatabase(path);
  try {
    const a = seedWorkspace(fixture.storage, 'a');
    seedPlan(fixture.storage, a, { suffix: 'a' });
    const b = seedWorkspace(fixture.storage, 'b');
    seedPlan(fixture.storage, b, { suffix: 'b', digest: 'b'.repeat(64) });
    runMigrations(database, toSchema40);
    // Projects and their active versions reference each other; the copy checks keys at the end.
    database.pragma('foreign_keys = OFF');
    copyRows(source, database, [
      'users',
      'workspaces',
      'workspace_memberships',
      'plan_bundles',
      'projects',
      'plan_versions',
      'work_items',
      'work_item_dependencies',
    ]);
    database.pragma('foreign_keys = ON');
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    source.close();
    fixture.cleanup();
  }
  const state = { id: ROADMAP, workspaceId: WS, version: 3, status: 'stopped' };
  database
    .prepare('INSERT INTO roadmaps VALUES (?,?,?,?,?)')
    .run(ROADMAP, WS, 'stopped', 3, JSON.stringify(state));
  return database;
}

function windDown(fields: Record<string, unknown> = {}) {
  const record = {
    id: WIND_DOWN,
    workspaceId: WS,
    roadmapId: ROADMAP,
    version: 1,
    status: 'settling',
    ...fields,
  };
  return [
    record.id,
    record.workspaceId,
    record.roadmapId,
    record.status,
    record.version,
    JSON.stringify(record),
  ] as const;
}

function cleanup(fields: Record<string, unknown> = {}) {
  const record = {
    id: CLEANUP,
    workspaceId: WS,
    roadmapId: ROADMAP,
    version: 1,
    status: 'running',
    ...fields,
  };
  return [
    record.id,
    record.workspaceId,
    record.roadmapId,
    record.status,
    record.version,
    JSON.stringify(record),
  ] as const;
}

describe('migration 0041: roadmap wind-downs, retired plan versions, repository cleanups', () => {
  it('keeps every existing row, index and trigger, and adds the tables and catalog rows', () => {
    const database = schema40(temporaryPath());
    try {
      const before = imageOf(database);
      runMigrations(database, migrations.slice(0, 41));
      const after = imageOf(database);
      expect(preservationProblems(before, after)).toEqual([]);
      for (const table of ['roadmap_wind_downs', 'retired_plan_versions', 'repository_cleanups'])
        expect(after.tables[table], table).toEqual([]);
      expect(
        database
          .prepare(
            'SELECT action FROM audit_action_kinds WHERE introduced_in_schema = 41 ORDER BY action',
          )
          .all(),
      ).toEqual([
        { action: 'plan.version-retired' },
        { action: 'repository-cleanup.action' },
        { action: 'repository-cleanup.updated' },
        { action: 'roadmap.wind-down' },
      ]);
      expect(
        database
          .prepare(
            'SELECT kind FROM workspace_event_kinds WHERE introduced_in_schema = 41 ORDER BY kind',
          )
          .all(),
      ).toEqual([{ kind: 'plan-version-retired' }, { kind: 'repository-cleanup-changed' }]);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'migration_%'").all(),
      ).toEqual([]);
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rolls the whole migration back when the catalogs already hold a schema-41 row', () => {
    const database = schema40(temporaryPath());
    try {
      // Another migration claiming schema 41 in a catalog: the count guard refuses.
      database
        .prepare('INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES (?, 41)')
        .run('stray-kind');
      expect(() => runMigrations(database, migrations.slice(0, 41))).toThrow(
        /CHECK constraint failed: ok = 1/,
      );
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name = 'roadmap_wind_downs'").all(),
      ).toEqual([]);
      expect(database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({
        v: 40,
      });
    } finally {
      database.close();
    }
  });

  it('keeps a wind-down per roadmap, moving forward, and never deletes it', () => {
    const database = schema40(temporaryPath());
    try {
      runMigrations(database, migrations.slice(0, 41));
      const insert = database.prepare('INSERT INTO roadmap_wind_downs VALUES (?,?,?,?,?,?)');
      // The record names its own row.
      const named = windDown();
      expect(() =>
        insert.run(
          named[0],
          named[1],
          named[2],
          named[3],
          named[4],
          named[5].replace(ROADMAP, 'x'),
        ),
      ).toThrow(/CHECK constraint/);
      expect(() => insert.run(...windDown({ status: 'stopped' }))).toThrow(/CHECK constraint/);
      expect(() =>
        insert.run(...windDown({ roadmapId: '00000000-0000-4000-8000-0000000000ff' })),
      ).toThrow(/CHECK constraint|FOREIGN KEY/);
      insert.run(...windDown());
      // One per roadmap.
      expect(() => insert.run(...windDown({ id: '00000000-0000-4000-8000-000000000009' }))).toThrow(
        /UNIQUE/,
      );
      const update = database.prepare(
        'UPDATE roadmap_wind_downs SET status=?, version=?, record_json=? WHERE id=?',
      );
      const [, , , , , settled] = windDown({ status: 'settled', version: 2 });
      update.run('settled', 2, settled, WIND_DOWN);
      // A version that does not move forward, or a changed identity, is refused.
      const [, , , , , stale] = windDown({ status: 'settling', version: 2 });
      expect(() => update.run('settling', 2, stale, WIND_DOWN)).toThrow(/only moves forward/);
      expect(() =>
        database
          .prepare("UPDATE roadmap_wind_downs SET roadmap_id='other' WHERE id=?")
          .run(WIND_DOWN),
      ).toThrow(/identity/);
      expect(() => database.prepare('DELETE FROM roadmap_wind_downs').run()).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });

  it('keeps retirements immutable and within their workspace', () => {
    const database = schema40(temporaryPath());
    try {
      runMigrations(database, migrations.slice(0, 41));
      database.prepare('INSERT INTO roadmap_wind_downs VALUES (?,?,?,?,?,?)').run(...windDown());
      const retire = database.prepare('INSERT INTO retired_plan_versions VALUES (?,?,?,?,?,?)');
      expect(() =>
        retire.run('version-a', WS, 'abandoned', WIND_DOWN, 'user-a', '2026-10-13T00:00:00Z'),
      ).toThrow(/CHECK constraint/);
      // Another workspace's version is not this workspace's to retire.
      expect(() =>
        retire.run('version-b', WS, 'parked', WIND_DOWN, 'user-a', '2026-10-13T00:00:00Z'),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        retire.run('version-a', OTHER, 'parked', WIND_DOWN, 'user-a', '2026-10-13T00:00:00Z'),
      ).toThrow(/FOREIGN KEY/);
      retire.run('version-a', WS, 'superseded', WIND_DOWN, 'user-a', '2026-10-13T00:00:00Z');
      expect(() =>
        retire.run('version-a', WS, 'parked', WIND_DOWN, 'user-a', '2026-10-13T00:00:00Z'),
      ).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(() =>
        database.prepare("UPDATE retired_plan_versions SET disposition='parked'").run(),
      ).toThrow(/immutable/);
      expect(() => database.prepare('DELETE FROM retired_plan_versions').run()).toThrow(
        /immutable/,
      );
    } finally {
      database.close();
    }
  });

  it('allows one running cleanup per roadmap and freezes a finished one', () => {
    const database = schema40(temporaryPath());
    try {
      runMigrations(database, migrations.slice(0, 41));
      const insert = database.prepare('INSERT INTO repository_cleanups VALUES (?,?,?,?,?,?)');
      insert.run(...cleanup());
      expect(() => insert.run(...cleanup({ id: '00000000-0000-4000-8000-00000000000a' }))).toThrow(
        /UNIQUE/,
      );
      const update = database.prepare(
        'UPDATE repository_cleanups SET status=?, version=?, record_json=? WHERE id=?',
      );
      const [, , , , , done] = cleanup({ status: 'done', version: 2 });
      update.run('done', 2, done, CLEANUP);
      // A finished cleanup never changes; another may then run.
      const [, , , , , again] = cleanup({ status: 'running', version: 3 });
      expect(() => update.run('running', 3, again, CLEANUP)).toThrow(/final once done/);
      insert.run(...cleanup({ id: '00000000-0000-4000-8000-00000000000a' }));
      expect(() => database.prepare('DELETE FROM repository_cleanups').run()).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });
});
