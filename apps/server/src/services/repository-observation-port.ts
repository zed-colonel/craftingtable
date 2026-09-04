import type {
  STORED_REPOSITORY_OBSERVATION_VERSION,
  STORED_REPOSITORY_RISK_SCAN_SCOPE_VERSION,
} from '@craftingtable/domain';
import type {
  A1RepositoryInspectionErrorCode,
  A1RepositoryInspectionErrorSubject,
  A1RepositoryInspectionOperation,
  NormalizedRepositoryErrorEvidence,
  RegisteredRepository,
  RepositoryObservationAssessment,
  StoredCoreEvidenceDifference,
  StoredEnvironmentalEvidenceDifference,
  StoredRepositoryInspectionErrorCategory,
  StoredRepositoryInspectionRetryability,
  StoredRepositoryRiskSignal,
  StoredRiskEvidenceDifference,
  SuccessfulRepositoryInspection,
} from '@craftingtable/domain';

export interface RepositoryObservationEvidence {
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
}

export interface NormalizedRepositoryA1Failure {
  readonly kind: 'a1-error';
  readonly code: A1RepositoryInspectionErrorCode;
  readonly subject: A1RepositoryInspectionErrorSubject;
  readonly category: StoredRepositoryInspectionErrorCategory;
  readonly operation: A1RepositoryInspectionOperation;
  readonly retryability: StoredRepositoryInspectionRetryability;
  readonly evidence: NormalizedRepositoryErrorEvidence;
  readonly assessment: RepositoryObservationAssessment;
}

export type RepositoryIntegrityFailureReason =
  | 'stored-digest-mismatch'
  | 'stored-json-invalid'
  | 'a1-record-invalid'
  | 'unsupported-observation-version'
  | 'projected-inspection-mismatch'
  | 'registered-identity-mismatch'
  | 'comparison-policy-version-mismatch';

export interface RepositoryIntegrityFailure {
  readonly kind: 'integrity-error';
  readonly reason: RepositoryIntegrityFailureReason;
  readonly field?: RepositoryProjectionField;
  readonly a1Failure?: NormalizedRepositoryA1Failure;
  readonly assessment: Extract<
    RepositoryObservationAssessment,
    { readonly kind: 'evidence-invalid' }
  >;
}

export type RepositoryAdapterFailureReason =
  | 'adapter-vocabulary-mismatch'
  | 'adapter-invariant-fault';

export interface RepositoryAdapterFailure {
  readonly kind: 'adapter-error';
  readonly reason: RepositoryAdapterFailureReason;
}

export type RepositoryObservationFailure =
  | NormalizedRepositoryA1Failure
  | RepositoryIntegrityFailure
  | RepositoryAdapterFailure;

export type RepositoryObservationResult =
  | { readonly ok: true; readonly evidence: RepositoryObservationEvidence }
  | { readonly ok: false; readonly failure: RepositoryObservationFailure };

export type RepositoryProjectionField =
  | 'observation-version'
  | 'inspection-policy-version'
  | 'observed-at'
  | 'canonical-top-level'
  | 'canonical-git-directory'
  | 'canonical-common-git-directory'
  | 'object-format'
  | 'top-level-inode'
  | 'common-directory-inode'
  | 'core-fingerprint'
  | 'top-level-device'
  | 'common-directory-device'
  | 'risk-scan-scope-version'
  | 'risk-scanned-key-pattern'
  | 'risk-classification'
  | 'risk-signals';

declare const verifiedStoredBrand: unique symbol;
declare const verifiedBaselineBrand: unique symbol;

export interface VerifiedStoredRepositoryObservation {
  readonly evidence: RepositoryObservationEvidence;
  readonly [verifiedStoredBrand]: true;
}

export interface VerifiedRepositoryBaseline {
  readonly repository: RegisteredRepository;
  readonly observation: VerifiedStoredRepositoryObservation;
  readonly [verifiedBaselineBrand]: true;
}

export type StoredRepositoryObservationVerificationResult =
  | { readonly ok: true; readonly observation: VerifiedStoredRepositoryObservation }
  | { readonly ok: false; readonly failure: RepositoryObservationFailure };

export type RegisteredRepositoryIdentityVerificationResult =
  | { readonly ok: true; readonly baseline: VerifiedRepositoryBaseline }
  | { readonly ok: false; readonly failure: RepositoryObservationFailure };

export type RepositoryObservationComparisonResult =
  | {
      readonly ok: true;
      readonly coreDifferences: readonly StoredCoreEvidenceDifference[];
      readonly environmentalDifferences: readonly StoredEnvironmentalEvidenceDifference[];
      readonly riskDifferences: readonly StoredRiskEvidenceDifference[];
      readonly sameCoreIdentity: boolean;
      readonly sameEnvironmentalEvidence: boolean;
      readonly sameRiskScanEvidence: boolean;
      readonly assessment: RepositoryObservationAssessment;
    }
  | { readonly ok: false; readonly failure: RepositoryObservationFailure };

export interface RepositoryObservationPort {
  inspect(input: {
    readonly requestedPath: string;
    readonly signal?: AbortSignal;
  }): Promise<RepositoryObservationResult>;

  verifyStored(
    inspection: SuccessfulRepositoryInspection,
  ): StoredRepositoryObservationVerificationResult;

  verifyRegisteredIdentity(
    repository: RegisteredRepository,
    observation: VerifiedStoredRepositoryObservation,
  ): RegisteredRepositoryIdentityVerificationResult;

  compare(
    baseline: VerifiedRepositoryBaseline,
    current: RepositoryObservationEvidence,
  ): RepositoryObservationComparisonResult;
}
