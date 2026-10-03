import {
  asAuditEventId,
  asEventId,
  asRepositoryId,
  asRepositoryInspectionId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
} from '@craftingtable/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDatabase } from '../src/database.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';
import type { WorkspaceEventAppendError, WorkspaceEventMappingError } from '../src/types.js';

const temporaries: TemporaryStorage[] = [];
afterEach(() => {
  for (const temporary of temporaries.splice(0)) {
    temporary.cleanup();
  }
});

function seed(temporary: TemporaryStorage, suffix = '1') {
  const now = new Date().toISOString();
  const userId = asUserId(`user-${suffix}`);
  const workspaceId = asWorkspaceId(`workspace-${suffix}`);
  temporary.storage.transaction((tx) => {
    tx.users.insert({
      id: userId,
      username: `user${suffix}`,
      usernameNormalized: `user${suffix}`,
      passwordHash: '$argon2id$fake',
      occurredAt: now,
    });
    tx.workspaces.insert({
      id: workspaceId,
      name: `Workspace ${suffix}`,
      slug: `workspace-${suffix}`,
      createdByUserId: userId,
      occurredAt: now,
    });
    tx.workspaces.insertMembership({
      id: asWorkspaceMembershipId(`membership-${suffix}`),
      workspaceId,
      userId,
      role: 'owner',
      occurredAt: now,
    });
    tx.audit.append({
      id: asAuditEventId(`audit-${suffix}`),
      occurredAt: now,
      actorKind: 'system',
      workspaceId,
      action: 'workspace.created',
      outcome: 'succeeded',
    });
    tx.workspaceEvents.appendWorkspaceCreated({
      id: asEventId(`event-${suffix}`),
      occurredAt: now,
      workspaceId,
      actorUserId: userId,
      name: `Workspace ${suffix}`,
      slug: `workspace-${suffix}`,
    });
  });
  return { userId, workspaceId };
}

/** Retired repository-registry ids: the journal still maps their kinds (R-B8). */
const REPOSITORY_ID = asRepositoryId('repository-journal');
const INSPECTION_ID = asRepositoryInspectionId('inspection-journal');

function rawDatabase(temporary: TemporaryStorage): Database.Database {
  const database = new Database(temporary.databasePath);
  configureDatabase(database);
  return database;
}

describe('repositories', () => {
  it('supports multiple users and workspaces without singleton assumptions', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const first = seed(temporary, '1');
    const second = seed(temporary, '2');
    expect(temporary.storage.workspaces.listAuthorized(first.userId)).toHaveLength(1);
    expect(temporary.storage.workspaces.listAuthorized(second.userId)).toHaveLength(1);
    expect(
      temporary.storage.workspaces.findAuthorized(first.userId, second.workspaceId),
    ).toBeUndefined();
  });

  it('B1-STO-006 sequences events globally and filters foreign-workspace delivery', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const first = seed(temporary, '1');
    const second = seed(temporary, '2');
    expect(
      temporary.storage.workspaceEvents.listAfter({
        workspaceId: first.workspaceId,
        after: 0,
        limit: 10,
      }),
    ).toMatchObject([{ sequence: 1, workspaceId: first.workspaceId }]);
    expect(
      temporary.storage.workspaceEvents.listAfter({
        workspaceId: second.workspaceId,
        after: 0,
        limit: 10,
      }),
    ).toMatchObject([{ sequence: 2, workspaceId: second.workspaceId }]);
  });

  it('B1-STO-007 and A2B-JRN-012 enforce append-only event rows at the database layer', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    seed(temporary);
    temporary.storage.close();
    const database = new Database(temporary.databasePath);
    configureDatabase(database);
    expect(() => database.prepare(`UPDATE audit_events SET outcome = 'failed'`).run()).toThrow(
      /append-only/,
    );
    expect(() => database.prepare(`DELETE FROM audit_events`).run()).toThrow(/append-only/);
    expect(() => database.prepare(`UPDATE workspace_events SET kind = kind`).run()).toThrow(
      /append-only/,
    );
    expect(() => database.prepare(`DELETE FROM workspace_events`).run()).toThrow(/append-only/);
    database.close();
  });

  it('B1-STO-003 returns exact recent activity at the requested cursor', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const graph = seed(temporary, 'recent');
    const renamed = temporary.storage.workspaceEvents.appendWorkspaceCreated({
      id: asEventId('recent-at-cursor'),
      occurredAt: '2026-07-29T00:00:01.000Z',
      workspaceId: graph.workspaceId,
      name: 'At cursor',
      slug: 'at-cursor',
    });
    temporary.storage.workspaceEvents.appendWorkspaceCreated({
      id: asEventId('recent-after-cursor'),
      occurredAt: '2026-07-29T00:00:02.000Z',
      workspaceId: graph.workspaceId,
      name: 'After cursor',
      slug: 'after-cursor',
    });

    expect(
      temporary.storage.workspaceEvents
        .listRecentAtOrBefore({
          workspaceId: graph.workspaceId,
          asOfSequence: renamed.sequence,
          limit: 20,
        })
        .map((event) => [event.sequence, event.id]),
    ).toEqual([
      [1, 'event-recent'],
      [2, 'recent-at-cursor'],
    ]);
  });

  it('B1-STO-004 and B1-STO-009 fail closed on an unknown runtime kind for every read query', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const graph = seed(temporary, 'unknown');
    const database = rawDatabase(temporary);
    database.exec(`
      INSERT INTO workspace_event_kinds (kind, introduced_in_schema)
      VALUES ('future-runtime-kind', 5);
      INSERT INTO workspace_events (
        id, schema_version, occurred_at, workspace_id, kind, payload_json)
      VALUES (
        'future-runtime-event', 1, '${'2026-07-29T00:00:01.000Z'}',
        '${graph.workspaceId}', 'future-runtime-kind', '{}');
    `);
    database.close();

    for (const read of [
      () =>
        temporary.storage.workspaceEvents.listAfter({
          workspaceId: graph.workspaceId,
          after: 0,
          limit: 20,
        }),
      () =>
        temporary.storage.workspaceEvents.listRecentAtOrBefore({
          workspaceId: graph.workspaceId,
          asOfSequence: 100,
          limit: 20,
        }),
    ]) {
      expect(read).toThrow(
        expect.objectContaining<Partial<WorkspaceEventMappingError>>({
          failure: 'unknown-kind',
        }),
      );
    }
  });

  it('B1-STO-009 rejects direct-SQL payload disagreement and retirement mismatch on read', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const graph = seed(temporary, 'poison');
    const database = rawDatabase(temporary);
    // The registry rows these correlations named are gone; only the journal mapping remains.
    database.pragma('foreign_keys = OFF');
    database
      .prepare(
        `INSERT INTO workspace_events (
           id, schema_version, occurred_at, workspace_id, repository_id,
           repository_inspection_id, kind, payload_json)
         VALUES (?, 1, ?, ?, ?, ?, 'repository-registered', ?)`,
      )
      .run(
        'payload-mismatch',
        '2026-07-29T00:00:01.000Z',
        graph.workspaceId,
        REPOSITORY_ID,
        INSPECTION_ID,
        JSON.stringify({
          repositoryId: asRepositoryId('repository-different'),
          inspectionId: INSPECTION_ID,
        }),
      );
    database.close();
    expect(() =>
      temporary.storage.workspaceEvents.listAfter({
        workspaceId: graph.workspaceId,
        after: 1,
        limit: 20,
      }),
    ).toThrow(
      expect.objectContaining<Partial<WorkspaceEventMappingError>>({
        failure: 'payload-correlation-mismatch',
      }),
    );

    const retirementTemporary = temporaryStorage();
    temporaries.push(retirementTemporary);
    const retirementGraph = seed(retirementTemporary, 'retirement-poison');
    const retirementDatabase = rawDatabase(retirementTemporary);
    retirementDatabase.pragma('foreign_keys = OFF');
    retirementDatabase
      .prepare(
        `INSERT INTO workspace_events (
           id, schema_version, occurred_at, workspace_id, repository_id, kind, payload_json)
         VALUES (?, 1, ?, ?, ?, 'repository-status-changed', ?)`,
      )
      .run(
        'retirement-mismatch',
        '2026-07-29T00:00:01.000Z',
        retirementGraph.workspaceId,
        REPOSITORY_ID,
        JSON.stringify({
          repositoryId: REPOSITORY_ID,
          displayName: 'Retirement poison',
          fromStatus: 'unavailable',
          toStatus: 'active',
          statusReason: 'evidence-matches',
          priorVersion: 1,
          resultingVersion: 2,
        }),
      );
    retirementDatabase.close();
    expect(() =>
      retirementTemporary.storage.workspaceEvents.listRecentAtOrBefore({
        workspaceId: retirementGraph.workspaceId,
        asOfSequence: 100,
        limit: 20,
      }),
    ).toThrow(
      expect.objectContaining<Partial<WorkspaceEventMappingError>>({
        failure: 'invalid-retirement-correlation',
      }),
    );
  });

  it('B1-STO-011 rejects append disagreement before row or sequence mutation', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const graph = seed(temporary, 'append-mismatch');
    const beforeCount = temporary.storage.workspaceEvents.count();
    const beforeSequence = temporary.storage.workspaceEvents.maxSequence();
    expect(() =>
      temporary.storage.workspaceEvents.appendEvent({
        id: asEventId('append-mismatch'),
        occurredAt: '2026-07-29T00:00:01.000Z',
        workspaceId: graph.workspaceId,
        repositoryId: REPOSITORY_ID,
        repositoryInspectionId: INSPECTION_ID,
        kind: 'repository-registered',
        payload: {
          repositoryId: asRepositoryId('repository-other'),
          inspectionId: INSPECTION_ID,
          displayName: 'Mismatch',
          status: 'active',
          statusReason: 'registration-accepted',
          version: 1,
        },
      }),
    ).toThrow(
      expect.objectContaining<Partial<WorkspaceEventAppendError>>({
        failure: 'payload-correlation-mismatch',
      }),
    );
    expect(temporary.storage.workspaceEvents.count()).toBe(beforeCount);
    expect(temporary.storage.workspaceEvents.maxSequence()).toBe(beforeSequence);
  });
});
