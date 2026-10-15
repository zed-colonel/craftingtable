import {
  admitWorkItemResponseSchema,
  completeWorkItemResponseSchema,
  planArtifactIdSchema,
  planImportFieldsSchema,
  planImportResponseSchema,
  planVersionDetailResponseSchema,
  planVersionGraphSchema,
  planVersionIdSchema,
  projectDetailResponseSchema,
  projectIdSchema,
  workItemControlRequestSchema,
  removeFromAgendaResponseSchema,
  workItemIdSchema,
  workspaceWorkItemFilterSchema,
  workspaceWorkItemListResponseSchema,
} from '@craftingtable/contracts';
import type { PlanDiagnostic } from '@craftingtable/planning';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { PlanImportResult, PlanImportService } from '../services/plan-import-service.js';
import type { PlanningQueryService } from '../services/planning-query-service.js';
import type { WorkItemService } from '../services/work-item-service.js';
import { noStore, sendApiError } from './http.js';
import {
  MalformedMultipartError,
  MULTIPART_PLUGIN_LIMITS,
  readPlanImportParts,
} from './multipart.js';
import {
  type BodyOf,
  contextOf,
  WORKSPACE_PARAMS,
  workspaceParams,
  paramsOf,
} from './route-access.js';

/** Each route's path parameters (R-H7). */
const PROJECT = workspaceParams({ projectId: projectIdSchema });
const PROJECT_PLAN_VERSION = workspaceParams({
  projectId: projectIdSchema,
  planVersionId: planVersionIdSchema,
});
const PLAN_VERSION = workspaceParams({ planVersionId: planVersionIdSchema });
const WORK_ITEM = workspaceParams({ workItemId: workItemIdSchema });
const ARTIFACT = workspaceParams({ artifactId: planArtifactIdSchema });

/**
 * Thin planning routes.
 *
 * A route authenticates, applies the shared CSRF and origin policy, turns the
 * request into bounded bytes plus logical metadata, calls a service, and
 * serialises a strict contract. It parses no YAML, issues no SQL, and decides
 * no dependency semantics.
 */

function diagnosticPayload(diagnostic: PlanDiagnostic) {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.artifactName === undefined ? {} : { artifactName: diagnostic.artifactName }),
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    ...(diagnostic.workItemSourceId === undefined
      ? {}
      : { workItemSourceId: diagnostic.workItemSourceId }),
  };
}

export function importResponse(result: PlanImportResult) {
  switch (result.outcome) {
    case 'succeeded':
      return {
        outcome: 'succeeded' as const,
        importAttemptId: result.attempt.id,
        projectId: result.project.id,
        planVersionId: result.version.id,
        versionNumber: result.version.versionNumber,
        isActiveVersion: result.isActiveVersion,
        itemCount: result.version.itemCount,
        requiredDependencyCount: result.version.requiredDependencyCount,
        warningCount: result.attempt.warningCount,
        diagnostics: result.diagnostics.map(diagnosticPayload),
      };
    case 'duplicate':
      return {
        outcome: 'duplicate' as const,
        importAttemptId: result.attempt.id,
        projectId: result.project.id,
        planVersionId: result.version.id,
        versionNumber: result.version.versionNumber,
        isActiveVersion: result.isActiveVersion,
      };
    case 'failed-validation':
      return {
        outcome: 'failed-validation' as const,
        importAttemptId: result.attempt.id,
        diagnostics: result.diagnostics.map(diagnosticPayload),
      };
  }
}

export function registerPlanningRoutes(
  app: FastifyInstance,
  planImportService: PlanImportService,
  queryService: PlanningQueryService,
  workItemService: WorkItemService,
): void {
  // `throwFileSizeLimit: false` so an oversized file becomes a recorded
  // `artifact-too-large` diagnostic on a durable import attempt rather than an
  // opaque 413 that leaves the operator nothing to inspect. The plugin still
  // stops buffering at the limit and marks the stream truncated.
  void app.register(multipart, {
    limits: MULTIPART_PLUGIN_LIMITS,
    throwFileSizeLimit: false,
  });

  app.post(
    '/api/workspaces/:workspaceId/imports/plans',
    {
      config: {
        access: 'editor',
        params: WORKSPACE_PARAMS,
        tag: 'config',
        multipart: true,
        body: planImportFieldsSchema,
        invalidBody: 'Invalid plan import request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);

      let parts: Awaited<ReturnType<typeof readPlanImportParts>>;
      try {
        parts = await readPlanImportParts(request);
      } catch (error) {
        if (error instanceof MalformedMultipartError) {
          return sendApiError(reply, 400, 'invalid-request', 'Invalid plan import request');
        }
        throw error;
      }

      const projectNameField = parts.fields.projectName?.normalize('NFC').trim();
      const projectIdField = parts.fields.projectId?.trim();
      const bundleNameField = parts.fields.bundleName?.normalize('NFC').trim();

      let projectId: ReturnType<typeof projectIdSchema.parse> | undefined;
      if (projectIdField !== undefined && projectIdField !== '') {
        const parsed = projectIdSchema.safeParse(projectIdField);
        if (!parsed.success) {
          return sendApiError(reply, 404, 'not-found', 'Resource not found');
        }
        projectId = parsed.data;
      }
      if (
        projectId === undefined &&
        (projectNameField === undefined ||
          projectNameField.length === 0 ||
          projectNameField.length > 120)
      ) {
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'A project name is required when no project is selected',
        );
      }

      const result = planImportService.import(context, {
        workspaceId,
        ...(projectNameField === undefined || projectNameField.length === 0
          ? {}
          : { projectName: projectNameField }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(bundleNameField === undefined || bundleNameField.length === 0
          ? {}
          : { bundleName: bundleNameField }),
        bundle: {
          artifacts: parts.artifacts,
          transportFindings: parts.transportFindings,
        },
        requestId: request.id,
      });

      // Every recorded outcome is HTTP 200; 4xx stays reserved for transport
      // and authorization faults, which record no attempt.
      return noStore(reply).send(planImportResponseSchema.parse(importResponse(result)));
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/projects/:projectId',
    { config: { access: 'member', params: PROJECT } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, projectId } = paramsOf(request, PROJECT);
      return noStore(reply).send(
        projectDetailResponseSchema.parse(
          queryService.projectDetail(context, workspaceId, projectId, request.id),
        ),
      );
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId',
    { config: { access: 'member', params: PROJECT_PLAN_VERSION } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, planVersionId, projectId } = paramsOf(request, PROJECT_PLAN_VERSION);
      return noStore(reply).send(
        planVersionDetailResponseSchema.parse(
          queryService.planVersionDetail(
            context,
            workspaceId,
            projectId,
            planVersionId,
            request.id,
          ),
        ),
      );
    },
  );

  // A plan version's dependency structure, which never changes (R-E4).
  app.get(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/graph',
    { config: { access: 'member', params: PLAN_VERSION } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, planVersionId } = paramsOf(request, PLAN_VERSION);
      return noStore(reply).send(
        planVersionGraphSchema.parse(
          queryService.planVersionGraph(context, workspaceId, planVersionId, request.id),
        ),
      );
    },
  );

  app.get<{ Querystring: { filter?: string } }>(
    '/api/workspaces/:workspaceId/work-items',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      const filter = workspaceWorkItemFilterSchema.safeParse(request.query.filter ?? 'all');
      if (!filter.success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid work item filter');
      }
      return noStore(reply).send(
        workspaceWorkItemListResponseSchema.parse(
          queryService.listWorkspaceWorkItems(context, workspaceId, filter.data, request.id),
        ),
      );
    },
  );

  // A work item's agenda commands share one route (R-H5, H5-2): the same access, none carries
  // authority. Each answers in its own shape.
  app.post<{
    Body: BodyOf<typeof workItemControlRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/control',
    {
      config: {
        access: 'editor',
        params: WORK_ITEM,
        tag: 'control',
        body: workItemControlRequestSchema,
        invalidBody: 'Invalid work item command',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, workItemId } = paramsOf(request, WORK_ITEM);
      const body = request.body;
      if (body.action === 'complete') {
        const result = workItemService.complete(context, workspaceId, workItemId, request.id);
        return noStore(reply).send(
          completeWorkItemResponseSchema.parse({
            workItemId: result.workItem.id,
            status: 'completed',
            completed: result.completed,
          }),
        );
      }
      if (body.action === 'remove-from-agenda') {
        const result = workItemService.removeFromAgenda(
          context,
          workspaceId,
          workItemId,
          body.expectedVersion,
          request.id,
        );
        return noStore(reply).send(
          removeFromAgendaResponseSchema.parse({
            workItemId: result.workItem.id,
            status: 'proposed',
            removed: result.removed,
          }),
        );
      }
      const result = workItemService.admit(context, workspaceId, workItemId, request.id);
      return noStore(reply).send(
        admitWorkItemResponseSchema.parse({
          workItemId: result.workItem.id,
          status: 'admitted',
          admitted: result.admitted,
        }),
      );
    },
  );

  /**
   * Raw source bytes.
   *
   * Always served as attachment `text/plain`, regardless of the stored media
   * type, with sniffing disabled and a null-source CSP: planning files are
   * untrusted input and must never be rendered as executable HTML (CT03-A40).
   */
  app.get(
    '/api/workspaces/:workspaceId/plan-artifacts/:artifactId',
    { config: { access: 'member', params: ARTIFACT } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, artifactId } = paramsOf(request, ARTIFACT);
      const artifact = queryService.artifactContent(context, workspaceId, artifactId, request.id);
      return noStore(reply)
        .header('content-type', 'text/plain; charset=utf-8')
        .header('content-disposition', `attachment; filename="${artifact.logicalFilename}"`)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('content-length', String(artifact.byteLength))
        .header('x-craftingtable-artifact-media-type', artifact.mediaType)
        .send(Buffer.from(artifact.content));
    },
  );
}
