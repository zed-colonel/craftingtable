import {
  asAuditEventId,
  asEventId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';

const temporaries: TemporaryStorage[] = [];
afterEach(() => {
  for (const temporary of temporaries.splice(0)) {
    temporary.cleanup();
  }
});

describe('storage transaction boundary', () => {
  it('rolls state, audit, and events back together on failure', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const now = new Date().toISOString();
    expect(() =>
      temporary.storage.transaction((tx) => {
        const userId = asUserId('user-rollback');
        const workspaceId = asWorkspaceId('workspace-rollback');
        tx.users.insert({
          id: userId,
          username: 'rollback',
          usernameNormalized: 'rollback',
          passwordHash: '$argon2id$fake',
          occurredAt: now,
        });
        tx.workspaces.insert({
          id: workspaceId,
          name: 'Rollback',
          slug: 'rollback',
          createdByUserId: userId,
          occurredAt: now,
        });
        tx.workspaces.insertMembership({
          id: asWorkspaceMembershipId('membership-rollback'),
          workspaceId,
          userId,
          role: 'owner',
          occurredAt: now,
        });
        tx.audit.append({
          id: asAuditEventId('audit-rollback'),
          occurredAt: now,
          actorKind: 'system',
          workspaceId,
          action: 'workspace.created',
          outcome: 'succeeded',
        });
        tx.workspaceEvents.appendWorkspaceCreated({
          id: asEventId('event-rollback'),
          occurredAt: now,
          workspaceId,
          actorUserId: userId,
          name: 'Rollback',
          slug: 'rollback',
        });
        throw new Error('injected failure');
      }),
    ).toThrow(/injected failure/);

    expect(temporary.storage.users.count()).toBe(0);
    expect(temporary.storage.audit.count()).toBe(0);
    expect(temporary.storage.workspaceEvents.count()).toBe(0);
  });
});
