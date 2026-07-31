import {
  asAuditEventId,
  asEventId,
  asProjectId,
  asProjectRepositoryBindingId,
  asRepositoryId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
} from '@craftingtable/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDatabase } from './database.js';
import { repositoryRegistrationInspection } from './repository-test-support.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';
import type {
  AppendWorkspaceEventInput,
  WorkspaceEventAppendError,
  WorkspaceEventMappingError,
} from './types.js';

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

function seedRepositoryGraph(temporary: TemporaryStorage, suffix: string) {
  const seeded = seed(temporary, suffix);
  const projectId = asProjectId(`project-${suffix}`);
  const bindingId = asProjectRepositoryBindingId(`binding-${suffix}`);
  const inspection = repositoryRegistrationInspection({
    suffix,
    workspaceId: seeded.workspaceId,
    actorUserId: seeded.userId,
    createdAt: '2026-07-29T00:00:00.000Z',
  });
  temporary.storage.planning.projects.insert({
    id: projectId,
    workspaceId: seeded.workspaceId,
    name: `Project ${suffix}`,
    slug: `project-${suffix}`,
    createdAt: '2026-07-29T00:00:00.000Z',
    createdByUserId: seeded.userId,
  });
  const repository = temporary.storage.repositoryRegistry.repositories.register({
    id: inspection.repositoryId,
    workspaceId: seeded.workspaceId,
    displayName: `Repository ${suffix}`,
    actorUserId: seeded.userId,
    inspection,
  });
  if (repository.kind !== 'created') throw new Error(repository.kind);
  const binding = temporary.storage.repositoryRegistry.bindings.insert({
    id: bindingId,
    workspaceId: seeded.workspaceId,
    projectId,
    repositoryId: repository.repository.id,
    expectedRepositoryVersion: 1,
    actorUserId: seeded.userId,
    boundAt: '2026-07-29T00:00:00.000Z',
  });
  if (binding.kind !== 'created') throw new Error(binding.kind);
  return {
    ...seeded,
    projectId,
    repositoryId: repository.repository.id,
    inspectionId: inspection.id,
    bindingId,
  };
}

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

  it('B1-STO-001/B1-STO-005 round-trips explicit base correlations and payloads for every new kind', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const graph = seedRepositoryGraph(temporary, 'round-trip');
    const common = {
      occurredAt: '2026-07-29T00:00:01.000Z',
      workspaceId: graph.workspaceId,
      actorUserId: graph.userId,
    };
    const inputs = [
      {
        ...common,
        id: asEventId('event-repository-registered'),
        kind: 'repository-registered',
        repositoryId: graph.repositoryId,
        repositoryInspectionId: graph.inspectionId,
        payload: {
          repositoryId: graph.repositoryId,
          inspectionId: graph.inspectionId,
          displayName: 'Repository round-trip',
          status: 'active',
          statusReason: 'registration-accepted',
          version: 1,
        },
      },
      {
        ...common,
        id: asEventId('event-repository-status'),
        kind: 'repository-status-changed',
        repositoryId: graph.repositoryId,
        repositoryInspectionId: graph.inspectionId,
        payload: {
          repositoryId: graph.repositoryId,
          inspectionId: graph.inspectionId,
          displayName: 'Repository round-trip',
          fromStatus: 'unavailable',
          toStatus: 'active',
          statusReason: 'evidence-matches',
          priorVersion: 1,
          resultingVersion: 2,
        },
      },
      {
        ...common,
        id: asEventId('event-repository-evidence'),
        kind: 'repository-evidence-changed',
        repositoryId: graph.repositoryId,
        repositoryInspectionId: graph.inspectionId,
        payload: {
          repositoryId: graph.repositoryId,
          inspectionId: graph.inspectionId,
          displayName: 'Repository round-trip',
          evidenceClass: 'risk-scan',
          repositoryVersion: 2,
        },
      },
      {
        ...common,
        id: asEventId('event-repository-bound'),
        kind: 'project-repository-bound',
        projectId: graph.projectId,
        repositoryId: graph.repositoryId,
        repositoryBindingId: graph.bindingId,
        payload: {
          projectId: graph.projectId,
          repositoryId: graph.repositoryId,
          bindingId: graph.bindingId,
          repositoryDisplayName: 'Repository round-trip',
          bindingVersion: 1,
        },
      },
      {
        ...common,
        id: asEventId('event-repository-binding-retired'),
        kind: 'project-repository-binding-retired',
        projectId: graph.projectId,
        repositoryId: graph.repositoryId,
        repositoryBindingId: graph.bindingId,
        payload: {
          projectId: graph.projectId,
          repositoryId: graph.repositoryId,
          bindingId: graph.bindingId,
          repositoryDisplayName: 'Repository round-trip',
          priorVersion: 1,
          resultingVersion: 2,
        },
      },
    ] as const satisfies readonly AppendWorkspaceEventInput[];

    const appended = inputs.map((input) => temporary.storage.workspaceEvents.appendEvent(input));
    const queried = temporary.storage.workspaceEvents.listAfter({
      workspaceId: graph.workspaceId,
      after: 1,
      limit: 20,
    });
    expect(queried).toEqual(appended);
    expect(
      queried.map((event) => ({
        kind: event.kind,
        projectId: event.projectId,
        repositoryId: event.repositoryId,
        repositoryInspectionId: event.repositoryInspectionId,
        repositoryBindingId: event.repositoryBindingId,
        payload: event.payload,
      })),
    ).toEqual(
      inputs.map((input) => ({
        kind: input.kind,
        projectId: 'projectId' in input ? input.projectId : undefined,
        repositoryId: input.repositoryId,
        repositoryInspectionId:
          'repositoryInspectionId' in input ? input.repositoryInspectionId : undefined,
        repositoryBindingId: 'repositoryBindingId' in input ? input.repositoryBindingId : undefined,
        payload: input.payload,
      })),
    );
  });

  it('B1-STO-002 sequences mixed legacy and repository kinds globally', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const first = seedRepositoryGraph(temporary, 'mixed-first');
    const second = seedRepositoryGraph(temporary, 'mixed-second');
    const appended = temporary.storage.workspaceEvents.appendEvent({
      id: asEventId('mixed-repository-event'),
      occurredAt: '2026-07-29T00:00:01.000Z',
      workspaceId: first.workspaceId,
      repositoryId: first.repositoryId,
      repositoryInspectionId: first.inspectionId,
      kind: 'repository-registered',
      payload: {
        repositoryId: first.repositoryId,
        inspectionId: first.inspectionId,
        displayName: 'Mixed first',
        status: 'active',
        statusReason: 'registration-accepted',
        version: 1,
      },
    });
    expect(appended.sequence).toBe(3);
    expect(
      temporary.storage.workspaceEvents
        .listAfter({ workspaceId: first.workspaceId, after: 0, limit: 10 })
        .map((event) => event.sequence),
    ).toEqual([1, 3]);
    expect(
      temporary.storage.workspaceEvents
        .listAfter({ workspaceId: second.workspaceId, after: 0, limit: 10 })
        .map((event) => event.sequence),
    ).toEqual([2]);
  });

  it('B1-STO-003 returns exact mixed recent activity at the requested cursor', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const graph = seedRepositoryGraph(temporary, 'recent');
    const registered = temporary.storage.workspaceEvents.appendEvent({
      id: asEventId('recent-repository-event'),
      occurredAt: '2026-07-29T00:00:01.000Z',
      workspaceId: graph.workspaceId,
      repositoryId: graph.repositoryId,
      repositoryInspectionId: graph.inspectionId,
      kind: 'repository-registered',
      payload: {
        repositoryId: graph.repositoryId,
        inspectionId: graph.inspectionId,
        displayName: 'Recent',
        status: 'active',
        statusReason: 'registration-accepted',
        version: 1,
      },
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
          asOfSequence: registered.sequence,
          limit: 20,
        })
        .map((event) => [event.sequence, event.kind]),
    ).toEqual([
      [1, 'workspace-created'],
      [2, 'repository-registered'],
    ]);
  });

  it('B1-STO-004 and B1-STO-009 fail closed on an unknown runtime kind for every read query', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const graph = seedRepositoryGraph(temporary, 'unknown');
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
    const graph = seedRepositoryGraph(temporary, 'poison');
    const database = rawDatabase(temporary);
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
        graph.repositoryId,
        graph.inspectionId,
        JSON.stringify({
          repositoryId: asRepositoryId('repository-different'),
          inspectionId: graph.inspectionId,
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
    const retirementGraph = seedRepositoryGraph(retirementTemporary, 'retirement-poison');
    const retirementDatabase = rawDatabase(retirementTemporary);
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
        retirementGraph.repositoryId,
        JSON.stringify({
          repositoryId: retirementGraph.repositoryId,
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
    const graph = seedRepositoryGraph(temporary, 'append-mismatch');
    const beforeCount = temporary.storage.workspaceEvents.count();
    const beforeSequence = temporary.storage.workspaceEvents.maxSequence();
    expect(() =>
      temporary.storage.workspaceEvents.appendEvent({
        id: asEventId('append-mismatch'),
        occurredAt: '2026-07-29T00:00:01.000Z',
        workspaceId: graph.workspaceId,
        repositoryId: graph.repositoryId,
        repositoryInspectionId: graph.inspectionId,
        kind: 'repository-registered',
        payload: {
          repositoryId: asRepositoryId('repository-other'),
          inspectionId: graph.inspectionId,
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
