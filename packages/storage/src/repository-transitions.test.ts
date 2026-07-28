import {
  asProjectRepositoryBindingId,
  asRepositoryId,
  asRepositoryInspectionId,
  normalizeRepositoryErrorEvidence,
  reduceRepositoryState,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { seedPlan, seedWorkspace, SEED_NOW } from './planning-test-support.js';
import { repositoryRegistrationInspection } from './repository-test-support.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';

const temporaries: TemporaryStorage[] = [];
afterEach(() => {
  for (const temporary of temporaries.splice(0)) temporary.cleanup();
});

function setup(suffix: string) {
  const temporary = temporaryStorage();
  temporaries.push(temporary);
  const seed = seedWorkspace(temporary.storage, suffix);
  const inspection = repositoryRegistrationInspection({
    suffix,
    workspaceId: seed.workspaceId,
    actorUserId: seed.userId,
    createdAt: SEED_NOW,
  });
  const created = temporary.storage.repositoryRegistry.repositories.register({
    id: asRepositoryId(`repository-${suffix}`),
    workspaceId: seed.workspaceId,
    displayName: `Repository ${suffix}`,
    actorUserId: seed.userId,
    inspection,
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  return { temporary, ...seed, repository: created.repository, inspection };
}

describe('repository transition persistence', () => {
  it('accepts two exact transitions at the same timestamp and rejects backwards time (A2A-REP-016)', () => {
    const seeded = setup('same-time');
    const unavailable = reduceRepositoryState('active', {
      kind: 'apply-assessment',
      assessment: { kind: 'unavailable', reason: 'path-unavailable' },
    });
    if (unavailable.kind !== 'transition') throw new Error(unavailable.kind);
    expect(
      seeded.temporary.storage.repositoryRegistry.repositories.applyTransition({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 1,
        actorUserId: seeded.userId,
        changedAt: SEED_NOW,
        reduction: unavailable,
      }),
    ).toMatchObject({ kind: 'changed', repository: { version: 2 } });
    const restored = reduceRepositoryState('unavailable', {
      kind: 'apply-assessment',
      assessment: { kind: 'same' },
    });
    if (restored.kind !== 'transition') throw new Error(restored.kind);
    expect(
      seeded.temporary.storage.repositoryRegistry.repositories.applyTransition({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 2,
        actorUserId: seeded.userId,
        changedAt: SEED_NOW,
        reduction: restored,
      }),
    ).toMatchObject({ kind: 'changed', repository: { status: 'active', version: 3 } });

    const raw = openDatabase(seeded.temporary.databasePath);
    try {
      expect(() =>
        raw
          .prepare(
            `UPDATE registered_repositories SET status = 'unavailable',
               status_reason = 'path-unavailable',
               status_changed_at = '2026-07-23T23:59:59.999Z',
               version = version + 1 WHERE id = ?`,
          )
          .run(seeded.repository.id),
      ).toThrow(/invalid repository transition/);
    } finally {
      raw.close();
    }
  });

  it('rolls back binding and repository retirement together on outer failure (A2A-RET-002)', () => {
    const seeded = setup('retire-rollback');
    const first = seedPlan(seeded.temporary.storage, seeded, {
      suffix: 'retire-rollback-1',
      digest: '1'.repeat(64),
    });
    const second = seedPlan(seeded.temporary.storage, seeded, {
      suffix: 'retire-rollback-2',
      digest: '2'.repeat(64),
    });
    for (const [index, projectId] of [first.projectId, second.projectId].entries()) {
      seeded.temporary.storage.repositoryRegistry.bindings.insert({
        id: asProjectRepositoryBindingId(`retire-binding-${index}`),
        workspaceId: seeded.workspaceId,
        projectId,
        repositoryId: seeded.repository.id,
        expectedRepositoryVersion: 1,
        actorUserId: seeded.userId,
        boundAt: SEED_NOW,
      });
    }
    expect(() =>
      seeded.temporary.storage.transaction((tx) => {
        tx.repositoryRegistry.repositories.retireWithBindings({
          workspaceId: seeded.workspaceId,
          repositoryId: seeded.repository.id,
          expectedVersion: 1,
          actorUserId: seeded.userId,
          changedAt: SEED_NOW,
        });
        throw new Error('force outer rollback');
      }),
    ).toThrow(/force outer rollback/);
    expect(
      seeded.temporary.storage.repositoryRegistry.repositories.find(
        seeded.workspaceId,
        seeded.repository.id,
      ),
    ).toMatchObject({ status: 'active', version: 1 });
    expect(
      seeded.temporary.storage.repositoryRegistry.bindings
        .listForRepository(seeded.workspaceId, seeded.repository.id)
        .map((binding) => binding.status),
    ).toEqual(['active', 'active']);
  });

  it('makes retirement idempotent and releases all identity reservations (A2A-RET-003/006)', () => {
    const seeded = setup('identity-reuse');
    const first = seeded.temporary.storage.repositoryRegistry.repositories.retireWithBindings({
      workspaceId: seeded.workspaceId,
      repositoryId: seeded.repository.id,
      expectedVersion: 1,
      actorUserId: seeded.userId,
      changedAt: SEED_NOW,
    });
    expect(first).toMatchObject({ kind: 'changed', repository: { status: 'retired', version: 2 } });
    expect(
      seeded.temporary.storage.repositoryRegistry.repositories.retireWithBindings({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 2,
        actorUserId: seeded.userId,
        changedAt: SEED_NOW,
      }),
    ).toMatchObject({ kind: 'unchanged', repository: { version: 2 } });

    const replacement = seeded.temporary.storage.repositoryRegistry.repositories.register({
      id: asRepositoryId('replacement-repository'),
      workspaceId: seeded.workspaceId,
      displayName: 'Replacement',
      actorUserId: seeded.userId,
      inspection: {
        ...seeded.inspection,
        id: asRepositoryInspectionId('replacement-inspection'),
        repositoryId: asRepositoryId('replacement-repository'),
      },
    });
    expect(replacement).toMatchObject({ kind: 'created', repository: { status: 'active' } });
  });

  it('derives baseline acceptance from the link, not reaffirmation kind (A2A-BASE-009)', () => {
    const seeded = setup('stray-reaffirmation');
    const reduction = reduceRepositoryState('active', {
      kind: 'apply-assessment',
      assessment: {
        kind: 'environment-evidence-changed',
        differences: ['top-level-device'],
      },
    });
    if (reduction.kind !== 'transition') throw new Error(reduction.kind);
    seeded.temporary.storage.repositoryRegistry.repositories.applyTransition({
      workspaceId: seeded.workspaceId,
      repositoryId: seeded.repository.id,
      expectedVersion: 1,
      actorUserId: seeded.userId,
      changedAt: SEED_NOW,
      reduction,
    });

    const raw = openDatabase(seeded.temporary.databasePath);
    try {
      raw
        .prepare(
          `INSERT INTO repository_inspections (
             id, workspace_id, repository_id, actor_user_id, kind, outcome, created_at,
             observation_json, observation_sha256, observation_version,
             inspection_policy_version, observed_at, canonical_top_level,
             canonical_git_directory, canonical_common_git_directory, object_format,
             top_level_inode, common_directory_inode, core_fingerprint_sha256,
             top_level_device, common_directory_device, risk_scan_scope_version,
             risk_scanned_key_pattern, risk_classification, risk_signals_json,
             core_differences_json, environmental_differences_json, risk_differences_json)
           SELECT 'stray-reaffirmation', workspace_id, repository_id, actor_user_id,
             'reaffirmation', outcome, created_at, observation_json, observation_sha256,
             observation_version, inspection_policy_version, observed_at,
             canonical_top_level, canonical_git_directory,
             canonical_common_git_directory, object_format, top_level_inode,
             common_directory_inode, core_fingerprint_sha256, '11',
             common_directory_device, risk_scan_scope_version,
             risk_scanned_key_pattern, risk_classification, risk_signals_json,
             '[]', '["top-level-device"]', '[]'
           FROM repository_inspections WHERE id = ?`,
        )
        .run(seeded.inspection.id);
    } finally {
      raw.close();
    }
    expect(
      seeded.temporary.storage.repositoryRegistry.queries.inspectionSummaries(
        seeded.workspaceId,
        seeded.repository.id,
        10,
      ),
    ).toMatchObject([
      {
        inspection: { id: 'stray-reaffirmation', kind: 'reaffirmation' },
        acceptedAsEnvironmentBaseline: false,
      },
      {
        inspection: { id: seeded.inspection.id, kind: 'registration' },
        acceptedAsEnvironmentBaseline: true,
      },
    ]);
  });

  it('rejects direct baseline rollback, core rewrite, unretire, and evidence deletion', () => {
    const seeded = setup('direct-rejections');
    const raw = openDatabase(seeded.temporary.databasePath);
    try {
      expect(() =>
        raw
          .prepare(
            `UPDATE registered_repositories
             SET accepted_environment_inspection_id = registration_inspection_id,
                 version = version + 1 WHERE id = ?`,
          )
          .run(seeded.repository.id),
      ).toThrow(/invalid repository transition/);
      expect(() =>
        raw
          .prepare(
            `UPDATE registered_repositories
             SET core_fingerprint_sha256 = ?, status = 'unavailable',
                 status_reason = 'path-unavailable', version = version + 1
             WHERE id = ?`,
          )
          .run('f'.repeat(64), seeded.repository.id),
      ).toThrow(/invalid repository transition/);
      expect(() =>
        raw.prepare(`DELETE FROM repository_inspections WHERE id = ?`).run(seeded.inspection.id),
      ).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it('records stale-digest integrity failure and blocks evidence in one outer transaction (A2A-INSP-015)', () => {
    const seeded = setup('integrity-block');
    const result = seeded.temporary.storage.transaction((tx) => {
      const appended = tx.repositoryRegistry.inspections.appendVerification({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 1,
        inspection: {
          id: asRepositoryInspectionId('integrity-failure'),
          workspaceId: seeded.workspaceId,
          repositoryId: seeded.repository.id,
          actorUserId: seeded.userId,
          kind: 'verification',
          outcome: 'failed',
          createdAt: SEED_NOW,
          errorOrigin: 'storage-integrity',
          errorCode: 'stored-evidence-digest-mismatch',
          errorSubject: 'stored-evidence-integrity',
          errorCategory: 'observation',
          errorOperation: 'verify-stored-record',
          errorRetryability: 'not-retryable',
          errorEvidence: normalizeRepositoryErrorEvidence({ inspectionSequence: 1 }),
        },
      });
      const reduction = reduceRepositoryState('active', {
        kind: 'apply-assessment',
        assessment: {
          kind: 'evidence-invalid',
          reason: 'stored-evidence-digest-mismatch',
        },
      });
      if (reduction.kind !== 'transition') throw new Error(reduction.kind);
      const changed = tx.repositoryRegistry.repositories.applyTransition({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 1,
        actorUserId: seeded.userId,
        changedAt: SEED_NOW,
        reduction,
      });
      return { appended, changed };
    });
    expect(result).toMatchObject({
      appended: {
        kind: 'appended',
        inspection: { errorOrigin: 'storage-integrity' },
      },
      changed: {
        kind: 'changed',
        repository: {
          status: 'evidence-blocked',
          statusReason: 'stored-evidence-digest-mismatch',
          version: 2,
        },
      },
    });
  });
});
