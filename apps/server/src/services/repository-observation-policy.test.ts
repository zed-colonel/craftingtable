import {
  A1_REPOSITORY_INSPECTION_ERROR_CODES,
  A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE,
  type A1RepositoryInspectionErrorCode,
  type A1RepositoryInspectionErrorSubject,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  A1_ERROR_ASSESSMENT_POLICY,
  assessObservationDifferences,
  normalizeAndAssessA1Error,
} from './repository-observation-policy.js';

function category(subject: A1RepositoryInspectionErrorSubject) {
  if (subject === 'policy-configuration' || subject === 'host-environment') {
    return 'configuration' as const;
  }
  if (
    subject === 'caller-input' ||
    subject === 'repository-unavailable' ||
    subject === 'repository-class-changed'
  ) {
    return 'path-policy' as const;
  }
  if (subject === 'git-boundary-fault') {
    return 'git-process' as const;
  }
  return 'observation' as const;
}

function retryability(subject: A1RepositoryInspectionErrorSubject) {
  if (
    subject === 'repository-unavailable' ||
    subject === 'git-boundary-fault' ||
    subject === 'host-environment'
  ) {
    return 'retryable' as const;
  }
  return subject === 'policy-configuration'
    ? ('configuration-required' as const)
    : ('not-retryable' as const);
}

function actualError(code: A1RepositoryInspectionErrorCode) {
  const subject = A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE[code];
  return {
    code,
    subject,
    category: category(subject),
    operation:
      code === 'recorded-observation-invalid' || code === 'unsupported-observation-version'
        ? 'parse-recorded-observation'
        : code === 'inspection-policy-version-mismatch'
          ? 'compare-observations'
          : 'inspect-path',
    retryability: retryability(subject),
    evidence: {},
  } as const;
}

describe('repository observation policy', () => {
  it('maps every A1 code exactly once and keeps operational failures non-identity judgments (B2-ADP-008 B2A-SRC-007 B2A-ASMT-005/006)', () => {
    expect(Object.keys(A1_ERROR_ASSESSMENT_POLICY)).toEqual(A1_REPOSITORY_INSPECTION_ERROR_CODES);
    const results = Object.fromEntries(
      A1_REPOSITORY_INSPECTION_ERROR_CODES.map((code) => [
        code,
        normalizeAndAssessA1Error(actualError(code)),
      ]),
    );
    expect(results['path-unavailable']).toMatchObject({
      assessment: { kind: 'unavailable', reason: 'path-unavailable' },
    });
    expect(results['repository-metadata-unreadable']).toMatchObject({
      assessment: { kind: 'unavailable', reason: 'metadata-unreadable' },
    });
    for (const code of [
      'observation-raced',
      'timed-out',
      'stdout-overflow',
      'stderr-overflow',
      'spawn-failed',
      'aborted',
      'malformed-identity-output',
      'malformed-feature-output',
    ]) {
      expect(results[code]).toMatchObject({ assessment: { kind: 'no-state-change-failure' } });
    }
  });

  it('rejects runtime category, retryability, subject, operation, and code drift (B2-ADP-002 B2A-SRC-002 B2A-EVID-006)', () => {
    const valid = actualError('timed-out');
    for (const mutation of [
      { ...valid, category: 'configuration' },
      { ...valid, retryability: 'not-retryable' },
      { ...valid, subject: 'host-environment' },
      { ...valid, operation: 'invented' },
      { ...valid, code: 'invented' },
    ]) {
      expect(normalizeAndAssessA1Error(mutation)).toEqual({
        kind: 'adapter-error',
        reason: 'adapter-invariant-fault',
      });
    }
  });

  it('prioritizes core, then environment, then risk while retaining caller arrays (B2-ADP-009/010 B2A-ASMT-002/003/004)', () => {
    expect(
      assessObservationDifferences({
        coreDifferences: ['fingerprint'],
        environmentalDifferences: ['top-level-device'],
        riskDifferences: ['signals'],
      }),
    ).toEqual({ kind: 'core-identity-changed', differences: ['fingerprint'] });
    expect(
      assessObservationDifferences({
        coreDifferences: [],
        environmentalDifferences: ['top-level-device'],
        riskDifferences: ['signals'],
      }),
    ).toEqual({
      kind: 'environment-evidence-changed',
      differences: ['top-level-device'],
    });
    expect(
      assessObservationDifferences({
        coreDifferences: [],
        environmentalDifferences: [],
        riskDifferences: ['signals'],
      }),
    ).toEqual({ kind: 'risk-evidence-changed', differences: ['signals'] });
  });
});
