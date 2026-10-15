import {
  acknowledgeProtectedRefMovesRequestSchema,
  acknowledgeProtectedRefMovesResponseSchema,
  attentionFeedSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { AttentionService } from '../services/attention-service.js';
import { noStore } from './http.js';
import { type BodyOf, contextOf, paramsOf, WORKSPACE_PARAMS } from './route-access.js';

export function registerAttentionRoutes(app: FastifyInstance, service: AttentionService) {
  app.get(
    '/api/workspaces/:workspaceId/attention',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(attentionFeedSchema.parse(service.feed(context, workspaceId)));
    },
  );
  app.post<{
    Body: BodyOf<typeof acknowledgeProtectedRefMovesRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/protected-ref-moves/acknowledge',
    {
      config: {
        access: 'editor',
        params: WORKSPACE_PARAMS,
        tag: 'decision',
        body: acknowledgeProtectedRefMovesRequestSchema,
        invalidBody: 'Name the moves to acknowledge.',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        acknowledgeProtectedRefMovesResponseSchema.parse(
          service.acknowledgeProtectedRefMoves(context, workspaceId, request.body.moveIds),
        ),
      );
    },
  );
}
