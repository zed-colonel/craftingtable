import multipart from '@fastify/multipart';
import {
  admitWorkItemRequestSchema,
  admitWorkItemResponseSchema,
  planArtifactIdSchema,
  planImportAttemptListResponseSchema,
  planImportResponseSchema,
  planVersionDetailResponseSchema,
  planVersionIdSchema,
  projectDetailResponseSchema,
  projectIdSchema,
  projectListResponseSchema,
  workItemDetailResponseSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { PlanDiagnostic } from '@craftingtable/planning';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { PlanImportService, PlanImportResult } from '../services/plan-import-service.js';
import type { PlanningQueryService } from '../services/planning-query-service.js';
import type { WorkItemService } from '../services/work-item-service.js';
import { noStore, sendApiError } from './http.js';
import {
  MalformedMultipartError,
  MULTIPART_PLUGIN_LIMITS,
  readPlanImportParts,
} from './multipart.js';
import { authenticate, authorizeMutation } from './request-security.js';

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

function importResponse(result: PlanImportResult) {
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
  authService: AuthService,
  planImportService: PlanImportService,
  queryService: PlanningQueryService,
  workItemService: WorkItemService,
  config: ServerConfig,
): void {
  // `throwFileSizeLimit: false` so an oversized file becomes a recorded
  // `artifact-too-large` diagnostic on a durable import attempt rather than an
  // opaque 413 that leaves the operator nothing to inspect. The plugin still
  // stops buffering at the limit and marks the stream truncated.
  void app.register(multipart, {
    limits: MULTIPART_PLUGIN_LIMITS,
    throwFileSizeLimit: false,
  });

  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/plan-imports',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const parsedWorkspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!parsedWorkspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }

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
        workspaceId: parsedWorkspaceId.data,
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

  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/projects',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        projectListResponseSchema.parse(
          queryService.listProjects(context, workspaceId.data, request.id),
        ),
      );
    },
  );

  app.get<{ Params: { workspaceId: string; projectId: string } }>(
    '/api/workspaces/:workspaceId/projects/:projectId',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const projectId = projectIdSchema.safeParse(request.params.projectId);
      if (!workspaceId.success || !projectId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        projectDetailResponseSchema.parse(
          queryService.projectDetail(context, workspaceId.data, projectId.data, request.id),
        ),
      );
    },
  );

  app.get<{ Params: { workspaceId: string; projectId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const projectId = projectIdSchema.safeParse(request.params.projectId);
      const planVersionId = planVersionIdSchema.safeParse(request.params.planVersionId);
      if (!workspaceId.success || !projectId.success || !planVersionId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        planVersionDetailResponseSchema.parse(
          queryService.planVersionDetail(
            context,
            workspaceId.data,
            projectId.data,
            planVersionId.data,
            request.id,
          ),
        ),
      );
    },
  );

  app.get<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const workItemId = workItemIdSchema.safeParse(request.params.workItemId);
      if (!workspaceId.success || !workItemId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        workItemDetailResponseSchema.parse(
          queryService.workItemDetail(context, workspaceId.data, workItemId.data, request.id),
        ),
      );
    },
  );

  app.post<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/admit',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const workItemId = workItemIdSchema.safeParse(request.params.workItemId);
      if (!workspaceId.success || !workItemId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      if (!admitWorkItemRequestSchema.safeParse(request.body ?? {}).success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid admission request');
      }
      const result = workItemService.admit(context, workspaceId.data, workItemId.data, request.id);
      return noStore(reply).send(
        admitWorkItemResponseSchema.parse({
          workItemId: result.workItem.id,
          status: 'admitted',
          admitted: result.admitted,
          draft: {
            id: result.draft.id,
            schemaVersion: result.draft.schemaVersion,
            status: result.draft.status,
            completeness: result.draft.completeness,
            createdAt: result.draft.createdAt,
            document: result.draft.document,
          },
        }),
      );
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/plan-imports',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        planImportAttemptListResponseSchema.parse(
          queryService.listImportAttempts(context, workspaceId.data, request.id),
        ),
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
  app.get<{ Params: { workspaceId: string; artifactId: string } }>(
    '/api/workspaces/:workspaceId/plan-artifacts/:artifactId',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const artifactId = planArtifactIdSchema.safeParse(request.params.artifactId);
      if (!workspaceId.success || !artifactId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const artifact = queryService.artifactContent(
        context,
        workspaceId.data,
        artifactId.data,
        request.id,
      );
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
