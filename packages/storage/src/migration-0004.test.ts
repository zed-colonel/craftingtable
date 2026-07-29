import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asProjectId,
  asProjectRepositoryBindingId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA,
  WORKSPACE_EVENT_KINDS,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import {
  checksumSql,
  discoverMigrations,
  type MigrationDefinition,
  migrationStatus,
  runMigrations,
} from './migrations.js';
import { planningRepositories } from './repositories/planning/index.js';
import { repositoryRegistryRepositories } from './repositories/repository-registry/index.js';
import { SqliteUserRepository } from './repositories/users.js';
import { SqliteWorkspaceRepository } from './repositories/workspaces.js';
import { repositoryRegistrationInspection } from './repository-test-support.js';

const NOW = '2026-07-29T00:00:00.000Z';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Graph {
  readonly userId: ReturnType<typeof asUserId>;
  readonly workspaceId: ReturnType<typeof asWorkspaceId>;
  readonly projectId: ReturnType<typeof asProjectId>;
  readonly repositoryId: ReturnType<typeof repositoryRegistrationInspection>['repositoryId'];
  readonly inspectionId: ReturnType<typeof repositoryRegistrationInspection>['id'];
  readonly bindingId: ReturnType<typeof asProjectRepositoryBindingId>;
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-migration-0004-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

function schemaThreeDatabase(): {
  readonly database: Database.Database;
  readonly migrations: readonly MigrationDefinition[];
} {
  const database = openDatabase(databasePath());
  const migrations = discoverMigrations();
  runMigrations(database, migrations.slice(0, 3));
  return { database, migrations };
}

function seedGraph(database: Database.Database, suffix: string): Graph {
  const userId = asUserId(`user-${suffix}`);
  const workspaceId = asWorkspaceId(`workspace-${suffix}`);
  const projectId = asProjectId(`project-${suffix}`);
  const bindingId = asProjectRepositoryBindingId(`binding-${suffix}`);
  const users = new SqliteUserRepository(database);
  const workspaces = new SqliteWorkspaceRepository(database);
  const planning = planningRepositories(database);
  const registry = repositoryRegistryRepositories(database);

  users.insert({
    id: userId,
    username: `user-${suffix}`,
    usernameNormalized: `user-${suffix}`,
    passwordHash: '$argon2id$seed',
    occurredAt: NOW,
  });
  workspaces.insert({
    id: workspaceId,
    name: `Workspace ${suffix}`,
    slug: `workspace-${suffix}`,
    createdByUserId: userId,
    occurredAt: NOW,
  });
  workspaces.insertMembership({
    id: asWorkspaceMembershipId(`membership-${suffix}`),
    workspaceId,
    userId,
    role: 'owner',
    occurredAt: NOW,
  });
  planning.projects.insert({
    id: projectId,
    workspaceId,
    name: `Project ${suffix}`,
    slug: `project-${suffix}`,
    createdAt: NOW,
    createdByUserId: userId,
  });

  const inspection = repositoryRegistrationInspection({
    suffix,
    workspaceId,
    actorUserId: userId,
    createdAt: NOW,
  });
  const repository = registry.repositories.register({
    id: inspection.repositoryId,
    workspaceId,
    displayName: `Repository ${suffix}`,
    actorUserId: userId,
    inspection,
  });
  if (repository.kind !== 'created') {
    throw new Error(`Expected created repository, got ${repository.kind}`);
  }
  const binding = registry.bindings.insert({
    id: bindingId,
    workspaceId,
    projectId,
    repositoryId: inspection.repositoryId,
    expectedRepositoryVersion: 1,
    actorUserId: userId,
    boundAt: NOW,
  });
  if (binding.kind !== 'created') {
    throw new Error(`Expected created binding, got ${binding.kind}`);
  }

  return {
    userId,
    workspaceId,
    projectId,
    repositoryId: inspection.repositoryId,
    inspectionId: inspection.id,
    bindingId,
  };
}

function seedSiblingGraph(database: Database.Database, parent: Graph, suffix: string): Graph {
  const projectId = asProjectId(`project-${suffix}`);
  const bindingId = asProjectRepositoryBindingId(`binding-${suffix}`);
  const planning = planningRepositories(database);
  const registry = repositoryRegistryRepositories(database);
  planning.projects.insert({
    id: projectId,
    workspaceId: parent.workspaceId,
    name: `Project ${suffix}`,
    slug: `project-${suffix}`,
    createdAt: NOW,
    createdByUserId: parent.userId,
  });
  const inspection = repositoryRegistrationInspection({
    suffix,
    workspaceId: parent.workspaceId,
    actorUserId: parent.userId,
    createdAt: NOW,
  });
  const repository = registry.repositories.register({
    id: inspection.repositoryId,
    workspaceId: parent.workspaceId,
    displayName: `Repository ${suffix}`,
    actorUserId: parent.userId,
    inspection,
  });
  if (repository.kind !== 'created') {
    throw new Error(`Expected sibling repository, got ${repository.kind}`);
  }
  const binding = registry.bindings.insert({
    id: bindingId,
    workspaceId: parent.workspaceId,
    projectId,
    repositoryId: inspection.repositoryId,
    expectedRepositoryVersion: 1,
    actorUserId: parent.userId,
    boundAt: NOW,
  });
  if (binding.kind !== 'created') {
    throw new Error(`Expected sibling binding, got ${binding.kind}`);
  }
  return {
    userId: parent.userId,
    workspaceId: parent.workspaceId,
    projectId,
    repositoryId: inspection.repositoryId,
    inspectionId: inspection.id,
    bindingId,
  };
}

function migrateToFour(
  database: Database.Database,
  migrations: readonly MigrationDefinition[],
): void {
  expect(runMigrations(database, migrations)).toEqual({
    currentVersion: 4,
    supportedVersion: 4,
    pendingVersions: [],
  });
}

function insertEvent(
  database: Database.Database,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly kind: string;
    readonly projectId?: string;
    readonly workItemId?: string;
    readonly runId?: string;
    readonly repositoryId?: string;
    readonly inspectionId?: string;
    readonly bindingId?: string;
    readonly payload?: string;
  },
): number {
  return Number(
    database
      .prepare(
        `INSERT INTO workspace_events (
           id, schema_version, occurred_at, workspace_id, project_id, work_item_id, run_id,
           repository_id, repository_inspection_id, repository_binding_id, kind, payload_json)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        NOW,
        input.workspaceId,
        input.projectId ?? null,
        input.workItemId ?? null,
        input.runId ?? null,
        input.repositoryId ?? null,
        input.inspectionId ?? null,
        input.bindingId ?? null,
        input.kind,
        input.payload ?? '{}',
      ).lastInsertRowid,
  );
}

function insertSchemaThreeEvent(
  database: Database.Database,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly kind: 'workspace-created' | 'project-created';
    readonly projectId?: string;
    readonly payload?: string;
  },
): number {
  return Number(
    database
      .prepare(
        `INSERT INTO workspace_events (
           id, schema_version, occurred_at, workspace_id, project_id, kind, payload_json)
         VALUES (?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        NOW,
        input.workspaceId,
        input.projectId ?? null,
        input.kind,
        input.payload ?? '{}',
      ).lastInsertRowid,
  );
}

function workspaceEventSchemaObjects(database: Database.Database) {
  return database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name IN (
         'idx_workspace_events_workspace_sequence',
         'workspace_events_no_update',
         'workspace_events_no_delete'
       )
       ORDER BY type, name`,
    )
    .all();
}

function correlationContext() {
  const { database, migrations } = schemaThreeDatabase();
  const first = seedGraph(database, 'first');
  const foreign = seedGraph(database, 'foreign');
  const sibling = seedSiblingGraph(database, first, 'sibling');
  migrateToFour(database, migrations);
  return { database, first, foreign, sibling };
}

describe('migration 0004 repository journal', () => {
  it('B1-MIG-001 and A2B-JRN-001 preserve every legacy row, sequence, and payload byte', () => {
    const { database, migrations } = schemaThreeDatabase();
    const graph = seedGraph(database, 'preserve');
    const exactPayload = '{ "name" : "Workspace preserve", "slug" : "workspace-preserve" }';
    insertSchemaThreeEvent(database, {
      id: 'legacy-workspace',
      workspaceId: graph.workspaceId,
      kind: 'workspace-created',
      payload: exactPayload,
    });
    insertSchemaThreeEvent(database, {
      id: 'legacy-project',
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      kind: 'project-created',
      payload: '{"projectId":"project-preserve","name":"Project preserve"}',
    });
    const before = database
      .prepare(
        `SELECT sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
                project_id, work_item_id, run_id, kind,
                hex(CAST(payload_json AS BLOB)) AS payload_bytes
         FROM workspace_events ORDER BY sequence`,
      )
      .all();
    const beforeSequence = database
      .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'`)
      .get();

    migrateToFour(database, migrations);

    const after = database
      .prepare(
        `SELECT sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
                project_id, work_item_id, run_id, kind,
                hex(CAST(payload_json AS BLOB)) AS payload_bytes
         FROM workspace_events ORDER BY sequence`,
      )
      .all();
    expect(after).toEqual(before);
    expect(
      database
        .prepare(
          `SELECT repository_id, repository_inspection_id, repository_binding_id
           FROM workspace_events`,
        )
        .all(),
    ).toEqual(
      before.map(() => ({
        repository_id: null,
        repository_inspection_id: null,
        repository_binding_id: null,
      })),
    );
    expect(
      database.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'`).get(),
    ).toEqual(beforeSequence);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
    database.close();
  });

  it('B1-MIG-002 preserves a deleted high-water and normalizes an empty journal', () => {
    const populated = schemaThreeDatabase();
    const graph = seedGraph(populated.database, 'sequence');
    insertSchemaThreeEvent(populated.database, {
      id: 'sequence-one',
      workspaceId: graph.workspaceId,
      kind: 'workspace-created',
    });
    insertSchemaThreeEvent(populated.database, {
      id: 'sequence-two',
      workspaceId: graph.workspaceId,
      kind: 'workspace-created',
    });
    const issued = insertSchemaThreeEvent(populated.database, {
      id: 'sequence-issued-then-deleted',
      workspaceId: graph.workspaceId,
      kind: 'workspace-created',
    });
    populated.database.exec(`
      DROP TRIGGER workspace_events_no_delete;
      DELETE FROM workspace_events WHERE id = 'sequence-issued-then-deleted';
      CREATE TRIGGER workspace_events_no_delete
      BEFORE DELETE ON workspace_events
      BEGIN
        SELECT RAISE(ABORT, 'workspace events are append-only');
      END;
    `);
    expect(
      (
        populated.database
          .prepare(`SELECT MAX(sequence) AS maximum FROM workspace_events`)
          .get() as { maximum: number }
      ).maximum,
    ).toBeLessThan(issued);

    migrateToFour(populated.database, populated.migrations);
    expect(
      (
        populated.database
          .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'`)
          .get() as { seq: number }
      ).seq,
    ).toBe(issued);
    expect(
      insertEvent(populated.database, {
        id: 'sequence-after-migration',
        workspaceId: graph.workspaceId,
        kind: 'workspace-created',
      }),
    ).toBe(issued + 1);
    populated.database.close();

    const empty = schemaThreeDatabase();
    migrateToFour(empty.database, empty.migrations);
    expect(
      empty.database
        .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'`)
        .get(),
    ).toEqual({ seq: 0 });
    empty.database.close();
  });

  it('B1-MIG-003 restores the exact index and append-only triggers', () => {
    const { database, migrations } = schemaThreeDatabase();
    const graph = seedGraph(database, 'catalog');
    insertSchemaThreeEvent(database, {
      id: 'catalog-event',
      workspaceId: graph.workspaceId,
      kind: 'workspace-created',
    });
    migrateToFour(database, migrations);

    expect(workspaceEventSchemaObjects(database)).toEqual([
      {
        type: 'index',
        name: 'idx_workspace_events_workspace_sequence',
        tbl_name: 'workspace_events',
        sql: expect.stringContaining('workspace_id, sequence'),
      },
      {
        type: 'trigger',
        name: 'workspace_events_no_delete',
        tbl_name: 'workspace_events',
        sql: expect.stringContaining('workspace events are append-only'),
      },
      {
        type: 'trigger',
        name: 'workspace_events_no_update',
        tbl_name: 'workspace_events',
        sql: expect.stringContaining('workspace events are append-only'),
      },
    ]);
    expect(() => database.prepare(`UPDATE workspace_events SET occurred_at = ?`).run(NOW)).toThrow(
      /append-only/,
    );
    expect(() => database.prepare(`DELETE FROM workspace_events`).run()).toThrow(/append-only/);
    database.close();
  });

  it('B1-MIG-004 and B1-MIG-007 preserve introduction values and register exact schema 4', () => {
    const { database, migrations } = schemaThreeDatabase();
    migrateToFour(database, migrations);
    const rows = database
      .prepare(`SELECT kind, introduced_in_schema FROM workspace_event_kinds ORDER BY kind`)
      .all();
    expect(rows).toEqual(
      WORKSPACE_EVENT_KINDS.map((kind) => ({
        kind,
        introduced_in_schema: WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA[kind],
      })).toSorted((left, right) => left.kind.localeCompare(right.kind)),
    );
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
    database.close();
  });

  it('B1-MIG-005 keeps migrations 0001 through 0003 byte-identical', () => {
    const migrations = discoverMigrations();
    expect(migrations.map((migration) => migration.checksum).slice(0, 3)).toEqual([
      '42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273',
      '6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247',
      '526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4',
    ]);
    expect(migrations[3]).toMatchObject({
      version: 4,
      name: 'ct04a2b-repository-journal',
    });
  });

  it('B1-MIG-006 derives one failing guard from real 0004 and rolls back to complete schema 3', () => {
    const { database, migrations } = schemaThreeDatabase();
    const graph = seedGraph(database, 'rollback');
    insertSchemaThreeEvent(database, {
      id: 'rollback-event',
      workspaceId: graph.workspaceId,
      kind: 'workspace-created',
      payload: '{"name":"Rollback","slug":"rollback"}',
    });
    const migration = migrations[3];
    if (migration === undefined) throw new Error('Expected migration 0004');
    const marker = '1 /* B1_GUARD_TEST_SENTINEL */';
    expect(migration.sql.split(marker)).toHaveLength(2);
    const failedSql = migration.sql.replace(marker, '0 /* B1_GUARD_TEST_SENTINEL */');
    expect(failedSql).not.toBe(migration.sql);

    expect(() =>
      runMigrations(database, [
        ...migrations.slice(0, 3),
        { ...migration, sql: failedSql, checksum: checksumSql(failedSql) },
      ]),
    ).toThrow(/CHECK constraint failed/);
    expect(migrationStatus(database, migrations.slice(0, 3))).toEqual({
      currentVersion: 3,
      supportedVersion: 3,
      pendingVersions: [],
    });
    expect(
      database.prepare(`SELECT id, payload_json FROM workspace_events ORDER BY sequence`).all(),
    ).toEqual([{ id: 'rollback-event', payload_json: '{"name":"Rollback","slug":"rollback"}' }]);
    expect(
      database
        .prepare(
          `SELECT name FROM pragma_table_info('workspace_events')
           WHERE name IN ('repository_id', 'repository_inspection_id', 'repository_binding_id')`,
        )
        .all(),
    ).toEqual([]);
    expect(
      (
        database.prepare(`SELECT COUNT(*) AS count FROM workspace_event_kinds`).get() as {
          count: number;
        }
      ).count,
    ).toBe(4);
    expect(workspaceEventSchemaObjects(database)).toHaveLength(3);
    expect(() => database.prepare(`UPDATE workspace_events SET occurred_at = ?`).run(NOW)).toThrow(
      /append-only/,
    );
    expect(() => database.prepare(`DELETE FROM workspace_events`).run()).toThrow(/append-only/);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });

  it('B1-MIG-008 rejects checksum drift in an applied migration 0004', () => {
    const { database, migrations } = schemaThreeDatabase();
    migrateToFour(database, migrations);
    const migration = migrations[3];
    if (migration === undefined) throw new Error('Expected migration 0004');
    const changedSql = `${migration.sql}\n-- changed after application`;
    expect(() =>
      migrationStatus(database, [
        ...migrations.slice(0, 3),
        { ...migration, sql: changedSql, checksum: checksumSql(changedSql) },
      ]),
    ).toThrow(/checksum mismatch/);
    expect(
      (
        database.prepare(`SELECT COUNT(*) AS count FROM schema_migrations`).get() as {
          count: number;
        }
      ).count,
    ).toBe(4);
    database.close();
  });

  it('B1-MIG-009 contains no new payload-aware semantic DDL', () => {
    const { database, migrations } = schemaThreeDatabase();
    migrateToFour(database, migrations);
    const row = database
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_events'`)
      .get() as { sql: string };
    const normalized = row.sql.toLowerCase();
    expect(normalized).not.toContain('json_extract(');
    expect(normalized.match(/json_type\s*\(\s*payload_json\s*\)/g)).toHaveLength(1);
    expect(normalized.match(/json_valid\s*\(\s*payload_json\s*\)/g)).toHaveLength(1);
    for (const payloadField of [
      'repositoryid',
      'inspectionid',
      'bindingid',
      'tostatus',
      'statusreason',
    ]) {
      expect(normalized).not.toContain(payloadField);
    }
    database.close();
  });

  it('B1-MIG-010 declares exact repository composite FKs with RESTRICT deletion', () => {
    const { database, migrations } = schemaThreeDatabase();
    migrateToFour(database, migrations);
    const rows = database.pragma('foreign_key_list(workspace_events)') as {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }[];
    const repositoryTables = new Set([
      'registered_repositories',
      'repository_inspections',
      'project_repository_bindings',
    ]);
    const grouped = Object.values(
      rows
        .filter((row) => repositoryTables.has(row.table))
        .reduce<
          Record<
            string,
            {
              table: string;
              from: string[];
              to: string[];
              onDelete: string;
            }
          >
        >((groups, row) => {
          let group = groups[row.id];
          if (group === undefined) {
            group = {
              table: row.table,
              from: [],
              to: [],
              onDelete: row.on_delete,
            };
            groups[row.id] = group;
          }
          group.from[row.seq] = row.from;
          group.to[row.seq] = row.to;
          return groups;
        }, {}),
    ).toSorted((left, right) => left.table.localeCompare(right.table));

    expect(grouped).toEqual([
      {
        table: 'project_repository_bindings',
        from: ['workspace_id', 'project_id', 'repository_id', 'repository_binding_id'],
        to: ['workspace_id', 'project_id', 'repository_id', 'id'],
        onDelete: 'RESTRICT',
      },
      {
        table: 'registered_repositories',
        from: ['workspace_id', 'repository_id'],
        to: ['workspace_id', 'id'],
        onDelete: 'RESTRICT',
      },
      {
        table: 'repository_inspections',
        from: ['workspace_id', 'repository_id', 'repository_inspection_id'],
        to: ['workspace_id', 'repository_id', 'id'],
        onDelete: 'RESTRICT',
      },
    ]);
    database.close();
  });

  it('B1-COR-001 accepts every legal same-workspace structural correlation', () => {
    const { database, migrations } = schemaThreeDatabase();
    const graph = seedGraph(database, 'legal');
    migrateToFour(database, migrations);

    expect(() =>
      insertEvent(database, {
        id: 'registered-legal',
        workspaceId: graph.workspaceId,
        kind: 'repository-registered',
        repositoryId: graph.repositoryId,
        inspectionId: graph.inspectionId,
      }),
    ).not.toThrow();
    expect(() =>
      insertEvent(database, {
        id: 'status-inspection-legal',
        workspaceId: graph.workspaceId,
        kind: 'repository-status-changed',
        repositoryId: graph.repositoryId,
        inspectionId: graph.inspectionId,
      }),
    ).not.toThrow();
    expect(() =>
      insertEvent(database, {
        id: 'evidence-legal',
        workspaceId: graph.workspaceId,
        kind: 'repository-evidence-changed',
        repositoryId: graph.repositoryId,
        inspectionId: graph.inspectionId,
      }),
    ).not.toThrow();
    for (const kind of [
      'project-repository-bound',
      'project-repository-binding-retired',
    ] as const) {
      expect(() =>
        insertEvent(database, {
          id: `${kind}-legal`,
          workspaceId: graph.workspaceId,
          kind,
          projectId: graph.projectId,
          repositoryId: graph.repositoryId,
          bindingId: graph.bindingId,
        }),
      ).not.toThrow();
    }
    database.close();
  });

  it('B1-COR-002 and A2B-JRN-002 reject a repository owned by a foreign workspace', () => {
    const { database, first, foreign } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'foreign-repository',
        workspaceId: first.workspaceId,
        kind: 'repository-status-changed',
        repositoryId: foreign.repositoryId,
      }),
    ).toThrow(/FOREIGN KEY/);
    database.close();
  });

  it('B1-COR-003 rejects a missing repository parent', () => {
    const { database, first } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'missing-repository',
        workspaceId: first.workspaceId,
        kind: 'repository-status-changed',
        repositoryId: 'repository-missing',
      }),
    ).toThrow(/FOREIGN KEY/);
    database.close();
  });

  it('B1-COR-004 and A2B-JRN-003 reject an inspection owned by a sibling repository', () => {
    const { database, first, sibling } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'sibling-inspection',
        workspaceId: first.workspaceId,
        kind: 'repository-evidence-changed',
        repositoryId: first.repositoryId,
        inspectionId: sibling.inspectionId,
      }),
    ).toThrow(/FOREIGN KEY/);
    database.close();
  });

  it('B1-COR-005 rejects an inspection correlation without a repository', () => {
    const { database, first } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'inspection-without-repository',
        workspaceId: first.workspaceId,
        kind: 'repository-evidence-changed',
        inspectionId: first.inspectionId,
      }),
    ).toThrow(/CHECK/);
    database.close();
  });

  it('B1-COR-006 and A2B-JRN-004 reject a binding owned by a sibling project and repository', () => {
    const { database, first, sibling } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'sibling-project-binding',
        workspaceId: first.workspaceId,
        kind: 'project-repository-bound',
        projectId: first.projectId,
        repositoryId: sibling.repositoryId,
        bindingId: sibling.bindingId,
      }),
    ).toThrow(/FOREIGN KEY/);
    database.close();
  });

  it('B1-COR-007 rejects a binding correlation without its project', () => {
    const { database, first } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'binding-without-project',
        workspaceId: first.workspaceId,
        kind: 'project-repository-bound',
        repositoryId: first.repositoryId,
        bindingId: first.bindingId,
      }),
    ).toThrow(/CHECK/);
    database.close();
  });

  it('B1-COR-008 rejects repository correlations on legacy event kinds', () => {
    const { database, first } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'legacy-with-repository',
        workspaceId: first.workspaceId,
        kind: 'workspace-created',
        repositoryId: first.repositoryId,
      }),
    ).toThrow(/CHECK/);
    database.close();
  });

  it('B1-COR-009 rejects repository registration without an inspection', () => {
    const { database, first } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'registration-without-inspection',
        workspaceId: first.workspaceId,
        kind: 'repository-registered',
        repositoryId: first.repositoryId,
      }),
    ).toThrow(/CHECK/);
    database.close();
  });

  it('B1-COR-010 rejects repository evidence change without an inspection', () => {
    const { database, first } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'evidence-without-inspection',
        workspaceId: first.workspaceId,
        kind: 'repository-evidence-changed',
        repositoryId: first.repositoryId,
      }),
    ).toThrow(/CHECK/);
    database.close();
  });

  it('B1-COR-011 permits status correlation without inspection while Zod proves retirement', () => {
    const { database, first } = correlationContext();
    expect(() =>
      insertEvent(database, {
        id: 'status-without-inspection',
        workspaceId: first.workspaceId,
        kind: 'repository-status-changed',
        repositoryId: first.repositoryId,
      }),
    ).not.toThrow();
    database.close();
  });

  it('B1-COR-012 rejects binding work-item, inspection, and run correlations', () => {
    const { database, first } = correlationContext();
    const illegalDimensions = [
      { inspectionId: first.inspectionId },
      { workItemId: 'work-item-illegal' },
      { runId: 'run-illegal' },
    ];
    for (const [index, illegal] of illegalDimensions.entries()) {
      expect(() =>
        insertEvent(database, {
          id: `binding-illegal-dimension-${index}`,
          workspaceId: first.workspaceId,
          kind: 'project-repository-bound',
          projectId: first.projectId,
          repositoryId: first.repositoryId,
          bindingId: first.bindingId,
          ...illegal,
        }),
      ).toThrow();
    }
    database.close();
  });

  it('B1-COR-014 forces repository correlations NULL for an unlisted future kind', () => {
    const { database, migrations } = schemaThreeDatabase();
    const graph = seedGraph(database, 'future');
    migrateToFour(database, migrations);
    database
      .prepare(
        `INSERT INTO workspace_event_kinds (kind, introduced_in_schema)
         VALUES ('future-schema-five-kind', 5)`,
      )
      .run();

    expect(() =>
      insertEvent(database, {
        id: 'future-with-repository',
        workspaceId: graph.workspaceId,
        kind: 'future-schema-five-kind',
        repositoryId: graph.repositoryId,
      }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertEvent(database, {
        id: 'future-without-repository',
        workspaceId: graph.workspaceId,
        kind: 'future-schema-five-kind',
      }),
    ).not.toThrow();
    database.close();
  });
});
