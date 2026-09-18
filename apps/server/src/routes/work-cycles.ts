import {
  controlWorkCycleRequestSchema,
  baselinePreviewSchema,
  baselineEvidenceSchema,
  prepareBaselineRequestSchema,
  recoverDesignRequestSchema,
  designRecoveryPreviewSchema,
  integrationResolutionRequestSchema,
  startWorkCycleRequestSchema,
  workCycleResponseSchema,
  workCyclesResponseSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { WorkCycleService } from '../services/work-cycle-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';

export function registerWorkCycleRoutes(
  app: FastifyInstance,
  auth: AuthService,
  cycles: WorkCycleService,
  config: ServerConfig,
): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/cycles',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        workCyclesResponseSchema.parse({ cycles: cycles.list(context, workspace.data) }),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/cycles',
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const item = workItemIdSchema.safeParse(request.params.workItemId);
      const body = startWorkCycleRequestSchema.safeParse(request.body);
      if (!workspace.success || !item.success)
        return sendApiError(reply, 404, 'not-found', 'Work item not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid cycle settings');
      return noStore(reply).send(
        workCycleResponseSchema.parse({
          cycle: cycles.start(context, workspace.data, item.data, body.data),
        }),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/baseline-evidence',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        baselineEvidenceSchema.parse(
          cycles.baselineEvidence(context, workspace.data, request.params.cycleId),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/design-recovery',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        designRecoveryPreviewSchema.parse(
          cycles.previewDesignRecovery(context, workspace.data, request.params.cycleId),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/baseline-preparation',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        baselinePreviewSchema.parse(
          await cycles.previewBaseline(context, workspace.data, request.params.cycleId),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/baseline-preparation',
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = prepareBaselineRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid baseline preparation');
      return noStore(reply).send(
        workCycleResponseSchema.parse({
          cycle: await cycles.prepareBaseline(
            context,
            workspace.data,
            request.params.cycleId,
            input.data,
          ),
        }),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/design-recovery',
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = recoverDesignRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid design recovery request');
      const cycle = await cycles.recoverDesign(
        context,
        workspace.data,
        request.params.cycleId,
        input.data,
      );
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle }));
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/control',
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = controlWorkCycleRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid cycle command');
      const cycle =
        body.data.action === 'authorize-remediation'
          ? await cycles.authorizeWorkItemRemediation(
              context,
              workspace.data,
              request.params.cycleId,
              body.data,
            )
          : await cycles.control(
              context,
              workspace.data,
              request.params.cycleId,
              body.data.action,
              body.data.expectedVersion,
              body.data.action === 'resume' ? body.data.instructions : undefined,
            );
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle }));
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/integration-resolution',
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = integrationResolutionRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Invalid integration resolution command',
        );
      const cycle = await cycles.resolveIntegration(
        context,
        workspace.data,
        request.params.cycleId,
        body.data,
      );
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle }));
    },
  );
}
