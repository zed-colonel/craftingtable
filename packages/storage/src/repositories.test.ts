import {
  asAuditEventId,
  asEventId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
} from '@craftingtable/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDatabase } from './database.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';

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

  it('sequences events globally and filters workspace delivery', () => {
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

  it('enforces append-only audit and event rows at the database layer', () => {
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
});
