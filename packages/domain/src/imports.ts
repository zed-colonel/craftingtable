import type { ConcurrencySource } from './concurrency-source.js';
import type {
  ConcurrencyDefinitionId,
  ConcurrencyMapId,
  ImportedArchiveId,
  MapSourceFileId,
  MapWorkItemId,
  PlanArtifactId,
  PlanVersionId,
  ProjectId,
  SourceRepositoryId,
  UserId,
  WorkItemId,
  WorkspaceId,
} from './ids.js';
export interface ImportIssue {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}
export interface ImportedArchive {
  readonly id: ImportedArchiveId;
  readonly workspaceId: WorkspaceId;
  readonly filename: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly createdAt: string;
}
export interface ArchiveImportAttempt {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly archiveId: ImportedArchiveId;
  readonly kind: 'plan' | 'concurrency';
  readonly outcome: 'succeeded' | 'duplicate' | 'failed-validation' | 'conflict';
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly diagnostics: readonly ImportIssue[];
  readonly definitionId?: ConcurrencyDefinitionId;
  readonly planVersionId?: PlanVersionId;
}
export interface ConcurrencyDefinition {
  readonly id: ConcurrencyDefinitionId;
  readonly workspaceId: WorkspaceId;
  readonly archiveId: ImportedArchiveId;
  readonly mapId: ConcurrencyMapId;
  readonly revision: string;
  readonly digest: string;
  readonly source: ConcurrencySource;
  readonly graphNodeCount: number;
  readonly graphEdgeCount: number;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
export interface ConcurrencyPlanBinding {
  readonly alias: string;
  readonly projectId?: ProjectId;
  readonly planVersionId?: PlanVersionId;
  readonly repositoryId?: SourceRepositoryId;
  readonly integrationBranch?: string;
  readonly branchSettingsVersion?: number;
  readonly sourceArtifacts: readonly {
    readonly sourceId: MapSourceFileId;
    readonly artifactId: PlanArtifactId;
    readonly sha256: string;
  }[];
  readonly workItems: readonly {
    readonly sourceId: MapWorkItemId;
    readonly workItemId: WorkItemId;
    readonly sourceRecordDigest: string;
  }[];
}
export interface ConcurrencyBindingRevision {
  readonly definitionId: ConcurrencyDefinitionId;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly bindings: readonly ConcurrencyPlanBinding[];
}
export interface PlanArchiveLink {
  readonly workspaceId: WorkspaceId;
  readonly planVersionId: PlanVersionId;
  readonly archiveId: ImportedArchiveId;
  readonly implementationPlan: string;
  readonly workBreakdown: string;
  readonly selectedPaths: readonly string[];
}
