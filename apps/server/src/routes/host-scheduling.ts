import {
  hostSchedulingSchema,
  saveHostSchedulingSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { HostSchedulingService } from '../services/host-scheduling-service.js';
import { noStore, sendApiError } from './http.js';
import { contextOf } from './route-access.js';
export function registerHostSchedulingRoutes(app: FastifyInstance, service: HostSchedulingService) {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/host-scheduling',
    { config: { access: 'installation' } },
    async (request, reply) => {
      const context = contextOf(request);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(hostSchedulingSchema.parse(service.get(context, id.data)));
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/host-scheduling',
    { config: { access: 'installation' } },
    async (request, reply) => {
      const context = contextOf(request);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = saveHostSchedulingSchema.safeParse(request.body);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Each workstation capacity must be an integer from 1 to 32 with its current settings version.',
        );
      return noStore(reply).send(
        hostSchedulingSchema.parse(service.save(context, id.data, input.data)),
      );
    },
  );
}
