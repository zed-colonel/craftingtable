import { hostSchedulingSchema, saveHostSchedulingSchema } from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { HostSchedulingService } from '../services/host-scheduling-service.js';
import { noStore } from './http.js';
import { type BodyOf, contextOf, paramsOf, WORKSPACE_PARAMS } from './route-access.js';
export function registerHostSchedulingRoutes(app: FastifyInstance, service: HostSchedulingService) {
  app.get(
    '/api/workspaces/:workspaceId/host-scheduling',
    { config: { access: 'installation', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(hostSchedulingSchema.parse(service.get(context, workspaceId)));
    },
  );
  app.post<{ Body: BodyOf<typeof saveHostSchedulingSchema> }>(
    '/api/workspaces/:workspaceId/host-scheduling',
    {
      config: {
        access: 'installation',
        params: WORKSPACE_PARAMS,
        tag: 'config',
        body: saveHostSchedulingSchema,
        invalidBody:
          'Each workstation capacity must be an integer from 1 to 32 with its current settings version.',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        hostSchedulingSchema.parse(service.save(context, workspaceId, request.body)),
      );
    },
  );
}
