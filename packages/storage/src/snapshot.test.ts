import { randomUUID } from 'node:crypto';
import {
  asEventId,
  asRepositoryId,
  asRepositoryInspectionId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { temporaryStorage } from './test-support.js';
import { openCraftingTableStorage } from './storage.js';
import { repositoryRegistrationInspection } from './repository-test-support.js';

describe('snapshot consistency', () => {
  it('B1-REGRESS-002 keeps a mixed legacy/repository activity cursor in one snapshot', () => {
    const temporary = temporaryStorage();
    try {
      const userId = asUserId('mixed-snapshot-user');
      const workspaceId = asWorkspaceId('mixed-snapshot-workspace');
      const repositoryId = asRepositoryId('repository-mixed-snapshot');
      const occurredAt = '2026-07-29T00:00:00.000Z';
      temporary.storage.transaction((tx) => {
        tx.users.insert({
          id: userId,
          username: 'mixed-snapshot',
          usernameNormalized: 'mixed-snapshot',
          passwordHash: '$argon2id$test',
          occurredAt,
        });
        tx.workspaces.insert({
          id: workspaceId,
          name: 'Mixed snapshot workspace',
          slug: 'mixed-snapshot',
          createdByUserId: userId,
          occurredAt,
        });
        tx.workspaces.insertMembership({
          id: asWorkspaceMembershipId('mixed-snapshot-membership'),
          workspaceId,
          userId,
          role: 'owner',
          occurredAt,
        });
        tx.workspaceEvents.appendWorkspaceCreated({
          id: asEventId('mixed-snapshot-created'),
          occurredAt,
          workspaceId,
          actorUserId: userId,
          name: 'Mixed snapshot workspace',
          slug: 'mixed-snapshot',
        });
      });
      const registration = repositoryRegistrationInspection({
        suffix: 'mixed-snapshot',
        workspaceId,
        actorUserId: userId,
        createdAt: occurredAt,
      });
      temporary.storage.repositoryRegistry.repositories.register({
        id: repositoryId,
        workspaceId,
        displayName: 'Mixed snapshot repository',
        actorUserId: userId,
        inspection: { ...registration, repositoryId },
      });
      temporary.storage.workspaceEvents.appendEvent({
        id: asEventId('mixed-snapshot-repository-registered'),
        occurredAt: '2026-07-29T00:00:01.000Z',
        workspaceId,
        actorUserId: userId,
        repositoryId,
        repositoryInspectionId: registration.id,
        kind: 'repository-registered',
        payload: {
          repositoryId,
          inspectionId: registration.id,
          displayName: 'Mixed snapshot repository',
          status: 'active',
          statusReason: 'registration-accepted',
          version: 1,
        },
      });

      const snapshot = temporary.storage.readTransaction((tx) => {
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

      expect(snapshot.asOfSequence).toBe(2);
      expect(snapshot.events.map(({ sequence, kind }) => ({ sequence, kind }))).toEqual([
        { sequence: 1, kind: 'workspace-created' },
        { sequence: 2, kind: 'repository-registered' },
      ]);
    } finally {
      temporary.cleanup();
    }
  });

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

  it('keeps repository evidence and latest sequence in one read view during a WAL commit (A2A-MIG-007)', () => {
    const first = temporaryStorage();
    try {
      const userId = asUserId('repository-snapshot-user');
      const workspaceId = asWorkspaceId('repository-snapshot-workspace');
      const repositoryId = asRepositoryId('repository-snapshot');
      const occurredAt = '2026-07-24T00:00:00.000Z';
      first.storage.transaction((tx) => {
        tx.users.insert({
          id: userId,
          username: 'repository-snapshot',
          usernameNormalized: 'repository-snapshot',
          passwordHash: '$argon2id$test',
          occurredAt,
        });
        tx.workspaces.insert({
          id: workspaceId,
          name: 'Repository snapshot workspace',
          slug: 'repository-snapshot',
          createdByUserId: userId,
          occurredAt,
        });
        tx.workspaces.insertMembership({
          id: asWorkspaceMembershipId('repository-snapshot-membership'),
          workspaceId,
          userId,
          role: 'owner',
          occurredAt,
        });
      });
      const registration = repositoryRegistrationInspection({
        suffix: 'snapshot',
        workspaceId,
        actorUserId: userId,
        createdAt: occurredAt,
      });
      first.storage.repositoryRegistry.repositories.register({
        id: repositoryId,
        workspaceId,
        displayName: 'Snapshot repository',
        actorUserId: userId,
        inspection: { ...registration, repositoryId },
      });
      const second = openCraftingTableStorage(first.storage.databasePath);
      try {
        const snapshot = first.storage.readTransaction((reader) => {
          const before = reader.repositoryRegistry.queries.repositorySummary(
            workspaceId,
            repositoryId,
          );
          second.transaction((writer) => {
            writer.repositoryRegistry.inspections.appendVerification({
              workspaceId,
              repositoryId,
              expectedVersion: 1,
              inspection: {
                ...registration,
                id: asRepositoryInspectionId('repository-snapshot-verification'),
                repositoryId,
                kind: 'verification',
                coreDifferences: [],
                environmentalDifferences: [],
                riskDifferences: [],
              },
            });
          });
          const after = reader.repositoryRegistry.queries.repositorySummary(
            workspaceId,
            repositoryId,
          );
          return { before, after };
        });
        expect(snapshot.before?.latestInspection.sequence).toBe(1);
        expect(snapshot.after?.latestInspection.sequence).toBe(1);
        expect(
          second.repositoryRegistry.inspections.latestForRepository(workspaceId, repositoryId)
            .sequence,
        ).toBe(2);
      } finally {
        second.close();
      }
    } finally {
      first.cleanup();
    }
  });
});
