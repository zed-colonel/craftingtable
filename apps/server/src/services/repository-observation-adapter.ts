import {
  ALL_REPOSITORY_INSPECTION_ERROR_CODES,
  compareRepositoryObservations,
  createRepositoryInspector,
  parseRecordedObservation,
  REPOSITORY_INSPECTION_ERROR_SUBJECTS,
  REPOSITORY_INSPECTION_POLICY_VERSION,
  REPOSITORY_OBSERVATION_VERSION,
  REPOSITORY_RISK_SCAN_PATTERN,
  REPOSITORY_RISK_SCAN_SCOPE_VERSION,
  REPOSITORY_RISK_SIGNALS,
  type CoreEvidenceDifference,
  type EnvironmentalEvidenceDifference,
  type ParsedRepositoryObservation,
  type RepositoryInspector,
  type RepositoryInspectorOptions,
  type RiskScanDifference,
} from '@craftingtable/git';
import {
  A1_REPOSITORY_INSPECTION_ERROR_CODES,
  A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE,
  CURRENT_REPOSITORY_INSPECTION_POLICY_VERSION,
  STORED_CORE_EVIDENCE_DIFFERENCES,
  STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES,
  STORED_REPOSITORY_OBSERVATION_VERSION,
  STORED_REPOSITORY_RISK_SCAN_PATTERN,
  STORED_REPOSITORY_RISK_SCAN_SCOPE_VERSION,
  STORED_REPOSITORY_RISK_SIGNALS,
  STORED_RISK_EVIDENCE_DIFFERENCES,
  type RegisteredRepository,
  type RepositoryObservationAssessment,
  type SuccessfulRepositoryInspection,
} from '@craftingtable/domain';
import { serializeRepositoryObservation, verifyExactUtf8Sha256 } from '@craftingtable/storage';
import type { RepositoryFeatureConfig } from '../config.js';
import {
  assessObservationDifferences,
  normalizeAndAssessA1Error,
} from './repository-observation-policy.js';
import type {
  NormalizedRepositoryA1Failure,
  RegisteredRepositoryIdentityVerificationResult,
  RepositoryAdapterFailure,
  RepositoryIntegrityFailure,
  RepositoryObservationComparisonResult,
  RepositoryObservationEvidence,
  RepositoryObservationPort,
  RepositoryObservationResult,
  RepositoryProjectionField,
  StoredRepositoryObservationVerificationResult,
  VerifiedRepositoryBaseline,
  VerifiedStoredRepositoryObservation,
} from './repository-observation-port.js';

export interface RepositoryObservationPortCreationFailure {
  readonly reason: 'creation-failed' | 'adapter-vocabulary-mismatch' | 'adapter-invariant-fault';
  readonly retryability: 'retryable' | 'configuration-required' | 'not-retryable';
}

export type RepositoryObservationPortCreationResult =
  | { readonly ok: true; readonly port: RepositoryObservationPort }
  | { readonly ok: false; readonly failure: RepositoryObservationPortCreationFailure };

const CORE_DIFFERENCE_KEYS = {
  'canonical-top-level': true,
  'canonical-git-directory': true,
  'canonical-common-git-directory': true,
  'object-format': true,
  'top-level-inode': true,
  'common-directory-inode': true,
  fingerprint: true,
} as const satisfies Record<CoreEvidenceDifference, true>;

const ENVIRONMENT_DIFFERENCE_KEYS = {
  'top-level-device': true,
  'common-directory-device': true,
} as const satisfies Record<EnvironmentalEvidenceDifference, true>;

const RISK_DIFFERENCE_KEYS = {
  'scan-scope-version': true,
  'scanned-key-pattern': true,
  signals: true,
} as const satisfies Record<RiskScanDifference, true>;

function orderedEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return orderedEqual(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key]);
}

export function repositoryObservationVocabularyMatches(): boolean {
  return (
    REPOSITORY_OBSERVATION_VERSION === STORED_REPOSITORY_OBSERVATION_VERSION &&
    REPOSITORY_INSPECTION_POLICY_VERSION === CURRENT_REPOSITORY_INSPECTION_POLICY_VERSION &&
    REPOSITORY_RISK_SCAN_SCOPE_VERSION === STORED_REPOSITORY_RISK_SCAN_SCOPE_VERSION &&
    REPOSITORY_RISK_SCAN_PATTERN === STORED_REPOSITORY_RISK_SCAN_PATTERN &&
    orderedEqual(REPOSITORY_RISK_SIGNALS, STORED_REPOSITORY_RISK_SIGNALS) &&
    orderedEqual(ALL_REPOSITORY_INSPECTION_ERROR_CODES, A1_REPOSITORY_INSPECTION_ERROR_CODES) &&
    recordEqual(
      REPOSITORY_INSPECTION_ERROR_SUBJECTS,
      A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE,
    ) &&
    orderedEqual(Object.keys(CORE_DIFFERENCE_KEYS), STORED_CORE_EVIDENCE_DIFFERENCES) &&
    orderedEqual(
      Object.keys(ENVIRONMENT_DIFFERENCE_KEYS),
      STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES,
    ) &&
    orderedEqual(Object.keys(RISK_DIFFERENCE_KEYS), STORED_RISK_EVIDENCE_DIFFERENCES)
  );
}

function inspectorOptions(
  config: Extract<RepositoryFeatureConfig, { readonly enabled: true }>,
): RepositoryInspectorOptions {
  return {
    allowedSourceRoots: [...config.allowedSourceRoots],
    reservedRoots: [config.reservedDataRoot],
    ...(config.gitExecutable === undefined ? {} : { gitExecutable: config.gitExecutable }),
    ...(config.executableSearchPath === undefined
      ? {}
      : { executableSearchPath: config.executableSearchPath }),
    commandTimeoutMs: config.commandTimeoutMs,
    creationTimeoutMs: config.creationTimeoutMs,
    inspectionTimeoutMs: config.inspectionTimeoutMs,
    stdoutLimitBytes: config.stdoutLimitBytes,
    stderrLimitBytes: config.stderrLimitBytes,
    terminationGraceMs: config.terminationGraceMs,
  };
}

function evidenceFromObservation(
  observation: ParsedRepositoryObservation,
  serialized = serializeRepositoryObservation(observation),
): RepositoryObservationEvidence {
  return Object.freeze({
    ...serialized,
    observationVersion: observation.observationVersion,
    inspectionPolicyVersion: observation.inspectionPolicyVersion,
    observedAt: observation.observedAt,
    canonicalTopLevel: observation.canonicalTopLevel,
    canonicalGitDirectory: observation.canonicalGitDirectory,
    canonicalCommonGitDirectory: observation.canonicalCommonGitDirectory,
    objectFormat: observation.objectFormat,
    topLevelInode: observation.coreIdentity.topLevelInode,
    commonDirectoryInode: observation.coreIdentity.commonDirectoryInode,
    coreFingerprintSha256: observation.coreIdentity.fingerprintSha256,
    topLevelDevice: observation.environmentalEvidence.topLevelDevice,
    commonDirectoryDevice: observation.environmentalEvidence.commonDirectoryDevice,
    riskScanScopeVersion: observation.riskScan.scanScopeVersion,
    riskScannedKeyPattern: observation.riskScan.scannedKeyPattern,
    riskClassification: observation.riskScan.classification,
    riskSignals: Object.freeze([...observation.riskScan.signals]),
  });
}

function integrityFailure(
  reason: RepositoryIntegrityFailure['reason'],
  assessmentReason: Extract<
    RepositoryObservationAssessment,
    { readonly kind: 'evidence-invalid' }
  >['reason'],
  options: {
    readonly field?: RepositoryProjectionField;
    readonly a1Failure?: NormalizedRepositoryA1Failure;
  } = {},
): RepositoryIntegrityFailure {
  return {
    kind: 'integrity-error',
    reason,
    ...(options.field === undefined ? {} : { field: options.field }),
    ...(options.a1Failure === undefined ? {} : { a1Failure: options.a1Failure }),
    assessment: { kind: 'evidence-invalid', reason: assessmentReason },
  };
}

function parseEvidenceJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

const INSPECTION_PROJECTIONS = [
  [
    'observation-version',
    (row: SuccessfulRepositoryInspection) => row.observationVersion,
    (o: ParsedRepositoryObservation) => o.observationVersion,
  ],
  [
    'inspection-policy-version',
    (row: SuccessfulRepositoryInspection) => row.inspectionPolicyVersion,
    (o: ParsedRepositoryObservation) => o.inspectionPolicyVersion,
  ],
  [
    'observed-at',
    (row: SuccessfulRepositoryInspection) => row.observedAt,
    (o: ParsedRepositoryObservation) => o.observedAt,
  ],
  [
    'canonical-top-level',
    (row: SuccessfulRepositoryInspection) => row.canonicalTopLevel,
    (o: ParsedRepositoryObservation) => o.canonicalTopLevel,
  ],
  [
    'canonical-git-directory',
    (row: SuccessfulRepositoryInspection) => row.canonicalGitDirectory,
    (o: ParsedRepositoryObservation) => o.canonicalGitDirectory,
  ],
  [
    'canonical-common-git-directory',
    (row: SuccessfulRepositoryInspection) => row.canonicalCommonGitDirectory,
    (o: ParsedRepositoryObservation) => o.canonicalCommonGitDirectory,
  ],
  [
    'object-format',
    (row: SuccessfulRepositoryInspection) => row.objectFormat,
    (o: ParsedRepositoryObservation) => o.objectFormat,
  ],
  [
    'top-level-inode',
    (row: SuccessfulRepositoryInspection) => row.topLevelInode,
    (o: ParsedRepositoryObservation) => o.coreIdentity.topLevelInode,
  ],
  [
    'common-directory-inode',
    (row: SuccessfulRepositoryInspection) => row.commonDirectoryInode,
    (o: ParsedRepositoryObservation) => o.coreIdentity.commonDirectoryInode,
  ],
  [
    'core-fingerprint',
    (row: SuccessfulRepositoryInspection) => row.coreFingerprintSha256,
    (o: ParsedRepositoryObservation) => o.coreIdentity.fingerprintSha256,
  ],
  [
    'top-level-device',
    (row: SuccessfulRepositoryInspection) => row.topLevelDevice,
    (o: ParsedRepositoryObservation) => o.environmentalEvidence.topLevelDevice,
  ],
  [
    'common-directory-device',
    (row: SuccessfulRepositoryInspection) => row.commonDirectoryDevice,
    (o: ParsedRepositoryObservation) => o.environmentalEvidence.commonDirectoryDevice,
  ],
  [
    'risk-scan-scope-version',
    (row: SuccessfulRepositoryInspection) => row.riskScanScopeVersion,
    (o: ParsedRepositoryObservation) => o.riskScan.scanScopeVersion,
  ],
  [
    'risk-scanned-key-pattern',
    (row: SuccessfulRepositoryInspection) => row.riskScannedKeyPattern,
    (o: ParsedRepositoryObservation) => o.riskScan.scannedKeyPattern,
  ],
  [
    'risk-classification',
    (row: SuccessfulRepositoryInspection) => row.riskClassification,
    (o: ParsedRepositoryObservation) => o.riskScan.classification,
  ],
] as const satisfies readonly (readonly [
  RepositoryProjectionField,
  (row: SuccessfulRepositoryInspection) => unknown,
  (observation: ParsedRepositoryObservation) => unknown,
])[];

function evidenceMatchesObservation(
  evidence: RepositoryObservationEvidence,
  observation: ParsedRepositoryObservation,
): boolean {
  return (
    evidence.observationVersion === observation.observationVersion &&
    evidence.inspectionPolicyVersion === observation.inspectionPolicyVersion &&
    evidence.observedAt === observation.observedAt &&
    evidence.canonicalTopLevel === observation.canonicalTopLevel &&
    evidence.canonicalGitDirectory === observation.canonicalGitDirectory &&
    evidence.canonicalCommonGitDirectory === observation.canonicalCommonGitDirectory &&
    evidence.objectFormat === observation.objectFormat &&
    evidence.topLevelInode === observation.coreIdentity.topLevelInode &&
    evidence.commonDirectoryInode === observation.coreIdentity.commonDirectoryInode &&
    evidence.coreFingerprintSha256 === observation.coreIdentity.fingerprintSha256 &&
    evidence.topLevelDevice === observation.environmentalEvidence.topLevelDevice &&
    evidence.commonDirectoryDevice === observation.environmentalEvidence.commonDirectoryDevice &&
    evidence.riskScanScopeVersion === observation.riskScan.scanScopeVersion &&
    evidence.riskScannedKeyPattern === observation.riskScan.scannedKeyPattern &&
    evidence.riskClassification === observation.riskScan.classification &&
    orderedEqual(evidence.riskSignals, observation.riskScan.signals)
  );
}

class A1RepositoryObservationAdapter implements RepositoryObservationPort {
  private permanentFault: RepositoryAdapterFailure | undefined;

  constructor(
    private readonly inspector: RepositoryInspector,
    private readonly onInvariantFault: (failure: RepositoryAdapterFailure) => void,
  ) {}

  private invariantFault(): RepositoryAdapterFailure {
    if (this.permanentFault === undefined) {
      this.permanentFault = { kind: 'adapter-error', reason: 'adapter-invariant-fault' };
      this.onInvariantFault(this.permanentFault);
    }
    return this.permanentFault;
  }

  private currentFault(): RepositoryAdapterFailure | undefined {
    return this.permanentFault;
  }

  async inspect(input: {
    readonly requestedPath: string;
    readonly signal?: AbortSignal;
  }): Promise<RepositoryObservationResult> {
    const fault = this.currentFault();
    if (fault !== undefined) {
      return { ok: false, failure: fault };
    }
    const result = await this.inspector.inspect(input);
    if (!result.ok) {
      const normalized = normalizeAndAssessA1Error(result.error);
      if (normalized.kind === 'adapter-error') {
        return { ok: false, failure: this.invariantFault() };
      }
      return { ok: false, failure: normalized };
    }
    return { ok: true, evidence: evidenceFromObservation(result.observation) };
  }

  verifyStored(
    inspection: SuccessfulRepositoryInspection,
  ): StoredRepositoryObservationVerificationResult {
    const fault = this.currentFault();
    if (fault !== undefined) {
      return { ok: false, failure: fault };
    }
    if (!verifyExactUtf8Sha256(inspection.observationJson, inspection.observationSha256)) {
      return {
        ok: false,
        failure: integrityFailure('stored-digest-mismatch', 'stored-evidence-digest-mismatch'),
      };
    }
    const parsedJson = parseEvidenceJson(inspection.observationJson);
    if (parsedJson === undefined) {
      return {
        ok: false,
        failure: integrityFailure('stored-json-invalid', 'stored-evidence-invalid'),
      };
    }
    const parsed = parseRecordedObservation(parsedJson);
    if (!parsed.ok) {
      const normalized = normalizeAndAssessA1Error(parsed.error);
      if (normalized.kind === 'adapter-error') {
        return { ok: false, failure: this.invariantFault() };
      }
      if (normalized.code === 'recorded-observation-invalid') {
        return {
          ok: false,
          failure: integrityFailure('a1-record-invalid', 'stored-evidence-invalid', {
            a1Failure: normalized,
          }),
        };
      }
      if (normalized.code === 'unsupported-observation-version') {
        return {
          ok: false,
          failure: integrityFailure(
            'unsupported-observation-version',
            'unsupported-observation-version',
            { a1Failure: normalized },
          ),
        };
      }
      return { ok: false, failure: this.invariantFault() };
    }
    for (const [field, rowValue, observationValue] of INSPECTION_PROJECTIONS) {
      if (rowValue(inspection) !== observationValue(parsed.observation)) {
        return {
          ok: false,
          failure: integrityFailure('projected-inspection-mismatch', 'stored-evidence-invalid', {
            field,
          }),
        };
      }
    }
    if (!orderedEqual(inspection.riskSignals, parsed.observation.riskScan.signals)) {
      return {
        ok: false,
        failure: integrityFailure('projected-inspection-mismatch', 'stored-evidence-invalid', {
          field: 'risk-signals',
        }),
      };
    }
    return {
      ok: true,
      observation: {
        evidence: evidenceFromObservation(parsed.observation, {
          observationJson: inspection.observationJson,
          observationSha256: inspection.observationSha256,
        }),
      } as VerifiedStoredRepositoryObservation,
    };
  }

  verifyRegisteredIdentity(
    repository: RegisteredRepository,
    observation: VerifiedStoredRepositoryObservation,
  ): RegisteredRepositoryIdentityVerificationResult {
    const fault = this.currentFault();
    if (fault !== undefined) {
      return { ok: false, failure: fault };
    }
    const evidence = observation.evidence;
    const fields = [
      ['observation-version', repository.observationVersion, evidence.observationVersion],
      [
        'inspection-policy-version',
        repository.inspectionPolicyVersion,
        evidence.inspectionPolicyVersion,
      ],
      ['canonical-top-level', repository.canonicalTopLevel, evidence.canonicalTopLevel],
      ['canonical-git-directory', repository.canonicalGitDirectory, evidence.canonicalGitDirectory],
      [
        'canonical-common-git-directory',
        repository.canonicalCommonGitDirectory,
        evidence.canonicalCommonGitDirectory,
      ],
      ['object-format', repository.objectFormat, evidence.objectFormat],
      ['top-level-inode', repository.topLevelInode, evidence.topLevelInode],
      ['common-directory-inode', repository.commonDirectoryInode, evidence.commonDirectoryInode],
      ['core-fingerprint', repository.coreFingerprintSha256, evidence.coreFingerprintSha256],
    ] as const satisfies readonly (readonly [RepositoryProjectionField, unknown, unknown])[];
    const mismatch = fields.find(([, left, right]) => left !== right);
    if (mismatch !== undefined) {
      return {
        ok: false,
        failure: integrityFailure('registered-identity-mismatch', 'stored-evidence-invalid', {
          field: mismatch[0],
        }),
      };
    }
    return {
      ok: true,
      baseline: { repository, observation } as VerifiedRepositoryBaseline,
    };
  }

  compare(
    baseline: VerifiedRepositoryBaseline,
    current: RepositoryObservationEvidence,
  ): RepositoryObservationComparisonResult {
    const fault = this.currentFault();
    if (fault !== undefined) {
      return { ok: false, failure: fault };
    }
    if (
      !verifyExactUtf8Sha256(
        baseline.observation.evidence.observationJson,
        baseline.observation.evidence.observationSha256,
      ) ||
      !verifyExactUtf8Sha256(current.observationJson, current.observationSha256)
    ) {
      return { ok: false, failure: this.invariantFault() };
    }
    const recordedJson = parseEvidenceJson(baseline.observation.evidence.observationJson);
    const currentJson = parseEvidenceJson(current.observationJson);
    if (recordedJson === undefined || currentJson === undefined) {
      return { ok: false, failure: this.invariantFault() };
    }
    const recorded = parseRecordedObservation(recordedJson);
    const parsedCurrent = parseRecordedObservation(currentJson);
    if (!recorded.ok || !parsedCurrent.ok) {
      return { ok: false, failure: this.invariantFault() };
    }
    if (
      !evidenceMatchesObservation(baseline.observation.evidence, recorded.observation) ||
      !evidenceMatchesObservation(current, parsedCurrent.observation)
    ) {
      return { ok: false, failure: this.invariantFault() };
    }
    const compared = compareRepositoryObservations(recorded.observation, parsedCurrent.observation);
    if (!compared.ok) {
      const normalized = normalizeAndAssessA1Error(compared.error);
      if (
        normalized.kind === 'adapter-error' ||
        normalized.code !== 'inspection-policy-version-mismatch'
      ) {
        return { ok: false, failure: this.invariantFault() };
      }
      return {
        ok: false,
        failure: integrityFailure(
          'comparison-policy-version-mismatch',
          'inspection-policy-version-mismatch',
          { a1Failure: normalized },
        ),
      };
    }
    const comparison = compared.comparison;
    const assessment = assessObservationDifferences({
      coreDifferences: comparison.coreDifferences,
      environmentalDifferences: comparison.environmentalDifferences,
      riskDifferences: comparison.riskScanDifferences,
    });
    return {
      ok: true,
      coreDifferences: Object.freeze([...comparison.coreDifferences]),
      environmentalDifferences: Object.freeze([...comparison.environmentalDifferences]),
      riskDifferences: Object.freeze([...comparison.riskScanDifferences]),
      sameCoreIdentity: comparison.sameCoreIdentity,
      sameEnvironmentalEvidence: comparison.sameEnvironmentalEvidence,
      sameRiskScanEvidence: comparison.sameRiskScanEvidence,
      assessment,
    };
  }
}

export async function createRepositoryObservationPort(
  config: Extract<RepositoryFeatureConfig, { readonly enabled: true }>,
  onInvariantFault: (failure: RepositoryAdapterFailure) => void = () => {},
): Promise<RepositoryObservationPortCreationResult> {
  if (!repositoryObservationVocabularyMatches()) {
    return {
      ok: false,
      failure: { reason: 'adapter-vocabulary-mismatch', retryability: 'not-retryable' },
    };
  }
  try {
    const created = await createRepositoryInspector(inspectorOptions(config));
    if (!created.ok) {
      const normalized = normalizeAndAssessA1Error(created.error);
      if (normalized.kind === 'adapter-error') {
        return {
          ok: false,
          failure: { reason: 'adapter-invariant-fault', retryability: 'not-retryable' },
        };
      }
      return {
        ok: false,
        failure: { reason: 'creation-failed', retryability: normalized.retryability },
      };
    }
    return {
      ok: true,
      port: new A1RepositoryObservationAdapter(created.inspector, onInvariantFault),
    };
  } catch {
    return {
      ok: false,
      failure: { reason: 'adapter-invariant-fault', retryability: 'not-retryable' },
    };
  }
}
