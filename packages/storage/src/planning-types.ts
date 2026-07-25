import type {
  DependencyKind,
  DiagnosticSeverity,
  JsonValue,
  PlanArtifact,
  PlanArtifactId,
  PlanArtifactRole,
  PlanBundle,
  PlanBundleId,
  PlanImportAttempt,
  PlanImportAttemptId,
  PlanImportDiagnostic,
  PlanImportDiagnosticId,
  PlanImportOutcome,
  PlanSourceProfile,
  PlanVersion,
  PlanVersionId,
  Project,
  ProjectId,
  UserId,
  WorkContractDraft,
  WorkContractDraftId,
  WorkItem,
  WorkItemDependency,
  WorkItemDependencyId,
  WorkItemId,
  WorkItemRisk,
  WorkspaceId,
} from '@craftingtable/domain';

/* -------------------------------------------------------------------------- */
/* Write inputs                                                                */
/* -------------------------------------------------------------------------- */

export interface CreateProjectInput {
  readonly id: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}

export interface CreatePlanBundleInput {
  readonly id: PlanBundleId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly logicalName: string;
  readonly createdAt: string;
}

export interface CreatePlanVersionInput {
  readonly id: PlanVersionId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly bundleId: PlanBundleId;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly digestAlgorithm: 'sha-256';
  readonly digestFormatVersion: 1;
  readonly sourceProfile: PlanSourceProfile;
  readonly document: string;
  readonly normalizedSource: JsonValue;
  readonly itemCount: number;
  readonly requiredDependencyCount: number;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}

export interface CreatePlanImportAttemptInput {
  readonly id: PlanImportAttemptId;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId: UserId;
  readonly outcome: PlanImportOutcome;
  readonly requestedProjectName: string;
  readonly requestedProjectId?: ProjectId;
  readonly bundleDigest?: string;
  readonly digestFormatVersion?: number;
  readonly projectId?: ProjectId;
  readonly planVersionId?: PlanVersionId;
  readonly artifactCount: number;
  readonly totalByteLength: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly createdAt: string;
}

export interface CreatePlanArtifactInput {
  readonly id: PlanArtifactId;
  readonly workspaceId: WorkspaceId;
  readonly importAttemptId: PlanImportAttemptId;
  readonly planVersionId?: PlanVersionId;
  readonly logicalFilename: string;
  readonly role: PlanArtifactRole;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly content: Uint8Array;
  readonly createdAt: string;
}

export interface CreatePlanImportDiagnosticInput {
  readonly id: PlanImportDiagnosticId;
  readonly workspaceId: WorkspaceId;
  readonly importAttemptId: PlanImportAttemptId;
  readonly planVersionId?: PlanVersionId;
  readonly ordinal: number;
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly artifactName?: string;
  readonly path?: string;
  readonly workItemSourceId?: string;
  readonly message: string;
}

export interface CreateWorkItemInput {
  readonly id: WorkItemId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly planVersionId: PlanVersionId;
  readonly sourceId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly risk: WorkItemRisk;
  readonly phase?: string;
  readonly primaryAreas: readonly string[];
  readonly exitGate: string;
  readonly sourceFields: JsonValue;
}

export interface CreateWorkItemDependencyInput {
  readonly id: WorkItemDependencyId;
  readonly workspaceId: WorkspaceId;
  readonly planVersionId: PlanVersionId;
  readonly predecessorWorkItemId: WorkItemId;
  readonly successorWorkItemId: WorkItemId;
  readonly kind: DependencyKind;
  readonly ordinal: number;
}

export interface CreateWorkContractDraftInput {
  readonly id: WorkContractDraftId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly planVersionId: PlanVersionId;
  readonly workItemId: WorkItemId;
  readonly document: JsonValue;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}

export interface AdmitWorkItemInput {
  readonly workItemId: WorkItemId;
  readonly workspaceId: WorkspaceId;
  readonly admittedAt: string;
  readonly admittedByUserId: UserId;
}

/* -------------------------------------------------------------------------- */
/* Read shapes                                                                 */
/* -------------------------------------------------------------------------- */

/** Artifact metadata plus bytes; only the dedicated artifact route uses this. */
export interface StoredPlanArtifact extends PlanArtifact {
  readonly content: Uint8Array;
}

export interface WorkItemDependencySummary {
  readonly workItemId: WorkItemId;
  readonly sourceId: string;
  readonly title: string;
  readonly status: WorkItem['status'];
  readonly risk: WorkItemRisk;
  readonly kind: DependencyKind;
}

export interface WorkItemRow extends WorkItem {
  /** Required predecessors that are not Completed, derived server-side. */
  readonly blockerSourceIds: readonly string[];
  readonly requiredPredecessorCount: number;
  readonly recommendedPredecessorCount: number;
}

export interface PlanningRiskCounts {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  readonly critical: number;
  readonly unspecified: number;
}

export interface PlanningStatusCounts {
  readonly proposedCount: number;
  readonly admittedCount: number;
  readonly planningReadyCount: number;
  readonly dependencyBlockedCount: number;
  readonly riskCounts: PlanningRiskCounts;
}

export interface ProjectSummaryRow extends PlanningStatusCounts {
  readonly id: ProjectId;
  readonly name: string;
  readonly slug: string;
  readonly activePlanVersionId?: PlanVersionId;
  readonly document?: string;
  readonly versionCount: number;
  readonly warningCount: number;
  readonly createdAt: string;
}

export interface WorkspacePlanningSummary extends PlanningStatusCounts {
  readonly projectCount: number;
  /** Failed attempts plus attempts carrying warnings. */
  readonly importAttentionCount: number;
}

export interface PlanVersionSummaryRow {
  readonly id: PlanVersionId;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly document: string;
  readonly itemCount: number;
  readonly requiredDependencyCount: number;
  readonly createdAt: string;
  readonly isActive: boolean;
}

/* -------------------------------------------------------------------------- */
/* Repositories                                                                */
/* -------------------------------------------------------------------------- */

export interface ProjectRepository {
  insert(input: CreateProjectInput): Project;
  find(workspaceId: WorkspaceId, projectId: ProjectId): Project | undefined;
  findBySlug(workspaceId: WorkspaceId, slug: string): Project | undefined;
  list(workspaceId: WorkspaceId): readonly Project[];
  /** No-op when the project already has an active version (CT03-A31). */
  setActivePlanVersionIfUnset(input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly planVersionId: PlanVersionId;
  }): Project | undefined;
  count(): number;
}

export interface PlanBundleRepository {
  insert(input: CreatePlanBundleInput): PlanBundle;
  findForProject(workspaceId: WorkspaceId, projectId: ProjectId): PlanBundle | undefined;
  count(): number;
}

export interface PlanVersionRepository {
  insert(input: CreatePlanVersionInput): PlanVersion;
  find(workspaceId: WorkspaceId, planVersionId: PlanVersionId): PlanVersion | undefined;
  findByDigest(workspaceId: WorkspaceId, contentDigest: string): PlanVersion | undefined;
  listForProject(workspaceId: WorkspaceId, projectId: ProjectId): readonly PlanVersion[];
  nextVersionNumber(bundleId: PlanBundleId): number;
  count(): number;
}

export interface PlanImportAttemptRepository {
  insert(input: CreatePlanImportAttemptInput): PlanImportAttempt;
  find(workspaceId: WorkspaceId, attemptId: PlanImportAttemptId): PlanImportAttempt | undefined;
  listRecent(workspaceId: WorkspaceId, limit: number): readonly PlanImportAttempt[];
  count(): number;
}

export interface PlanArtifactRepository {
  insertMany(inputs: readonly CreatePlanArtifactInput[]): readonly PlanArtifact[];
  /** Metadata only; bytes are fetched explicitly. */
  listForVersion(workspaceId: WorkspaceId, planVersionId: PlanVersionId): readonly PlanArtifact[];
  listForAttempt(workspaceId: WorkspaceId, attemptId: PlanImportAttemptId): readonly PlanArtifact[];
  /** Resolves the workspace through parent ownership, not a route parameter. */
  findWithContent(
    workspaceId: WorkspaceId,
    artifactId: PlanArtifactId,
  ): StoredPlanArtifact | undefined;
  count(): number;
}

export interface PlanImportDiagnosticRepository {
  insertMany(inputs: readonly CreatePlanImportDiagnosticInput[]): readonly PlanImportDiagnostic[];
  listForAttempt(
    workspaceId: WorkspaceId,
    attemptId: PlanImportAttemptId,
  ): readonly PlanImportDiagnostic[];
  listForVersion(
    workspaceId: WorkspaceId,
    planVersionId: PlanVersionId,
  ): readonly PlanImportDiagnostic[];
  count(): number;
}

export interface WorkItemRepository {
  insertMany(inputs: readonly CreateWorkItemInput[]): readonly WorkItem[];
  find(workspaceId: WorkspaceId, workItemId: WorkItemId): WorkItem | undefined;
  listForVersion(workspaceId: WorkspaceId, planVersionId: PlanVersionId): readonly WorkItemRow[];
  admit(input: AdmitWorkItemInput): WorkItem | undefined;
  count(): number;
}

export interface WorkItemDependencyRepository {
  insertMany(inputs: readonly CreateWorkItemDependencyInput[]): readonly WorkItemDependency[];
  listForVersion(
    workspaceId: WorkspaceId,
    planVersionId: PlanVersionId,
  ): readonly WorkItemDependency[];
  listPredecessors(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
  ): readonly WorkItemDependencySummary[];
  listSuccessors(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
  ): readonly WorkItemDependencySummary[];
  count(): number;
}

export interface WorkContractDraftRepository {
  insert(input: CreateWorkContractDraftInput): WorkContractDraft;
  findForWorkItem(workspaceId: WorkspaceId, workItemId: WorkItemId): WorkContractDraft | undefined;
  count(): number;
}

/** Set-based summary reads. Deliberately not N+1 per work item. */
export interface PlanningQueryRepository {
  workspaceSummary(workspaceId: WorkspaceId): WorkspacePlanningSummary;
  projectSummaries(workspaceId: WorkspaceId, limit: number): readonly ProjectSummaryRow[];
  versionSummaries(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): readonly PlanVersionSummaryRow[];
  versionStatusCounts(workspaceId: WorkspaceId, planVersionId: PlanVersionId): PlanningStatusCounts;
}

export interface PlanningRepositories {
  readonly projects: ProjectRepository;
  readonly bundles: PlanBundleRepository;
  readonly versions: PlanVersionRepository;
  readonly importAttempts: PlanImportAttemptRepository;
  readonly artifacts: PlanArtifactRepository;
  readonly diagnostics: PlanImportDiagnosticRepository;
  readonly workItems: WorkItemRepository;
  readonly dependencies: WorkItemDependencyRepository;
  readonly drafts: WorkContractDraftRepository;
  readonly queries: PlanningQueryRepository;
}
