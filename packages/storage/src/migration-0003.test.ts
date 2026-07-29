import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_ACTIONS, AUDIT_ACTION_INTRODUCED_IN_SCHEMA } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { checksumSql, discoverMigrations, runMigrations } from './migrations.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-migration-0003-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

describe('migration 0003 repository model', () => {
  it('preserves a populated schema 2 database and its journal definitions (A2A-MIG-002/003)', () => {
    const database = openDatabase(databasePath());
    const migrations = discoverMigrations();
    runMigrations(database, migrations.slice(0, 2));
    database.exec(`
      INSERT INTO users (
        id, username, username_normalized, password_hash, status,
        created_at, updated_at, version)
      VALUES ('u', 'user', 'user', '$argon2id$seed', 'active',
              '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z', 1);
      INSERT INTO workspaces (
        id, name, slug, status, created_by_user_id, created_at, updated_at, version)
      VALUES ('w', 'Workspace', 'workspace', 'active', 'u',
              '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z', 1);
      INSERT INTO workspace_memberships (
        id, workspace_id, user_id, role, status, created_at, version)
      VALUES ('m', 'w', 'u', 'owner', 'active', '2026-07-24T00:00:00.000Z', 1);
      INSERT INTO projects (
        id, workspace_id, name, slug, active_plan_version_id,
        created_at, created_by_user_id, version)
      VALUES ('p', 'w', 'Project', 'project', NULL,
              '2026-07-24T00:00:00.000Z', 'u', 1);
      INSERT INTO audit_events (
        id, occurred_at, actor_kind, actor_user_id, workspace_id,
        action, outcome, metadata_json)
      VALUES ('a', '2026-07-24T00:00:00.000Z', 'user', 'u', 'w',
              'workspace.created', 'succeeded', '{}');
      INSERT INTO workspace_events (
        id, schema_version, occurred_at, workspace_id, actor_user_id,
        kind, payload_json)
      VALUES ('e', 1, '2026-07-24T00:00:00.000Z', 'w', 'u',
              'workspace-created', '{"name":"Workspace","slug":"workspace"}');
    `);
    const before = {
      users: database.prepare(`SELECT * FROM users`).all(),
      workspaces: database.prepare(`SELECT * FROM workspaces`).all(),
      memberships: database.prepare(`SELECT * FROM workspace_memberships`).all(),
      projects: database.prepare(`SELECT * FROM projects`).all(),
      audit: database.prepare(`SELECT * FROM audit_events`).all(),
      events: database.prepare(`SELECT * FROM workspace_events`).all(),
      auditSql: (
        database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'audit_events'`).get() as {
          sql: string;
        }
      ).sql,
      eventSql: (
        database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'workspace_events'`).get() as {
          sql: string;
        }
      ).sql,
    };

    expect(runMigrations(database, migrations)).toEqual({
      currentVersion: 3,
      supportedVersion: 3,
      pendingVersions: [],
    });
    expect(database.prepare(`SELECT * FROM users`).all()).toEqual(before.users);
    expect(database.prepare(`SELECT * FROM workspaces`).all()).toEqual(before.workspaces);
    expect(database.prepare(`SELECT * FROM workspace_memberships`).all()).toEqual(
      before.memberships,
    );
    expect(database.prepare(`SELECT * FROM projects`).all()).toEqual(before.projects);
    expect(database.prepare(`SELECT * FROM audit_events`).all()).toEqual(before.audit);
    expect(database.prepare(`SELECT * FROM workspace_events`).all()).toEqual(before.events);
    expect(
      (
        database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'audit_events'`).get() as {
          sql: string;
        }
      ).sql,
    ).toBe(before.auditSql);
    expect(
      (
        database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'workspace_events'`).get() as {
          sql: string;
        }
      ).sql,
    ).toBe(before.eventSql);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });

  it('registers all 19 audit actions with their exact introduction versions (A2A-MIG-001)', () => {
    const database = openDatabase(databasePath());
    const migrations = discoverMigrations();
    runMigrations(database, migrations);
    const rows = database
      .prepare(`SELECT action, introduced_in_schema FROM audit_action_kinds ORDER BY action`)
      .all() as { action: (typeof AUDIT_ACTIONS)[number]; introduced_in_schema: 1 | 2 | 3 }[];
    expect(rows).toEqual(
      AUDIT_ACTIONS.map((action) => ({
        action,
        introduced_in_schema: AUDIT_ACTION_INTRODUCED_IN_SCHEMA[action],
      })).toSorted((left, right) => left.action.localeCompare(right.action)),
    );
    database.close();
  });

  it('keeps migrations 0001 and 0002 byte-identical and records 0003 checksum (A2A-MIG-008)', () => {
    const migrations = discoverMigrations();
    expect(migrations[0]?.checksum).toBe(
      '42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273',
    );
    expect(migrations[1]?.checksum).toBe(
      '6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247',
    );
    expect(migrations[2]).toMatchObject({
      version: 3,
      name: 'ct04a2a-repository-model',
    });
    expect(migrations[2]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rolls a synthetic interrupted 0003 back to intact schema 2 (A2A-MIG-005)', () => {
    const database = openDatabase(databasePath());
    const migrations = discoverMigrations();
    runMigrations(database, migrations.slice(0, 2));
    const sql = `
      CREATE TABLE migration_0003_partial (id INTEGER PRIMARY KEY) STRICT;
      INSERT INTO missing_migration_0003_table VALUES (1);
    `;
    expect(() =>
      runMigrations(database, [
        ...migrations.slice(0, 2),
        {
          version: 3,
          name: 'synthetic-interrupted-0003',
          sql,
          checksum: checksumSql(sql),
        },
      ]),
    ).toThrow();
    expect(
      database.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all(),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'migration_0003_partial'`)
        .get(),
    ).toBeUndefined();
    expect(database.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });
});
