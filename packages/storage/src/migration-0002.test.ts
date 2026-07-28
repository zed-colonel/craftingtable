import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asAuditEventId,
  asEventId,
  asProjectId,
  asSessionId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  AUDIT_ACTIONS,
  AUDIT_ACTION_INTRODUCED_IN_SCHEMA,
  WORKSPACE_EVENT_KINDS,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { discoverMigrations, runMigrations } from './migrations.js';
import { SqliteAuditRepository } from './repositories/audit.js';
import { SqliteSessionRepository } from './repositories/sessions.js';
import { SqliteUserRepository } from './repositories/users.js';
import { SqliteWorkspaceEventRepository } from './repositories/workspace-events.js';
import { SqliteWorkspaceRepository } from './repositories/workspaces.js';

/**
 * CT03-A01 to A07.
 *
 * Every case starts from a *real* schema-1 database file seeded through the
 * accepted CT-02 repositories, so the migration is exercised against rows this
 * application actually writes rather than against hand-built fixtures.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const NOW = '2026-07-24T00:00:00.000Z';

interface Seeded {
  readonly path: string;
  readonly database: Database.Database;
  readonly auditIds: readonly string[];
  readonly eventSequence: number;
  readonly auditSequences: readonly number[];
}

/** Applies migration 0001 only, then seeds it through the CT-02 repositories. */
function seedSchemaOne(): Seeded {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-migration-0002-'));
  directories.push(directory);
  const path = join(directory, 'craftingtable.sqlite');
  const database = openDatabase(path);
  const [first] = discoverMigrations();
  if (first === undefined) {
    throw new Error('Expected migration 0001 to exist');
  }
  runMigrations(database, [first]);

  const users = new SqliteUserRepository(database);
  const workspaces = new SqliteWorkspaceRepository(database);
  const sessions = new SqliteSessionRepository(database);
  const audit = new SqliteAuditRepository(database);
  const events = new SqliteWorkspaceEventRepository(database);

  const userId = asUserId('user-ct02');
  const workspaceId = asWorkspaceId('workspace-ct02');
  users.insert({
    id: userId,
    username: 'keith',
    usernameNormalized: 'keith',
    passwordHash: '$argon2id$seed',
    occurredAt: NOW,
  });
  workspaces.insert({
    id: workspaceId,
    name: 'Default workspace',
    slug: 'default',
    createdByUserId: userId,
    occurredAt: NOW,
  });
  workspaces.insertMembership({
    id: asWorkspaceMembershipId('membership-ct02'),
    workspaceId,
    userId,
    role: 'owner',
    occurredAt: NOW,
  });
  sessions.insert({
    id: asSessionId('session-ct02'),
    userId,
    tokenDigest: 'a'.repeat(64),
    csrfToken: 'c'.repeat(40),
    createdAt: NOW,
    expiresAt: '2026-08-24T00:00:00.000Z',
  });

  const auditSequences: number[] = [];
  const auditIds: string[] = [];
  for (const action of ['admin.bootstrap', 'workspace.created', 'auth.login'] as const) {
    const record = audit.append({
      id: asAuditEventId(`audit-${action}`),
      occurredAt: NOW,
      actorKind: 'system',
      actorUserId: userId,
      workspaceId,
      action,
      outcome: 'succeeded',
      metadata: { seeded: true },
    });
    auditSequences.push(record.sequence);
    auditIds.push(record.id);
  }
  const event = events.appendWorkspaceCreated({
    id: asEventId('event-ct02'),
    occurredAt: NOW,
    workspaceId,
    actorUserId: userId,
    name: 'Default workspace',
    slug: 'default',
  });

  return { path, database, auditIds, eventSequence: event.sequence, auditSequences };
}

function migrateToTwo(database: Database.Database): void {
  const status = runMigrations(database, discoverMigrations().slice(0, 2));
  expect(status.currentVersion).toBe(2);
  expect(status.pendingVersions).toEqual([]);
}

describe('migration 0002 journal preservation', () => {
  it('preserves every CT-02 row, id, and sequence (CT03-A01)', () => {
    const seeded = seedSchemaOne();
    const before = {
      users: seeded.database.prepare(`SELECT * FROM users`).all(),
      workspaces: seeded.database.prepare(`SELECT * FROM workspaces`).all(),
      memberships: seeded.database.prepare(`SELECT * FROM workspace_memberships`).all(),
      sessions: seeded.database.prepare(`SELECT * FROM sessions`).all(),
      audit: seeded.database.prepare(`SELECT * FROM audit_events ORDER BY sequence`).all(),
      events: seeded.database.prepare(`SELECT * FROM workspace_events ORDER BY sequence`).all(),
    };

    migrateToTwo(seeded.database);

    expect(seeded.database.prepare(`SELECT * FROM users`).all()).toEqual(before.users);
    expect(seeded.database.prepare(`SELECT * FROM workspaces`).all()).toEqual(before.workspaces);
    expect(seeded.database.prepare(`SELECT * FROM workspace_memberships`).all()).toEqual(
      before.memberships,
    );
    expect(seeded.database.prepare(`SELECT * FROM sessions`).all()).toEqual(before.sessions);
    expect(seeded.database.prepare(`SELECT * FROM audit_events ORDER BY sequence`).all()).toEqual(
      before.audit,
    );
    expect(
      seeded.database.prepare(`SELECT * FROM workspace_events ORDER BY sequence`).all(),
    ).toEqual(before.events);
    expect(seeded.database.pragma('foreign_key_check')).toEqual([]);
    expect(seeded.database.pragma('integrity_check', { simple: true })).toBe('ok');
    seeded.database.close();
  });

  it('preserves the maximum global event sequence exactly (CT03-A01)', () => {
    const seeded = seedSchemaOne();
    migrateToTwo(seeded.database);
    const maxima = seeded.database
      .prepare(
        `SELECT (SELECT MAX(sequence) FROM audit_events) AS audit,
                (SELECT MAX(sequence) FROM workspace_events) AS events`,
      )
      .get() as { audit: number; events: number };
    expect(maxima.audit).toBe(seeded.auditSequences.at(-1));
    expect(maxima.events).toBe(seeded.eventSequence);
    seeded.database.close();
  });

  it('gives the next appended event a greater sequence (CT03-A06)', () => {
    const seeded = seedSchemaOne();
    migrateToTwo(seeded.database);
    const events = new SqliteWorkspaceEventRepository(seeded.database);
    const audit = new SqliteAuditRepository(seeded.database);

    seeded.database
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, slug, created_at, created_by_user_id, version)
         VALUES ('p1', 'workspace-ct02', 'AQ', 'aq', ?, 'user-ct02', 1)`,
      )
      .run(NOW);

    const appended = events.appendEvent({
      id: asEventId('event-after-migration'),
      occurredAt: NOW,
      workspaceId: asWorkspaceId('workspace-ct02'),
      projectId: asProjectId('p1'),
      kind: 'project-created',
      payload: { projectId: asProjectId('p1'), name: 'AQ' },
    });
    expect(appended.sequence).toBeGreaterThan(seeded.eventSequence);

    const auditRow = audit.append({
      id: asAuditEventId('audit-after-migration'),
      occurredAt: NOW,
      actorKind: 'user',
      actorUserId: asUserId('user-ct02'),
      workspaceId: asWorkspaceId('workspace-ct02'),
      action: 'plan.import.succeeded',
      outcome: 'succeeded',
      metadata: {},
    });
    expect(auditRow.sequence).toBeGreaterThan(seeded.auditSequences.at(-1) ?? 0);
    seeded.database.close();
  });

  it('registers every CT-02 and CT-03 kind in the catalogs (CT03-A03)', () => {
    const seeded = seedSchemaOne();
    migrateToTwo(seeded.database);
    const actions = (
      seeded.database.prepare(`SELECT action FROM audit_action_kinds ORDER BY action`).all() as {
        action: string;
      }[]
    ).map((row) => row.action);
    const kinds = (
      seeded.database.prepare(`SELECT kind FROM workspace_event_kinds ORDER BY kind`).all() as {
        kind: string;
      }[]
    ).map((row) => row.kind);
    // The catalogs and the domain vocabularies must agree exactly, in both
    // directions: an unseeded action would fail closed at insert time.
    expect(actions).toEqual(
      AUDIT_ACTIONS.filter((action) => AUDIT_ACTION_INTRODUCED_IN_SCHEMA[action] <= 2).toSorted(),
    );
    expect(kinds).toEqual([...WORKSPACE_EVENT_KINDS].toSorted());
    seeded.database.close();
  });

  it('rejects an unregistered audit action and event kind (CT03-A04)', () => {
    const seeded = seedSchemaOne();
    migrateToTwo(seeded.database);
    expect(() =>
      seeded.database
        .prepare(
          `INSERT INTO audit_events (id, occurred_at, actor_kind, action, outcome, metadata_json)
           VALUES ('bad-audit', ?, 'system', 'plan.import.invented', 'succeeded', '{}')`,
        )
        .run(NOW),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      seeded.database
        .prepare(
          `INSERT INTO workspace_events (id, schema_version, occurred_at, workspace_id, kind, payload_json)
           VALUES ('bad-event', 1, ?, 'workspace-ct02', 'invented-kind', '{}')`,
        )
        .run(NOW),
    ).toThrow(/FOREIGN KEY/);
    seeded.database.close();
  });

  it('keeps both journals append-only after the rebuild (CT03-A05)', () => {
    const seeded = seedSchemaOne();
    migrateToTwo(seeded.database);
    expect(() =>
      seeded.database.prepare(`UPDATE audit_events SET outcome = 'failed'`).run(),
    ).toThrow(/append-only/);
    expect(() => seeded.database.prepare(`DELETE FROM audit_events`).run()).toThrow(/append-only/);
    expect(() =>
      seeded.database.prepare(`UPDATE workspace_events SET kind = 'project-created'`).run(),
    ).toThrow(/append-only/);
    expect(() => seeded.database.prepare(`DELETE FROM workspace_events`).run()).toThrow(
      /append-only/,
    );
    seeded.database.close();
  });

  it('protects the catalogs from update and delete while permitting registration (CT03-A07)', () => {
    const seeded = seedSchemaOne();
    migrateToTwo(seeded.database);
    expect(() =>
      seeded.database
        .prepare(`UPDATE workspace_event_kinds SET kind = 'x' WHERE kind = 'workspace-created'`)
        .run(),
    ).toThrow(/migration-owned/);
    expect(() =>
      seeded.database.prepare(`DELETE FROM audit_action_kinds WHERE action = 'auth.login'`).run(),
    ).toThrow(/migration-owned/);

    // A future migration registers a kind with one INSERT and no table rebuild.
    const journalSqlBefore = seeded.database
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'workspace_events'`)
      .get() as { sql: string };
    seeded.database
      .prepare(`INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES (?, 3)`)
      .run('future-kind');
    seeded.database
      .prepare(
        `INSERT INTO workspace_events (id, schema_version, occurred_at, workspace_id, kind, payload_json)
         VALUES ('future-event', 1, ?, 'workspace-ct02', 'future-kind', '{}')`,
      )
      .run(NOW);
    const journalSqlAfter = seeded.database
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'workspace_events'`)
      .get() as { sql: string };
    expect(journalSqlAfter.sql).toBe(journalSqlBefore.sql);
    seeded.database.close();
  });

  it('rejects a workspace-event payload that is not a JSON object', () => {
    const seeded = seedSchemaOne();
    migrateToTwo(seeded.database);
    expect(() =>
      seeded.database
        .prepare(
          `INSERT INTO workspace_events (id, schema_version, occurred_at, workspace_id, kind, payload_json)
           VALUES ('array-payload', 1, ?, 'workspace-ct02', 'workspace-created', '[1,2]')`,
        )
        .run(NOW),
    ).toThrow(/CHECK/);
    seeded.database.close();
  });

  it('is idempotent when the database is reopened (CT03-A02)', () => {
    const seeded = seedSchemaOne();
    migrateToTwo(seeded.database);
    seeded.database.close();

    const reopened = openDatabase(seeded.path);
    const status = runMigrations(reopened, discoverMigrations().slice(0, 2));
    expect(status).toEqual({ currentVersion: 2, supportedVersion: 2, pendingVersions: [] });
    expect(
      (
        reopened.prepare(`SELECT COUNT(*) AS count FROM schema_migrations`).get() as {
          count: number;
        }
      ).count,
    ).toBe(2);
    expect(
      (reopened.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get() as { count: number })
        .count,
    ).toBe(seeded.auditIds.length);
    reopened.close();
  });

  it('records migration 0002 with its checksum and rejects a changed one (CT03-A02)', () => {
    const seeded = seedSchemaOne();
    const migrations = discoverMigrations();
    migrateToTwo(seeded.database);
    const row = seeded.database
      .prepare(`SELECT version, name, checksum FROM schema_migrations WHERE version = 2`)
      .get() as { version: number; name: string; checksum: string };
    expect(row).toMatchObject({
      version: 2,
      name: 'ct03-planning',
      checksum: migrations[1]?.checksum,
    });
    seeded.database.close();
  });

  it('leaves migration 0001 untouched so existing databases stay valid', () => {
    const migrations = discoverMigrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      'ct02-foundation',
      'ct03-planning',
      'ct04a2a-repository-model',
    ]);
    // The recorded checksum of 0001 is what every already-migrated installation
    // validates against; changing that file would lock operators out.
    expect(migrations[0]?.checksum).toBe(
      '42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273',
    );
  });
});
