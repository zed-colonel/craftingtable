import {
  controlFinalizationRequestSchema,
  finalizationsResponseSchema,
  finalizationViewSchema,
  planVersionIdSchema,
  startFinalizationRequestSchema,
  finalizationIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { FinalizationService } from '../services/finalization-service.js';
import { noStore } from './http.js';
import {
  type BodyOf,
  contextOf,
  stepUpForStoredWork,
  workspaceParams,
  paramsOf,
  parsedParamsOf,
} from './route-access.js';

/** Each route's path parameters (R-H7). */
const PLAN_VERSION = workspaceParams({ planVersionId: planVersionIdSchema });
const FINALIZATION = workspaceParams({ finalizationId: finalizationIdSchema });
export function registerFinalizationRoutes(
  app: FastifyInstance,
  service: FinalizationService,
): void {
  app.get(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/finalizations',
    { config: { access: 'member', params: PLAN_VERSION, notFound: 'Plan not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, planVersionId } = paramsOf(request, PLAN_VERSION);
      return noStore(reply).send(
        finalizationsResponseSchema.parse({
          finalizations: await service.list(context, workspaceId, planVersionId),
        }),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof startFinalizationRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/finalizations',
    {
      config: {
        access: 'editor',
        params: PLAN_VERSION,
        notFound: 'Plan not found',
        tag: 'control',
        body: startFinalizationRequestSchema,
        invalidBody: 'Invalid finalization settings',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, planVersionId } = paramsOf(request, PLAN_VERSION);
      return noStore(reply).send(
        finalizationViewSchema.parse(
          await service.start(context, workspaceId, planVersionId, request.body),
        ),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof controlFinalizationRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/finalizations/:finalizationId/control',
    // Final promotion, and work under profiles that grant unrestricted, ask again (R-G9).
    {
      config: {
        access: 'editor',
        params: FINALIZATION,
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
            const params = parsedParamsOf(request, FINALIZATION);
            return params && service.storedWork(params.workspaceId, params.finalizationId);
          })(body, request),
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, finalizationId } = paramsOf(request, FINALIZATION);
      return noStore(reply).send(
        finalizationViewSchema.parse(
          await service.control(context, workspaceId, finalizationId, request.body),
        ),
      );
    },
  );
}
