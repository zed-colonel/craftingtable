export const REPOSITORY_OBSERVATION_VERSION = 1 as const;
export const REPOSITORY_INSPECTION_POLICY_VERSION = 1 as const;
export const REPOSITORY_RISK_SCAN_SCOPE_VERSION = 1 as const;

export const REPOSITORY_RISK_SCAN_PATTERN =
  '^(extensions\\.worktreeconfig|core\\.(hookspath|fsmonitor|worktree)|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process)|include\\.path|includeif\\..*\\.path)$' as const;

export const REPOSITORY_RISK_SIGNALS = [
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

export type RepositoryRiskSignal = (typeof REPOSITORY_RISK_SIGNALS)[number];

export interface RepositoryRiskScanObservation {
  readonly scanScopeVersion: typeof REPOSITORY_RISK_SCAN_SCOPE_VERSION;
  readonly scannedKeyPattern: typeof REPOSITORY_RISK_SCAN_PATTERN;
  readonly classification: 'no-signals-in-scanned-set' | 'signals-observed';
  readonly signals: readonly RepositoryRiskSignal[];
}

export interface RepositoryObservationShape {
  readonly observationVersion: typeof REPOSITORY_OBSERVATION_VERSION;
  readonly inspectionPolicyVersion: number;
  readonly observedAt: string;
  readonly gitVersion: {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
  };
  readonly canonicalTopLevel: string;
  readonly canonicalGitDirectory: string;
  readonly canonicalCommonGitDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly coreIdentity: {
    readonly topLevelInode: string;
    readonly commonDirectoryInode: string;
    readonly fingerprintSha256: string;
  };
  readonly environmentalEvidence: {
    readonly topLevelDevice: string;
    readonly commonDirectoryDevice: string;
  };
  readonly riskScan: RepositoryRiskScanObservation;
}

declare const parsedRepositoryObservationBrand: unique symbol;

export type ParsedRepositoryObservation = RepositoryObservationShape & {
  readonly [parsedRepositoryObservationBrand]: true;
};

export interface RepositoryInspectionRequest {
  readonly requestedPath: string;
  readonly signal?: AbortSignal;
}

export interface RepositoryInspectorOptions {
  readonly allowedSourceRoots: readonly string[];
  readonly reservedRoots?: readonly string[];
  readonly gitExecutable?: string;
  readonly executableSearchPath?: string;
  readonly commandTimeoutMs?: number;
  readonly inspectionTimeoutMs?: number;
  readonly stdoutLimitBytes?: number;
  readonly stderrLimitBytes?: number;
  readonly terminationGraceMs?: number;
}

export type RepositoryInspectionErrorCode =
  | 'invalid-options'
  | 'unsupported-platform'
  | 'root-daemon-refused'
  | 'invalid-root-policy'
  | 'git-not-found'
  | 'git-not-executable'
  | 'git-executable-changed'
  | 'unsupported-git-version'
  | 'invalid-path'
  | 'outside-allowed-root'
  | 'reserved-root-overlap'
  | 'path-unavailable'
  | 'symlink-rejected'
  | 'ownership-refused'
  | 'repository-metadata-unreadable'
  | 'not-primary-repository'
  | 'not-git-repository'
  | 'unsupported-object-format'
  | 'unsupported-repository-extension'
  | 'spawn-failed'
  | 'aborted'
  | 'timed-out'
  | 'stdout-overflow'
  | 'stderr-overflow'
  | 'signal-terminated'
  | 'git-command-failed'
  | 'invalid-output-encoding'
  | 'malformed-version-output'
  | 'malformed-identity-output'
  | 'malformed-feature-output'
  | 'feature-count-exceeded'
  | 'observation-raced'
  | 'recorded-observation-invalid'
  | 'unsupported-observation-version'
  | 'inspection-policy-version-mismatch';

export const ALL_REPOSITORY_INSPECTION_ERROR_CODES = [
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
] as const satisfies readonly RepositoryInspectionErrorCode[];

export type RepositoryInspectionErrorSubject =
  | 'caller-input'
  | 'policy-configuration'
  | 'host-environment'
  | 'repository-unavailable'
  | 'repository-class-changed'
  | 'git-boundary-fault'
  | 'recorded-evidence-invalid'
  | 'evidence-not-comparable';

export type RepositoryInspectionErrorCategory =
  | 'configuration'
  | 'path-policy'
  | 'git-process'
  | 'observation';

export type RepositoryInspectionOperation =
  | 'create-inspector'
  | 'inspect-path'
  | 'parse-recorded-observation'
  | 'compare-observations';

export type RepositoryInspectionRetryability =
  | 'retryable'
  | 'configuration-required'
  | 'not-retryable';

export interface RepositoryInspectionError {
  readonly category: RepositoryInspectionErrorCategory;
  readonly code: RepositoryInspectionErrorCode;
  readonly subject: RepositoryInspectionErrorSubject;
  readonly operation: RepositoryInspectionOperation;
  readonly retryability: RepositoryInspectionRetryability;
  readonly message: string;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

export type RepositoryInspectionResult =
  | { readonly ok: true; readonly observation: ParsedRepositoryObservation }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

export interface RepositoryInspector {
  inspect(request: RepositoryInspectionRequest): Promise<RepositoryInspectionResult>;
}

export type RepositoryInspectorCreationResult =
  | { readonly ok: true; readonly inspector: RepositoryInspector }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

export type RecordedObservationResult =
  | { readonly ok: true; readonly observation: ParsedRepositoryObservation }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

export type CoreEvidenceDifference =
  | 'canonical-top-level'
  | 'canonical-git-directory'
  | 'canonical-common-git-directory'
  | 'object-format'
  | 'top-level-inode'
  | 'common-directory-inode'
  | 'fingerprint';

export type EnvironmentalEvidenceDifference = 'top-level-device' | 'common-directory-device';

export type RiskScanDifference = 'scan-scope-version' | 'scanned-key-pattern' | 'signals';

export interface RepositoryObservationComparison {
  readonly coreDifferences: readonly CoreEvidenceDifference[];
  readonly environmentalDifferences: readonly EnvironmentalEvidenceDifference[];
  readonly riskScanDifferences: readonly RiskScanDifference[];
  readonly sameCoreIdentity: boolean;
  readonly sameEnvironmentalEvidence: boolean;
  readonly sameRiskScanEvidence: boolean;
}

export type RepositoryObservationComparisonResult =
  | { readonly ok: true; readonly comparison: RepositoryObservationComparison }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

export const REPOSITORY_INSPECTION_ERROR_SUBJECTS = {
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
} as const satisfies Record<RepositoryInspectionErrorCode, RepositoryInspectionErrorSubject>;

const ERROR_MESSAGES: Record<RepositoryInspectionErrorCode, string> = {
  'invalid-options': 'Repository inspector options are invalid.',
  'unsupported-platform': 'Repository inspection requires a supported POSIX platform.',
  'root-daemon-refused': 'Repository inspection refuses to run with root daemon authority.',
  'invalid-root-policy': 'Repository source and reserved root policy is invalid.',
  'git-not-found': 'No eligible Git executable was found.',
  'git-not-executable': 'The configured Git executable is not an executable regular file.',
  'git-executable-changed': 'The trusted Git executable changed after inspector creation.',
  'unsupported-git-version': 'The Git executable does not satisfy the required version.',
  'invalid-path': 'The requested repository path is invalid.',
  'outside-allowed-root': 'The requested path is outside the allowed source roots.',
  'reserved-root-overlap': 'The requested path overlaps a reserved root.',
  'path-unavailable': 'The requested repository path is unavailable.',
  'symlink-rejected': 'A symlink is not permitted at this repository boundary.',
  'ownership-refused': 'Repository ownership does not match the daemon effective user.',
  'repository-metadata-unreadable': 'Repository metadata cannot be read safely.',
  'not-primary-repository': 'The requested path is not an exact primary repository checkout.',
  'not-git-repository': 'The requested path is not a Git repository.',
  'unsupported-object-format': 'The repository uses an unsupported object format.',
  'unsupported-repository-extension': 'The repository uses an unsupported extension.',
  'spawn-failed': 'The fixed Git process could not be started.',
  aborted: 'Repository inspection was aborted.',
  'timed-out': 'The fixed Git operation exceeded its deadline.',
  'stdout-overflow': 'The fixed Git operation exceeded its stdout bound.',
  'stderr-overflow': 'The fixed Git operation exceeded its stderr bound.',
  'signal-terminated': 'The fixed Git process terminated by signal.',
  'git-command-failed': 'The fixed Git operation failed.',
  'invalid-output-encoding': 'The fixed Git operation emitted invalid UTF-8.',
  'malformed-version-output': 'The Git version output is malformed.',
  'malformed-identity-output': 'The Git identity output is malformed.',
  'malformed-feature-output': 'The repository risk-signal output is malformed.',
  'feature-count-exceeded': 'The repository risk-signal count exceeded its bound.',
  'observation-raced': 'Repository evidence changed during inspection.',
  'recorded-observation-invalid': 'The recorded repository observation is invalid.',
  'unsupported-observation-version': 'The recorded repository observation version is unsupported.',
  'inspection-policy-version-mismatch':
    'Repository observations use different inspection policy versions.',
};

function categoryFor(code: RepositoryInspectionErrorCode): RepositoryInspectionErrorCategory {
  switch (REPOSITORY_INSPECTION_ERROR_SUBJECTS[code]) {
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

function retryabilityFor(
  subject: RepositoryInspectionErrorSubject,
): RepositoryInspectionRetryability {
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

export function createInspectionError(
  code: RepositoryInspectionErrorCode,
  operation: RepositoryInspectionOperation,
  evidence: Readonly<Record<string, string | number | boolean>> = {},
): RepositoryInspectionError {
  const subject = REPOSITORY_INSPECTION_ERROR_SUBJECTS[code];
  return {
    category: categoryFor(code),
    code,
    subject,
    operation,
    retryability: retryabilityFor(subject),
    message: ERROR_MESSAGES[code],
    evidence: { ...evidence },
  };
}

export function asParsedObservation(
  observation: RepositoryObservationShape,
): ParsedRepositoryObservation {
  return observation as ParsedRepositoryObservation;
}
