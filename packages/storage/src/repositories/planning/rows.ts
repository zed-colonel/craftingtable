import type {
  DependencyKind,
  DiagnosticSeverity,
  JsonValue,
  PlanArtifact,
  PlanBundle,
  PlanImportAttempt,
  PlanImportDiagnostic,
  PlanImportOutcome,
  PlanVersion,
  Project,
  WorkContractDraft,
  WorkItem,
  WorkItemDependency,
  WorkItemRisk,
  WorkItemStatus,
} from '@craftingtable/domain';

/**
 * Row shapes and mappers shared by the planning repositories.
 *
 * Optional columns are omitted rather than set to `undefined` so the mapped
 * records match the exact-optional domain types.
 */

export function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  active_plan_version_id: string | null;
  created_at: string;
  created_by_user_id: string;
  version: number;
}

export function mapProject(row: ProjectRow): Project {
  return {
    id: row.id as Project['id'],
    workspaceId: row.workspace_id as Project['workspaceId'],
    name: row.name,
    slug: row.slug,
    ...(row.active_plan_version_id === null
      ? {}
      : {
          activePlanVersionId: row.active_plan_version_id as NonNullable<
            Project['activePlanVersionId']
          >,
        }),
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id as Project['createdByUserId'],
    version: row.version,
  };
}

export interface PlanBundleRow {
  id: string;
  workspace_id: string;
  project_id: string;
  logical_name: string;
  created_at: string;
}

export function mapBundle(row: PlanBundleRow): PlanBundle {
  return {
    id: row.id as PlanBundle['id'],
    workspaceId: row.workspace_id as PlanBundle['workspaceId'],
    projectId: row.project_id as PlanBundle['projectId'],
    logicalName: row.logical_name,
    createdAt: row.created_at,
  };
}

export interface PlanVersionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  bundle_id: string;
  version_number: number;
  content_digest: string;
  digest_algorithm: 'sha-256';
  digest_format_version: 1;
  source_profile: PlanVersion['sourceProfile'];
  document: string;
  normalized_source_json: string;
  item_count: number;
  required_dependency_count: number;
  created_at: string;
  created_by_user_id: string;
}

export function mapVersion(row: PlanVersionRow): PlanVersion {
  return {
    id: row.id as PlanVersion['id'],
    workspaceId: row.workspace_id as PlanVersion['workspaceId'],
    projectId: row.project_id as PlanVersion['projectId'],
    bundleId: row.bundle_id as PlanVersion['bundleId'],
    versionNumber: row.version_number,
    contentDigest: row.content_digest,
    digestAlgorithm: row.digest_algorithm,
    digestFormatVersion: row.digest_format_version,
    sourceProfile: row.source_profile,
    document: row.document,
    normalizedSource: parseJson(row.normalized_source_json),
    itemCount: row.item_count,
    requiredDependencyCount: row.required_dependency_count,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id as PlanVersion['createdByUserId'],
  };
}

export interface PlanImportAttemptRow {
  id: string;
  workspace_id: string;
  actor_user_id: string;
  outcome: PlanImportOutcome;
  requested_project_name: string;
  requested_project_id: string | null;
  bundle_digest: string | null;
  digest_format_version: number | null;
  project_id: string | null;
  plan_version_id: string | null;
  artifact_count: number;
  total_byte_length: number;
  error_count: number;
  warning_count: number;
  created_at: string;
}

export function mapAttempt(row: PlanImportAttemptRow): PlanImportAttempt {
  return {
    id: row.id as PlanImportAttempt['id'],
    workspaceId: row.workspace_id as PlanImportAttempt['workspaceId'],
    actorUserId: row.actor_user_id as PlanImportAttempt['actorUserId'],
    outcome: row.outcome,
    requestedProjectName: row.requested_project_name,
    ...(row.requested_project_id === null
      ? {}
      : {
          requestedProjectId: row.requested_project_id as NonNullable<
            PlanImportAttempt['requestedProjectId']
          >,
        }),
    ...(row.bundle_digest === null ? {} : { bundleDigest: row.bundle_digest }),
    ...(row.digest_format_version === null
      ? {}
      : { digestFormatVersion: row.digest_format_version }),
    ...(row.project_id === null
      ? {}
      : { projectId: row.project_id as NonNullable<PlanImportAttempt['projectId']> }),
    ...(row.plan_version_id === null
      ? {}
      : { planVersionId: row.plan_version_id as NonNullable<PlanImportAttempt['planVersionId']> }),
    artifactCount: row.artifact_count,
    totalByteLength: row.total_byte_length,
    errorCount: row.error_count,
    warningCount: row.warning_count,
    createdAt: row.created_at,
  };
}

export interface PlanArtifactRow {
  id: string;
  workspace_id: string;
  import_attempt_id: string;
  plan_version_id: string | null;
  logical_filename: string;
  role: PlanArtifact['role'];
  media_type: string;
  byte_length: number;
  sha256: string;
  created_at: string;
}

export function mapArtifact(row: PlanArtifactRow): PlanArtifact {
  return {
    id: row.id as PlanArtifact['id'],
    workspaceId: row.workspace_id as PlanArtifact['workspaceId'],
    importAttemptId: row.import_attempt_id as PlanArtifact['importAttemptId'],
    ...(row.plan_version_id === null
      ? {}
      : { planVersionId: row.plan_version_id as NonNullable<PlanArtifact['planVersionId']> }),
    logicalFilename: row.logical_filename,
    role: row.role,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export interface PlanImportDiagnosticRow {
  id: string;
  workspace_id: string;
  import_attempt_id: string;
  plan_version_id: string | null;
  ordinal: number;
  severity: DiagnosticSeverity;
  code: string;
  artifact_name: string | null;
  path: string | null;
  work_item_source_id: string | null;
  message: string;
}

export function mapDiagnostic(row: PlanImportDiagnosticRow): PlanImportDiagnostic {
  return {
    id: row.id as PlanImportDiagnostic['id'],
    workspaceId: row.workspace_id as PlanImportDiagnostic['workspaceId'],
    importAttemptId: row.import_attempt_id as PlanImportDiagnostic['importAttemptId'],
    ...(row.plan_version_id === null
      ? {}
      : {
          planVersionId: row.plan_version_id as NonNullable<PlanImportDiagnostic['planVersionId']>,
        }),
    ordinal: row.ordinal,
    severity: row.severity,
    code: row.code,
    ...(row.artifact_name === null ? {} : { artifactName: row.artifact_name }),
    ...(row.path === null ? {} : { path: row.path }),
    ...(row.work_item_source_id === null ? {} : { workItemSourceId: row.work_item_source_id }),
    message: row.message,
  };
}

export interface WorkItemDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  plan_version_id: string;
  source_id: string;
  ordinal: number;
  title: string;
  status: WorkItemStatus;
  risk: WorkItemRisk;
  phase: string | null;
  primary_areas_json: string;
  exit_gate: string;
  source_fields_json: string;
  admitted_at: string | null;
  admitted_by_user_id: string | null;
  version: number;
}

export function mapWorkItem(row: WorkItemDbRow): WorkItem {
  return {
    id: row.id as WorkItem['id'],
    workspaceId: row.workspace_id as WorkItem['workspaceId'],
    projectId: row.project_id as WorkItem['projectId'],
    planVersionId: row.plan_version_id as WorkItem['planVersionId'],
    sourceId: row.source_id,
    ordinal: row.ordinal,
    title: row.title,
    status: row.status,
    risk: row.risk,
    ...(row.phase === null ? {} : { phase: row.phase }),
    primaryAreas: JSON.parse(row.primary_areas_json) as readonly string[],
    exitGate: row.exit_gate,
    sourceFields: parseJson(row.source_fields_json),
    ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }),
    ...(row.admitted_by_user_id === null
      ? {}
      : { admittedByUserId: row.admitted_by_user_id as NonNullable<WorkItem['admittedByUserId']> }),
    version: row.version,
  };
}

export interface WorkItemDependencyRow {
  id: string;
  workspace_id: string;
  plan_version_id: string;
  predecessor_work_item_id: string;
  successor_work_item_id: string;
  kind: DependencyKind;
  ordinal: number;
}

export function mapDependency(row: WorkItemDependencyRow): WorkItemDependency {
  return {
    id: row.id as WorkItemDependency['id'],
    workspaceId: row.workspace_id as WorkItemDependency['workspaceId'],
    planVersionId: row.plan_version_id as WorkItemDependency['planVersionId'],
    predecessorWorkItemId:
      row.predecessor_work_item_id as WorkItemDependency['predecessorWorkItemId'],
    successorWorkItemId: row.successor_work_item_id as WorkItemDependency['successorWorkItemId'],
    kind: row.kind,
    ordinal: row.ordinal,
  };
}

export interface WorkContractDraftRow {
  id: string;
  workspace_id: string;
  project_id: string;
  plan_version_id: string;
  work_item_id: string;
  schema_version: 1;
  status: 'draft';
  completeness: 'incomplete';
  document_json: string;
  created_at: string;
  created_by_user_id: string;
}

export function mapDraft(row: WorkContractDraftRow): WorkContractDraft {
  return {
    id: row.id as WorkContractDraft['id'],
    workspaceId: row.workspace_id as WorkContractDraft['workspaceId'],
    projectId: row.project_id as WorkContractDraft['projectId'],
    planVersionId: row.plan_version_id as WorkContractDraft['planVersionId'],
    workItemId: row.work_item_id as WorkContractDraft['workItemId'],
    schemaVersion: row.schema_version,
    status: row.status,
    completeness: row.completeness,
    document: parseJson(row.document_json),
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id as WorkContractDraft['createdByUserId'],
  };
}
