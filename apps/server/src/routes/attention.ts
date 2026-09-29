import {
  acknowledgeProtectedRefMovesRequestSchema,
  acknowledgeProtectedRefMovesResponseSchema,
  attentionFeedSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AttentionService } from '../services/attention-service.js';
import type { AuthService } from '../services/auth-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';

export function registerAttentionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: AttentionService,
  config: ServerConfig,
) {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/attention',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(attentionFeedSchema.parse(service.feed(context, id.data)));
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/protected-ref-moves/acknowledge',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      const input = acknowledgeProtectedRefMovesRequestSchema.safeParse(request.body);
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Name the moves to acknowledge.');
      return noStore(reply).send(
        acknowledgeProtectedRefMovesResponseSchema.parse(
          service.acknowledgeProtectedRefMoves(context, id.data, input.data.moveIds),
        ),
      );
    },
  );
}
