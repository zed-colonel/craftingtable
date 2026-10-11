import {
  acknowledgeProtectedRefMovesRequestSchema,
  acknowledgeProtectedRefMovesResponseSchema,
  attentionFeedSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { AttentionService } from '../services/attention-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf } from './route-access.js';

export function registerAttentionRoutes(app: FastifyInstance, service: AttentionService) {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/attention',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(attentionFeedSchema.parse(service.feed(context, id.data)));
    },
  );
  app.post<{
    Params: { workspaceId: string };
    Body: BodyOf<typeof acknowledgeProtectedRefMovesRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/protected-ref-moves/acknowledge',
    {
      config: {
        access: 'editor',
        tag: 'decision',
        body: acknowledgeProtectedRefMovesRequestSchema,
        invalidBody: 'Name the moves to acknowledge.',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        acknowledgeProtectedRefMovesResponseSchema.parse(
          service.acknowledgeProtectedRefMoves(context, id.data, request.body.moveIds),
        ),
      );
    },
  );
}
