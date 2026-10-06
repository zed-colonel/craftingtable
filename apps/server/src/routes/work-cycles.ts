import {
  baselineEvidenceSchema,
  baselinePreviewSchema,
  controlWorkCycleRequestSchema,
  acknowledgeInvestigationChangeRequestSchema,
  endInvestigationRequestSchema,
  designRecoveryPreviewSchema,
  integrationResolutionRequestSchema,
  prepareBaselineRequestSchema,
  recoverDesignRequestSchema,
  startInvestigationRequestSchema,
  scopeRepairPreviewSchema,
  scopeRepairRequestSchema,
  startWorkCycleRequestSchema,
  workCycleResponseSchema,
  workCyclesResponseSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { RoadmapService } from '../services/roadmap-service.js';
import type { WorkCycleService } from '../services/work-cycle-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';

export function registerWorkCycleRoutes(
  app: FastifyInstance,
  auth: AuthService,
  cycles: WorkCycleService,
  config: ServerConfig,
  /** Owns repairs of a roadmap's reviews as recovery rounds. */
  roadmaps: Pick<RoadmapService, 'delegateScopeRepair'>,
): void {
  app.get<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/scope-repair',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        scopeRepairPreviewSchema.parse(
          cycles.previewScopeRepair(context, workspace.data, request.params.cycleId),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/scope-repair',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = scopeRepairRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid scope repair request');
      return noStore(reply).send(
        workCycleResponseSchema.parse({
          cycle: cycles.present(
            await roadmaps.delegateScopeRepair(
              context,
              workspace.data,
              request.params.cycleId,
              input.data,
            ),
          ),
        }),
      );
    },
  );
  // Without `workItemId`: the cycles that have not ended, without design-recovery
  // detail (the shell's attention list). With it: that work item's full cycles.
  app.get<{ Params: { workspaceId: string }; Querystring: { workItemId?: string } }>(
    '/api/workspaces/:workspaceId/cycles',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      const item =
        request.query.workItemId === undefined
          ? undefined
          : workItemIdSchema.safeParse(request.query.workItemId);
      if (item !== undefined && !item.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid work item');
      return noStore(reply).send(
        workCyclesResponseSchema.parse({
          cycles: cycles.list(
            context,
            workspace.data,
            item === undefined ? {} : { workItemId: item.data },
          ),
        }),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/cycles',
    { config: { access: 'editor' } },
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
          cycle: cycles.present(
            cycles.startRequested(context, workspace.data, item.data, body.data),
          ),
        }),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/baseline-evidence',
    { config: { access: 'member' } },
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
    { config: { access: 'editor' } },
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
    { config: { access: 'editor' } },
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
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = prepareBaselineRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid baseline preparation');
      return noStore(reply).send(
        workCycleResponseSchema.parse({
          cycle: cycles.present(
            await cycles.prepareBaseline(
              context,
              workspace.data,
              request.params.cycleId,
              input.data,
            ),
          ),
        }),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/design-recovery',
    { config: { access: 'editor' }, bodyLimit: 2 * 1024 * 1024 },
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
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle: cycles.present(cycle) }));
    },
  );
  // A question stop's read-only investigation (R-C16), and ending it.
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/investigation',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = startInvestigationRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid investigation request');
      const cycle = await cycles.startInvestigation(
        context,
        workspace.data,
        request.params.cycleId,
        input.data,
      );
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle }));
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/investigation/end',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = endInvestigationRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid investigation request');
      const cycle = await cycles.endInvestigation(
        context,
        workspace.data,
        request.params.cycleId,
        input.data.expectedVersion,
      );
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle }));
    },
  );
  // The worktree changed while the stop's investigation ran: the operator has seen it (R-C16).
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/investigation/acknowledge-change',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = acknowledgeInvestigationChangeRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid acknowledgement request');
      const cycle = cycles.acknowledgeWorktreeChange(
        context,
        workspace.data,
        request.params.cycleId,
        input.data.expectedVersion,
      );
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle }));
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/control',
    { config: { access: 'editor' } },
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
          : body.data.action === 'review-again'
            ? await cycles.repeatScopeReview(
                context,
                workspace.data,
                request.params.cycleId,
                body.data.expectedVersion,
                body.data.instructions ?? '',
              )
            : await cycles.control(
                context,
                workspace.data,
                request.params.cycleId,
                body.data.action,
                body.data.expectedVersion,
                body.data.action === 'resume' ? body.data.instructions : undefined,
              );
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle: cycles.present(cycle) }));
    },
  );
  app.post<{ Params: { workspaceId: string; cycleId: string } }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/integration-resolution',
    { config: { access: 'editor' } },
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
      return noStore(reply).send(workCycleResponseSchema.parse({ cycle: cycles.present(cycle) }));
    },
  );
}
