import {
  asAuditEventId,
  asEventId,
  asPlanArtifactId,
  asPlanBundleId,
  asPlanImportAttemptId,
  asPlanImportDiagnosticId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { seedWorkspace, SEED_NOW } from './planning-test-support.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';
import type { CraftingTableStorage } from './types.js';

/**
 * CT03-A25 and CT03-A27.
 *
 * A successful import is one atomic planning transition. This exercises the
 * exact durable write sequence the import service uses, injecting a failure
 * after each stage and asserting that *every* planning table, both journals,
 * and the notifier generation are untouched.
 */

const temporaries: TemporaryStorage[] = [];
afterEach(() => {
  for (const temporary of temporaries.splice(0)) {
    temporary.cleanup();
  }
});

const STAGES = [
  'project',
  'bundle',
  'version',
  'attempt',
  'artifacts',
  'diagnostics',
  'work-items',
  'dependencies',
  'active-version',
  'audit',
  'project-event',
  'version-event',
] as const;

type Stage = (typeof STAGES)[number];

class InjectedFailure extends Error {
  constructor(readonly stage: Stage) {
    super(`injected failure after ${stage}`);
  }
}

function importPlan(
  storage: CraftingTableStorage,
  seed: ReturnType<typeof seedWorkspace>,
  failAfter?: Stage,
): void {
  const stop = (stage: Stage): void => {
    if (failAfter === stage) {
      throw new InjectedFailure(stage);
    }
  };

  storage.transaction((tx) => {
    const project = tx.planning.projects.insert({
      id: asProjectId('project-1'),
      workspaceId: seed.workspaceId,
      name: 'AQ',
      slug: 'aq',
      createdAt: SEED_NOW,
      createdByUserId: seed.userId,
    });
    stop('project');

    const bundle = tx.planning.bundles.insert({
      id: asPlanBundleId('bundle-1'),
      workspaceId: seed.workspaceId,
      projectId: project.id,
      logicalName: 'aq',
      createdAt: SEED_NOW,
    });
    stop('bundle');

    const version = tx.planning.versions.insert({
      id: asPlanVersionId('version-1'),
      workspaceId: seed.workspaceId,
      projectId: project.id,
      bundleId: bundle.id,
      versionNumber: 1,
      contentDigest: 'd'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'AQ Plan',
      normalizedSource: { document: 'AQ Plan' },
      itemCount: 2,
      requiredDependencyCount: 1,
      createdAt: SEED_NOW,
      createdByUserId: seed.userId,
    });
    stop('version');

    const attempt = tx.planning.importAttempts.insert({
      id: asPlanImportAttemptId('attempt-1'),
      workspaceId: seed.workspaceId,
      actorUserId: seed.userId,
      outcome: 'succeeded',
      requestedProjectName: 'AQ',
      bundleDigest: 'd'.repeat(64),
      digestFormatVersion: 1,
      projectId: asProjectId('project-1'),
      planVersionId: asPlanVersionId('version-1'),
      artifactCount: 1,
      totalByteLength: 7,
      errorCount: 0,
      warningCount: 1,
      createdAt: SEED_NOW,
    });
    stop('attempt');

    tx.planning.artifacts.insertMany([
      {
        id: asPlanArtifactId('artifact-1'),
        workspaceId: seed.workspaceId,
        importAttemptId: attempt.id,
        planVersionId: version.id,
        logicalFilename: 'plan.md',
        role: 'implementation-plan',
        mediaType: 'text/markdown',
        byteLength: 7,
        sha256: 'a'.repeat(64),
        content: new TextEncoder().encode('# Plan\n'),
        createdAt: SEED_NOW,
      },
    ]);
    stop('artifacts');

    tx.planning.diagnostics.insertMany([
      {
        id: asPlanImportDiagnosticId('diagnostic-1'),
        workspaceId: seed.workspaceId,
        importAttemptId: attempt.id,
        planVersionId: version.id,
        ordinal: 0,
        severity: 'warning',
        code: 'unrecognized-risk',
        message: 'Risk "apocalyptic" is not recognized',
      },
    ]);
    stop('diagnostics');

    const items = tx.planning.workItems.insertMany([
      {
        id: asWorkItemId('item-1'),
        workspaceId: seed.workspaceId,
        projectId: project.id,
        planVersionId: version.id,
        sourceId: 'AQ-01',
        ordinal: 0,
        title: 'Root',
        risk: 'medium',
        primaryAreas: ['contract'],
        exitGate: 'Green.',
        sourceFields: { id: 'AQ-01' },
      },
      {
        id: asWorkItemId('item-2'),
        workspaceId: seed.workspaceId,
        projectId: project.id,
        planVersionId: version.id,
        sourceId: 'AQ-02',
        ordinal: 1,
        title: 'Successor',
        risk: 'high',
        primaryAreas: ['core'],
        exitGate: 'Green.',
        sourceFields: { id: 'AQ-02' },
      },
    ]);
    stop('work-items');

    tx.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId('dependency-1'),
        workspaceId: seed.workspaceId,
        planVersionId: version.id,
        predecessorWorkItemId: items[0]?.id ?? asWorkItemId('item-1'),
        successorWorkItemId: items[1]?.id ?? asWorkItemId('item-2'),
        kind: 'required',
        ordinal: 0,
      },
    ]);
    stop('dependencies');

    tx.planning.projects.setActivePlanVersionIfUnset({
      projectId: project.id,
      workspaceId: seed.workspaceId,
      planVersionId: version.id,
    });
    stop('active-version');

    tx.audit.append({
      id: asAuditEventId('audit-1'),
      occurredAt: SEED_NOW,
      actorKind: 'user',
      actorUserId: seed.userId,
      workspaceId: seed.workspaceId,
      action: 'plan.import.succeeded',
      targetType: 'plan-version',
      targetId: version.id,
      outcome: 'succeeded',
      metadata: { itemCount: 2 },
    });
    stop('audit');

    tx.workspaceEvents.appendEvent({
      id: asEventId('event-project'),
      occurredAt: SEED_NOW,
      workspaceId: seed.workspaceId,
      actorUserId: seed.userId,
      projectId: project.id,
      kind: 'project-created',
      payload: { projectId: project.id, name: project.name },
    });
    stop('project-event');

    tx.workspaceEvents.appendEvent({
      id: asEventId('event-version'),
      occurredAt: SEED_NOW,
      workspaceId: seed.workspaceId,
      actorUserId: seed.userId,
      projectId: project.id,
      kind: 'plan-version-imported',
      payload: {
        projectId: project.id,
        planVersionId: version.id,
        versionNumber: 1,
        document: 'AQ Plan',
        itemCount: 2,
        requiredDependencyCount: 1,
        warningCount: 1,
      },
    });
    stop('version-event');
  });
}

function planningCounts(storage: CraftingTableStorage) {
  return {
    attempts: storage.planning.importAttempts.count(),
    projects: storage.planning.projects.count(),
    bundles: storage.planning.bundles.count(),
    versions: storage.planning.versions.count(),
    artifacts: storage.planning.artifacts.count(),
    diagnostics: storage.planning.diagnostics.count(),
    workItems: storage.planning.workItems.count(),
    dependencies: storage.planning.dependencies.count(),
    drafts: storage.planning.drafts.count(),
    audit: storage.audit.count(),
    events: storage.workspaceEvents.count(),
  };
}

describe('planning import transaction', () => {
  it('commits every durable record together on success (CT03-A25)', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const seed = seedWorkspace(temporary.storage, 'a');
    const baselineEvents = temporary.storage.workspaceEvents.count();
    const baselineAudit = temporary.storage.audit.count();

    importPlan(temporary.storage, seed);

    expect(planningCounts(temporary.storage)).toEqual({
      attempts: 1,
      projects: 1,
      bundles: 1,
      versions: 1,
      artifacts: 1,
      diagnostics: 1,
      workItems: 2,
      dependencies: 1,
      drafts: 0,
      audit: baselineAudit + 1,
      events: baselineEvents + 2,
    });
    expect(
      temporary.storage.planning.projects.find(seed.workspaceId, asProjectId('project-1'))
        ?.activePlanVersionId,
    ).toBe('version-1');
  });

  it.each(STAGES)(
    'leaves no partial state when the transaction fails after %s (CT03-A27)',
    (stage) => {
      const temporary = temporaryStorage();
      temporaries.push(temporary);
      const seed = seedWorkspace(temporary.storage, 'a');
      const before = planningCounts(temporary.storage);

      expect(() => importPlan(temporary.storage, seed, stage)).toThrow(/injected failure/);

      expect(planningCounts(temporary.storage)).toEqual(before);
      expect(
        temporary.storage.planning.projects.find(seed.workspaceId, asProjectId('project-1')),
      ).toBeUndefined();
      expect(
        temporary.storage.planning.versions.findByDigest(seed.workspaceId, 'd'.repeat(64)),
      ).toBeUndefined();
    },
  );

  it('rolls back a failed admission completely (CT03-A56)', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const seed = seedWorkspace(temporary.storage, 'a');
    importPlan(temporary.storage, seed);
    const before = planningCounts(temporary.storage);
    const itemBefore = temporary.storage.planning.workItems.find(
      seed.workspaceId,
      asWorkItemId('item-1'),
    );

    expect(() =>
      temporary.storage.transaction((tx) => {
        tx.planning.workItems.admit({
          workItemId: asWorkItemId('item-1'),
          workspaceId: seed.workspaceId,
          admittedAt: SEED_NOW,
          admittedByUserId: seed.userId,
        });
        tx.audit.append({
          id: asAuditEventId('audit-admit'),
          occurredAt: SEED_NOW,
          actorKind: 'user',
          actorUserId: seed.userId,
          workspaceId: seed.workspaceId,
          action: 'work-item.admitted',
          outcome: 'succeeded',
          metadata: {},
        });
        throw new Error('injected admission failure');
      }),
    ).toThrow(/injected admission failure/);

    expect(planningCounts(temporary.storage)).toEqual(before);
    expect(
      temporary.storage.planning.workItems.find(seed.workspaceId, asWorkItemId('item-1')),
    ).toEqual(itemBefore);
  });

  it('records a failed validation attempt with no accepted planning state (CT03-A28)', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const seed = seedWorkspace(temporary.storage, 'a');
    const baselineEvents = temporary.storage.workspaceEvents.count();

    temporary.storage.transaction((tx) => {
      const attempt = tx.planning.importAttempts.insert({
        id: asPlanImportAttemptId('attempt-failed'),
        workspaceId: seed.workspaceId,
        actorUserId: seed.userId,
        outcome: 'failed-validation',
        requestedProjectName: 'AQ',
        bundleDigest: 'e'.repeat(64),
        digestFormatVersion: 1,
        artifactCount: 1,
        totalByteLength: 7,
        errorCount: 2,
        warningCount: 0,
        createdAt: SEED_NOW,
      });
      tx.planning.artifacts.insertMany([
        {
          id: asPlanArtifactId('artifact-failed'),
          workspaceId: seed.workspaceId,
          importAttemptId: attempt.id,
          logicalFilename: 'plan.md',
          role: 'implementation-plan',
          mediaType: 'text/markdown',
          byteLength: 7,
          sha256: 'b'.repeat(64),
          content: new TextEncoder().encode('# Plan\n'),
          createdAt: SEED_NOW,
        },
      ]);
      tx.planning.diagnostics.insertMany([
        {
          id: asPlanImportDiagnosticId('diagnostic-failed'),
          workspaceId: seed.workspaceId,
          importAttemptId: attempt.id,
          ordinal: 0,
          severity: 'error',
          code: 'required-dependency-cycle',
          message: 'Required dependency cycle: WI-01 → WI-02 → WI-01',
        },
      ]);
      tx.audit.append({
        id: asAuditEventId('audit-failed'),
        occurredAt: SEED_NOW,
        actorKind: 'user',
        actorUserId: seed.userId,
        workspaceId: seed.workspaceId,
        action: 'plan.import.failed',
        outcome: 'failed',
        metadata: { errorCount: 2 },
      });
    });

    // Diagnostics and bounded source bytes persist; accepted planning state and
    // the activity journal do not.
    expect(temporary.storage.planning.importAttempts.count()).toBe(1);
    expect(temporary.storage.planning.artifacts.count()).toBe(1);
    expect(temporary.storage.planning.diagnostics.count()).toBe(1);
    expect(temporary.storage.planning.projects.count()).toBe(0);
    expect(temporary.storage.planning.versions.count()).toBe(0);
    expect(temporary.storage.planning.workItems.count()).toBe(0);
    expect(temporary.storage.planning.dependencies.count()).toBe(0);
    expect(temporary.storage.planning.drafts.count()).toBe(0);
    expect(temporary.storage.workspaceEvents.count()).toBe(baselineEvents);
  });

  it('survives close and reopen with every planning record intact (CT03-A50)', async () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const seed = seedWorkspace(temporary.storage, 'a');
    importPlan(temporary.storage, seed);
    const before = planningCounts(temporary.storage);
    const path = temporary.databasePath;
    temporary.storage.close();

    const { openCraftingTableStorage } = await import('./storage.js');
    const reopened = openCraftingTableStorage(path);
    try {
      expect(planningCounts(reopened)).toEqual(before);
      expect(
        reopened.planning.workItems
          .listForVersion(seed.workspaceId, asPlanVersionId('version-1'))
          .map((item) => [item.sourceId, item.blockerSourceIds]),
      ).toEqual([
        ['AQ-01', []],
        ['AQ-02', ['AQ-01']],
      ]);
    } finally {
      reopened.close();
    }
  });
});
