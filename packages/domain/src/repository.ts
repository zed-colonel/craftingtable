import type {
  ProjectId,
  ProjectRepositoryBindingId,
  RepositoryId,
  RepositoryInspectionId,
  UserId,
  WorkspaceId,
} from './ids.js';

export const REPOSITORY_STATUSES = [
  'active',
  'unavailable',
  'identity-evidence-changed',
  'identity-mismatch',
  'evidence-blocked',
  'retired',
] as const;
export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number];

export const REPOSITORY_STATUS_REASONS = [
  'registration-accepted',
  'evidence-matches',
  'environment-evidence-changed',
  'core-identity-changed',
  'repository-class-changed',
  'path-unavailable',
  'metadata-unreadable',
  'stored-evidence-digest-mismatch',
  'stored-evidence-invalid',
  'unsupported-observation-version',
  'inspection-policy-version-mismatch',
  'environment-evidence-reaffirmed',
  'operator-retired',
] as const;
export type RepositoryStatusReason = (typeof REPOSITORY_STATUS_REASONS)[number];

export const REPOSITORY_STATUS_REASON_SETS = {
  active: ['registration-accepted', 'evidence-matches', 'environment-evidence-reaffirmed'],
  unavailable: ['path-unavailable', 'metadata-unreadable'],
  'identity-evidence-changed': ['environment-evidence-changed'],
  'identity-mismatch': ['core-identity-changed', 'repository-class-changed'],
  'evidence-blocked': [
    'stored-evidence-digest-mismatch',
    'stored-evidence-invalid',
    'unsupported-observation-version',
    'inspection-policy-version-mismatch',
  ],
  retired: ['operator-retired'],
} as const satisfies Readonly<Record<RepositoryStatus, readonly RepositoryStatusReason[]>>;

export const REPOSITORY_INSPECTION_KINDS = [
  'registration',
  'verification',
  'reaffirmation',
] as const;
export type RepositoryInspectionKind = (typeof REPOSITORY_INSPECTION_KINDS)[number];

export const REPOSITORY_INSPECTION_OUTCOMES = ['succeeded', 'failed'] as const;
export type RepositoryInspectionOutcome = (typeof REPOSITORY_INSPECTION_OUTCOMES)[number];

export const PROJECT_REPOSITORY_BINDING_STATUSES = ['active', 'retired'] as const;
export type ProjectRepositoryBindingStatus = (typeof PROJECT_REPOSITORY_BINDING_STATUSES)[number];

export const STORED_REPOSITORY_OBSERVATION_VERSION = 1 as const;
export const STORED_REPOSITORY_RISK_SCAN_SCOPE_VERSION = 1 as const;
export const STORED_REPOSITORY_RISK_SCAN_PATTERN =
  '^(extensions\\.worktreeconfig|core\\.(hookspath|fsmonitor|worktree)|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process)|include\\.path|includeif\\..*\\.path)$' as const;

export const STORED_REPOSITORY_RISK_SIGNALS = [
  'core-hooks-path',
  'core-fsmonitor',
  'core-worktree-redirection',
  'diff-external',
  'diff-driver-command',
  'diff-driver-textconv',
  'filter-clean',
  'filter-smudge',
  'filter-process',
  'config-include',
  'conditional-config-include',
  'worktree-config-enabled',
  'hooks-directory-symlink',
  'hook-entry',
] as const;
export type StoredRepositoryRiskSignal = (typeof STORED_REPOSITORY_RISK_SIGNALS)[number];

export const STORED_CORE_EVIDENCE_DIFFERENCES = [
  'canonical-top-level',
  'canonical-git-directory',
  'canonical-common-git-directory',
  'object-format',
  'top-level-inode',
  'common-directory-inode',
  'fingerprint',
] as const;
export type StoredCoreEvidenceDifference = (typeof STORED_CORE_EVIDENCE_DIFFERENCES)[number];

export const STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES = [
  'top-level-device',
  'common-directory-device',
] as const;
export type StoredEnvironmentalEvidenceDifference =
  (typeof STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES)[number];

export const STORED_RISK_EVIDENCE_DIFFERENCES = [
  'scan-scope-version',
  'scanned-key-pattern',
  'signals',
] as const;
export type StoredRiskEvidenceDifference = (typeof STORED_RISK_EVIDENCE_DIFFERENCES)[number];

export const A1_REPOSITORY_INSPECTION_ERROR_CODES = [
  'invalid-options',
  'unsupported-platform',
  'root-daemon-refused',
  'invalid-root-policy',
  'git-not-found',
  'git-not-executable',
  'git-executable-changed',
  'unsupported-git-version',
  'invalid-path',
  'outside-allowed-root',
  'reserved-root-overlap',
  'path-unavailable',
  'symlink-rejected',
  'ownership-refused',
  'repository-metadata-unreadable',
  'not-primary-repository',
  'not-git-repository',
  'unsupported-object-format',
  'unsupported-repository-extension',
  'spawn-failed',
  'aborted',
  'timed-out',
  'stdout-overflow',
  'stderr-overflow',
  'signal-terminated',
  'git-command-failed',
  'invalid-output-encoding',
  'malformed-version-output',
  'malformed-identity-output',
  'malformed-feature-output',
  'feature-count-exceeded',
  'observation-raced',
  'recorded-observation-invalid',
  'unsupported-observation-version',
  'inspection-policy-version-mismatch',
] as const;
export type A1RepositoryInspectionErrorCode = (typeof A1_REPOSITORY_INSPECTION_ERROR_CODES)[number];

export const STORED_REPOSITORY_INSPECTION_ERROR_CODES = [
  ...A1_REPOSITORY_INSPECTION_ERROR_CODES,
  'stored-evidence-digest-mismatch',
] as const;
export type StoredRepositoryInspectionErrorCode =
  (typeof STORED_REPOSITORY_INSPECTION_ERROR_CODES)[number];

export const A1_REPOSITORY_INSPECTION_ERROR_SUBJECTS = [
  'caller-input',
  'policy-configuration',
  'host-environment',
  'repository-unavailable',
  'repository-class-changed',
  'git-boundary-fault',
  'recorded-evidence-invalid',
  'evidence-not-comparable',
] as const;
export type A1RepositoryInspectionErrorSubject =
  (typeof A1_REPOSITORY_INSPECTION_ERROR_SUBJECTS)[number];
export const STORED_REPOSITORY_INSPECTION_ERROR_SUBJECTS = [
  ...A1_REPOSITORY_INSPECTION_ERROR_SUBJECTS,
  'stored-evidence-integrity',
] as const;
export type StoredRepositoryInspectionErrorSubject =
  (typeof STORED_REPOSITORY_INSPECTION_ERROR_SUBJECTS)[number];

export const STORED_REPOSITORY_INSPECTION_ERROR_CATEGORIES = [
  'configuration',
  'path-policy',
  'git-process',
  'observation',
] as const;
export type StoredRepositoryInspectionErrorCategory =
  (typeof STORED_REPOSITORY_INSPECTION_ERROR_CATEGORIES)[number];

export const A1_REPOSITORY_INSPECTION_OPERATIONS = [
  'create-inspector',
  'inspect-path',
  'parse-recorded-observation',
  'compare-observations',
] as const;
export type A1RepositoryInspectionOperation = (typeof A1_REPOSITORY_INSPECTION_OPERATIONS)[number];
export const STORED_REPOSITORY_INSPECTION_OPERATIONS = [
  ...A1_REPOSITORY_INSPECTION_OPERATIONS,
  'verify-stored-record',
] as const;
export type StoredRepositoryInspectionOperation =
  (typeof STORED_REPOSITORY_INSPECTION_OPERATIONS)[number];

export const STORED_REPOSITORY_INSPECTION_RETRYABILITIES = [
  'retryable',
  'configuration-required',
  'not-retryable',
] as const;
export type StoredRepositoryInspectionRetryability =
  (typeof STORED_REPOSITORY_INSPECTION_RETRYABILITIES)[number];
export type StoredRepositoryInspectionErrorOrigin = 'a1' | 'storage-integrity';

export const A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE = {
  'invalid-options': 'policy-configuration',
  'unsupported-platform': 'host-environment',
  'root-daemon-refused': 'host-environment',
  'invalid-root-policy': 'policy-configuration',
  'git-not-found': 'host-environment',
  'git-not-executable': 'host-environment',
  'git-executable-changed': 'host-environment',
  'unsupported-git-version': 'host-environment',
  'invalid-path': 'caller-input',
  'outside-allowed-root': 'policy-configuration',
  'reserved-root-overlap': 'policy-configuration',
  'path-unavailable': 'repository-unavailable',
  'symlink-rejected': 'repository-class-changed',
  'ownership-refused': 'repository-class-changed',
  'repository-metadata-unreadable': 'repository-unavailable',
  'not-primary-repository': 'repository-class-changed',
  'not-git-repository': 'repository-class-changed',
  'unsupported-object-format': 'repository-class-changed',
  'unsupported-repository-extension': 'repository-class-changed',
  'spawn-failed': 'git-boundary-fault',
  aborted: 'host-environment',
  'timed-out': 'git-boundary-fault',
  'stdout-overflow': 'git-boundary-fault',
  'stderr-overflow': 'git-boundary-fault',
  'signal-terminated': 'git-boundary-fault',
  'git-command-failed': 'git-boundary-fault',
  'invalid-output-encoding': 'git-boundary-fault',
  'malformed-version-output': 'git-boundary-fault',
  'malformed-identity-output': 'git-boundary-fault',
  'malformed-feature-output': 'git-boundary-fault',
  'feature-count-exceeded': 'git-boundary-fault',
  'observation-raced': 'repository-unavailable',
  'recorded-observation-invalid': 'recorded-evidence-invalid',
  'unsupported-observation-version': 'recorded-evidence-invalid',
  'inspection-policy-version-mismatch': 'evidence-not-comparable',
} as const satisfies Readonly<
  Record<A1RepositoryInspectionErrorCode, A1RepositoryInspectionErrorSubject>
>;

export interface RegisteredRepository {
  readonly id: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly canonicalTopLevel: string;
  readonly canonicalGitDirectory: string;
  readonly canonicalCommonGitDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly topLevelInode: string;
  readonly commonDirectoryInode: string;
  readonly coreFingerprintSha256: string;
  readonly observationVersion: typeof STORED_REPOSITORY_OBSERVATION_VERSION;
  readonly inspectionPolicyVersion: number;
  readonly registrationInspectionId: RepositoryInspectionId;
  readonly acceptedEnvironmentInspectionId: RepositoryInspectionId;
  readonly status: RepositoryStatus;
  readonly statusReason: RepositoryStatusReason;
  readonly registeredByUserId: UserId;
  readonly registeredAt: string;
  readonly statusChangedByUserId: UserId;
  readonly statusChangedAt: string;
  readonly version: number;
}

interface RepositoryInspectionBase {
  readonly sequence: number;
  readonly id: RepositoryInspectionId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly actorUserId: UserId;
  readonly createdAt: string;
}

export interface SuccessfulRepositoryInspection extends RepositoryInspectionBase {
  readonly kind: RepositoryInspectionKind;
  readonly outcome: 'succeeded';
  readonly observationJson: string;
  readonly observationSha256: string;
  readonly observationVersion: typeof STORED_REPOSITORY_OBSERVATION_VERSION;
  readonly inspectionPolicyVersion: number;
  readonly observedAt: string;
  readonly canonicalTopLevel: string;
  readonly canonicalGitDirectory: string;
  readonly canonicalCommonGitDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly topLevelInode: string;
  readonly commonDirectoryInode: string;
  readonly coreFingerprintSha256: string;
  readonly topLevelDevice: string;
  readonly commonDirectoryDevice: string;
  readonly riskScanScopeVersion: typeof STORED_REPOSITORY_RISK_SCAN_SCOPE_VERSION;
  readonly riskScannedKeyPattern: string;
  readonly riskClassification: 'no-signals-in-scanned-set' | 'signals-observed';
  readonly riskSignals: readonly StoredRepositoryRiskSignal[];
  readonly coreDifferences?: readonly StoredCoreEvidenceDifference[];
  readonly environmentalDifferences?: readonly StoredEnvironmentalEvidenceDifference[];
  readonly riskDifferences?: readonly StoredRiskEvidenceDifference[];
}

export type NormalizedRepositoryErrorEvidence = Readonly<Record<string, string | number | boolean>>;

export interface FailedRepositoryInspection extends RepositoryInspectionBase {
  readonly kind: 'verification' | 'reaffirmation';
  readonly outcome: 'failed';
  readonly errorOrigin: StoredRepositoryInspectionErrorOrigin;
  readonly errorCode: StoredRepositoryInspectionErrorCode;
  readonly errorSubject: StoredRepositoryInspectionErrorSubject;
  readonly errorCategory: StoredRepositoryInspectionErrorCategory;
  readonly errorOperation: StoredRepositoryInspectionOperation;
  readonly errorRetryability: StoredRepositoryInspectionRetryability;
  readonly errorEvidence: NormalizedRepositoryErrorEvidence;
}

export type RepositoryInspection = SuccessfulRepositoryInspection | FailedRepositoryInspection;

export interface ProjectRepositoryBinding {
  readonly id: ProjectRepositoryBindingId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly repositoryId: RepositoryId;
  readonly status: ProjectRepositoryBindingStatus;
  readonly boundByUserId: UserId;
  readonly boundAt: string;
  readonly retiredByUserId?: UserId;
  readonly retiredAt?: string;
  readonly version: number;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) {
    return value;
  }
  let result = '';
  let used = 0;
  const encoder = new TextEncoder();
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (used + bytes > maximumBytes) {
      break;
    }
    result += character;
    used += bytes;
  }
  return result;
}

export function normalizeRepositoryErrorEvidence(
  value: Readonly<Record<string, string | number | boolean>>,
): NormalizedRepositoryErrorEvidence {
  const accepted: Record<string, string | number | boolean> = {};
  try {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const [key, candidate] of entries) {
      if (
        Object.keys(accepted).length === 16 ||
        key.length > 64 ||
        !/^[A-Za-z][A-Za-z0-9]*$/.test(key)
      ) {
        continue;
      }
      let normalized: string | number | boolean;
      if (typeof candidate === 'string') {
        normalized = truncateUtf8(candidate, 2048);
      } else if (typeof candidate === 'boolean') {
        normalized = candidate;
      } else if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        normalized = candidate;
      } else {
        continue;
      }
      const proposed = { ...accepted, [key]: normalized };
      if (new TextEncoder().encode(JSON.stringify(proposed)).byteLength <= 8192) {
        accepted[key] = normalized;
      }
    }
  } catch {
    // Return the deterministic prefix accumulated before an exotic accessor
    // or serialization failure. Recording the failure is more important than
    // retaining every diagnostic field.
  }
  return Object.freeze({ ...accepted });
}

export type RepositoryObservationAssessment =
  | { readonly kind: 'same' }
  | {
      readonly kind: 'risk-evidence-changed';
      readonly differences: readonly StoredRiskEvidenceDifference[];
    }
  | {
      readonly kind: 'environment-evidence-changed';
      readonly differences: readonly StoredEnvironmentalEvidenceDifference[];
    }
  | {
      readonly kind: 'core-identity-changed';
      readonly differences: readonly StoredCoreEvidenceDifference[];
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'path-unavailable' | 'metadata-unreadable';
    }
  | {
      readonly kind: 'evidence-invalid';
      readonly reason:
        | 'stored-evidence-digest-mismatch'
        | 'stored-evidence-invalid'
        | 'unsupported-observation-version'
        | 'inspection-policy-version-mismatch';
    }
  | { readonly kind: 'no-state-change-failure' };

export type RepositoryStateCommand =
  | {
      readonly kind: 'apply-assessment';
      readonly assessment: RepositoryObservationAssessment;
    }
  | {
      readonly kind: 'reaffirm-environment';
      readonly assessment: RepositoryObservationAssessment;
    }
  | { readonly kind: 'retire' };

export type RepositoryReduction =
  | {
      readonly kind: 'unchanged';
      readonly status: RepositoryStatus;
      readonly evidenceDisposition:
        | 'verified'
        | 'risk-evidence-changed'
        | 'environment-evidence-still-changed'
        | 'failure-recorded'
        | 'already-retired';
    }
  | {
      readonly kind: 'transition';
      readonly fromStatus: RepositoryStatus;
      readonly toStatus: RepositoryStatus;
      readonly reason: RepositoryStatusReason;
      readonly evidenceDisposition: 'none' | 'risk-evidence-changed';
      readonly baselineAdvanceRequired: boolean;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'terminal-status'
        | 'retired'
        | 'reaffirmation-not-required'
        | 'unsupported-transition';
    };

function assertNever(value: never): never {
  throw new Error(`Unsupported repository state variant: ${String(value)}`);
}

function requireSortedUniqueAllowlist(
  values: readonly string[],
  allowlist: readonly string[],
  label: string,
): void {
  if (
    values.length === 0 ||
    values.some(
      (value, index) =>
        !allowlist.includes(value) || (index > 0 && (values[index - 1] as string) >= value),
    )
  ) {
    throw new Error(`${label} must be a non-empty sorted unique allowlisted set`);
  }
}

function validateAssessment(assessment: RepositoryObservationAssessment): void {
  switch (assessment.kind) {
    case 'same':
    case 'no-state-change-failure':
      return;
    case 'risk-evidence-changed':
      requireSortedUniqueAllowlist(
        assessment.differences,
        STORED_RISK_EVIDENCE_DIFFERENCES,
        'risk differences',
      );
      return;
    case 'environment-evidence-changed':
      requireSortedUniqueAllowlist(
        assessment.differences,
        STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES,
        'environmental differences',
      );
      return;
    case 'core-identity-changed':
      requireSortedUniqueAllowlist(
        assessment.differences,
        STORED_CORE_EVIDENCE_DIFFERENCES,
        'core differences',
      );
      return;
    case 'unavailable':
      if (!['path-unavailable', 'metadata-unreadable'].includes(assessment.reason)) {
        throw new Error('Unsupported repository unavailable reason');
      }
      return;
    case 'evidence-invalid':
      if (
        ![
          'stored-evidence-digest-mismatch',
          'stored-evidence-invalid',
          'unsupported-observation-version',
          'inspection-policy-version-mismatch',
        ].includes(assessment.reason)
      ) {
        throw new Error('Unsupported repository evidence-invalid reason');
      }
      return;
    default:
      assertNever(assessment);
  }
}

function transition(
  fromStatus: RepositoryStatus,
  toStatus: RepositoryStatus,
  reason: RepositoryStatusReason,
  evidenceDisposition: 'none' | 'risk-evidence-changed' = 'none',
  baselineAdvanceRequired = false,
): RepositoryReduction {
  return {
    kind: 'transition',
    fromStatus,
    toStatus,
    reason,
    evidenceDisposition,
    baselineAdvanceRequired,
  };
}

function applyAssessment(
  status: 'active' | 'unavailable' | 'identity-evidence-changed',
  assessment: RepositoryObservationAssessment,
): RepositoryReduction {
  switch (assessment.kind) {
    case 'same':
      return status === 'active'
        ? { kind: 'unchanged', status, evidenceDisposition: 'verified' }
        : transition(status, 'active', 'evidence-matches');
    case 'risk-evidence-changed':
      return status === 'active'
        ? { kind: 'unchanged', status, evidenceDisposition: 'risk-evidence-changed' }
        : transition(status, 'active', 'evidence-matches', 'risk-evidence-changed');
    case 'environment-evidence-changed':
      return status === 'identity-evidence-changed'
        ? {
            kind: 'unchanged',
            status,
            evidenceDisposition: 'environment-evidence-still-changed',
          }
        : transition(status, 'identity-evidence-changed', 'environment-evidence-changed');
    case 'core-identity-changed':
      return transition(status, 'identity-mismatch', 'core-identity-changed');
    case 'unavailable':
      return status === 'unavailable'
        ? { kind: 'unchanged', status, evidenceDisposition: 'failure-recorded' }
        : transition(status, 'unavailable', assessment.reason);
    case 'evidence-invalid':
      return transition(status, 'evidence-blocked', assessment.reason);
    case 'no-state-change-failure':
      return { kind: 'unchanged', status, evidenceDisposition: 'failure-recorded' };
    default:
      return assertNever(assessment);
  }
}

export function reduceRepositoryState(
  status: RepositoryStatus,
  command: RepositoryStateCommand,
): RepositoryReduction {
  if (!(REPOSITORY_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unsupported repository status: ${String(status)}`);
  }
  if (command.kind === 'retire') {
    return status === 'retired'
      ? { kind: 'unchanged', status, evidenceDisposition: 'already-retired' }
      : transition(status, 'retired', 'operator-retired');
  }
  if (command.kind !== 'apply-assessment' && command.kind !== 'reaffirm-environment') {
    return assertNever(command);
  }
  validateAssessment(command.assessment);
  if (status === 'retired') {
    return { kind: 'rejected', reason: 'retired' };
  }
  if (status === 'identity-mismatch' || status === 'evidence-blocked') {
    return { kind: 'rejected', reason: 'terminal-status' };
  }
  if (command.kind === 'apply-assessment') {
    return applyAssessment(status, command.assessment);
  }
  if (command.kind === 'reaffirm-environment') {
    if (status !== 'identity-evidence-changed') {
      return { kind: 'rejected', reason: 'reaffirmation-not-required' };
    }
    switch (command.assessment.kind) {
      case 'environment-evidence-changed':
        return transition(status, 'active', 'environment-evidence-reaffirmed', 'none', true);
      case 'core-identity-changed':
      case 'unavailable':
      case 'evidence-invalid':
      case 'no-state-change-failure':
        return applyAssessment(status, command.assessment);
      case 'same':
      case 'risk-evidence-changed':
        return { kind: 'rejected', reason: 'reaffirmation-not-required' };
      default:
        return assertNever(command.assessment);
    }
  }
  return assertNever(command);
}
