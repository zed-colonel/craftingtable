import {
  asPlanArtifactId,
  asPlanBundleId,
  asPlanImportAttemptId,
  asPlanVersionId,
  asProjectId,
  asWorkContractDraftId,
  asWorkItemDependencyId,
  asWorkItemId,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { seedPlan, seedWorkspace, SEED_NOW, uniqueDigest } from './planning-test-support.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';

/**
 * CT03-A08, A33, A34: planning schema ownership, immutability, and uniqueness.
 *
 * These assert database-level guarantees, so every negative case goes through
 * the repositories or raw SQL and expects the database itself to refuse.
 */

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

const PLANNING_TABLES = [
  'projects',
  'plan_bundles',
  'plan_versions',
  'plan_import_attempts',
  'plan_artifacts',
  'plan_import_diagnostics',
  'work_items',
  'work_item_dependencies',
  'work_contract_drafts',
] as const;

describe('planning schema', () => {
  it('gives every planning table workspace ownership and a foreign key (CT03-A08)', () => {
    const store = storage();
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;
    for (const table of PLANNING_TABLES) {
      const columns = database.pragma(`table_info(${table})`) as { name: string }[];
      expect(
        columns.map((column) => column.name),
        `${table} must carry workspace_id`,
      ).toContain('workspace_id');

      const keys = database.pragma(`foreign_key_list(${table})`) as {
        table: string;
        on_delete: string;
      }[];
      expect(
        keys.map((key) => key.table),
        `${table} must reference workspaces`,
      ).toContain('workspaces');
      // No cascade may erase accepted historical planning data.
      for (const key of keys) {
        expect(key.on_delete, `${table} -> ${key.table}`).toBe('RESTRICT');
      }
    }
  });

  it('refuses a plan version attached to another workspace’s project (CT03-A08)', () => {
    const store = storage();
    const first = seedWorkspace(store, 'a');
    const second = seedWorkspace(store, 'b');
    const plan = seedPlan(store, first);

    expect(() =>
      store.transaction((tx) =>
        tx.planning.versions.insert({
          id: asPlanVersionId('cross-workspace'),
          workspaceId: second.workspaceId,
          projectId: plan.projectId,
          bundleId: plan.bundleId,
          // Version 2 so the composite workspace foreign key, not the
          // (bundle, version) uniqueness, is the constraint under test.
          versionNumber: 2,
          contentDigest: uniqueDigest(),
          digestAlgorithm: 'sha-256',
          digestFormatVersion: 1,
          sourceProfile: 'exo-work-breakdown-v1',
          document: 'Cross workspace',
          normalizedSource: {},
          itemCount: 0,
          requiredDependencyCount: 0,
          createdAt: SEED_NOW,
          createdByUserId: second.userId,
        }),
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('refuses a dependency edge spanning two plan versions (CT03-A08)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const first = seedPlan(store, seed, { suffix: 'a' });
    const second = seedPlan(store, seed, { suffix: 'b', digest: uniqueDigest() });

    expect(() =>
      store.transaction((tx) =>
        tx.planning.dependencies.insertMany([
          {
            id: asWorkItemDependencyId('cross-version'),
            workspaceId: seed.workspaceId,
            planVersionId: first.planVersionId,
            predecessorWorkItemId: first.rootWorkItemId,
            successorWorkItemId: second.leafWorkItemId,
            kind: 'required',
            ordinal: 0,
          },
        ]),
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('refuses a self-referential dependency edge (CT03-A08)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    expect(() =>
      store.transaction((tx) =>
        tx.planning.dependencies.insertMany([
          {
            id: asWorkItemDependencyId('self'),
            workspaceId: seed.workspaceId,
            planVersionId: plan.planVersionId,
            predecessorWorkItemId: plan.rootWorkItemId,
            successorWorkItemId: plan.rootWorkItemId,
            kind: 'required',
            ordinal: 0,
          },
        ]),
      ),
    ).toThrow(/CHECK/);
  });

  it('refuses a duplicate dependency edge of the same kind (CT03-A08)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    expect(() =>
      store.transaction((tx) =>
        tx.planning.dependencies.insertMany([
          {
            id: asWorkItemDependencyId('duplicate'),
            workspaceId: seed.workspaceId,
            planVersionId: plan.planVersionId,
            predecessorWorkItemId: plan.rootWorkItemId,
            successorWorkItemId: plan.middleWorkItemId,
            kind: 'required',
            ordinal: 1,
          },
        ]),
      ),
    ).toThrow(/UNIQUE/);
  });

  it('rejects updates and deletes on plan versions and artifacts (CT03-A33)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;

    expect(() => database.prepare(`UPDATE plan_versions SET document = 'tampered'`).run()).toThrow(
      /immutable/,
    );
    expect(() => database.prepare(`DELETE FROM plan_versions`).run()).toThrow(/immutable/);

    store.transaction((tx) => {
      const attempt = tx.planning.importAttempts.insert({
        id: asPlanImportAttemptId('attempt-immutable'),
        workspaceId: seed.workspaceId,
        actorUserId: seed.userId,
        outcome: 'succeeded',
        requestedProjectName: 'Project a',
        bundleDigest: 'd'.repeat(64),
        digestFormatVersion: 1,
        projectId: plan.projectId,
        planVersionId: plan.planVersionId,
        artifactCount: 1,
        totalByteLength: 4,
        errorCount: 0,
        warningCount: 0,
        createdAt: SEED_NOW,
      });
      tx.planning.artifacts.insertMany([
        {
          id: asPlanArtifactId('artifact-immutable'),
          workspaceId: seed.workspaceId,
          importAttemptId: attempt.id,
          planVersionId: plan.planVersionId,
          logicalFilename: 'plan.md',
          role: 'implementation-plan',
          mediaType: 'text/markdown',
          byteLength: 4,
          sha256: 'a'.repeat(64),
          content: new TextEncoder().encode('# Pl'),
          createdAt: SEED_NOW,
        },
      ]);
    });

    expect(() => database.prepare(`UPDATE plan_artifacts SET sha256 = 'x'`).run()).toThrow(
      /immutable/,
    );
    expect(() => database.prepare(`DELETE FROM plan_artifacts`).run()).toThrow(/immutable/);
  });

  it('rejects updates and deletes on work-contract drafts', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;

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
        document: { schemaVersion: 1 },
        createdAt: SEED_NOW,
        createdByUserId: seed.userId,
      });
    });

    expect(() =>
      database.prepare(`UPDATE work_contract_drafts SET status = 'approved'`).run(),
    ).toThrow(/immutable/);
    expect(() => database.prepare(`DELETE FROM work_contract_drafts`).run()).toThrow(/immutable/);
  });

  it('permits one draft per work item only', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
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
        document: {},
        createdAt: SEED_NOW,
        createdByUserId: seed.userId,
      });
    });
    expect(() =>
      store.transaction((tx) =>
        tx.planning.drafts.insert({
          id: asWorkContractDraftId('draft-2'),
          workspaceId: seed.workspaceId,
          projectId: plan.projectId,
          planVersionId: plan.planVersionId,
          workItemId: plan.rootWorkItemId,
          document: {},
          createdAt: SEED_NOW,
          createdByUserId: seed.userId,
        }),
      ),
    ).toThrow(/UNIQUE/);
  });

  it('scopes work-item source ids to a plan version (CT03-A34)', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const first = seedPlan(store, seed, { suffix: 'a' });

    // The same source id recurs freely in a different immutable version.
    const second = seedPlan(store, seed, { suffix: 'b', digest: uniqueDigest() });
    expect(
      store.planning.workItems
        .listForVersion(seed.workspaceId, second.planVersionId)
        .map((item) => item.sourceId),
    ).toEqual(['WI-01', 'WI-02', 'WI-03']);

    // Within one version it must not.
    expect(() =>
      store.transaction((tx) =>
        tx.planning.workItems.insertMany([
          {
            id: asWorkItemId('duplicate-source'),
            workspaceId: seed.workspaceId,
            projectId: first.projectId,
            planVersionId: first.planVersionId,
            sourceId: 'WI-01',
            ordinal: 99,
            title: 'Duplicate',
            risk: 'low',
            primaryAreas: [],
            exitGate: 'Green.',
            sourceFields: {},
          },
        ]),
      ),
    ).toThrow(/UNIQUE/);
  });

  it('rejects a second plan version with the same digest in one workspace', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    expect(() =>
      store.transaction((tx) =>
        tx.planning.versions.insert({
          id: asPlanVersionId('duplicate-digest'),
          workspaceId: seed.workspaceId,
          projectId: plan.projectId,
          bundleId: plan.bundleId,
          versionNumber: 2,
          contentDigest: 'd'.repeat(64),
          digestAlgorithm: 'sha-256',
          digestFormatVersion: 1,
          sourceProfile: 'exo-work-breakdown-v1',
          document: 'Same digest',
          normalizedSource: {},
          itemCount: 0,
          requiredDependencyCount: 0,
          createdAt: SEED_NOW,
          createdByUserId: seed.userId,
        }),
      ),
    ).toThrow(/UNIQUE/);
  });

  it('permits the same digest in a different workspace (CT03-A35)', () => {
    const store = storage();
    const first = seedWorkspace(store, 'a');
    const second = seedWorkspace(store, 'b');
    seedPlan(store, first, { suffix: 'a' });
    expect(() => seedPlan(store, second, { suffix: 'b' })).not.toThrow();
    expect(store.planning.versions.findByDigest(first.workspaceId, 'd'.repeat(64))?.id).toBe(
      'version-a',
    );
    expect(store.planning.versions.findByDigest(second.workspaceId, 'd'.repeat(64))?.id).toBe(
      'version-b',
    );
  });

  it('rejects an artifact whose stored length disagrees with its bytes', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    expect(() =>
      store.transaction((tx) => {
        const attempt = tx.planning.importAttempts.insert({
          id: asPlanImportAttemptId('attempt-bad-length'),
          workspaceId: seed.workspaceId,
          actorUserId: seed.userId,
          outcome: 'succeeded',
          requestedProjectName: 'Project a',
          bundleDigest: 'd'.repeat(64),
          digestFormatVersion: 1,
          projectId: plan.projectId,
          planVersionId: plan.planVersionId,
          artifactCount: 1,
          totalByteLength: 4,
          errorCount: 0,
          warningCount: 0,
          createdAt: SEED_NOW,
        });
        tx.planning.artifacts.insertMany([
          {
            id: asPlanArtifactId('artifact-bad-length'),
            workspaceId: seed.workspaceId,
            importAttemptId: attempt.id,
            logicalFilename: 'plan.md',
            role: 'implementation-plan',
            mediaType: 'text/markdown',
            byteLength: 999,
            sha256: 'a'.repeat(64),
            content: new TextEncoder().encode('# Pl'),
            createdAt: SEED_NOW,
          },
        ]);
      }),
    ).toThrow(/CHECK/);
  });

  it('rejects an import attempt whose outcome disagrees with its resolved rows', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    expect(() =>
      store.transaction((tx) =>
        tx.planning.importAttempts.insert({
          // A failed validation must not name a project or plan version.
          id: asPlanImportAttemptId('inconsistent'),
          workspaceId: seed.workspaceId,
          actorUserId: seed.userId,
          outcome: 'failed-validation',
          requestedProjectName: 'Project a',
          projectId: asProjectId('project-a'),
          planVersionId: asPlanVersionId('version-a'),
          artifactCount: 0,
          totalByteLength: 0,
          errorCount: 1,
          warningCount: 0,
          createdAt: SEED_NOW,
        }),
      ),
    ).toThrow(/CHECK/);
  });

  it('rejects an admitted work item without actor attribution', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;
    expect(() =>
      database
        .prepare(`UPDATE work_items SET status = 'admitted' WHERE id = ?`)
        .run(plan.rootWorkItemId),
    ).toThrow(/CHECK/);
  });

  it('keeps a bundle unique per project logical name', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    expect(() =>
      store.transaction((tx) =>
        tx.planning.bundles.insert({
          id: asPlanBundleId('bundle-duplicate'),
          workspaceId: seed.workspaceId,
          projectId: plan.projectId,
          logicalName: 'project-a',
          createdAt: SEED_NOW,
        }),
      ),
    ).toThrow(/UNIQUE/);
  });
});
