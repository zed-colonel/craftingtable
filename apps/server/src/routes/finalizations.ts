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
import { type BodyOf, contextOf, stepUpForStoredWork } from './route-access.js';
export function registerFinalizationRoutes(
  app: FastifyInstance,
  service: FinalizationService,
): void {
  app.get<{ Params: { workspaceId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/finalizations',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      if (!workspace.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Plan not found');
      return noStore(reply).send(
        finalizationsResponseSchema.parse({
          finalizations: await service.list(context, workspace.data, plan.data),
        }),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; planVersionId: string };
    Body: BodyOf<typeof startFinalizationRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/finalizations',
    {
      config: {
        access: 'editor',
        tag: 'control',
        body: startFinalizationRequestSchema,
        invalidBody: 'Invalid finalization settings',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      if (!workspace.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Plan not found');
      return noStore(reply).send(
        finalizationViewSchema.parse(
          await service.start(context, workspace.data, plan.data, request.body),
        ),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; finalizationId: string };
    Body: BodyOf<typeof controlFinalizationRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/finalizations/:finalizationId/control',
    // Final promotion, and work under profiles that grant unrestricted, ask again (R-G9).
    {
      config: {
        access: 'editor',
        tag: 'decision',
        body: controlFinalizationRequestSchema,
        invalidBody: 'Invalid finalization command',
        stepUpRule:
          'the final promotion (merge), or an action that starts work under stored settings granting unrestricted',
        stepUp: (body, request) =>
          (typeof body === 'object' &&
            body !== null &&
            (body as { action?: unknown }).action === 'merge') ||
          stepUpForStoredWork((request) => {
            const { workspaceId, finalizationId } = request.params as {
              readonly workspaceId: string;
              readonly finalizationId: string;
            };
            return service.storedWork(workspaceId, finalizationId);
          })(body, request),
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        finalizationViewSchema.parse(
          await service.control(
            context,
            workspace.data,
            request.params.finalizationId,
            request.body,
          ),
        ),
      );
    },
  );
}
