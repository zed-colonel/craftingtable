import {
  A1_REPOSITORY_INSPECTION_ERROR_CODES,
  A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE,
  normalizeRepositoryErrorEvidence,
  type A1RepositoryInspectionErrorCode,
  type A1RepositoryInspectionErrorSubject,
  type A1RepositoryInspectionOperation,
  type RepositoryObservationAssessment,
  type StoredCoreEvidenceDifference,
  type StoredEnvironmentalEvidenceDifference,
  type StoredRepositoryInspectionErrorCategory,
  type StoredRepositoryInspectionRetryability,
  type StoredRiskEvidenceDifference,
} from '@craftingtable/domain';
import type {
  NormalizedRepositoryA1Failure,
  RepositoryAdapterFailure,
} from './repository-observation-port.js';

export interface A1ErrorLike {
  readonly code: string;
  readonly subject: string;
  readonly category: string;
  readonly operation: string;
  readonly retryability: string;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

type AssessmentPolicy =
  | 'no-state-change'
  | 'path-unavailable'
  | 'metadata-unreadable'
  | 'repository-class-changed'
  | 'stored-evidence-invalid'
  | 'unsupported-observation-version'
  | 'inspection-policy-version-mismatch';

type RepositoryClassChangedReason = Extract<
  RepositoryObservationAssessment,
  { readonly kind: 'repository-class-changed' }
>['reason'];

const REPOSITORY_CLASS_CHANGED_REASONS = new Set<RepositoryClassChangedReason>([
  'symlink-rejected',
  'ownership-refused',
  'not-primary-repository',
  'not-git-repository',
  'unsupported-object-format',
  'unsupported-repository-extension',
]);

const A1_SUBJECT_KEYS = {
  'caller-input': true,
  'policy-configuration': true,
  'host-environment': true,
  'repository-unavailable': true,
  'repository-class-changed': true,
  'git-boundary-fault': true,
  'recorded-evidence-invalid': true,
  'evidence-not-comparable': true,
} as const satisfies Record<A1RepositoryInspectionErrorSubject, true>;

const A1_CATEGORY_KEYS = {
  configuration: true,
  'path-policy': true,
  'git-process': true,
  observation: true,
} as const satisfies Record<StoredRepositoryInspectionErrorCategory, true>;

const A1_OPERATION_KEYS = {
  'create-inspector': true,
  'inspect-path': true,
  'parse-recorded-observation': true,
  'compare-observations': true,
} as const satisfies Record<A1RepositoryInspectionOperation, true>;

const A1_RETRYABILITY_KEYS = {
  retryable: true,
  'configuration-required': true,
  'not-retryable': true,
} as const satisfies Record<StoredRepositoryInspectionRetryability, true>;

const OPERATIONS_BY_CODE = {
  'invalid-options': ['create-inspector'],
  'unsupported-platform': ['create-inspector'],
  'root-daemon-refused': ['create-inspector'],
  'invalid-root-policy': ['create-inspector'],
  'git-not-found': ['create-inspector'],
  'git-not-executable': ['create-inspector'],
  'git-executable-changed': ['create-inspector', 'inspect-path'],
  'unsupported-git-version': ['create-inspector'],
  'invalid-path': ['inspect-path'],
  'outside-allowed-root': ['inspect-path'],
  'reserved-root-overlap': ['inspect-path'],
  'path-unavailable': ['inspect-path'],
  'symlink-rejected': ['inspect-path'],
  'ownership-refused': ['inspect-path'],
  'repository-metadata-unreadable': ['inspect-path'],
  'not-primary-repository': ['inspect-path'],
  'not-git-repository': ['inspect-path'],
  'unsupported-object-format': ['inspect-path'],
  'unsupported-repository-extension': ['inspect-path'],
  'spawn-failed': ['create-inspector', 'inspect-path'],
  aborted: ['inspect-path'],
  'timed-out': ['create-inspector', 'inspect-path'],
  'stdout-overflow': ['create-inspector', 'inspect-path'],
  'stderr-overflow': ['create-inspector', 'inspect-path'],
  'signal-terminated': ['create-inspector', 'inspect-path'],
  'git-command-failed': ['create-inspector', 'inspect-path'],
  'invalid-output-encoding': ['inspect-path'],
  'malformed-version-output': ['create-inspector'],
  'malformed-identity-output': ['inspect-path'],
  'malformed-feature-output': ['inspect-path'],
  'feature-count-exceeded': ['inspect-path'],
  'observation-raced': ['inspect-path'],
  'recorded-observation-invalid': ['parse-recorded-observation'],
  'unsupported-observation-version': ['parse-recorded-observation'],
  'inspection-policy-version-mismatch': ['compare-observations'],
} as const satisfies Record<
  A1RepositoryInspectionErrorCode,
  readonly A1RepositoryInspectionOperation[]
>;

function hasOwnKey(record: Readonly<Record<string, true>>, key: string): boolean {
  return Object.hasOwn(record, key);
}

const ASSESSMENT_BY_CODE = {
  'invalid-options': 'no-state-change',
  'unsupported-platform': 'no-state-change',
  'root-daemon-refused': 'no-state-change',
  'invalid-root-policy': 'no-state-change',
  'git-not-found': 'no-state-change',
  'git-not-executable': 'no-state-change',
  'git-executable-changed': 'no-state-change',
  'unsupported-git-version': 'no-state-change',
  'invalid-path': 'no-state-change',
  'outside-allowed-root': 'no-state-change',
  'reserved-root-overlap': 'no-state-change',
  'path-unavailable': 'path-unavailable',
  'symlink-rejected': 'repository-class-changed',
  'ownership-refused': 'repository-class-changed',
  'repository-metadata-unreadable': 'metadata-unreadable',
  'not-primary-repository': 'repository-class-changed',
  'not-git-repository': 'repository-class-changed',
  'unsupported-object-format': 'repository-class-changed',
  'unsupported-repository-extension': 'repository-class-changed',
  'spawn-failed': 'no-state-change',
  aborted: 'no-state-change',
  'timed-out': 'no-state-change',
  'stdout-overflow': 'no-state-change',
  'stderr-overflow': 'no-state-change',
  'signal-terminated': 'no-state-change',
  'git-command-failed': 'no-state-change',
  'invalid-output-encoding': 'no-state-change',
  'malformed-version-output': 'no-state-change',
  'malformed-identity-output': 'no-state-change',
  'malformed-feature-output': 'no-state-change',
  'feature-count-exceeded': 'no-state-change',
  'observation-raced': 'no-state-change',
  'recorded-observation-invalid': 'stored-evidence-invalid',
  'unsupported-observation-version': 'unsupported-observation-version',
  'inspection-policy-version-mismatch': 'inspection-policy-version-mismatch',
} as const satisfies Record<A1RepositoryInspectionErrorCode, AssessmentPolicy>;

function expectedCategory(
  subject: A1RepositoryInspectionErrorSubject,
): StoredRepositoryInspectionErrorCategory {
  switch (subject) {
    case 'policy-configuration':
    case 'host-environment':
      return 'configuration';
    case 'caller-input':
    case 'repository-unavailable':
    case 'repository-class-changed':
      return 'path-policy';
    case 'git-boundary-fault':
      return 'git-process';
    case 'recorded-evidence-invalid':
    case 'evidence-not-comparable':
      return 'observation';
  }
}

function expectedRetryability(
  subject: A1RepositoryInspectionErrorSubject,
): StoredRepositoryInspectionRetryability {
  switch (subject) {
    case 'repository-unavailable':
    case 'git-boundary-fault':
    case 'host-environment':
      return 'retryable';
    case 'policy-configuration':
      return 'configuration-required';
    case 'caller-input':
    case 'repository-class-changed':
    case 'recorded-evidence-invalid':
    case 'evidence-not-comparable':
      return 'not-retryable';
  }
}

function assessmentFor(
  code: A1RepositoryInspectionErrorCode,
  policy: AssessmentPolicy,
): RepositoryObservationAssessment {
  switch (policy) {
    case 'no-state-change':
      return { kind: 'no-state-change-failure' };
    case 'path-unavailable':
      return { kind: 'unavailable', reason: 'path-unavailable' };
    case 'metadata-unreadable':
      return { kind: 'unavailable', reason: 'metadata-unreadable' };
    case 'repository-class-changed':
      if (!REPOSITORY_CLASS_CHANGED_REASONS.has(code as RepositoryClassChangedReason)) {
        throw new Error('Repository class policy contains a non-class error code');
      }
      return { kind: 'repository-class-changed', reason: code as RepositoryClassChangedReason };
    case 'stored-evidence-invalid':
      return { kind: 'evidence-invalid', reason: 'stored-evidence-invalid' };
    case 'unsupported-observation-version':
      return { kind: 'evidence-invalid', reason: 'unsupported-observation-version' };
    case 'inspection-policy-version-mismatch':
      return { kind: 'evidence-invalid', reason: 'inspection-policy-version-mismatch' };
  }
}

export function normalizeAndAssessA1Error(
  error: A1ErrorLike,
): NormalizedRepositoryA1Failure | RepositoryAdapterFailure {
  if (!(A1_REPOSITORY_INSPECTION_ERROR_CODES as readonly string[]).includes(error.code)) {
    return { kind: 'adapter-error', reason: 'adapter-invariant-fault' };
  }
  const code = error.code as A1RepositoryInspectionErrorCode;
  const subject = A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE[code];
  if (
    error.subject !== subject ||
    error.category !== expectedCategory(subject) ||
    error.retryability !== expectedRetryability(subject) ||
    !hasOwnKey(A1_SUBJECT_KEYS, error.subject) ||
    !hasOwnKey(A1_CATEGORY_KEYS, error.category) ||
    !hasOwnKey(A1_OPERATION_KEYS, error.operation) ||
    !(OPERATIONS_BY_CODE[code] as readonly string[]).includes(error.operation) ||
    !hasOwnKey(A1_RETRYABILITY_KEYS, error.retryability)
  ) {
    return { kind: 'adapter-error', reason: 'adapter-invariant-fault' };
  }
  return {
    kind: 'a1-error',
    code,
    subject,
    category: error.category as StoredRepositoryInspectionErrorCategory,
    operation: error.operation as A1RepositoryInspectionOperation,
    retryability: error.retryability as StoredRepositoryInspectionRetryability,
    evidence: normalizeRepositoryErrorEvidence(error.evidence),
    assessment: assessmentFor(code, ASSESSMENT_BY_CODE[code]),
  };
}

export function assessObservationDifferences(input: {
  readonly coreDifferences: readonly StoredCoreEvidenceDifference[];
  readonly environmentalDifferences: readonly StoredEnvironmentalEvidenceDifference[];
  readonly riskDifferences: readonly StoredRiskEvidenceDifference[];
}): RepositoryObservationAssessment {
  if (input.coreDifferences.length > 0) {
    return { kind: 'core-identity-changed', differences: input.coreDifferences };
  }
  if (input.environmentalDifferences.length > 0) {
    return {
      kind: 'environment-evidence-changed',
      differences: input.environmentalDifferences,
    };
  }
  if (input.riskDifferences.length > 0) {
    return { kind: 'risk-evidence-changed', differences: input.riskDifferences };
  }
  return { kind: 'same' };
}

export const A1_ERROR_ASSESSMENT_POLICY = ASSESSMENT_BY_CODE;
export const A1_ERROR_OPERATION_POLICY = OPERATIONS_BY_CODE;
