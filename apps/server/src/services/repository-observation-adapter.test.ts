import {
  A1_REPOSITORY_INSPECTION_ERROR_CODES,
  A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE,
  type RegisteredRepository,
  STORED_REPOSITORY_RISK_SIGNALS,
  type SuccessfulRepositoryInspection,
} from '@craftingtable/domain';
import {
  calculateCoreIdentityFingerprint,
  parseRecordedObservation,
  REPOSITORY_INSPECTION_POLICY_VERSION,
  REPOSITORY_OBSERVATION_VERSION,
  REPOSITORY_RISK_SCAN_PATTERN,
  REPOSITORY_RISK_SCAN_SCOPE_VERSION,
  type RepositoryInspectionError,
  type RepositoryObservationShape,
} from '@craftingtable/git';
import { serializeRepositoryObservation, sha256ExactUtf8 } from '@craftingtable/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryFeatureConfig } from '../config.js';
import {
  createRepositoryObservationPort,
  repositoryObservationVocabularyMatches,
} from './repository-observation-adapter.js';
import type {
  RepositoryObservationEvidence,
  RepositoryObservationPort,
  VerifiedRepositoryBaseline,
} from './repository-observation-port.js';

const a1 = vi.hoisted(() => ({
  createRepositoryInspector: vi.fn(),
  codes: [] as string[],
  subjects: {} as Record<string, string>,
  signals: [] as string[],
  realCodes: [] as string[],
  realSubjects: {} as Record<string, string>,
  realSignals: [] as string[],
}));

vi.mock('@craftingtable/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@craftingtable/git')>();
  a1.realCodes.splice(0, a1.realCodes.length, ...actual.ALL_REPOSITORY_INSPECTION_ERROR_CODES);
  Object.assign(a1.realSubjects, actual.REPOSITORY_INSPECTION_ERROR_SUBJECTS);
  a1.realSignals.splice(0, a1.realSignals.length, ...actual.REPOSITORY_RISK_SIGNALS);
  a1.codes.splice(0, a1.codes.length, ...actual.ALL_REPOSITORY_INSPECTION_ERROR_CODES);
  Object.assign(a1.subjects, actual.REPOSITORY_INSPECTION_ERROR_SUBJECTS);
  a1.signals.splice(0, a1.signals.length, ...actual.REPOSITORY_RISK_SIGNALS);
  return {
    ...actual,
    ALL_REPOSITORY_INSPECTION_ERROR_CODES: a1.codes,
    REPOSITORY_INSPECTION_ERROR_SUBJECTS: a1.subjects,
    REPOSITORY_RISK_SIGNALS: a1.signals,
    createRepositoryInspector: a1.createRepositoryInspector,
  };
});

const enabledFeature = {
  enabled: true,
  allowedSourceRoots: ['/srv/repositories'],
  reservedDataRoot: '/var/lib/craftingtable',
  artifactRoot: '/var/lib/craftingtable/artifacts',
  managedWorktreeRoot: '/var/lib/craftingtable/worktrees',
  gitExecutable: '/usr/bin/git',
  commandTimeoutMs: 5000,
  creationTimeoutMs: 15000,
  inspectionTimeoutMs: 15000,
  stdoutLimitBytes: 65536,
  stderrLimitBytes: 65536,
  terminationGraceMs: 250,
  retryDelayMs: 5000,
} as const satisfies RepositoryFeatureConfig;

function validObservation(
  changes: {
    readonly inspectionPolicyVersion?: number;
    readonly canonicalTopLevel?: string;
    readonly topLevelDevice?: string;
    readonly riskSignals?: readonly (typeof STORED_REPOSITORY_RISK_SIGNALS)[number][];
  } = {},
) {
  const signals = changes.riskSignals ?? [];
  const draft: RepositoryObservationShape = {
    observationVersion: REPOSITORY_OBSERVATION_VERSION,
    inspectionPolicyVersion:
      changes.inspectionPolicyVersion ?? REPOSITORY_INSPECTION_POLICY_VERSION,
    observedAt: '2026-08-11T00:00:00.000Z',
    gitVersion: { major: 2, minor: 45, patch: 1 },
    canonicalTopLevel: changes.canonicalTopLevel ?? '/srv/repositories/example',
    canonicalGitDirectory: '/srv/repositories/example/.git',
    canonicalCommonGitDirectory: '/srv/repositories/example/.git',
    objectFormat: 'sha1',
    coreIdentity: {
      topLevelInode: '100',
      commonDirectoryInode: '101',
      fingerprintSha256: '0'.repeat(64),
    },
    environmentalEvidence: {
      topLevelDevice: changes.topLevelDevice ?? '10',
      commonDirectoryDevice: '10',
    },
    riskScan: {
      scanScopeVersion: REPOSITORY_RISK_SCAN_SCOPE_VERSION,
      scannedKeyPattern: REPOSITORY_RISK_SCAN_PATTERN,
      classification: signals.length === 0 ? 'no-signals-in-scanned-set' : 'signals-observed',
      signals,
    },
  };
  return {
    ...draft,
    coreIdentity: {
      ...draft.coreIdentity,
      fingerprintSha256: calculateCoreIdentityFingerprint(draft),
    },
  };
}

function parsedObservation(changes: Parameters<typeof validObservation>[0] = {}) {
  const result = parseRecordedObservation(validObservation(changes));
  if (!result.ok) {
    throw new Error(`Fixture rejected: ${result.error.code}`);
  }
  return result.observation;
}

function inspectionFromEvidence(
  evidence: RepositoryObservationEvidence,
): SuccessfulRepositoryInspection {
  return {
    sequence: 1,
    id: 'inspection-1' as never,
    workspaceId: 'workspace-1' as never,
    repositoryId: 'repository-1' as never,
    actorUserId: 'user-1' as never,
    createdAt: '2026-08-11T00:00:01.000Z',
    kind: 'verification',
    outcome: 'succeeded',
    ...evidence,
  };
}

function repositoryFromEvidence(evidence: RepositoryObservationEvidence): RegisteredRepository {
  return {
    id: 'repository-1' as never,
    workspaceId: 'workspace-1' as never,
    displayName: 'Example',
    canonicalTopLevel: evidence.canonicalTopLevel,
    canonicalGitDirectory: evidence.canonicalGitDirectory,
    canonicalCommonGitDirectory: evidence.canonicalCommonGitDirectory,
    objectFormat: evidence.objectFormat,
    topLevelInode: evidence.topLevelInode,
    commonDirectoryInode: evidence.commonDirectoryInode,
    coreFingerprintSha256: evidence.coreFingerprintSha256,
    observationVersion: evidence.observationVersion,
    inspectionPolicyVersion: evidence.inspectionPolicyVersion,
    registrationInspectionId: 'inspection-registration' as never,
    acceptedEnvironmentInspectionId: 'inspection-1' as never,
    status: 'active',
    statusReason: 'registration-accepted',
    registeredByUserId: 'user-1' as never,
    registeredAt: '2026-08-11T00:00:00.000Z',
    statusChangedByUserId: 'user-1' as never,
    statusChangedAt: '2026-08-11T00:00:00.000Z',
    version: 1,
  };
}

async function portFor(observation = parsedObservation(), onFault = vi.fn()) {
  const inspect = vi.fn().mockResolvedValue({ ok: true, observation });
  a1.createRepositoryInspector.mockResolvedValue({ ok: true, inspector: { inspect } });
  const created = await createRepositoryObservationPort(enabledFeature, onFault);
  if (!created.ok) {
    throw new Error(`Port creation failed: ${created.failure.reason}`);
  }
  return { port: created.port, inspect, onFault };
}

beforeEach(() => {
  a1.createRepositoryInspector.mockReset();
  a1.codes.splice(0, a1.codes.length, ...a1.realCodes);
  for (const key of Object.keys(a1.subjects)) {
    delete a1.subjects[key];
  }
  Object.assign(a1.subjects, a1.realSubjects);
  a1.signals.splice(0, a1.signals.length, ...a1.realSignals);
});

describe('repository observation adapter', () => {
  it('uses the real package-root fingerprint and parser for valid fixtures (B2-ADP-001/003 B2A-EVID-001)', () => {
    expect(a1.realCodes).toEqual(A1_REPOSITORY_INSPECTION_ERROR_CODES);
    expect(a1.realSubjects).toEqual(A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE);
    expect(a1.realSignals).toEqual(STORED_REPOSITORY_RISK_SIGNALS);
    expect(parseRecordedObservation(validObservation()).ok).toBe(true);
    expect(repositoryObservationVocabularyMatches()).toBe(true);
  });

  it('fails creation on missing, reordered, or remapped runtime vocabulary (B2-ADP-002 B2A-SRC-002 B2A-EVID-006)', async () => {
    a1.codes.pop();
    expect(repositoryObservationVocabularyMatches()).toBe(false);
    expect(await createRepositoryObservationPort(enabledFeature)).toEqual({
      ok: false,
      failure: { reason: 'adapter-vocabulary-mismatch', retryability: 'not-retryable' },
    });
    a1.codes.splice(0, a1.codes.length, ...A1_REPOSITORY_INSPECTION_ERROR_CODES.toReversed());
    expect(repositoryObservationVocabularyMatches()).toBe(false);
    a1.codes.splice(0, a1.codes.length, ...A1_REPOSITORY_INSPECTION_ERROR_CODES);
    a1.subjects['timed-out'] = 'host-environment';
    expect(repositoryObservationVocabularyMatches()).toBe(false);
  });

  it('round-trips inspect output through all stored and repository projections (B2-ADP-003 B2A-SRC-003 B2A-EVID-001)', async () => {
    const { port } = await portFor();
    const inspected = await port.inspect({ requestedPath: '/srv/repositories/example' });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.evidence).toMatchObject(serializeRepositoryObservation(parsedObservation()));
    const stored = port.verifyStored(inspectionFromEvidence(inspected.evidence));
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const baseline = port.verifyRegisteredIdentity(
      repositoryFromEvidence(inspected.evidence),
      stored.observation,
    );
    expect(baseline.ok).toBe(true);
  });

  it('rejects a byte mutation at the digest gate before host inspection (B2-ADP-004 B2A-SRC-003 B2A-EVID-002)', async () => {
    const { port, inspect } = await portFor();
    const evidence = inspectionFromEvidence((await successfulInspection(port)).evidence);
    const result = port.verifyStored({
      ...evidence,
      observationJson: `${evidence.observationJson} `,
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: 'stored-digest-mismatch' },
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON and A1-invalid records with truthful internal reasons (B2-ADP-005 B2A-SRC-004 B2A-EVID-003/004)', async () => {
    const { port } = await portFor();
    const base = inspectionFromEvidence((await successfulInspection(port)).evidence);
    const invalidJson = '{';
    expect(
      port.verifyStored({
        ...base,
        observationJson: invalidJson,
        observationSha256: sha256ExactUtf8(invalidJson),
      }),
    ).toMatchObject({ ok: false, failure: { reason: 'stored-json-invalid' } });
    const invalidRecord = JSON.stringify({ hello: 'world' });
    expect(
      port.verifyStored({
        ...base,
        observationJson: invalidRecord,
        observationSha256: sha256ExactUtf8(invalidRecord),
      }),
    ).toMatchObject({ ok: false, failure: { reason: 'a1-record-invalid' } });
    const unsupportedRecord = JSON.stringify({ ...validObservation(), observationVersion: 2 });
    expect(
      port.verifyStored({
        ...base,
        observationJson: unsupportedRecord,
        observationSha256: sha256ExactUtf8(unsupportedRecord),
      }),
    ).toMatchObject({ ok: false, failure: { reason: 'unsupported-observation-version' } });
  });

  it('checks every one of the 16 inspection projections (B2-ADP-006 B2A-SRC-005 B2A-EVID-005)', async () => {
    const { port } = await portFor();
    const base = inspectionFromEvidence((await successfulInspection(port)).evidence);
    const mutations: readonly [keyof SuccessfulRepositoryInspection, unknown][] = [
      ['observationVersion', 2],
      ['inspectionPolicyVersion', 2],
      ['observedAt', '2026-08-12T00:00:00.000Z'],
      ['canonicalTopLevel', '/srv/repositories/other'],
      ['canonicalGitDirectory', '/srv/repositories/other/.git'],
      ['canonicalCommonGitDirectory', '/srv/repositories/common/.git'],
      ['objectFormat', 'sha256'],
      ['topLevelInode', '200'],
      ['commonDirectoryInode', '201'],
      ['coreFingerprintSha256', 'f'.repeat(64)],
      ['topLevelDevice', '20'],
      ['commonDirectoryDevice', '20'],
      ['riskScanScopeVersion', 2],
      ['riskScannedKeyPattern', '^other$'],
      ['riskClassification', 'signals-observed'],
      ['riskSignals', ['core-hooks-path']],
    ];
    for (const [field, value] of mutations) {
      expect(port.verifyStored({ ...base, [field]: value } as never)).toMatchObject({
        ok: false,
        failure: { reason: 'projected-inspection-mismatch' },
      });
    }
  });

  it('checks all nine repository identity/version projections before comparison (B2-ADP-006 B2A-SRC-005 B2A-EVID-005)', async () => {
    const { port } = await portFor();
    const inspected = await successfulInspection(port);
    const stored = port.verifyStored(inspectionFromEvidence(inspected.evidence));
    if (!stored.ok) throw new Error('Expected verified stored observation');
    const repository = repositoryFromEvidence(inspected.evidence);
    const mutations: readonly [keyof RegisteredRepository, unknown][] = [
      ['observationVersion', 2],
      ['inspectionPolicyVersion', 2],
      ['canonicalTopLevel', '/srv/repositories/other'],
      ['canonicalGitDirectory', '/srv/repositories/other/.git'],
      ['canonicalCommonGitDirectory', '/srv/repositories/common/.git'],
      ['objectFormat', 'sha256'],
      ['topLevelInode', '200'],
      ['commonDirectoryInode', '201'],
      ['coreFingerprintSha256', 'f'.repeat(64)],
    ];
    for (const [field, value] of mutations) {
      expect(
        port.verifyRegisteredIdentity(
          { ...repository, [field]: value } as never,
          stored.observation,
        ),
      ).toMatchObject({
        ok: false,
        failure: { reason: 'registered-identity-mismatch' },
      });
    }
  });

  it('lets A1 comparison own historical policy comparability (B2-ADP-005 B2A-EVID-004)', async () => {
    const recorded = parsedObservation({ inspectionPolicyVersion: 2 });
    const { port } = await portFor(recorded);
    const recordedResult = await successfulInspection(port);
    const stored = port.verifyStored(inspectionFromEvidence(recordedResult.evidence));
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const baselineResult = port.verifyRegisteredIdentity(
      repositoryFromEvidence(recordedResult.evidence),
      stored.observation,
    );
    if (!baselineResult.ok) throw new Error('Expected verified baseline');
    const current = parsedObservation();
    a1.createRepositoryInspector.mockResolvedValue({
      ok: true,
      inspector: { inspect: vi.fn().mockResolvedValue({ ok: true, observation: current }) },
    });
    const currentCreated = await createRepositoryObservationPort(enabledFeature);
    if (!currentCreated.ok) throw new Error('Expected current port');
    const currentResult = await successfulInspection(currentCreated.port);
    expect(port.compare(baselineResult.baseline, currentResult.evidence)).toMatchObject({
      ok: false,
      failure: { reason: 'comparison-policy-version-mismatch' },
    });
  });

  it('retains core, environment, and risk arrays under core priority (B2-ADP-009/010 B2A-ASMT-002/003/004)', async () => {
    const { port } = await portFor();
    const recorded = await successfulInspection(port);
    const baseline = verifiedBaseline(port, recorded.evidence);
    const currentObservation = parsedObservation({
      canonicalTopLevel: '/srv/repositories/moved',
      topLevelDevice: '20',
      riskSignals: ['core-hooks-path'],
    });
    const currentPort = await portFor(currentObservation);
    const current = await successfulInspection(currentPort.port);
    expect(port.compare(baseline, current.evidence)).toMatchObject({
      ok: true,
      coreDifferences: ['canonical-top-level', 'fingerprint'],
      environmentalDifferences: ['top-level-device'],
      riskDifferences: ['signals'],
      assessment: { kind: 'core-identity-changed' },
    });
  });

  it('latches runtime tuple drift and refuses later A1 calls (B2-ADP-002 B2A-SRC-002 B2A-EVID-006)', async () => {
    const error: RepositoryInspectionError = {
      category: 'configuration',
      code: 'timed-out',
      subject: 'git-boundary-fault',
      operation: 'inspect-path',
      retryability: 'retryable',
      message: 'drifted',
      evidence: {},
    };
    const inspect = vi.fn().mockResolvedValue({ ok: false, error });
    a1.createRepositoryInspector.mockResolvedValue({ ok: true, inspector: { inspect } });
    const onFault = vi.fn();
    const created = await createRepositoryObservationPort(enabledFeature, onFault);
    if (!created.ok) throw new Error('Expected created port');
    expect(await created.port.inspect({ requestedPath: '/srv/repositories/example' })).toEqual({
      ok: false,
      failure: { kind: 'adapter-error', reason: 'adapter-invariant-fault' },
    });
    expect(onFault).toHaveBeenCalledTimes(1);
    await created.port.inspect({ requestedPath: '/srv/repositories/example' });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('treats defensive compare reparse failure as an invariant fault without an assessment (B2A-EVID-006)', async () => {
    const onFault = vi.fn();
    const { port } = await portFor(parsedObservation(), onFault);
    const inspected = await successfulInspection(port);
    const baseline = verifiedBaseline(port, inspected.evidence);
    const castBaseline = {
      ...baseline,
      observation: {
        ...baseline.observation,
        evidence: {
          ...baseline.observation.evidence,
          observationJson: '{',
        },
      },
    } as never;
    expect(port.compare(castBaseline, inspected.evidence)).toEqual({
      ok: false,
      failure: { kind: 'adapter-error', reason: 'adapter-invariant-fault' },
    });
    expect(onFault).toHaveBeenCalledTimes(1);
  });
});

async function successfulInspection(port: RepositoryObservationPort) {
  const result = await port.inspect({ requestedPath: '/srv/repositories/example' });
  if (!result.ok) {
    throw new Error(`Expected inspection success: ${result.failure.kind}`);
  }
  return result;
}

function verifiedBaseline(
  port: RepositoryObservationPort,
  evidence: RepositoryObservationEvidence,
): VerifiedRepositoryBaseline {
  const stored = port.verifyStored(inspectionFromEvidence(evidence));
  if (!stored.ok) throw new Error('Expected verified stored observation');
  const baseline = port.verifyRegisteredIdentity(
    repositoryFromEvidence(evidence),
    stored.observation,
  );
  if (!baseline.ok) throw new Error('Expected verified baseline');
  return baseline.baseline;
}
