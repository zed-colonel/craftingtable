import {
  STORED_REPOSITORY_RISK_SCAN_PATTERN,
  asRepositoryId,
  asRepositoryInspectionId,
  type SuccessfulRepositoryInspection,
  type UserId,
  type WorkspaceId,
} from '@craftingtable/domain';
import {
  serializeRepositoryObservation,
  sha256ExactUtf8,
  type SuccessfulInspectionWrite,
} from './repository-types.js';

export { serializeRepositoryObservation, sha256ExactUtf8 } from './repository-types.js';

export function repositoryRegistrationInspection(input: {
  readonly suffix: string;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId: UserId;
  readonly createdAt: string;
}): SuccessfulInspectionWrite & {
  readonly kind: 'registration';
  readonly outcome: 'succeeded';
} {
  const repositoryId = asRepositoryId(`repository-${input.suffix}`);
  const path = `/source/${input.suffix}`;
  const observation = {
    observationVersion: 1,
    inspectionPolicyVersion: 1,
    observedAt: input.createdAt,
    gitVersion: { major: 2, minor: 50, patch: 0 },
    canonicalTopLevel: path,
    canonicalGitDirectory: `${path}/.git`,
    canonicalCommonGitDirectory: `${path}/.git`,
    objectFormat: 'sha1',
    coreIdentity: {
      topLevelInode: '100',
      commonDirectoryInode: '101',
      fingerprintSha256: sha256ExactUtf8(`fingerprint:${input.suffix}`),
    },
    environmentalEvidence: {
      topLevelDevice: '10',
      commonDirectoryDevice: '10',
    },
    riskScan: {
      scanScopeVersion: 1,
      scannedKeyPattern: STORED_REPOSITORY_RISK_SCAN_PATTERN,
      classification: 'no-signals-in-scanned-set',
      signals: [],
    },
  } as const;
  const serialized = serializeRepositoryObservation(observation);
  return {
    id: asRepositoryInspectionId(`inspection-${input.suffix}`),
    workspaceId: input.workspaceId,
    repositoryId,
    actorUserId: input.actorUserId,
    kind: 'registration',
    outcome: 'succeeded',
    createdAt: input.createdAt,
    ...serialized,
    observationVersion: 1,
    inspectionPolicyVersion: 1,
    observedAt: input.createdAt,
    canonicalTopLevel: observation.canonicalTopLevel,
    canonicalGitDirectory: observation.canonicalGitDirectory,
    canonicalCommonGitDirectory: observation.canonicalCommonGitDirectory,
    objectFormat: observation.objectFormat,
    topLevelInode: observation.coreIdentity.topLevelInode,
    commonDirectoryInode: observation.coreIdentity.commonDirectoryInode,
    coreFingerprintSha256: observation.coreIdentity.fingerprintSha256,
    topLevelDevice: observation.environmentalEvidence.topLevelDevice,
    commonDirectoryDevice: observation.environmentalEvidence.commonDirectoryDevice,
    riskScanScopeVersion: 1,
    riskScannedKeyPattern: STORED_REPOSITORY_RISK_SCAN_PATTERN,
    riskClassification: observation.riskScan.classification,
    riskSignals: [] as readonly SuccessfulRepositoryInspection['riskSignals'][number][],
  };
}
