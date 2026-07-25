import type {
  PlanArtifactId,
  PlanImportAttemptId,
  PlanVersionId,
  ProjectId,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import type {
  CraftingTableStorage,
  StoredPlanArtifact,
  StorageRepositories,
  WorkItemRow,
} from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { NotFoundError } from './errors.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * Authorized planning reads.
 *
 * Every method requires workspace membership first, and every lookup is scoped
 * by workspace in SQL rather than filtered afterwards. A resource in another
 * workspace is indistinguishable from one that does not exist (CT03-A35).
 */

export type WorkItemReadiness = 'planning-ready' | 'dependency-blocked' | 'active';

export function readinessOf(item: {
  readonly status: string;
  readonly blockerSourceIds: readonly string[];
}): WorkItemReadiness {
  if (item.status === 'admitted') {
    return 'active';
  }
  return item.blockerSourceIds.length === 0 ? 'planning-ready' : 'dependency-blocked';
}

function workItemSummary(item: WorkItemRow) {
  return {
    id: item.id,
    sourceId: item.sourceId,
    ordinal: item.ordinal,
    title: item.title,
    status: item.status,
    risk: item.risk,
    ...(item.phase === undefined ? {} : { phase: item.phase }),
    primaryAreas: [...item.primaryAreas],
    exitGate: item.exitGate,
    requiredPredecessorCount: item.requiredPredecessorCount,
    recommendedPredecessorCount: item.recommendedPredecessorCount,
    blockerSourceIds: [...item.blockerSourceIds],
    readiness: readinessOf(item),
  };
}

export class PlanningQueryService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
  ) {}

  listProjects(context: AuthContext, workspaceId: WorkspaceId, requestId?: string) {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.readTransaction((tx) => ({
      projects: tx.planning.queries.projectSummaries(workspaceId, 100),
    }));
  }

  projectDetail(
    context: AuthContext,
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    requestId?: string,
  ) {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const detail = this.storage.readTransaction((tx) => {
      const project = tx.planning.queries
        .projectSummaries(workspaceId, 100)
        .find((summary) => summary.id === projectId);
      if (project === undefined) {
        return undefined;
      }
      const versions = tx.planning.queries.versionSummaries(workspaceId, projectId);
      const activeVersionId = project.activePlanVersionId;
      return {
        project,
        versions,
        activeVersion:
          activeVersionId === undefined
            ? null
            : this.versionDetailWithin(tx, workspaceId, activeVersionId),
      };
    });
    if (detail === undefined) {
      throw new NotFoundError();
    }
    return detail;
  }

  planVersionDetail(
    context: AuthContext,
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    planVersionId: PlanVersionId,
    requestId?: string,
  ) {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const detail = this.storage.readTransaction((tx) => {
      const version = tx.planning.versions.find(workspaceId, planVersionId);
      if (version === undefined || version.projectId !== projectId) {
        return undefined;
      }
      return this.versionDetailWithin(tx, workspaceId, planVersionId);
    });
    if (detail === null || detail === undefined) {
      throw new NotFoundError();
    }
    return detail;
  }

  workItemDetail(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    requestId?: string,
  ) {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const detail = this.storage.readTransaction((tx) => {
      const item = tx.planning.workItems.find(workspaceId, workItemId);
      if (item === undefined) {
        return undefined;
      }
      const rows = tx.planning.workItems.listForVersion(workspaceId, item.planVersionId);
      const row = rows.find((candidate) => candidate.id === workItemId);
      if (row === undefined) {
        return undefined;
      }
      const project = tx.planning.projects.find(workspaceId, item.projectId);
      const predecessors = tx.planning.dependencies.listPredecessors(workspaceId, workItemId);
      const draft = tx.planning.drafts.findForWorkItem(workspaceId, workItemId);
      return {
        workItem: {
          ...workItemSummary(row),
          projectId: item.projectId,
          planVersionId: item.planVersionId,
          ...(item.admittedAt === undefined ? {} : { admittedAt: item.admittedAt }),
        },
        projectName: project?.name ?? 'Unknown project',
        requiredPredecessors: predecessors.filter((entry) => entry.kind === 'required'),
        recommendedPredecessors: predecessors.filter((entry) => entry.kind === 'recommended'),
        dependents: tx.planning.dependencies.listSuccessors(workspaceId, workItemId),
        draft:
          draft === undefined
            ? null
            : {
                id: draft.id,
                schemaVersion: draft.schemaVersion,
                status: draft.status,
                completeness: draft.completeness,
                createdAt: draft.createdAt,
                document: draft.document,
              },
      };
    });
    if (detail === undefined) {
      throw new NotFoundError();
    }
    return detail;
  }

  /** Recent import attempts with their diagnostics, for the attention region. */
  listImportAttempts(context: AuthContext, workspaceId: WorkspaceId, requestId?: string) {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.readTransaction((tx) => ({
      attempts: tx.planning.importAttempts.listRecent(workspaceId, 25).map((attempt) => ({
        id: attempt.id,
        outcome: attempt.outcome,
        requestedProjectName: attempt.requestedProjectName,
        ...(attempt.projectId === undefined ? {} : { projectId: attempt.projectId }),
        ...(attempt.planVersionId === undefined ? {} : { planVersionId: attempt.planVersionId }),
        ...(attempt.bundleDigest === undefined ? {} : { bundleDigest: attempt.bundleDigest }),
        artifactCount: attempt.artifactCount,
        totalByteLength: attempt.totalByteLength,
        errorCount: attempt.errorCount,
        warningCount: attempt.warningCount,
        createdAt: attempt.createdAt,
        diagnostics: tx.planning.diagnostics
          .listForAttempt(workspaceId, attempt.id)
          .map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
            ...(diagnostic.artifactName === undefined
              ? {}
              : { artifactName: diagnostic.artifactName }),
            ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
            ...(diagnostic.workItemSourceId === undefined
              ? {}
              : { workItemSourceId: diagnostic.workItemSourceId }),
          })),
      })),
    }));
  }

  /**
   * Artifact bytes.
   *
   * The repository resolves ownership through the parent import attempt, so an
   * artifact id from another workspace yields nothing rather than content.
   */
  artifactContent(
    context: AuthContext,
    workspaceId: WorkspaceId,
    artifactId: PlanArtifactId,
    requestId?: string,
  ): StoredPlanArtifact {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const artifact = this.storage.planning.artifacts.findWithContent(workspaceId, artifactId);
    if (artifact === undefined) {
      throw new NotFoundError();
    }
    return artifact;
  }

  private versionDetailWithin(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    planVersionId: PlanVersionId,
  ) {
    const version = tx.planning.versions.find(workspaceId, planVersionId);
    if (version === undefined) {
      return null;
    }
    const project = tx.planning.projects.find(workspaceId, version.projectId);
    return {
      version: {
        id: version.id,
        versionNumber: version.versionNumber,
        contentDigest: version.contentDigest,
        document: version.document,
        itemCount: version.itemCount,
        requiredDependencyCount: version.requiredDependencyCount,
        createdAt: version.createdAt,
        isActive: project?.activePlanVersionId === version.id,
        sourceProfile: version.sourceProfile,
        digestAlgorithm: version.digestAlgorithm,
        digestFormatVersion: version.digestFormatVersion,
      },
      projectId: version.projectId,
      counts: tx.planning.queries.versionStatusCounts(workspaceId, planVersionId),
      artifacts: tx.planning.artifacts
        .listForVersion(workspaceId, planVersionId)
        .map((artifact) => ({
          id: artifact.id,
          logicalFilename: artifact.logicalFilename,
          role: artifact.role,
          mediaType: artifact.mediaType,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
        })),
      diagnostics: tx.planning.diagnostics
        .listForVersion(workspaceId, planVersionId)
        .map((diagnostic) => ({
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.artifactName === undefined
            ? {}
            : { artifactName: diagnostic.artifactName }),
          ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
          ...(diagnostic.workItemSourceId === undefined
            ? {}
            : { workItemSourceId: diagnostic.workItemSourceId }),
        })),
      workItems: tx.planning.workItems
        .listForVersion(workspaceId, planVersionId)
        .map(workItemSummary),
    };
  }
}

export type { PlanImportAttemptId };
