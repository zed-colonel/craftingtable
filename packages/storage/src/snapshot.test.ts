import { randomUUID } from 'node:crypto';
import { asEventId, asUserId, asWorkspaceId, asWorkspaceMembershipId } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { temporaryStorage } from './test-support.js';
import { openCraftingTableStorage } from './storage.js';

describe('snapshot consistency', () => {
  it('keeps asOfSequence and activity in one read view during a concurrent WAL commit', () => {
    const first = temporaryStorage();
    const second = openCraftingTableStorage(first.storage.databasePath);
    try {
      const userId = asUserId(randomUUID());
      const workspaceId = asWorkspaceId(randomUUID());
      const occurredAt = '2026-07-24T00:00:00.000Z';
      first.storage.transaction((tx) => {
        tx.users.insert({
          id: userId,
          username: 'snapshot-user',
          usernameNormalized: 'snapshot-user',
          passwordHash: '$argon2id$test',
          occurredAt,
        });
        tx.workspaces.insert({
          id: workspaceId,
          name: 'Snapshot workspace',
          slug: 'snapshot',
          createdByUserId: userId,
          occurredAt,
        });
        tx.workspaces.insertMembership({
          id: asWorkspaceMembershipId(randomUUID()),
          workspaceId,
          userId,
          role: 'owner',
          occurredAt,
        });
        tx.workspaceEvents.appendWorkspaceCreated({
          id: asEventId(randomUUID()),
          occurredAt,
          workspaceId,
          actorUserId: userId,
          name: 'Snapshot workspace',
          slug: 'snapshot',
        });
      });

      const snapshot = first.storage.readTransaction((tx) => {
        expect(tx.workspaces.findAuthorized(userId, workspaceId)).toBeDefined();
        second.transaction((writer) => {
          writer.workspaceEvents.appendWorkspaceCreated({
            id: asEventId(randomUUID()),
            occurredAt: '2026-07-24T00:00:01.000Z',
            workspaceId,
            actorUserId: userId,
            name: 'Concurrent event',
            slug: 'concurrent',
          });
        });
        const asOfSequence = tx.workspaceEvents.maxSequence();
        return {
          asOfSequence,
          events: tx.workspaceEvents.listRecentAtOrBefore({
            workspaceId,
            asOfSequence,
            limit: 50,
          }),
        };
      });

      expect(snapshot.asOfSequence).toBe(1);
      expect(snapshot.events.map((event) => event.sequence)).toEqual([1]);
      expect(second.workspaceEvents.maxSequence()).toBe(2);
    } finally {
      second.close();
      first.cleanup();
    }
  });
});
