import {
  asPlanArtifactId,
  asPlanImportAttemptId,
  asPlanVersionId,
  asProjectId,
  asWorkContractDraftId,
  asWorkItemId,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { seedPlan, seedWorkspace, SEED_NOW, uniqueDigest } from './planning-test-support.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';

/** CT03-A26, A29 to A32, A34, A35, A39, A51, A52, A53, A54 at the storage layer. */

const temporaries: TemporaryStorage[] = [];
afterEach(() => {
  for (const temporary of temporaries.splice(0)) {
    temporary.cleanup();
  }
});

function storage() {
  const temporary = temporaryStorage();
  temporaries.push(temporary);
  return temporary.storage;
}

describe('planning repositories', () => {
  it('derives blockers and predecessor counts in one query (CT03-A51)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);

    const items = store.planning.workItems.listForVersion(seed.workspaceId, plan.planVersionId);
    expect(
      items.map((item) => [
        item.sourceId,
        item.blockerSourceIds,
        item.requiredPredecessorCount,
        item.recommendedPredecessorCount,
      ]),
    ).toEqual([
      ['WI-01', [], 0, 0],
      ['WI-02', ['WI-01'], 1, 0],
      ['WI-03', ['WI-02'], 1, 0],
    ]);
  });

  it('counts planning-ready, blocked, and risk exactly (CT03-A52)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);

    expect(
      store.planning.queries.versionStatusCounts(seed.workspaceId, plan.planVersionId),
    ).toEqual({
      proposedCount: 3,
      admittedCount: 0,
      planningReadyCount: 1,
      dependencyBlockedCount: 2,
      riskCounts: { low: 0, medium: 1, high: 1, critical: 1, unspecified: 0 },
    });

    const summary = store.planning.queries.workspaceSummary(seed.workspaceId);
    expect(summary.projectCount).toBe(1);
    expect(summary.planningReadyCount).toBe(1);
    expect(summary.dependencyBlockedCount).toBe(2);
    expect(summary.importAttentionCount).toBe(0);
  });

  it('keeps admission out of the planning-ready count and into active', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);

    store.transaction((tx) =>
      tx.planning.workItems.admit({
        workItemId: plan.rootWorkItemId,
        workspaceId: seed.workspaceId,
        admittedAt: SEED_NOW,
        admittedByUserId: seed.userId,
      }),
    );

    const counts = store.planning.queries.versionStatusCounts(seed.workspaceId, plan.planVersionId);
    expect(counts.admittedCount).toBe(1);
    expect(counts.proposedCount).toBe(2);
    // Admitting the root does not unblock its descendants: admission is not
    // completion (CT03-I10).
    expect(counts.dependencyBlockedCount).toBe(2);
    expect(counts.planningReadyCount).toBe(0);
  });

  it('admits exactly once and reports the repeat as a no-op (CT03-A53, CT03-A54)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);

    const first = store.transaction((tx) =>
      tx.planning.workItems.admit({
        workItemId: plan.rootWorkItemId,
        workspaceId: seed.workspaceId,
        admittedAt: SEED_NOW,
        admittedByUserId: seed.userId,
      }),
    );
    expect(first?.status).toBe('admitted');
    expect(first?.admittedByUserId).toBe(seed.userId);
    expect(first?.admittedAt).toBe(SEED_NOW);
    expect(first?.version).toBe(2);

    // The status guard in the UPDATE is the concurrency control: a second
    // admission matches no row, so the caller can detect the repeat.
    const second = store.transaction((tx) =>
      tx.planning.workItems.admit({
        workItemId: plan.rootWorkItemId,
        workspaceId: seed.workspaceId,
        admittedAt: '2026-07-25T00:00:00.000Z',
        admittedByUserId: seed.userId,
      }),
    );
    expect(second).toBeUndefined();
    expect(store.planning.workItems.find(seed.workspaceId, plan.rootWorkItemId)?.admittedAt).toBe(
      SEED_NOW,
    );
  });

  it('sets the active version once and never replaces it (CT03-A26, CT03-A31)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    expect(
      store.planning.projects.find(seed.workspaceId, plan.projectId)?.activePlanVersionId,
    ).toBe(plan.planVersionId);

    const secondVersionId = asPlanVersionId('version-second');
    store.transaction((tx) => {
      tx.planning.versions.insert({
        id: secondVersionId,
        workspaceId: seed.workspaceId,
        projectId: plan.projectId,
        bundleId: plan.bundleId,
        versionNumber: tx.planning.versions.nextVersionNumber(plan.bundleId),
        contentDigest: uniqueDigest(),
        digestAlgorithm: 'sha-256',
        digestFormatVersion: 1,
        sourceProfile: 'exo-work-breakdown-v1',
        document: 'Changed plan',
        normalizedSource: {},
        itemCount: 0,
        requiredDependencyCount: 0,
        createdAt: SEED_NOW,
        createdByUserId: seed.userId,
      });
      tx.planning.projects.setActivePlanVersionIfUnset({
        projectId: plan.projectId,
        workspaceId: seed.workspaceId,
        planVersionId: secondVersionId,
      });
    });

    expect(
      store.planning.projects.find(seed.workspaceId, plan.projectId)?.activePlanVersionId,
    ).toBe(plan.planVersionId);
    expect(store.planning.versions.nextVersionNumber(plan.bundleId)).toBe(3);
  });

  it('keeps older versions and their items queryable after a change (CT03-A32)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const first = seedPlan(store, seed, { suffix: 'a' });
    const second = seedPlan(store, seed, { suffix: 'b', digest: uniqueDigest() });

    expect(
      store.planning.workItems.listForVersion(seed.workspaceId, first.planVersionId),
    ).toHaveLength(3);
    expect(
      store.planning.workItems.listForVersion(seed.workspaceId, second.planVersionId),
    ).toHaveLength(3);
    expect(store.planning.versions.find(seed.workspaceId, first.planVersionId)?.versionNumber).toBe(
      1,
    );
  });

  it('resolves a version by digest only inside its own workspace (CT03-A29, CT03-A35)', () => {
    const store = storage();
    const first = seedWorkspace(store, 'a');
    const second = seedWorkspace(store, 'b');
    const plan = seedPlan(store, first, { suffix: 'a', digest: 'f'.repeat(64) });

    expect(store.planning.versions.findByDigest(first.workspaceId, 'f'.repeat(64))?.id).toBe(
      plan.planVersionId,
    );
    expect(
      store.planning.versions.findByDigest(second.workspaceId, 'f'.repeat(64)),
    ).toBeUndefined();
  });

  it('refuses cross-workspace reads of every planning record (CT03-A35)', () => {
    const store = storage();
    const first = seedWorkspace(store, 'a');
    const second = seedWorkspace(store, 'b');
    const plan = seedPlan(store, first);

    expect(store.planning.projects.find(second.workspaceId, plan.projectId)).toBeUndefined();
    expect(store.planning.versions.find(second.workspaceId, plan.planVersionId)).toBeUndefined();
    expect(store.planning.workItems.find(second.workspaceId, plan.rootWorkItemId)).toBeUndefined();
    expect(store.planning.workItems.listForVersion(second.workspaceId, plan.planVersionId)).toEqual(
      [],
    );
    expect(store.planning.projects.list(second.workspaceId)).toEqual([]);
    expect(store.planning.queries.projectSummaries(second.workspaceId, 50)).toEqual([]);
  });

  it('serves artifact bytes only through a parent-owned lookup (CT03-A39)', () => {
    const store = storage();
    const first = seedWorkspace(store, 'a');
    const second = seedWorkspace(store, 'b');
    const plan = seedPlan(store, first);
    const bytes = new TextEncoder().encode('# Plan\n');

    store.transaction((tx) => {
      const attempt = tx.planning.importAttempts.insert({
        id: asPlanImportAttemptId('attempt-artifact'),
        workspaceId: first.workspaceId,
        actorUserId: first.userId,
        outcome: 'succeeded',
        requestedProjectName: 'Project a',
        bundleDigest: 'd'.repeat(64),
        digestFormatVersion: 1,
        projectId: plan.projectId,
        planVersionId: plan.planVersionId,
        artifactCount: 1,
        totalByteLength: bytes.byteLength,
        errorCount: 0,
        warningCount: 0,
        createdAt: SEED_NOW,
      });
      tx.planning.artifacts.insertMany([
        {
          id: asPlanArtifactId('artifact-1'),
          workspaceId: first.workspaceId,
          importAttemptId: attempt.id,
          planVersionId: plan.planVersionId,
          logicalFilename: 'plan.md',
          role: 'implementation-plan',
          mediaType: 'text/markdown',
          byteLength: bytes.byteLength,
          sha256: 'a'.repeat(64),
          content: bytes,
          createdAt: SEED_NOW,
        },
      ]);
    });

    const found = store.planning.artifacts.findWithContent(
      first.workspaceId,
      asPlanArtifactId('artifact-1'),
    );
    expect(found?.logicalFilename).toBe('plan.md');
    expect(Buffer.from(found?.content ?? new Uint8Array()).toString('utf8')).toBe('# Plan\n');

    // Knowing the artifact id is not authorization: the other workspace sees
    // nothing, so a missing and an unauthorized artifact are indistinguishable.
    expect(
      store.planning.artifacts.findWithContent(second.workspaceId, asPlanArtifactId('artifact-1')),
    ).toBeUndefined();
    expect(store.planning.artifacts.listForVersion(second.workspaceId, plan.planVersionId)).toEqual(
      [],
    );
  });

  it('summarises projects with version and warning counts', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);

    const summaries = store.planning.queries.projectSummaries(seed.workspaceId, 50);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: plan.projectId,
      name: 'Project a',
      slug: 'project-a',
      activePlanVersionId: plan.planVersionId,
      document: 'Plan a',
      versionCount: 1,
      warningCount: 0,
      proposedCount: 3,
      admittedCount: 0,
      planningReadyCount: 1,
      dependencyBlockedCount: 2,
    });

    const versions = store.planning.queries.versionSummaries(seed.workspaceId, plan.projectId);
    expect(versions).toEqual([
      {
        id: plan.planVersionId,
        versionNumber: 1,
        contentDigest: 'd'.repeat(64),
        document: 'Plan a',
        itemCount: 3,
        requiredDependencyCount: 2,
        createdAt: SEED_NOW,
        isActive: true,
      },
    ]);
  });

  it('lists predecessors and successors with their current status', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);

    expect(
      store.planning.dependencies.listPredecessors(seed.workspaceId, plan.middleWorkItemId),
    ).toEqual([
      {
        workItemId: plan.rootWorkItemId,
        sourceId: 'WI-01',
        title: 'Root',
        status: 'proposed',
        risk: 'medium',
        kind: 'required',
      },
    ]);
    expect(
      store.planning.dependencies
        .listSuccessors(seed.workspaceId, plan.rootWorkItemId)
        .map((row) => row.sourceId),
    ).toEqual(['WI-02']);
  });

  it('counts import attention from failures and warnings', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    seedPlan(store, seed);

    store.transaction((tx) =>
      tx.planning.importAttempts.insert({
        id: asPlanImportAttemptId('attempt-failed'),
        workspaceId: seed.workspaceId,
        actorUserId: seed.userId,
        outcome: 'failed-validation',
        requestedProjectName: 'Broken',
        artifactCount: 1,
        totalByteLength: 10,
        errorCount: 3,
        warningCount: 0,
        createdAt: SEED_NOW,
      }),
    );
    expect(store.planning.queries.workspaceSummary(seed.workspaceId).importAttentionCount).toBe(1);
  });

  it('stores and reads back a draft document unchanged', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    const document = {
      schemaVersion: 1,
      status: 'draft',
      completeness: 'incomplete',
      missing: ['registered-repository'],
    };

    store.transaction((tx) => {
      tx.planning.workItems.admit({
        workItemId: plan.rootWorkItemId,
        workspaceId: seed.workspaceId,
        admittedAt: SEED_NOW,
        admittedByUserId: seed.userId,
      });
      tx.planning.drafts.insert({
        id: asWorkContractDraftId('draft-1'),
        workspaceId: seed.workspaceId,
        projectId: plan.projectId,
        planVersionId: plan.planVersionId,
        workItemId: plan.rootWorkItemId,
        document,
        createdAt: SEED_NOW,
        createdByUserId: seed.userId,
      });
    });

    const stored = store.planning.drafts.findForWorkItem(seed.workspaceId, plan.rootWorkItemId);
    expect(stored?.document).toEqual(document);
    expect(stored?.status).toBe('draft');
    expect(stored?.completeness).toBe('incomplete');
  });

  it('returns nothing for an unknown project, version, item, or artifact', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    seedPlan(store, seed);
    expect(store.planning.projects.find(seed.workspaceId, asProjectId('missing'))).toBeUndefined();
    expect(
      store.planning.versions.find(seed.workspaceId, asPlanVersionId('missing')),
    ).toBeUndefined();
    expect(
      store.planning.workItems.find(seed.workspaceId, asWorkItemId('missing')),
    ).toBeUndefined();
    expect(
      store.planning.artifacts.findWithContent(seed.workspaceId, asPlanArtifactId('missing')),
    ).toBeUndefined();
  });
});
