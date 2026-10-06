import {
  controlFinalizationRequestSchema,
  finalizationsResponseSchema,
  finalizationViewSchema,
  planVersionIdSchema,
  startFinalizationRequestSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { FinalizationService } from '../services/finalization-service.js';
import { noStore, sendApiError } from './http.js';
import { contextOf } from './route-access.js';
export function registerFinalizationRoutes(
  app: FastifyInstance,
  service: FinalizationService,
): void {
  app.get<{ Params: { workspaceId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/plans/:planVersionId/finalizations',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      if (!workspace.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Plan not found');
      return noStore(reply).send(
        finalizationsResponseSchema.parse({
          finalizations: service.list(context, workspace.data, plan.data),
        }),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/plans/:planVersionId/finalizations',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      const body = startFinalizationRequestSchema.safeParse(request.body);
      if (!workspace.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Plan not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid finalization settings');
      return noStore(reply).send(
        finalizationViewSchema.parse(
          await service.start(context, workspace.data, plan.data, body.data),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; finalizationId: string } }>(
    '/api/workspaces/:workspaceId/finalizations/:finalizationId/control',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = controlFinalizationRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid finalization command');
      return noStore(reply).send(
        finalizationViewSchema.parse(
          await service.control(context, workspace.data, request.params.finalizationId, body.data),
        ),
      );
    },
  );
}
