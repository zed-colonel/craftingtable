import { createHash } from 'node:crypto';
import { isAbsolute, normalize, resolve } from 'node:path';
import {
  REPOSITORY_INSPECTION_POLICY_VERSION,
  REPOSITORY_OBSERVATION_VERSION,
  REPOSITORY_RISK_SCAN_PATTERN,
  REPOSITORY_RISK_SCAN_SCOPE_VERSION,
  REPOSITORY_RISK_SIGNALS,
  asParsedObservation,
  createInspectionError,
} from './types.js';
import type {
  CoreEvidenceDifference,
  EnvironmentalEvidenceDifference,
  ParsedRepositoryObservation,
  RecordedObservationResult,
  RepositoryObservationComparisonResult,
  RepositoryObservationShape,
  RepositoryRiskSignal,
  RiskScanDifference,
} from './types.js';

function appendLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  hash.update(String(bytes.byteLength));
  hash.update(':');
  hash.update(bytes);
  hash.update('\n');
}

export function calculateCoreIdentityFingerprint(
  observation: Pick<
    RepositoryObservationShape,
    | 'observationVersion'
    | 'inspectionPolicyVersion'
    | 'canonicalTopLevel'
    | 'canonicalCommonGitDirectory'
    | 'objectFormat'
    | 'coreIdentity'
  >,
): string {
  const hash = createHash('sha256');
  for (const value of [
    String(observation.observationVersion),
    String(observation.inspectionPolicyVersion),
    observation.canonicalTopLevel,
    observation.canonicalCommonGitDirectory,
    observation.objectFormat,
    observation.coreIdentity.topLevelInode,
    observation.coreIdentity.commonDirectoryInode,
  ]) {
    appendLengthPrefixed(hash, value);
  }
  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isBoundedInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= 999_999_999
  );
}

function isCanonicalUnsignedDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function isCanonicalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !value.includes('\0') &&
    isAbsolute(value) &&
    normalize(value) === value &&
    resolve(value) === value
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isSortedUniqueSignals(value: unknown): value is readonly RepositoryRiskSignal[] {
  if (!Array.isArray(value) || value.length > 256) {
    return false;
  }
  const allowed = new Set<string>(REPOSITORY_RISK_SIGNALS);
  let previous: string | undefined;
  for (const signal of value) {
    if (typeof signal !== 'string' || !allowed.has(signal)) {
      return false;
    }
    if (previous !== undefined && signal <= previous) {
      return false;
    }
    previous = signal;
  }
  return true;
}

function validateObservation(
  value: Record<string, unknown>,
): RepositoryObservationShape | undefined {
  if (
    !hasExactKeys(value, [
      'observationVersion',
      'inspectionPolicyVersion',
      'observedAt',
      'gitVersion',
      'canonicalTopLevel',
      'canonicalGitDirectory',
      'canonicalCommonGitDirectory',
      'objectFormat',
      'coreIdentity',
      'environmentalEvidence',
      'riskScan',
    ]) ||
    value.observationVersion !== REPOSITORY_OBSERVATION_VERSION ||
    !isBoundedInteger(value.inspectionPolicyVersion, 1) ||
    !isTimestamp(value.observedAt) ||
    !isCanonicalPath(value.canonicalTopLevel) ||
    !isCanonicalPath(value.canonicalGitDirectory) ||
    !isCanonicalPath(value.canonicalCommonGitDirectory) ||
    !['sha1', 'sha256'].includes(String(value.objectFormat))
  ) {
    return undefined;
  }

  const gitVersion = value.gitVersion;
  if (
    !isRecord(gitVersion) ||
    !hasExactKeys(gitVersion, ['major', 'minor', 'patch']) ||
    !isBoundedInteger(gitVersion.major, 1) ||
    !isBoundedInteger(gitVersion.minor) ||
    !isBoundedInteger(gitVersion.patch)
  ) {
    return undefined;
  }

  const coreIdentity = value.coreIdentity;
  if (
    !isRecord(coreIdentity) ||
    !hasExactKeys(coreIdentity, ['topLevelInode', 'commonDirectoryInode', 'fingerprintSha256']) ||
    !isCanonicalUnsignedDecimal(coreIdentity.topLevelInode) ||
    !isCanonicalUnsignedDecimal(coreIdentity.commonDirectoryInode) ||
    typeof coreIdentity.fingerprintSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(coreIdentity.fingerprintSha256)
  ) {
    return undefined;
  }

  const environmentalEvidence = value.environmentalEvidence;
  if (
    !isRecord(environmentalEvidence) ||
    !hasExactKeys(environmentalEvidence, ['topLevelDevice', 'commonDirectoryDevice']) ||
    !isCanonicalUnsignedDecimal(environmentalEvidence.topLevelDevice) ||
    !isCanonicalUnsignedDecimal(environmentalEvidence.commonDirectoryDevice)
  ) {
    return undefined;
  }

  const riskScan = value.riskScan;
  if (
    !isRecord(riskScan) ||
    !hasExactKeys(riskScan, [
      'scanScopeVersion',
      'scannedKeyPattern',
      'classification',
      'signals',
    ]) ||
    riskScan.scanScopeVersion !== REPOSITORY_RISK_SCAN_SCOPE_VERSION ||
    riskScan.scannedKeyPattern !== REPOSITORY_RISK_SCAN_PATTERN ||
    !['no-signals-in-scanned-set', 'signals-observed'].includes(String(riskScan.classification)) ||
    !isSortedUniqueSignals(riskScan.signals) ||
    (riskScan.signals.length === 0) !== (riskScan.classification === 'no-signals-in-scanned-set')
  ) {
    return undefined;
  }

  return {
    observationVersion: REPOSITORY_OBSERVATION_VERSION,
    inspectionPolicyVersion: value.inspectionPolicyVersion,
    observedAt: value.observedAt,
    gitVersion: {
      major: gitVersion.major,
      minor: gitVersion.minor,
      patch: gitVersion.patch,
    },
    canonicalTopLevel: value.canonicalTopLevel,
    canonicalGitDirectory: value.canonicalGitDirectory,
    canonicalCommonGitDirectory: value.canonicalCommonGitDirectory,
    objectFormat: value.objectFormat as 'sha1' | 'sha256',
    coreIdentity: {
      topLevelInode: coreIdentity.topLevelInode,
      commonDirectoryInode: coreIdentity.commonDirectoryInode,
      fingerprintSha256: coreIdentity.fingerprintSha256,
    },
    environmentalEvidence: {
      topLevelDevice: environmentalEvidence.topLevelDevice,
      commonDirectoryDevice: environmentalEvidence.commonDirectoryDevice,
    },
    riskScan: {
      scanScopeVersion: REPOSITORY_RISK_SCAN_SCOPE_VERSION,
      scannedKeyPattern: REPOSITORY_RISK_SCAN_PATTERN,
      classification: riskScan.classification as 'no-signals-in-scanned-set' | 'signals-observed',
      signals: Object.freeze([...riskScan.signals]),
    },
  };
}

export function parseRecordedObservation(value: unknown): RecordedObservationResult {
  try {
    if (
      isRecord(value) &&
      isBoundedInteger(value.observationVersion) &&
      value.observationVersion !== REPOSITORY_OBSERVATION_VERSION
    ) {
      return {
        ok: false,
        error: createInspectionError(
          'unsupported-observation-version',
          'parse-recorded-observation',
          { observationVersion: value.observationVersion },
        ),
      };
    }
    if (!isRecord(value)) {
      return {
        ok: false,
        error: createInspectionError('recorded-observation-invalid', 'parse-recorded-observation'),
      };
    }
    const observation = validateObservation(value);
    if (
      observation === undefined ||
      calculateCoreIdentityFingerprint(observation) !== observation.coreIdentity.fingerprintSha256
    ) {
      return {
        ok: false,
        error: createInspectionError('recorded-observation-invalid', 'parse-recorded-observation'),
      };
    }
    return { ok: true, observation: asParsedObservation(observation) };
  } catch {
    return {
      ok: false,
      error: createInspectionError('recorded-observation-invalid', 'parse-recorded-observation'),
    };
  }
}

export function compareRepositoryObservations(
  recorded: ParsedRepositoryObservation,
  current: ParsedRepositoryObservation,
): RepositoryObservationComparisonResult {
  if (recorded.inspectionPolicyVersion !== current.inspectionPolicyVersion) {
    return {
      ok: false,
      error: createInspectionError('inspection-policy-version-mismatch', 'compare-observations', {
        recordedPolicyVersion: recorded.inspectionPolicyVersion,
        currentPolicyVersion: current.inspectionPolicyVersion,
      }),
    };
  }

  const coreDifferences: CoreEvidenceDifference[] = [];
  if (recorded.canonicalTopLevel !== current.canonicalTopLevel) {
    coreDifferences.push('canonical-top-level');
  }
  if (recorded.canonicalGitDirectory !== current.canonicalGitDirectory) {
    coreDifferences.push('canonical-git-directory');
  }
  if (recorded.canonicalCommonGitDirectory !== current.canonicalCommonGitDirectory) {
    coreDifferences.push('canonical-common-git-directory');
  }
  if (recorded.objectFormat !== current.objectFormat) {
    coreDifferences.push('object-format');
  }
  if (recorded.coreIdentity.topLevelInode !== current.coreIdentity.topLevelInode) {
    coreDifferences.push('top-level-inode');
  }
  if (recorded.coreIdentity.commonDirectoryInode !== current.coreIdentity.commonDirectoryInode) {
    coreDifferences.push('common-directory-inode');
  }
  if (recorded.coreIdentity.fingerprintSha256 !== current.coreIdentity.fingerprintSha256) {
    coreDifferences.push('fingerprint');
  }

  const environmentalDifferences: EnvironmentalEvidenceDifference[] = [];
  if (
    recorded.environmentalEvidence.topLevelDevice !== current.environmentalEvidence.topLevelDevice
  ) {
    environmentalDifferences.push('top-level-device');
  }
  if (
    recorded.environmentalEvidence.commonDirectoryDevice !==
    current.environmentalEvidence.commonDirectoryDevice
  ) {
    environmentalDifferences.push('common-directory-device');
  }

  const riskScanDifferences: RiskScanDifference[] = [];
  if (recorded.riskScan.scanScopeVersion !== current.riskScan.scanScopeVersion) {
    riskScanDifferences.push('scan-scope-version');
  }
  if (recorded.riskScan.scannedKeyPattern !== current.riskScan.scannedKeyPattern) {
    riskScanDifferences.push('scanned-key-pattern');
  }
  if (
    recorded.riskScan.signals.length !== current.riskScan.signals.length ||
    recorded.riskScan.signals.some((signal, index) => signal !== current.riskScan.signals[index])
  ) {
    riskScanDifferences.push('signals');
  }

  return {
    ok: true,
    comparison: {
      coreDifferences,
      environmentalDifferences,
      riskScanDifferences,
      sameCoreIdentity: coreDifferences.length === 0,
      sameEnvironmentalEvidence: environmentalDifferences.length === 0,
      sameRiskScanEvidence: riskScanDifferences.length === 0,
    },
  };
}

export function createParsedObservation(
  value: Omit<RepositoryObservationShape, 'coreIdentity'> & {
    readonly coreIdentity: Omit<RepositoryObservationShape['coreIdentity'], 'fingerprintSha256'>;
  },
): ParsedRepositoryObservation {
  const incomplete: RepositoryObservationShape = {
    ...value,
    coreIdentity: {
      ...value.coreIdentity,
      fingerprintSha256: '',
    },
  };
  const complete: RepositoryObservationShape = {
    ...incomplete,
    coreIdentity: {
      ...incomplete.coreIdentity,
      fingerprintSha256: calculateCoreIdentityFingerprint(incomplete),
    },
  };
  return asParsedObservation(complete);
}

export function currentInspectionPolicyVersion(): number {
  return REPOSITORY_INSPECTION_POLICY_VERSION;
}
