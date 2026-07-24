import {
  asPlanArtifactId,
  asPlanBundleId,
  asPlanImportAttemptId,
  asPlanImportDiagnosticId,
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

    // A bare status flip is stopped by the transition trigger first.
    expect(() =>
      database
        .prepare(`UPDATE work_items SET status = 'admitted' WHERE id = ?`)
        .run(plan.rootWorkItemId),
    ).toThrow(/proposed-to-admitted/);

    // A correctly shaped transition still has to carry actor attribution.
    expect(() =>
      database
        .prepare(`UPDATE work_items SET status = 'admitted', version = version + 1 WHERE id = ?`)
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

/**
 * Regression cover for CT03-R1 and CT03-R2.
 *
 * The first review found that structural ownership stopped at `workspace_id`
 * and that the versioned work graph was mutable. These assert the closed chain
 * and the frozen history directly, through raw SQL, so a future schema change
 * that reopens either hole fails here.
 */
describe('structural ownership chain (CT03-R1)', () => {
  function twoWorkspaces() {
    const store = storage();
    const first = seedWorkspace(store, 'a');
    const second = seedWorkspace(store, 'b');
    const planA = seedPlan(store, first, { suffix: 'a' });
    const planB = seedPlan(store, second, { suffix: 'b', digest: uniqueDigest() });
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;
    return { store, first, second, planA, planB, database };
  }

  it('refuses an active plan version owned by another workspace', () => {
    const { planA, planB, database } = twoWorkspaces();
    expect(() =>
      database
        .prepare(`UPDATE projects SET active_plan_version_id = ? WHERE id = ?`)
        .run(planB.planVersionId, planA.projectId),
    ).toThrow(/FOREIGN KEY/);
    // The pointer is unchanged, so the ordinary active-version join is safe.
    expect(
      database
        .prepare(`SELECT active_plan_version_id AS id FROM projects WHERE id = ?`)
        .get(planA.projectId),
    ).toEqual({ id: planA.planVersionId });
  });

  it('refuses an active plan version owned by another project in the same workspace', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const first = seedPlan(store, seed, { suffix: 'a' });
    const second = seedPlan(store, seed, { suffix: 'b', digest: uniqueDigest() });
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;
    expect(() =>
      database
        .prepare(`UPDATE projects SET active_plan_version_id = ? WHERE id = ?`)
        .run(second.planVersionId, first.projectId),
    ).toThrow(/FOREIGN KEY/);
  });

  it('refuses a work item reassigned to a project that does not own its version', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const first = seedPlan(store, seed, { suffix: 'a' });
    seedPlan(store, seed, { suffix: 'b', digest: uniqueDigest() });
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;
    expect(() =>
      database
        .prepare(`UPDATE work_items SET project_id = 'project-b' WHERE id = ?`)
        .run(first.rootWorkItemId),
    ).toThrow(/immutable|FOREIGN KEY/);
  });

  it('refuses a plan version whose bundle belongs to another project', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const first = seedPlan(store, seed, { suffix: 'a' });
    const second = seedPlan(store, seed, { suffix: 'b', digest: uniqueDigest() });
    expect(() =>
      store.transaction((tx) =>
        tx.planning.versions.insert({
          id: asPlanVersionId('mismatched-bundle'),
          workspaceId: seed.workspaceId,
          projectId: first.projectId,
          bundleId: second.bundleId,
          versionNumber: 2,
          contentDigest: uniqueDigest(),
          digestAlgorithm: 'sha-256',
          digestFormatVersion: 1,
          sourceProfile: 'exo-work-breakdown-v1',
          document: 'Mismatched',
          normalizedSource: {},
          itemCount: 0,
          requiredDependencyCount: 0,
          createdAt: SEED_NOW,
          createdByUserId: seed.userId,
        }),
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('refuses a workspace event correlated to another workspace project', () => {
    const { first, planB, database } = twoWorkspaces();
    expect(() =>
      database
        .prepare(
          `INSERT INTO workspace_events
             (id, schema_version, occurred_at, workspace_id, project_id, kind, payload_json)
           VALUES ('cross', 1, ?, ?, ?, 'project-created', '{"projectId":"x","name":"y"}')`,
        )
        .run(SEED_NOW, first.workspaceId, planB.projectId),
    ).toThrow(/FOREIGN KEY/);
  });

  it('still permits every legitimate relationship', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    expect(
      store.planning.projects.find(seed.workspaceId, plan.projectId)?.activePlanVersionId,
    ).toBe(plan.planVersionId);
    expect(
      store.planning.workItems.listForVersion(seed.workspaceId, plan.planVersionId),
    ).toHaveLength(3);
  });
});

describe('historical work-graph immutability (CT03-R2)', () => {
  function seeded() {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const plan = seedPlan(store, seed);
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;
    return { store, seed, plan, database };
  }

  it.each([
    ['title', `UPDATE work_items SET title = 'REWRITTEN' WHERE id = ?`],
    [
      'source_fields_json',
      `UPDATE work_items SET source_fields_json = '{"id":"OTHER"}' WHERE id = ?`,
    ],
    ['source_id', `UPDATE work_items SET source_id = 'WI-99' WHERE id = ?`],
    ['risk', `UPDATE work_items SET risk = 'critical' WHERE id = ?`],
    ['ordinal', `UPDATE work_items SET ordinal = 99 WHERE id = ?`],
    ['exit_gate', `UPDATE work_items SET exit_gate = 'Anything' WHERE id = ?`],
    ['primary_areas_json', `UPDATE work_items SET primary_areas_json = '["other"]' WHERE id = ?`],
    ['plan_version_id', `UPDATE work_items SET plan_version_id = 'version-b' WHERE id = ?`],
    ['workspace_id', `UPDATE work_items SET workspace_id = 'workspace-b' WHERE id = ?`],
  ])('refuses to rewrite an imported work item %s', (_field, sql) => {
    const { plan, database } = seeded();
    expect(() => database.prepare(sql).run(plan.rootWorkItemId)).toThrow(/immutable/);
  });

  it('refuses to delete an imported work item or dependency edge', () => {
    const { plan, database } = seeded();
    expect(() =>
      database.prepare(`DELETE FROM work_items WHERE id = ?`).run(plan.leafWorkItemId),
    ).toThrow(/immutable/);
    expect(() => database.prepare(`DELETE FROM work_item_dependencies`).run()).toThrow(/immutable/);
  });

  it('refuses to edit a dependency edge', () => {
    const { database } = seeded();
    expect(() =>
      database.prepare(`UPDATE work_item_dependencies SET kind = 'recommended'`).run(),
    ).toThrow(/immutable/);
  });

  it('refuses to rewrite or delete an import attempt or diagnostic', () => {
    const store = storage();
    const seed = seedWorkspace(store, 'a');
    const database = (store as unknown as { database: import('better-sqlite3').Database }).database;
    store.transaction((tx) => {
      const attempt = tx.planning.importAttempts.insert({
        id: asPlanImportAttemptId('attempt-history'),
        workspaceId: seed.workspaceId,
        actorUserId: seed.userId,
        outcome: 'failed-validation',
        requestedProjectName: 'Broken',
        artifactCount: 0,
        totalByteLength: 0,
        errorCount: 1,
        warningCount: 0,
        createdAt: SEED_NOW,
      });
      tx.planning.diagnostics.insertMany([
        {
          id: asPlanImportDiagnosticId('diagnostic-history'),
          workspaceId: seed.workspaceId,
          importAttemptId: attempt.id,
          ordinal: 0,
          severity: 'error',
          code: 'invalid-yaml',
          message: 'bad',
        },
      ]);
    });
    expect(() =>
      database.prepare(`UPDATE plan_import_attempts SET outcome = 'succeeded'`).run(),
    ).toThrow(/append-only/);
    expect(() => database.prepare(`DELETE FROM plan_import_attempts`).run()).toThrow(/append-only/);
    expect(() =>
      database.prepare(`UPDATE plan_import_diagnostics SET code = 'other'`).run(),
    ).toThrow(/append-only/);
    expect(() => database.prepare(`DELETE FROM plan_import_diagnostics`).run()).toThrow(
      /append-only/,
    );
  });

  it('permits exactly one admission and then freezes the row', () => {
    const { store, seed, plan, database } = seeded();
    const admitted = store.transaction((tx) =>
      tx.planning.workItems.admit({
        workItemId: plan.rootWorkItemId,
        workspaceId: seed.workspaceId,
        admittedAt: SEED_NOW,
        admittedByUserId: seed.userId,
      }),
    );
    expect(admitted?.status).toBe('admitted');

    // An admitted item is final: it cannot be un-admitted, re-attributed, or
    // re-admitted with a different actor.
    expect(() =>
      database
        .prepare(`UPDATE work_items SET status = 'proposed' WHERE id = ?`)
        .run(plan.rootWorkItemId),
    ).toThrow(/final/);
    expect(() =>
      database
        .prepare(`UPDATE work_items SET admitted_by_user_id = 'user-b' WHERE id = ?`)
        .run(plan.rootWorkItemId),
    ).toThrow(/final/);
  });
});
