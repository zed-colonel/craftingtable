import { randomUUID } from 'node:crypto';
import {
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asUserId,
  asWorkItemDependencyId,
  asWorkItemId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from './types.js';

/**
 * Shared seeding for the planning storage tests: a user, a workspace, and a
 * committed plan version whose graph is `root -> middle -> leaf`.
 */

export const SEED_NOW = '2026-07-24T00:00:00.000Z';

export interface SeededWorkspace {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

export function seedWorkspace(storage: CraftingTableStorage, suffix = 'a'): SeededWorkspace {
  const userId = asUserId(`user-${suffix}`);
  const workspaceId = asWorkspaceId(`workspace-${suffix}`);
  storage.transaction((tx) => {
    if (tx.users.findById(userId) === undefined) {
      tx.users.insert({
        id: userId,
        username: `user-${suffix}`,
        usernameNormalized: `user-${suffix}`,
        passwordHash: '$argon2id$seed',
        occurredAt: SEED_NOW,
      });
    }
    tx.workspaces.insert({
      id: workspaceId,
      name: `Workspace ${suffix}`,
      slug: `workspace-${suffix}`,
      createdByUserId: userId,
      occurredAt: SEED_NOW,
    });
    tx.workspaces.insertMembership({
      id: asWorkspaceMembershipId(`membership-${suffix}`),
      workspaceId,
      userId,
      role: 'owner',
      occurredAt: SEED_NOW,
    });
  });
  return { userId, workspaceId };
}

export interface SeededPlan extends SeededWorkspace {
  readonly projectId: ProjectId;
  readonly planVersionId: ReturnType<typeof asPlanVersionId>;
  readonly bundleId: ReturnType<typeof asPlanBundleId>;
  readonly rootWorkItemId: ReturnType<typeof asWorkItemId>;
  readonly middleWorkItemId: ReturnType<typeof asWorkItemId>;
  readonly leafWorkItemId: ReturnType<typeof asWorkItemId>;
}

export function seedPlan(
  storage: CraftingTableStorage,
  seed: SeededWorkspace,
  options: { readonly digest?: string; readonly suffix?: string } = {},
): SeededPlan {
  const suffix = options.suffix ?? 'a';
  const projectId = asProjectId(`project-${suffix}`);
  const bundleId = asPlanBundleId(`bundle-${suffix}`);
  const planVersionId = asPlanVersionId(`version-${suffix}`);
  const rootWorkItemId = asWorkItemId(`item-root-${suffix}`);
  const middleWorkItemId = asWorkItemId(`item-middle-${suffix}`);
  const leafWorkItemId = asWorkItemId(`item-leaf-${suffix}`);

  storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: projectId,
      workspaceId: seed.workspaceId,
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      createdAt: SEED_NOW,
      createdByUserId: seed.userId,
    });
    tx.planning.bundles.insert({
      id: bundleId,
      workspaceId: seed.workspaceId,
      projectId,
      logicalName: `project-${suffix}`,
      createdAt: SEED_NOW,
    });
    tx.planning.versions.insert({
      id: planVersionId,
      workspaceId: seed.workspaceId,
      projectId,
      bundleId,
      versionNumber: 1,
      contentDigest: options.digest ?? 'd'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: `Plan ${suffix}`,
      normalizedSource: { document: `Plan ${suffix}` },
      itemCount: 3,
      requiredDependencyCount: 2,
      createdAt: SEED_NOW,
      createdByUserId: seed.userId,
    });
    tx.planning.workItems.insertMany([
      {
        id: rootWorkItemId,
        workspaceId: seed.workspaceId,
        projectId,
        planVersionId,
        sourceId: 'WI-01',
        ordinal: 0,
        title: 'Root',
        risk: 'medium',
        primaryAreas: ['core'],
        exitGate: 'Green.',
        sourceFields: { id: 'WI-01' },
      },
      {
        id: middleWorkItemId,
        workspaceId: seed.workspaceId,
        projectId,
        planVersionId,
        sourceId: 'WI-02',
        ordinal: 1,
        title: 'Middle',
        risk: 'high',
        primaryAreas: ['core'],
        exitGate: 'Green.',
        sourceFields: { id: 'WI-02' },
      },
      {
        id: leafWorkItemId,
        workspaceId: seed.workspaceId,
        projectId,
        planVersionId,
        sourceId: 'WI-03',
        ordinal: 2,
        title: 'Leaf',
        risk: 'critical',
        primaryAreas: ['core'],
        exitGate: 'Green.',
        sourceFields: { id: 'WI-03' },
      },
    ]);
    tx.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId(`dep-1-${suffix}`),
        workspaceId: seed.workspaceId,
        planVersionId,
        predecessorWorkItemId: rootWorkItemId,
        successorWorkItemId: middleWorkItemId,
        kind: 'required',
        ordinal: 0,
      },
      {
        id: asWorkItemDependencyId(`dep-2-${suffix}`),
        workspaceId: seed.workspaceId,
        planVersionId,
        predecessorWorkItemId: middleWorkItemId,
        successorWorkItemId: leafWorkItemId,
        kind: 'required',
        ordinal: 0,
      },
    ]);
    tx.planning.projects.setActivePlanVersionIfUnset({
      projectId,
      workspaceId: seed.workspaceId,
      planVersionId,
    });
  });

  return {
    ...seed,
    projectId,
    bundleId,
    planVersionId,
    rootWorkItemId,
    middleWorkItemId,
    leafWorkItemId,
  };
}

export function uniqueDigest(): string {
  return randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64);
}
