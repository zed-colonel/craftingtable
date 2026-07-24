import { randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  asPlanArtifactId,
  asPlanBundleId,
  asPlanImportAttemptId,
  asPlanImportDiagnosticId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  type JsonValue,
  type PlanImportAttempt,
  type PlanVersion,
  type Project,
  type ProjectId,
  type WorkspaceId,
} from '@craftingtable/domain';
import {
  analyzePlanBundle,
  type PlanBundleAnalysis,
  type PlanBundleInput,
  type PlanDiagnostic,
} from '@craftingtable/planning';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { NotFoundError } from './errors.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

export interface PlanImportInput {
  readonly workspaceId: WorkspaceId;
  readonly projectName?: string;
  readonly projectId?: ProjectId;
  readonly bundleName?: string;
  readonly bundle: PlanBundleInput;
  readonly requestId?: string;
}

export type PlanImportResult =
  | {
      readonly outcome: 'succeeded';
      readonly attempt: PlanImportAttempt;
      readonly project: Project;
      readonly version: PlanVersion;
      readonly isActiveVersion: boolean;
      readonly diagnostics: readonly PlanDiagnostic[];
    }
  | {
      readonly outcome: 'duplicate';
      readonly attempt: PlanImportAttempt;
      readonly project: Project;
      readonly version: PlanVersion;
      readonly isActiveVersion: boolean;
    }
  | {
      readonly outcome: 'failed-validation';
      readonly attempt: PlanImportAttempt;
      readonly diagnostics: readonly PlanDiagnostic[];
    };

export class InvalidImportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImportRequestError';
  }
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return slug.length === 0 ? 'project' : slug;
}

/**
 * Audit metadata is built from an explicit allowlist of derived counts. It
 * never contains source artifacts, cookies, tokens, or headers (CT03-A42).
 */
function auditMetadata(analysis: PlanBundleAnalysis): Record<string, JsonValue> {
  return {
    artifactCount: analysis.artifacts.length,
    totalByteLength: analysis.totalByteLength,
    errorCount: analysis.errorCount,
    warningCount: analysis.warningCount,
    ...(analysis.digest === undefined ? {} : { bundleDigest: analysis.digest.hex }),
  };
}

export class PlanImportService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Imports one plan bundle.
   *
   * Parsing, digesting, and graph analysis all happen *before* the transaction
   * opens: `better-sqlite3` transaction callbacks are synchronous, and holding
   * a write lock across YAML parsing would serialise the daemon on untrusted
   * input (CT-03 §5.10, accepted plan §7).
   */
  import(context: AuthContext, input: PlanImportInput): PlanImportResult {
    this.workspaceService.requireRole(context, input.workspaceId, ['owner', 'editor'], {
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });

    const analysis = analyzePlanBundle(input.bundle);
    const occurredAt = this.now().toISOString();
    const actorUserId = context.user.id;

    if (analysis.fatal || analysis.digest === undefined || analysis.plan === undefined) {
      return this.commitFailure(input, analysis, actorUserId, occurredAt);
    }

    const result = this.commitImport(input, analysis, actorUserId, occurredAt);
    if (result.outcome === 'succeeded') {
      // After commit, never inside it, and never as storage (CT03-I12).
      this.notifier.notify();
    }
    return result;
  }

  private commitFailure(
    input: PlanImportInput,
    analysis: PlanBundleAnalysis,
    actorUserId: AuthContext['user']['id'],
    occurredAt: string,
  ): PlanImportResult {
    const requestedProjectName = input.projectName ?? 'Unnamed import';
    return this.storage.transaction((tx) => {
      const attempt = tx.planning.importAttempts.insert({
        id: asPlanImportAttemptId(randomUUID()),
        workspaceId: input.workspaceId,
        actorUserId,
        outcome: 'failed-validation',
        requestedProjectName,
        ...(input.projectId === undefined ? {} : { requestedProjectId: input.projectId }),
        ...(analysis.digest === undefined
          ? {}
          : {
              bundleDigest: analysis.digest.hex,
              digestFormatVersion: analysis.digest.formatVersion,
            }),
        artifactCount: analysis.artifacts.length,
        totalByteLength: analysis.totalByteLength,
        errorCount: Math.max(analysis.errorCount, 1),
        warningCount: analysis.warningCount,
        createdAt: occurredAt,
      });

      // Bounded source bytes are retained so the failure stays diagnosable;
      // they carry no plan version, so they are not accepted planning state.
      tx.planning.artifacts.insertMany(
        analysis.artifacts.map((artifact) => ({
          id: asPlanArtifactId(randomUUID()),
          workspaceId: input.workspaceId,
          importAttemptId: attempt.id,
          logicalFilename: artifact.logicalFilename,
          role: artifact.role,
          mediaType: artifact.mediaType,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
          content: artifact.bytes,
          createdAt: occurredAt,
        })),
      );
      this.insertDiagnostics(tx, input.workspaceId, attempt.id, analysis.diagnostics, occurredAt);

      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId,
        workspaceId: input.workspaceId,
        action: 'plan.import.failed',
        targetType: 'plan-import-attempt',
        targetId: attempt.id,
        outcome: 'failed',
        metadata: auditMetadata(analysis),
      });

      // No workspace event: a failed import accepted no planning state, and an
      // event would advertise state that does not exist (CT03-I05).
      return { outcome: 'failed-validation', attempt, diagnostics: analysis.diagnostics };
    });
  }

  private commitImport(
    input: PlanImportInput,
    analysis: PlanBundleAnalysis,
    actorUserId: AuthContext['user']['id'],
    occurredAt: string,
  ): PlanImportResult {
    const digest = analysis.digest;
    const plan = analysis.plan;
    const graph = analysis.graph;
    if (digest === undefined || plan === undefined || graph === undefined) {
      throw new Error('commitImport requires a fully analysed bundle');
    }
    const requestedProjectName = input.projectName ?? plan.document;

    // BEGIN IMMEDIATE takes the write lock at entry, so the digest lookup and
    // the insert cannot interleave with another importer: no pre-transaction
    // probe is needed and no duplicate version can slip through.
    return this.storage.transaction((tx): PlanImportResult => {
      const existing = tx.planning.versions.findByDigest(input.workspaceId, digest.hex);
      if (existing !== undefined) {
        const project = tx.planning.projects.find(input.workspaceId, existing.projectId);
        if (project === undefined) {
          throw new Error('Duplicate plan version has no readable project');
        }
        const attempt = tx.planning.importAttempts.insert({
          id: asPlanImportAttemptId(randomUUID()),
          workspaceId: input.workspaceId,
          actorUserId,
          outcome: 'duplicate',
          requestedProjectName,
          ...(input.projectId === undefined ? {} : { requestedProjectId: input.projectId }),
          bundleDigest: digest.hex,
          digestFormatVersion: digest.formatVersion,
          projectId: existing.projectId,
          planVersionId: existing.id,
          artifactCount: analysis.artifacts.length,
          totalByteLength: analysis.totalByteLength,
          errorCount: 0,
          warningCount: analysis.warningCount,
          createdAt: occurredAt,
        });
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt,
          actorKind: 'user',
          actorUserId,
          workspaceId: input.workspaceId,
          action: 'plan.import.duplicate',
          targetType: 'plan-version',
          targetId: existing.id,
          outcome: 'succeeded',
          metadata: auditMetadata(analysis),
        });
        // No artifacts, no diagnostics, no work items, no event.
        return {
          outcome: 'duplicate',
          attempt,
          project,
          version: existing,
          isActiveVersion: project.activePlanVersionId === existing.id,
        };
      }

      const projectCreated = input.projectId === undefined;
      const project = projectCreated
        ? tx.planning.projects.insert({
            id: asProjectId(randomUUID()),
            workspaceId: input.workspaceId,
            name: requestedProjectName.slice(0, 120),
            slug: this.uniqueSlug(tx, input.workspaceId, slugify(requestedProjectName)),
            createdAt: occurredAt,
            createdByUserId: actorUserId,
          })
        : this.requireProject(tx, input.workspaceId, input.projectId as ProjectId);

      const bundle =
        tx.planning.bundles.findForProject(input.workspaceId, project.id) ??
        tx.planning.bundles.insert({
          id: asPlanBundleId(randomUUID()),
          workspaceId: input.workspaceId,
          projectId: project.id,
          logicalName: (input.bundleName ?? project.slug).slice(0, 120),
          createdAt: occurredAt,
        });

      const version = tx.planning.versions.insert({
        id: asPlanVersionId(randomUUID()),
        workspaceId: input.workspaceId,
        projectId: project.id,
        bundleId: bundle.id,
        versionNumber: tx.planning.versions.nextVersionNumber(bundle.id),
        contentDigest: digest.hex,
        digestAlgorithm: digest.algorithm,
        digestFormatVersion: digest.formatVersion,
        sourceProfile: plan.sourceProfile,
        document: plan.document,
        normalizedSource: plan.metadata,
        itemCount: plan.workItems.length,
        requiredDependencyCount: graph.requiredEdges.length,
        createdAt: occurredAt,
        createdByUserId: actorUserId,
      });

      const attempt = tx.planning.importAttempts.insert({
        id: asPlanImportAttemptId(randomUUID()),
        workspaceId: input.workspaceId,
        actorUserId,
        outcome: 'succeeded',
        requestedProjectName,
        ...(input.projectId === undefined ? {} : { requestedProjectId: input.projectId }),
        bundleDigest: digest.hex,
        digestFormatVersion: digest.formatVersion,
        projectId: project.id,
        planVersionId: version.id,
        artifactCount: analysis.artifacts.length,
        totalByteLength: analysis.totalByteLength,
        errorCount: 0,
        warningCount: analysis.warningCount,
        createdAt: occurredAt,
      });

      tx.planning.artifacts.insertMany(
        analysis.artifacts.map((artifact) => ({
          id: asPlanArtifactId(randomUUID()),
          workspaceId: input.workspaceId,
          importAttemptId: attempt.id,
          planVersionId: version.id,
          logicalFilename: artifact.logicalFilename,
          role: artifact.role,
          mediaType: artifact.mediaType,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
          content: artifact.bytes,
          createdAt: occurredAt,
        })),
      );
      this.insertDiagnostics(
        tx,
        input.workspaceId,
        attempt.id,
        analysis.diagnostics,
        occurredAt,
        version.id,
      );

      const workItemIds = new Map<string, ReturnType<typeof asWorkItemId>>();
      for (const item of plan.workItems) {
        workItemIds.set(item.sourceId, asWorkItemId(randomUUID()));
      }
      tx.planning.workItems.insertMany(
        plan.workItems.map((item) => ({
          id: workItemIds.get(item.sourceId) as ReturnType<typeof asWorkItemId>,
          workspaceId: input.workspaceId,
          projectId: project.id,
          planVersionId: version.id,
          sourceId: item.sourceId,
          ordinal: item.ordinal,
          title: item.title,
          risk: item.risk,
          ...(item.phase === undefined ? {} : { phase: item.phase }),
          primaryAreas: item.primaryAreas,
          exitGate: item.exitGate,
          sourceFields: item.sourceFields,
        })),
      );

      tx.planning.dependencies.insertMany(
        [
          ...graph.requiredEdges.map((edge) => ({ edge, kind: 'required' as const })),
          ...graph.recommendedEdges.map((edge) => ({ edge, kind: 'recommended' as const })),
        ].map(({ edge, kind }) => ({
          id: asWorkItemDependencyId(randomUUID()),
          workspaceId: input.workspaceId,
          planVersionId: version.id,
          predecessorWorkItemId: workItemIds.get(edge.predecessorSourceId) as ReturnType<
            typeof asWorkItemId
          >,
          successorWorkItemId: workItemIds.get(edge.successorSourceId) as ReturnType<
            typeof asWorkItemId
          >,
          kind,
          ordinal: edge.ordinal,
        })),
      );

      // A changed version never silently replaces the active one (CT03-A31).
      const updated = tx.planning.projects.setActivePlanVersionIfUnset({
        projectId: project.id,
        workspaceId: input.workspaceId,
        planVersionId: version.id,
      });

      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId,
        workspaceId: input.workspaceId,
        action: 'plan.import.succeeded',
        targetType: 'plan-version',
        targetId: version.id,
        outcome: 'succeeded',
        metadata: {
          ...auditMetadata(analysis),
          projectId: project.id,
          versionNumber: version.versionNumber,
          itemCount: version.itemCount,
          requiredDependencyCount: version.requiredDependencyCount,
        },
      });

      if (projectCreated) {
        tx.workspaceEvents.appendEvent({
          id: asEventId(randomUUID()),
          occurredAt,
          workspaceId: input.workspaceId,
          actorUserId,
          projectId: project.id,
          kind: 'project-created',
          payload: { projectId: project.id, name: project.name },
        });
      }
      // One summary event, never one per imported work item (CT-03 §5.9).
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId: input.workspaceId,
        actorUserId,
        projectId: project.id,
        kind: 'plan-version-imported',
        payload: {
          projectId: project.id,
          planVersionId: version.id,
          versionNumber: version.versionNumber,
          document: version.document,
          itemCount: version.itemCount,
          requiredDependencyCount: version.requiredDependencyCount,
          warningCount: analysis.warningCount,
        },
      });

      return {
        outcome: 'succeeded',
        attempt,
        project: updated ?? project,
        version,
        isActiveVersion: (updated ?? project).activePlanVersionId === version.id,
        diagnostics: analysis.diagnostics,
      };
    });
  }

  private insertDiagnostics(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    importAttemptId: PlanImportAttempt['id'],
    diagnostics: readonly PlanDiagnostic[],
    _occurredAt: string,
    planVersionId?: PlanVersion['id'],
  ): void {
    tx.planning.diagnostics.insertMany(
      diagnostics.map((diagnostic, ordinal) => ({
        id: asPlanImportDiagnosticId(randomUUID()),
        workspaceId,
        importAttemptId,
        ...(planVersionId === undefined ? {} : { planVersionId }),
        ordinal,
        severity: diagnostic.severity,
        code: diagnostic.code,
        ...(diagnostic.artifactName === undefined
          ? {}
          : { artifactName: diagnostic.artifactName.slice(0, 200) }),
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path.slice(0, 200) }),
        ...(diagnostic.workItemSourceId === undefined
          ? {}
          : { workItemSourceId: diagnostic.workItemSourceId.slice(0, 64) }),
        message: diagnostic.message.slice(0, 500),
      })),
    );
  }

  private requireProject(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): Project {
    const project = tx.planning.projects.find(workspaceId, projectId);
    if (project === undefined) {
      // Indistinguishable from an unauthorized project in another workspace.
      throw new NotFoundError();
    }
    return project;
  }

  private uniqueSlug(tx: StorageRepositories, workspaceId: WorkspaceId, base: string): string {
    if (tx.planning.projects.findBySlug(workspaceId, base) === undefined) {
      return base;
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base.slice(0, 116)}-${suffix}`;
      if (tx.planning.projects.findBySlug(workspaceId, candidate) === undefined) {
        return candidate;
      }
    }
    throw new InvalidImportRequestError('Could not derive a unique project slug');
  }
}
