import type { ConcurrencySource } from './concurrency-source.js';
import type {
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
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly filename: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly createdAt: string;
}
export interface ArchiveImportAttempt {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly archiveId: string;
  readonly kind: 'plan' | 'concurrency';
  readonly outcome: 'succeeded' | 'duplicate' | 'failed-validation' | 'conflict';
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly diagnostics: readonly ImportIssue[];
  readonly definitionId?: string;
  readonly planVersionId?: PlanVersionId;
}
export interface ConcurrencyDefinition {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly archiveId: string;
  readonly mapId: string;
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
    readonly sourceId: string;
    readonly artifactId: PlanArtifactId;
    readonly sha256: string;
  }[];
  readonly workItems: readonly {
    readonly sourceId: string;
    readonly workItemId: WorkItemId;
    readonly sourceRecordDigest: string;
  }[];
}
export interface ConcurrencyBindingRevision {
  readonly definitionId: string;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly bindings: readonly ConcurrencyPlanBinding[];
}
export interface PlanArchiveLink {
  readonly workspaceId: WorkspaceId;
  readonly planVersionId: PlanVersionId;
  readonly archiveId: string;
  readonly implementationPlan: string;
  readonly workBreakdown: string;
  readonly selectedPaths: readonly string[];
}
