import {
  asProjectRepositoryBindingId,
  asRepositoryId,
  asRepositoryInspectionId,
  normalizeRepositoryErrorEvidence,
  reduceRepositoryState,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { seedPlan, seedWorkspace, SEED_NOW } from './planning-test-support.js';
import {
  repositoryRegistrationInspection,
  serializeRepositoryObservation,
} from './repository-test-support.js';
import { verifyExactUtf8Sha256 } from './repository-types.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';

const temporaries: TemporaryStorage[] = [];
afterEach(() => {
  for (const temporary of temporaries.splice(0)) temporary.cleanup();
});

function setup(suffix = 'a') {
  const temporary = temporaryStorage();
  temporaries.push(temporary);
  const seed = seedWorkspace(temporary.storage, suffix);
  const inspection = repositoryRegistrationInspection({
    suffix,
    workspaceId: seed.workspaceId,
    actorUserId: seed.userId,
    createdAt: SEED_NOW,
  });
  const result = temporary.storage.transaction((tx) =>
    tx.repositoryRegistry.repositories.register({
      id: asRepositoryId(`repository-${suffix}`),
      workspaceId: seed.workspaceId,
      displayName: `Repository ${suffix}`,
      actorUserId: seed.userId,
      inspection,
    }),
  );
  if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
  return { ...seed, temporary, repository: result.repository, inspection };
}

describe('repository registry repositories', () => {
  it('commits the inspection-first circular registration graph', () => {
    const seeded = setup();
    expect(seeded.repository.registrationInspectionId).toBe(seeded.inspection.id);
    expect(seeded.repository.acceptedEnvironmentInspectionId).toBe(seeded.inspection.id);
    expect(
      seeded.temporary.storage.repositoryRegistry.inspections.latestForRepository(
        seeded.workspaceId,
        seeded.repository.id,
      ).sequence,
    ).toBe(1);
  });

  it('classifies same-workspace identity without exposing foreign identity', () => {
    const seeded = setup('local');
    const repeated = seeded.temporary.storage.repositoryRegistry.repositories.register({
      id: asRepositoryId('new-id'),
      workspaceId: seeded.workspaceId,
      displayName: 'Repeated',
      actorUserId: seeded.userId,
      inspection: {
        ...seeded.inspection,
        id: asRepositoryInspectionId('new-inspection'),
        repositoryId: asRepositoryId('new-id'),
      },
    });
    expect(repeated.kind).toBe('existing');

    const foreign = seedWorkspace(seeded.temporary.storage, 'foreign');
    const foreignResult = seeded.temporary.storage.repositoryRegistry.repositories.register({
      id: asRepositoryId('foreign-repository'),
      workspaceId: foreign.workspaceId,
      displayName: 'Foreign',
      actorUserId: foreign.userId,
      inspection: {
        ...seeded.inspection,
        id: asRepositoryInspectionId('foreign-inspection'),
        workspaceId: foreign.workspaceId,
        repositoryId: asRepositoryId('foreign-repository'),
        actorUserId: foreign.userId,
      },
    });
    expect(foreignResult).toEqual({ kind: 'identity-reserved-elsewhere' });
    expect(JSON.stringify(foreignResult)).toBe('{"kind":"identity-reserved-elsewhere"}');
  });

  it('classifies partial local identity and exact non-active state without raw constraints', () => {
    const seeded = setup('local-classification');
    const partial = repositoryRegistrationInspection({
      suffix: 'partial-candidate',
      workspaceId: seeded.workspaceId,
      actorUserId: seeded.userId,
      createdAt: SEED_NOW,
    });
    expect(
      seeded.temporary.storage.repositoryRegistry.repositories.register({
        id: partial.repositoryId,
        workspaceId: seeded.workspaceId,
        displayName: 'Partial collision',
        actorUserId: seeded.userId,
        inspection: {
          ...partial,
          canonicalTopLevel: seeded.inspection.canonicalTopLevel,
        },
      }),
    ).toEqual({ kind: 'local-identity-conflict' });

    const reduction = reduceRepositoryState('active', {
      kind: 'apply-assessment',
      assessment: { kind: 'unavailable', reason: 'path-unavailable' },
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
    expect(
      seeded.temporary.storage.repositoryRegistry.repositories.register({
        id: asRepositoryId('same-nonactive-candidate'),
        workspaceId: seeded.workspaceId,
        displayName: 'Same nonactive',
        actorUserId: seeded.userId,
        inspection: {
          ...seeded.inspection,
          id: asRepositoryInspectionId('same-nonactive-inspection'),
          repositoryId: asRepositoryId('same-nonactive-candidate'),
        },
      }),
    ).toEqual({ kind: 'conflicting-local-state', status: 'unavailable' });
  });

  it('orders same-millisecond evidence by generated sequence', () => {
    const seeded = setup('sequence');
    const observation = {
      ...seeded.inspection,
      id: asRepositoryInspectionId('verification-sequence'),
      kind: 'verification' as const,
      coreDifferences: [],
      environmentalDifferences: [],
      riskDifferences: [],
    };
    const result = seeded.temporary.storage.repositoryRegistry.inspections.appendVerification({
      workspaceId: seeded.workspaceId,
      repositoryId: seeded.repository.id,
      expectedVersion: 1,
      inspection: observation,
    });
    expect(result.kind).toBe('appended');
    expect(
      seeded.temporary.storage.repositoryRegistry.inspections
        .listForRepository(seeded.workspaceId, seeded.repository.id, 10)
        .map((row) => row.id),
    ).toEqual([observation.id, seeded.inspection.id]);
  });

  it('binds one project, preserves projection, and retires atomically with repository', () => {
    const seeded = setup('binding');
    const plan = seedPlan(seeded.temporary.storage, seeded, {
      suffix: 'binding',
      digest: 'b'.repeat(64),
    });
    const binding = seeded.temporary.storage.repositoryRegistry.bindings.insert({
      id: asProjectRepositoryBindingId('binding-1'),
      workspaceId: seeded.workspaceId,
      projectId: plan.projectId,
      repositoryId: seeded.repository.id,
      expectedRepositoryVersion: 1,
      actorUserId: seeded.userId,
      boundAt: SEED_NOW,
    });
    expect(binding.kind).toBe('created');
    const retired = seeded.temporary.storage.repositoryRegistry.repositories.retireWithBindings({
      workspaceId: seeded.workspaceId,
      repositoryId: seeded.repository.id,
      expectedVersion: 1,
      actorUserId: seeded.userId,
      changedAt: SEED_NOW,
    });
    expect(retired).toMatchObject({
      kind: 'changed',
      repository: { status: 'retired', version: 2 },
      retiredBindingIds: ['binding-1'],
    });
  });

  it('adopts only a fresh latest environmental reaffirmation as baseline', () => {
    const seeded = setup('reaffirm');
    const reduction = reduceRepositoryState(seeded.repository.status, {
      kind: 'apply-assessment',
      assessment: {
        kind: 'environment-evidence-changed',
        differences: ['top-level-device'],
      },
    });
    if (reduction.kind !== 'transition') throw new Error(reduction.kind);
    const changed = seeded.temporary.storage.repositoryRegistry.repositories.applyTransition({
      workspaceId: seeded.workspaceId,
      repositoryId: seeded.repository.id,
      expectedVersion: 1,
      actorUserId: seeded.userId,
      changedAt: SEED_NOW,
      reduction,
    });
    expect(changed).toMatchObject({
      kind: 'changed',
      repository: { status: 'identity-evidence-changed', version: 2 },
    });

    const reaffirmation = {
      ...seeded.inspection,
      id: asRepositoryInspectionId('inspection-reaffirmed'),
      kind: 'reaffirmation' as const,
      topLevelDevice: '11',
      coreDifferences: [],
      environmentalDifferences: ['top-level-device'] as const,
      riskDifferences: [],
    };
    const reaffirmed = seeded.temporary.storage.repositoryRegistry.repositories.reaffirmEnvironment(
      {
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 2,
        expectedLatestSuccessfulInspectionId: seeded.inspection.id,
        actorUserId: seeded.userId,
        changedAt: SEED_NOW,
        inspection: reaffirmation,
      },
    );
    expect(reaffirmed).toMatchObject({
      kind: 'changed',
      repository: {
        status: 'active',
        statusReason: 'environment-evidence-reaffirmed',
        acceptedEnvironmentInspectionId: reaffirmation.id,
        version: 3,
      },
      inspection: { id: reaffirmation.id },
    });
  });

  it('does not append a reaffirmation when version or latest-success preconditions are stale', () => {
    const seeded = setup('stale-reaffirm');
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
    const inspection = {
      ...seeded.inspection,
      id: asRepositoryInspectionId('never-appended'),
      kind: 'reaffirmation' as const,
      coreDifferences: [],
      environmentalDifferences: ['top-level-device'] as const,
      riskDifferences: [],
    };
    expect(
      seeded.temporary.storage.repositoryRegistry.repositories.reaffirmEnvironment({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 1,
        expectedLatestSuccessfulInspectionId: seeded.inspection.id,
        actorUserId: seeded.userId,
        changedAt: SEED_NOW,
        inspection,
      }),
    ).toEqual({ kind: 'version-conflict' });
    expect(
      seeded.temporary.storage.repositoryRegistry.repositories.reaffirmEnvironment({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 2,
        expectedLatestSuccessfulInspectionId: asRepositoryInspectionId('wrong-latest'),
        actorUserId: seeded.userId,
        changedAt: SEED_NOW,
        inspection,
      }),
    ).toEqual({ kind: 'latest-successful-conflict' });
    expect(
      seeded.temporary.storage.repositoryRegistry.inspections.find(
        seeded.workspaceId,
        inspection.id,
      ),
    ).toBeUndefined();
  });

  it('keeps an active binding as history while projecting a non-active repository', () => {
    const seeded = setup('projection');
    const plan = seedPlan(seeded.temporary.storage, seeded, {
      suffix: 'projection',
      digest: 'c'.repeat(64),
    });
    seeded.temporary.storage.repositoryRegistry.bindings.insert({
      id: asProjectRepositoryBindingId('binding-projection'),
      workspaceId: seeded.workspaceId,
      projectId: plan.projectId,
      repositoryId: seeded.repository.id,
      expectedRepositoryVersion: 1,
      actorUserId: seeded.userId,
      boundAt: SEED_NOW,
    });
    const reduction = reduceRepositoryState('active', {
      kind: 'apply-assessment',
      assessment: { kind: 'unavailable', reason: 'path-unavailable' },
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
    expect(
      seeded.temporary.storage.repositoryRegistry.queries.projectBindingSummaries(
        seeded.workspaceId,
        plan.projectId,
      ),
    ).toMatchObject([
      {
        binding: { status: 'active' },
        repositoryStatus: 'unavailable',
        repositoryStatusReason: 'path-unavailable',
      },
    ]);
  });

  it('enforces one active binding per project while allowing sibling projects', () => {
    const seeded = setup('binding-cardinality');
    const first = seedPlan(seeded.temporary.storage, seeded, {
      suffix: 'binding-cardinality-1',
      digest: '3'.repeat(64),
    });
    const second = seedPlan(seeded.temporary.storage, seeded, {
      suffix: 'binding-cardinality-2',
      digest: '4'.repeat(64),
    });
    const firstBinding = seeded.temporary.storage.repositoryRegistry.bindings.insert({
      id: asProjectRepositoryBindingId('binding-cardinality-1'),
      workspaceId: seeded.workspaceId,
      projectId: first.projectId,
      repositoryId: seeded.repository.id,
      expectedRepositoryVersion: 1,
      actorUserId: seeded.userId,
      boundAt: SEED_NOW,
    });
    expect(firstBinding.kind).toBe('created');
    expect(
      seeded.temporary.storage.repositoryRegistry.bindings.insert({
        id: asProjectRepositoryBindingId('binding-cardinality-repeat'),
        workspaceId: seeded.workspaceId,
        projectId: first.projectId,
        repositoryId: seeded.repository.id,
        expectedRepositoryVersion: 1,
        actorUserId: seeded.userId,
        boundAt: SEED_NOW,
      }),
    ).toMatchObject({ kind: 'existing', binding: { id: 'binding-cardinality-1' } });
    expect(
      seeded.temporary.storage.repositoryRegistry.bindings.insert({
        id: asProjectRepositoryBindingId('binding-cardinality-2'),
        workspaceId: seeded.workspaceId,
        projectId: second.projectId,
        repositoryId: seeded.repository.id,
        expectedRepositoryVersion: 1,
        actorUserId: seeded.userId,
        boundAt: SEED_NOW,
      }),
    ).toMatchObject({ kind: 'created' });
    if (firstBinding.kind !== 'created') throw new Error(firstBinding.kind);
    expect(
      seeded.temporary.storage.repositoryRegistry.bindings.retire({
        workspaceId: seeded.workspaceId,
        bindingId: firstBinding.binding.id,
        expectedVersion: 1,
        actorUserId: seeded.userId,
        retiredAt: SEED_NOW,
      }),
    ).toMatchObject({
      kind: 'changed',
      binding: { status: 'retired', version: 2, retiredAt: SEED_NOW },
    });
    expect(
      seeded.temporary.storage.repositoryRegistry.bindings
        .listForRepository(seeded.workspaceId, seeded.repository.id)
        .map((binding) => binding.status),
    ).toEqual(['retired', 'active']);
  });

  it('hashes exact observation bytes without canonicalization overclaim', () => {
    const left = serializeRepositoryObservation({ a: 1, b: 2 });
    const right = serializeRepositoryObservation({ b: 2, a: 1 });
    expect(left.observationJson).not.toBe(right.observationJson);
    expect(left.observationSha256).not.toBe(right.observationSha256);
  });

  it('stores complete A1 and storage-integrity failures with null observation fields', () => {
    const seeded = setup('failures');
    const a1 = seeded.temporary.storage.repositoryRegistry.inspections.appendVerification({
      workspaceId: seeded.workspaceId,
      repositoryId: seeded.repository.id,
      expectedVersion: 1,
      inspection: {
        id: asRepositoryInspectionId('inspection-a1-failure'),
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        actorUserId: seeded.userId,
        kind: 'verification',
        outcome: 'failed',
        createdAt: SEED_NOW,
        errorOrigin: 'a1',
        errorCode: 'path-unavailable',
        errorSubject: 'repository-unavailable',
        errorCategory: 'path-policy',
        errorOperation: 'inspect-path',
        errorRetryability: 'retryable',
        errorEvidence: normalizeRepositoryErrorEvidence({
          requestedPathLength: 20,
        }),
      },
    });
    expect(a1).toMatchObject({
      kind: 'appended',
      inspection: {
        outcome: 'failed',
        errorCode: 'path-unavailable',
        errorEvidence: { requestedPathLength: 20 },
      },
    });
    expect(
      seeded.temporary.storage.repositoryRegistry.inspections.appendVerification({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 1,
        inspection: {
          id: asRepositoryInspectionId('inspection-integrity-failure'),
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
          errorEvidence: normalizeRepositoryErrorEvidence({
            inspectionSequence: 1,
          }),
        },
      }),
    ).toMatchObject({
      kind: 'appended',
      inspection: {
        outcome: 'failed',
        errorOrigin: 'storage-integrity',
      },
    });
  });

  it('detects a stale exact-byte digest before JSON use (A2A-INSP-013)', () => {
    const seeded = setup('stale-digest');
    expect(
      verifyExactUtf8Sha256(
        `${seeded.inspection.observationJson} `,
        seeded.inspection.observationSha256,
      ),
    ).toBe(false);
    expect(
      verifyExactUtf8Sha256(seeded.inspection.observationJson, seeded.inspection.observationSha256),
    ).toBe(true);
  });

  it('rejects cross-origin failure taxonomy tuples at the SQL boundary', () => {
    const seeded = setup('cross-origin');
    expect(() =>
      seeded.temporary.storage.repositoryRegistry.inspections.appendVerification({
        workspaceId: seeded.workspaceId,
        repositoryId: seeded.repository.id,
        expectedVersion: 1,
        inspection: {
          id: asRepositoryInspectionId('inspection-cross-origin-failure'),
          workspaceId: seeded.workspaceId,
          repositoryId: seeded.repository.id,
          actorUserId: seeded.userId,
          kind: 'verification',
          outcome: 'failed',
          createdAt: SEED_NOW,
          errorOrigin: 'storage-integrity',
          errorCode: 'path-unavailable',
          errorSubject: 'repository-unavailable',
          errorCategory: 'path-policy',
          errorOperation: 'inspect-path',
          errorRetryability: 'retryable',
          errorEvidence: {},
        },
      }),
    ).toThrow(/failure taxonomy/);
  });
});
