import type {
  FailedRepositoryInspection,
  ProjectRepositoryBinding,
  RegisteredRepository,
  RepositoryInspection,
  SuccessfulRepositoryInspection,
} from '@craftingtable/domain';

export interface RegisteredRepositoryRow {
  id: string;
  workspace_id: string;
  display_name: string;
  canonical_top_level: string;
  canonical_git_directory: string;
  canonical_common_git_directory: string;
  object_format: RegisteredRepository['objectFormat'];
  top_level_inode: string;
  common_directory_inode: string;
  core_fingerprint_sha256: string;
  observation_version: 1;
  inspection_policy_version: number;
  registration_inspection_id: string;
  accepted_environment_inspection_id: string;
  status: RegisteredRepository['status'];
  status_reason: RegisteredRepository['statusReason'];
  registered_by_user_id: string;
  registered_at: string;
  status_changed_by_user_id: string;
  status_changed_at: string;
  version: number;
}

export function mapRegisteredRepository(row: RegisteredRepositoryRow): RegisteredRepository {
  return {
    id: row.id as RegisteredRepository['id'],
    workspaceId: row.workspace_id as RegisteredRepository['workspaceId'],
    displayName: row.display_name,
    canonicalTopLevel: row.canonical_top_level,
    canonicalGitDirectory: row.canonical_git_directory,
    canonicalCommonGitDirectory: row.canonical_common_git_directory,
    objectFormat: row.object_format,
    topLevelInode: row.top_level_inode,
    commonDirectoryInode: row.common_directory_inode,
    coreFingerprintSha256: row.core_fingerprint_sha256,
    observationVersion: row.observation_version,
    inspectionPolicyVersion: row.inspection_policy_version,
    registrationInspectionId:
      row.registration_inspection_id as RegisteredRepository['registrationInspectionId'],
    acceptedEnvironmentInspectionId:
      row.accepted_environment_inspection_id as RegisteredRepository['acceptedEnvironmentInspectionId'],
    status: row.status,
    statusReason: row.status_reason,
    registeredByUserId: row.registered_by_user_id as RegisteredRepository['registeredByUserId'],
    registeredAt: row.registered_at,
    statusChangedByUserId:
      row.status_changed_by_user_id as RegisteredRepository['statusChangedByUserId'],
    statusChangedAt: row.status_changed_at,
    version: row.version,
  };
}

export interface RepositoryInspectionRow {
  sequence: number;
  id: string;
  workspace_id: string;
  repository_id: string;
  actor_user_id: string;
  kind: RepositoryInspection['kind'];
  outcome: RepositoryInspection['outcome'];
  created_at: string;
  observation_json: string | null;
  observation_sha256: string | null;
  observation_version: 1 | null;
  inspection_policy_version: number | null;
  observed_at: string | null;
  canonical_top_level: string | null;
  canonical_git_directory: string | null;
  canonical_common_git_directory: string | null;
  object_format: 'sha1' | 'sha256' | null;
  top_level_inode: string | null;
  common_directory_inode: string | null;
  core_fingerprint_sha256: string | null;
  top_level_device: string | null;
  common_directory_device: string | null;
  risk_scan_scope_version: 1 | null;
  risk_scanned_key_pattern: string | null;
  risk_classification: SuccessfulRepositoryInspection['riskClassification'] | null;
  risk_signals_json: string | null;
  core_differences_json: string | null;
  environmental_differences_json: string | null;
  risk_differences_json: string | null;
  error_origin: FailedRepositoryInspection['errorOrigin'] | null;
  error_code: FailedRepositoryInspection['errorCode'] | null;
  error_subject: FailedRepositoryInspection['errorSubject'] | null;
  error_category: FailedRepositoryInspection['errorCategory'] | null;
  error_operation: FailedRepositoryInspection['errorOperation'] | null;
  error_retryability: FailedRepositoryInspection['errorRetryability'] | null;
  error_evidence_json: string | null;
}

function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`Repository inspection has invalid NULL ${column}`);
  }
  return value;
}

export function mapRepositoryInspection(row: RepositoryInspectionRow): RepositoryInspection {
  const base = {
    sequence: row.sequence,
    id: row.id as RepositoryInspection['id'],
    workspaceId: row.workspace_id as RepositoryInspection['workspaceId'],
    repositoryId: row.repository_id as RepositoryInspection['repositoryId'],
    actorUserId: row.actor_user_id as RepositoryInspection['actorUserId'],
    createdAt: row.created_at,
  };
  if (row.outcome === 'failed') {
    return {
      ...base,
      kind: row.kind as FailedRepositoryInspection['kind'],
      outcome: 'failed',
      errorOrigin: required(row.error_origin, 'error_origin'),
      errorCode: required(row.error_code, 'error_code'),
      errorSubject: required(row.error_subject, 'error_subject'),
      errorCategory: required(row.error_category, 'error_category'),
      errorOperation: required(row.error_operation, 'error_operation'),
      errorRetryability: required(row.error_retryability, 'error_retryability'),
      errorEvidence: JSON.parse(
        required(row.error_evidence_json, 'error_evidence_json'),
      ) as FailedRepositoryInspection['errorEvidence'],
    };
  }
  const kind = row.kind as SuccessfulRepositoryInspection['kind'];
  return {
    ...base,
    kind,
    outcome: 'succeeded',
    observationJson: required(row.observation_json, 'observation_json'),
    observationSha256: required(row.observation_sha256, 'observation_sha256'),
    observationVersion: required(row.observation_version, 'observation_version'),
    inspectionPolicyVersion: required(row.inspection_policy_version, 'inspection_policy_version'),
    observedAt: required(row.observed_at, 'observed_at'),
    canonicalTopLevel: required(row.canonical_top_level, 'canonical_top_level'),
    canonicalGitDirectory: required(row.canonical_git_directory, 'canonical_git_directory'),
    canonicalCommonGitDirectory: required(
      row.canonical_common_git_directory,
      'canonical_common_git_directory',
    ),
    objectFormat: required(row.object_format, 'object_format'),
    topLevelInode: required(row.top_level_inode, 'top_level_inode'),
    commonDirectoryInode: required(row.common_directory_inode, 'common_directory_inode'),
    coreFingerprintSha256: required(row.core_fingerprint_sha256, 'core_fingerprint_sha256'),
    topLevelDevice: required(row.top_level_device, 'top_level_device'),
    commonDirectoryDevice: required(row.common_directory_device, 'common_directory_device'),
    riskScanScopeVersion: required(row.risk_scan_scope_version, 'risk_scan_scope_version'),
    riskScannedKeyPattern: required(row.risk_scanned_key_pattern, 'risk_scanned_key_pattern'),
    riskClassification: required(row.risk_classification, 'risk_classification'),
    riskSignals: JSON.parse(
      required(row.risk_signals_json, 'risk_signals_json'),
    ) as SuccessfulRepositoryInspection['riskSignals'],
    ...(kind === 'registration'
      ? {}
      : {
          coreDifferences: JSON.parse(
            required(row.core_differences_json, 'core_differences_json'),
          ) as NonNullable<SuccessfulRepositoryInspection['coreDifferences']>,
          environmentalDifferences: JSON.parse(
            required(row.environmental_differences_json, 'environmental_differences_json'),
          ) as NonNullable<SuccessfulRepositoryInspection['environmentalDifferences']>,
          riskDifferences: JSON.parse(
            required(row.risk_differences_json, 'risk_differences_json'),
          ) as NonNullable<SuccessfulRepositoryInspection['riskDifferences']>,
        }),
  };
}

export interface ProjectRepositoryBindingRow {
  id: string;
  workspace_id: string;
  project_id: string;
  repository_id: string;
  status: ProjectRepositoryBinding['status'];
  bound_by_user_id: string;
  bound_at: string;
  retired_by_user_id: string | null;
  retired_at: string | null;
  version: number;
}

export function mapProjectRepositoryBinding(
  row: ProjectRepositoryBindingRow,
): ProjectRepositoryBinding {
  return {
    id: row.id as ProjectRepositoryBinding['id'],
    workspaceId: row.workspace_id as ProjectRepositoryBinding['workspaceId'],
    projectId: row.project_id as ProjectRepositoryBinding['projectId'],
    repositoryId: row.repository_id as ProjectRepositoryBinding['repositoryId'],
    status: row.status,
    boundByUserId: row.bound_by_user_id as ProjectRepositoryBinding['boundByUserId'],
    boundAt: row.bound_at,
    ...(row.retired_by_user_id === null
      ? {}
      : {
          retiredByUserId: row.retired_by_user_id as NonNullable<
            ProjectRepositoryBinding['retiredByUserId']
          >,
        }),
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    version: row.version,
  };
}
