import { attentionFeedSchema, workspaceIdSchema } from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { AttentionService } from '../services/attention-service.js';
import type { AuthService } from '../services/auth-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate } from './request-security.js';

export function registerAttentionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: AttentionService,
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
}
