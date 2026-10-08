import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  asAgentRunId,
  asEventId,
  asPlanVersionId,
  asProjectId,
  asUserId,
  asWorkItemId,
  asWorkspaceId,
  asWorktreeId,
} from '@craftingtable/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { copyDatabase, openDatabase } from '../src/database.js';
import {
  checksumSql,
  discoverMigrations,
  type MigrationDefinition,
  migrationStatus,
  runMigrations,
} from '../src/migrations.js';
import { acceptAnyRecord } from '../src/records.js';
import { SqliteWorkspaceEventRepository } from '../src/repositories/workspace-events.js';
import { copyRows, imageOf, preservationProblems } from './migration-preservation.js';
import { seedPlan, seedWorkspace } from './planning-test-support.js';
import { temporaryStorage, testDataRoot } from './test-support.js';

/**
 * Migration 0040 (R-H6, operator decisions H6-1 and H6-3, 2026-10-06): the workspace journal is
 * rebuilt without the retired registry's three correlation columns, their per-kind CHECK and
 * their foreign keys, and the three empty registry tables are dropped. `sequence` is the event
 * stream's resume cursor (`Last-Event-ID`), so every row keeps it and the next event follows the
 * old high-water mark: a client resuming from before the migration sees no gap and no repeat.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const REGISTRY_TABLES = [
  'registered_repositories',
  'repository_inspections',
  'project_repository_bindings',
] as const;
const CORRELATIONS = ['repository_id', 'repository_inspection_id', 'repository_binding_id'];
const RETIRED_KINDS = [
  'repository-registered',
  'repository-status-changed',
  'repository-evidence-changed',
  'project-repository-bound',
  'project-repository-binding-retired',
];
const RETIRED_ACTIONS = [
  'repository.register',
  'repository.inspect',
  'repository.reaffirm',
  'repository.retire',
  'repository.bind-project',
  'repository.unbind-project',
];
/** The triggers 0040 adds: each journal refuses its retired vocabulary. */
const REFUSALS = ['workspace_events_retired_kinds', 'audit_events_retired_actions'];
const NOW = '2026-10-08T00:00:00.000Z';

function insertAudit(database: Database.Database, id: string, action: string) {
  database
    .prepare(
      `INSERT INTO audit_events (id, occurred_at, actor_kind, workspace_id, action, outcome)
       VALUES (?, ?, 'system', 'workspace-a', ?, 'succeeded')`,
    )
    .run(id, NOW, action);
}

function temporaryPath(name = 'state.sqlite'): string {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0040-'));
  directories.push(directory);
  return join(directory, name);
}

const migrations = discoverMigrations();
const toSchema39 = migrations.filter((migration) => migration.version <= 39);

/**
 * A database at schema 39 holding two workspaces' plans and an interleaved journal: events
 * with and without project, work-item and run correlations, so each workspace's sequences
 * have gaps a resuming client skips.
 */
function schema39(path: string): Database.Database {
  const fixture = temporaryStorage();
  const source = new Database(fixture.databasePath);
  const database = openDatabase(path);
  try {
    seedPlan(fixture.storage, seedWorkspace(fixture.storage, 'a'));
    seedPlan(fixture.storage, seedWorkspace(fixture.storage, 'b'), { suffix: 'b' });
    runMigrations(database, toSchema39);
    database.pragma('foreign_keys = OFF');
    copyRows(source, database, [
      'users',
      'workspaces',
      'workspace_memberships',
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
  const events = new SqliteWorkspaceEventRepository(database, acceptAnyRecord);
  let next = 0;
  const id = () => asEventId(`event-${++next}`);
  for (const suffix of ['a', 'b'])
    events.appendWorkspaceCreated({
      id: id(),
      occurredAt: NOW,
      workspaceId: asWorkspaceId(`workspace-${suffix}`),
      actorUserId: asUserId(`user-${suffix}`),
      name: `Workspace ${suffix}`,
      slug: `workspace-${suffix}`,
    });
  const a = { workspaceId: asWorkspaceId('workspace-a'), occurredAt: NOW };
  const b = { workspaceId: asWorkspaceId('workspace-b'), occurredAt: NOW };
  events.appendEvent({
    ...a,
    id: id(),
    projectId: asProjectId('project-a'),
    kind: 'project-created',
    payload: { projectId: asProjectId('project-a'), name: 'Project a' },
  });
  events.appendEvent({
    ...a,
    id: id(),
    projectId: asProjectId('project-a'),
    workItemId: asWorkItemId('item-root-a'),
    kind: 'work-item-admitted',
    payload: {
      projectId: asProjectId('project-a'),
      planVersionId: asPlanVersionId('version-a'),
      workItemId: asWorkItemId('item-root-a'),
      sourceWorkItemId: 'ROOT-A',
    },
  });
  events.appendEvent({
    ...b,
    id: id(),
    projectId: asProjectId('project-b'),
    workItemId: asWorkItemId('item-root-b'),
    runId: asAgentRunId('run-b'),
    kind: 'agent-run-started',
    payload: {
      runId: asAgentRunId('run-b'),
      worktreeId: asWorktreeId('worktree-b'),
      workItemId: asWorkItemId('item-root-b'),
      backend: 'claude-code',
      role: 'implement',
    },
  });
  events.appendEvent({
    ...a,
    id: id(),
    kind: 'notifications-changed',
    payload: { action: 'test' },
  });
  events.appendEvent({
    ...b,
    id: id(),
    kind: 'roadmap-changed',
    payload: { roadmapId: '00000000-0000-4000-8000-000000000001', status: 'running', reason: '' },
  });
  events.appendEvent({
    ...a,
    id: id(),
    projectId: asProjectId('project-a'),
    kind: 'branches-changed',
    payload: { planVersionId: asPlanVersionId('version-a'), action: 'configured' },
  });
  return database;
}

function sequenceRow(database: Database.Database) {
  return database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'").get();
}

function columnsOf(database: Database.Database, table: string): string[] {
  return (
    database.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]
  ).map((column) => column.name);
}

/** The journal's foreign keys, one row per key, with their actions and referenced columns. */
function keysOf(database: Database.Database) {
  return database
    .prepare(
      `SELECT "table" AS parent, group_concat("from", ',' ORDER BY seq) AS columns,
              group_concat("to", ',' ORDER BY seq) AS referenced, on_update, on_delete, "match"
       FROM pragma_foreign_key_list('workspace_events') GROUP BY id ORDER BY parent, columns`,
    )
    .all() as { parent: string }[];
}

/** The journal's columns as SQLite declares them: name, type, nullability, default, key. */
function definitionOf(database: Database.Database) {
  return database
    .prepare(
      `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_xinfo('workspace_events')
       ORDER BY cid`,
    )
    .all() as { name: string }[];
}

/** What a client resuming from each cursor is sent, per workspace. */
function resumed(database: Database.Database, cursors: readonly number[]) {
  const events = new SqliteWorkspaceEventRepository(database, acceptAnyRecord);
  return ['workspace-a', 'workspace-b'].map((workspaceId) =>
    cursors.map((after) =>
      events.listAfter({ workspaceId: asWorkspaceId(workspaceId), after, limit: 100 }),
    ),
  );
}

/** Migration 0040 with one edit, as a fault injected into it; `from` must occur once. */
function edited(from: string, to: string): MigrationDefinition {
  const migration = migrations.find((candidate) => candidate.version === 40);
  if (migration === undefined) throw new Error('Expected migration 0040');
  expect(migration.sql.split(from), from).toHaveLength(2);
  const sql = migration.sql.replace(from, to);
  return { ...migration, sql, checksum: checksumSql(sql) };
}

/** A guard refuses the edited migration, and a schema-39 database is left exactly as it was. */
function expectRollback(migration: MigrationDefinition, prepare?: (db: Database.Database) => void) {
  const database = schema39(temporaryPath());
  try {
    prepare?.(database);
    const before = imageOf(database);
    expect(() => runMigrations(database, [...toSchema39, migration])).toThrow(
      /CHECK constraint failed: ok = 1/,
    );
    expect(migrationStatus(database, toSchema39).currentVersion).toBe(39);
    expect(preservationProblems(before, imageOf(database))).toEqual([]);
  } finally {
    database.close();
  }
}

describe('migration 0040: the journal without the registry (R-H6)', () => {
  it('keeps every event, its sequence and the high-water mark, and drops only the registry', () => {
    const database = schema39(temporaryPath());
    try {
      // A high-water mark above the last row, as a deleted tail would leave: the next event
      // must still follow it, never reuse a sequence a client may have seen.
      database.exec("UPDATE sqlite_sequence SET seq = seq + 5 WHERE name = 'workspace_events'");
      const before = imageOf(database);
      const keysBefore = keysOf(database);
      const definitionBefore = definitionOf(database);
      const highWater = (sequenceRow(database) as { seq: number }).seq;
      expect(highWater).toBe(13);
      const cursors = [0, 1, 3, 4, 7, 8];
      const sent = resumed(database, cursors);

      runMigrations(database, migrations);
      const after = imageOf(database);
      expect(migrationStatus(database, migrations).currentVersion).toBe(40);

      // Every row of every table, in rowid order, with the same values; every index, trigger
      // and sequence; the catalogs unchanged. Only the registry and the columns are gone.
      expect(
        preservationProblems(before, after, {
          tables: REGISTRY_TABLES,
          columns: { workspace_events: CORRELATIONS },
        }),
      ).toEqual([]);
      // Without naming them, the dropped columns are a problem: the helper sees them.
      expect(preservationProblems(before, after, { tables: REGISTRY_TABLES })).toEqual(
        CORRELATIONS.map((column) => `column workspace_events.${column} is gone`),
      );
      expect(after.tables.workspace_events?.map((row) => row.sequence)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(after.sequences.workspace_events).toBe(highWater);
      expect(after.tables.workspace_event_kinds).toEqual(before.tables.workspace_event_kinds);
      expect(after.tables.audit_action_kinds).toEqual(before.tables.audit_action_kinds);

      // The schema: no correlation column, no registry table, the same index and triggers.
      expect(columnsOf(database, 'workspace_events')).toEqual([
        'sequence',
        'id',
        'schema_version',
        'occurred_at',
        'workspace_id',
        'actor_user_id',
        'project_id',
        'work_item_id',
        'run_id',
        'kind',
        'payload_json',
      ]);
      for (const table of REGISTRY_TABLES) expect(after.tables[table], table).toBeUndefined();
      for (const name of [
        'idx_workspace_events_workspace_sequence',
        'workspace_events_no_update',
        'workspace_events_no_delete',
      ]) {
        const kind = name.startsWith('idx') ? 'indexes' : 'triggers';
        expect(after[kind][name], name).toEqual(before[kind][name]);
      }
      expect(
        Object.entries({ ...after.indexes, ...after.triggers })
          .filter(([, entry]) => (REGISTRY_TABLES as readonly string[]).includes(entry.table))
          .map(([name]) => name),
      ).toEqual([]);
      // Every kept key exactly as it was, actions and referenced columns included; the
      // registry's three are the only ones gone (R-H6 review MEDIUM-1).
      expect(keysOf(database)).toEqual(
        keysBefore.filter((key) => !(REGISTRY_TABLES as readonly string[]).includes(key.parent)),
      );
      expect(keysOf(database).map((key) => key.parent)).toEqual([
        'projects',
        'users',
        'work_items',
        'work_items',
        'workspace_event_kinds',
        'workspaces',
      ]);
      // Every kept column declared as it was, and the table still STRICT.
      expect(definitionOf(database)).toEqual(
        definitionBefore.filter((column) => !CORRELATIONS.includes(column.name)),
      );
      expect(
        database.prepare("SELECT strict FROM pragma_table_list('workspace_events')").get(),
      ).toEqual({ strict: 1 });
      // Nothing anywhere still names a dropped table.
      expect(
        database
          .prepare(
            `SELECT m.name FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
             WHERE m.type = 'table' AND f."table" IN (${REGISTRY_TABLES.map(() => '?').join(',')})`,
          )
          .all(...REGISTRY_TABLES),
      ).toEqual([]);
      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok');

      // A client resuming from any cursor before the migration is sent the same events.
      expect(resumed(database, cursors)).toEqual(sent);

      // Still append-only.
      expect(() => database.prepare('UPDATE workspace_events SET kind = kind').run()).toThrow(
        /append-only/,
      );
      expect(() => database.prepare('DELETE FROM workspace_events').run()).toThrow(/append-only/);

      // The retired kinds and actions keep their catalog rows, and the journals refuse them.
      expect(Object.keys(after.triggers).filter((name) => !(name in before.triggers))).toEqual(
        REFUSALS,
      );
      for (const kind of RETIRED_KINDS)
        expect(() =>
          database
            .prepare(
              `INSERT INTO workspace_events (id, schema_version, occurred_at, workspace_id, kind, payload_json)
               VALUES (?, 1, ?, 'workspace-a', ?, '{}')`,
            )
            .run(`retired-${kind}`, NOW, kind),
        ).toThrow('workspace event kind is retired');
      for (const action of RETIRED_ACTIONS)
        expect(() => insertAudit(database, `retired-${action}`, action)).toThrow(
          'audit action is retired',
        );
      insertAudit(database, 'live-action', 'source-repository.register');

      // The kept rules still refuse what they refused (R-H6 review MEDIUM-1): a duplicate id, a
      // payload that is not an object, a work item without its project, a value of the wrong
      // type (STRICT), and a kind outside the catalog.
      let refused = 0;
      const insert = (fields: Record<string, unknown>) => {
        const row = {
          id: `refused-${++refused}`,
          schema_version: 1,
          occurred_at: NOW,
          workspace_id: 'workspace-a',
          kind: 'attention-changed',
          payload_json: '{}',
          ...fields,
        };
        const columns = Object.keys(row);
        return () =>
          database
            .prepare(
              `INSERT INTO workspace_events (${columns.join(', ')})
               VALUES (${columns.map(() => '?').join(', ')})`,
            )
            .run(...Object.values(row));
      };
      expect(insert({ id: 'event-1' })).toThrow(/UNIQUE constraint failed: workspace_events\.id/);
      expect(insert({ id: '' })).toThrow(/CHECK constraint failed/);
      expect(insert({ schema_version: 2 })).toThrow(/CHECK constraint failed/);
      for (const payload of ['[]', '"text"', 'not json'])
        expect(insert({ payload_json: payload }), payload).toThrow(/CHECK constraint failed/);
      expect(insert({ work_item_id: 'item-root-a' })).toThrow(/CHECK constraint failed/);
      expect(insert({ run_id: Buffer.from([0]) })).toThrow(/cannot store BLOB value in TEXT/);
      expect(insert({ kind: 'not-a-kind' })).toThrow(/FOREIGN KEY constraint failed/);
      expect(insert({ workspace_id: 'workspace-missing' })).toThrow(
        /FOREIGN KEY constraint failed/,
      );
      expect(insert({ project_id: 'project-a', work_item_id: 'item-root-b' })).toThrow(
        /FOREIGN KEY constraint failed/,
      );
      expect(
        (
          database.prepare('SELECT COUNT(*) AS count FROM workspace_events').get() as {
            count: number;
          }
        ).count,
      ).toBe(8);

      // The next event follows the old high-water mark, through storage's own append.
      const next = new SqliteWorkspaceEventRepository(database, acceptAnyRecord).appendEvent({
        id: asEventId('after-migration'),
        occurredAt: NOW,
        workspaceId: asWorkspaceId('workspace-a'),
        kind: 'attention-changed',
        payload: { open: 1 },
      });
      expect(next.sequence).toBe(highWater + 1);
      expect(resumed(database, [8])[0]?.[0]?.map((event) => [event.sequence, event.id])).toEqual([
        [highWater + 1, 'after-migration'],
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps an empty journal at its high-water mark of zero', () => {
    const database = openDatabase(temporaryPath());
    try {
      runMigrations(database, toSchema39);
      // Migration 0004 left a zero row for an empty journal.
      expect(sequenceRow(database)).toEqual({ seq: 0 });
      runMigrations(database, migrations);
      expect(sequenceRow(database)).toEqual({ seq: 0 });
      expect(columnsOf(database, 'workspace_events')).not.toContain('repository_id');
    } finally {
      database.close();
    }
  });

  it('leaves a missing high-water row missing, so the next event follows the last row (R-H6 review LOW-1)', () => {
    // SQLite issues MAX(sequence) + 1 when an AUTOINCREMENT table has no sqlite_sequence row,
    // so the stream continues without a gap; 0004 accepted this state too.
    for (const populated of [true, false]) {
      const database = populated ? schema39(temporaryPath()) : openDatabase(temporaryPath());
      try {
        if (!populated) runMigrations(database, toSchema39);
        database.exec("DELETE FROM sqlite_sequence WHERE name = 'workspace_events'");
        runMigrations(database, migrations);
        expect(sequenceRow(database), String(populated)).toBeUndefined();
        if (!populated)
          database.exec(`
            INSERT INTO users (id, username, username_normalized, password_hash, status, created_at, updated_at)
              VALUES ('user-a', 'user-a', 'user-a', '$argon2id$seed', 'active', '${NOW}', '${NOW}');
            INSERT INTO workspaces (id, name, slug, status, created_by_user_id, created_at, updated_at)
              VALUES ('workspace-a', 'Workspace a', 'workspace-a', 'active', 'user-a', '${NOW}', '${NOW}');
          `);
        const next = new SqliteWorkspaceEventRepository(database, acceptAnyRecord).appendEvent({
          id: asEventId('after-migration'),
          occurredAt: NOW,
          workspaceId: asWorkspaceId('workspace-a'),
          kind: 'attention-changed',
          payload: { open: 1 },
        });
        expect(next.sequence, String(populated)).toBe(populated ? 9 : 1);
      } finally {
        database.close();
      }
    }
  });

  it('rolls back, leaving schema 39 whole, when an event carries a registry correlation', () => {
    const database = schema39(temporaryPath());
    try {
      // A registry row the old CHECK accepts; its registry rows never existed.
      database.pragma('foreign_keys = OFF');
      database
        .prepare(
          `INSERT INTO workspace_events (id, schema_version, occurred_at, workspace_id,
             repository_id, kind, payload_json)
           VALUES ('registry-event', 1, ?, 'workspace-a', 'repository-1',
             'repository-status-changed', '{}')`,
        )
        .run(NOW);
      database.pragma('foreign_keys = ON');
      const before = imageOf(database);
      expect(() => runMigrations(database, migrations)).toThrow(/CHECK constraint failed: ok = 1/);
      expect(migrationStatus(database, toSchema39).currentVersion).toBe(39);
      expect(preservationProblems(before, imageOf(database))).toEqual([]);
      expect(columnsOf(database, 'workspace_events')).toEqual(expect.arrayContaining(CORRELATIONS));
    } finally {
      database.close();
    }
  });

  it('rolls back, leaving schema 39 whole, when an audit record uses a retired action', () => {
    const database = schema39(temporaryPath());
    try {
      // The action's catalog row lets it in at schema 39; the contract no longer reads it.
      insertAudit(database, 'registry-audit', 'repository.retire');
      const before = imageOf(database);
      expect(() => runMigrations(database, migrations)).toThrow(/CHECK constraint failed: ok = 1/);
      expect(migrationStatus(database, toSchema39).currentVersion).toBe(39);
      expect(preservationProblems(before, imageOf(database))).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rolls back on a copy that loses a row: the count guard (R-H3)', () => {
    expectRollback(
      edited(
        'FROM workspace_events_schema39\nORDER BY sequence;',
        'FROM workspace_events_schema39 WHERE sequence > 1\nORDER BY sequence;',
      ),
    );
  });

  it('rolls back when the rebuilt table loses a kept rule: the schema guard (R-H6 review MEDIUM-1)', () => {
    // A kept key that cascades instead of restricting.
    expectRollback(
      edited(
        'workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,',
        'workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,',
      ),
    );
    // A table that is no longer STRICT.
    expectRollback(
      edited(
        'REFERENCES work_items(workspace_id, project_id, id) ON DELETE RESTRICT\n) STRICT;',
        'REFERENCES work_items(workspace_id, project_id, id) ON DELETE RESTRICT\n);',
      ),
    );
  });
});

/**
 * The same migration on a copy of a real database (R-H6 done-when). Point
 * `CRAFTINGTABLE_MIGRATION_SNAPSHOT` at a snapshot below schema 40, never at a live database:
 *
 *     CRAFTINGTABLE_MIGRATION_SNAPSHOT=<copy>/snapshot.sqlite \
 *       pnpm exec vitest run --project node packages/storage/test/migration-0040.test.ts
 *
 * It copies the snapshot with SQLite's backup API, brings the copy to schema 39, copies that,
 * migrates the second copy and compares the two in SQL, table by table, so the rows never sit
 * in memory at once.
 */
const SNAPSHOT = process.env.CRAFTINGTABLE_MIGRATION_SNAPSHOT;

it.skipIf(SNAPSHOT === undefined)(
  'keeps every row, sequence, index and trigger of a snapshot, and resumes its event stream without a gap',
  async () => {
    const beforePath = temporaryPath('before.sqlite');
    const afterPath = join(beforePath, '..', 'after.sqlite');
    await copyDatabase(SNAPSHOT as string, beforePath);
    const prepared = openDatabase(beforePath);
    runMigrations(prepared, toSchema39);
    prepared.pragma('wal_checkpoint(TRUNCATE)');
    prepared.close();
    copyFileSync(beforePath, afterPath);

    const database = openDatabase(afterPath);
    try {
      const highWater = (sequenceRow(database) as { seq: number }).seq;
      const workspaces = (
        database
          .prepare(
            'SELECT workspace_id AS id, MAX(sequence) AS last FROM workspace_events GROUP BY 1',
          )
          .all() as { id: string; last: number }[]
      ).map((row) => ({ ...row, cursors: [0, Math.max(0, row.last - 25), row.last] }));
      const events = new SqliteWorkspaceEventRepository(database, acceptAnyRecord);
      const sent = workspaces.map((workspace) =>
        workspace.cursors.map((after) =>
          events.listAfter({ workspaceId: asWorkspaceId(workspace.id), after, limit: 100 }),
        ),
      );

      runMigrations(database, migrations);
      expect(migrationStatus(database, migrations).currentVersion).toBe(40);

      database.prepare('ATTACH DATABASE ? AS prior').run(beforePath);
      const objects = (schema: string, type: string) =>
        database
          .prepare(
            `SELECT name, tbl_name AS "table", sql FROM ${schema}.sqlite_master
             WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all(type) as { name: string; table: string; sql: string | null }[];
      const dropped = (entry: { table: string }) =>
        (REGISTRY_TABLES as readonly string[]).includes(entry.table);
      const tables = objects('prior', 'table');
      expect(
        tables
          .filter(dropped)
          .map((table) => table.name)
          .sort(),
      ).toEqual([...REGISTRY_TABLES].sort());
      // Every other table: the same rows, by rowid, in both directions, and the same count.
      const differences: string[] = [];
      for (const { name } of tables.filter((table) => !dropped(table))) {
        const priorColumns = (
          database.prepare("SELECT name FROM pragma_table_info(?, 'prior')").all(name) as {
            name: string;
          }[]
        ).map((column) => column.name);
        const kept = priorColumns.filter(
          (column) => !(name === 'workspace_events' && CORRELATIONS.includes(column)),
        );
        expect(columnsOf(database, name), name).toEqual(kept);
        const list = ['rowid', ...kept].map((column) => `"${column}"`).join(', ');
        const count = (schema: string) =>
          (
            database.prepare(`SELECT COUNT(*) AS count FROM ${schema}."${name}"`).get() as {
              count: number;
            }
          ).count;
        const missing = (from: string, to: string) =>
          (
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM (SELECT ${list} FROM ${from}."${name}"
                 EXCEPT SELECT ${list} FROM ${to}."${name}")`,
              )
              .get() as { count: number }
          ).count;
        // The ledger gains this migration's row; every other table is unchanged.
        const added = name === 'schema_migrations' ? 1 : 0;
        if (
          count('prior') + added !== count('main') ||
          missing('prior', 'main') ||
          missing('main', 'prior') !== added
        )
          differences.push(name);
      }
      expect(differences).toEqual([]);
      // No event carried a correlation, so nothing was lost with the columns.
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM prior.workspace_events
             WHERE ${CORRELATIONS.map((column) => `${column} IS NOT NULL`).join(' OR ')}`,
          )
          .get(),
      ).toEqual({ count: 0 });
      // Every index and trigger, with its definition, but the registry's; and the two refusals.
      expect(objects('main', 'index')).toEqual(
        objects('prior', 'index').filter((entry) => !dropped(entry)),
      );
      expect(objects('main', 'trigger').filter((entry) => !REFUSALS.includes(entry.name))).toEqual(
        objects('prior', 'trigger').filter((entry) => !dropped(entry)),
      );
      // Every sequence but a dropped table's (an inspection ever written would have left one).
      expect(database.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()).toEqual(
        (
          database.prepare('SELECT name, seq FROM prior.sqlite_sequence ORDER BY name').all() as {
            name: string;
          }[]
        ).filter((row) => !(REGISTRY_TABLES as readonly string[]).includes(row.name)),
      );
      database.exec('DETACH DATABASE prior');
      expect(database.pragma('foreign_key_check')).toEqual([]);

      // A client resuming from before the migration is sent the same events, and then the next
      // one, which follows the old high-water mark.
      expect(
        workspaces.map((workspace) =>
          workspace.cursors.map((after) =>
            events.listAfter({ workspaceId: asWorkspaceId(workspace.id), after, limit: 100 }),
          ),
        ),
      ).toEqual(sent);
      const first = workspaces[0];
      if (first === undefined) throw new Error('The snapshot has no workspace events');
      const next = events.appendEvent({
        id: asEventId(`snapshot-check-${highWater}`),
        occurredAt: new Date().toISOString(),
        workspaceId: asWorkspaceId(first.id),
        kind: 'attention-changed',
        payload: { open: 0 },
      });
      expect(next.sequence).toBe(highWater + 1);
      expect(
        events
          .listAfter({ workspaceId: asWorkspaceId(first.id), after: first.last, limit: 100 })
          .map((event) => event.sequence),
      ).toEqual([highWater + 1]);
    } finally {
      database.close();
    }
  },
);
