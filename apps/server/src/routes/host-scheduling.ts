import {
  hostSchedulingSchema,
  saveHostSchedulingSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { HostSchedulingService } from '../services/host-scheduling-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
export function registerHostSchedulingRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: HostSchedulingService,
  config: ServerConfig,
) {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/host-scheduling',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(hostSchedulingSchema.parse(service.get(context, id.data)));
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/host-scheduling',
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      const input = saveHostSchedulingSchema.safeParse(request.body);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Verification capacity must be an integer from 1 to 32 with the current settings version.',
        );
      return noStore(reply).send(
        hostSchedulingSchema.parse(service.save(context, id.data, input.data)),
      );
    },
  );
}
