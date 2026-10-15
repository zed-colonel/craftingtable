import {
  saveStorageRequestSchema,
  storageControlRequestSchema,
  storageStatusSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { StorageService } from '../services/storage-service.js';
import { noStore } from './http.js';
import { type BodyOf, contextOf, paramsOf, WORKSPACE_PARAMS } from './route-access.js';
export function registerStorageRoutes(app: FastifyInstance, service: StorageService): void {
  app.get(
    '/api/workspaces/:workspaceId/storage',
    { config: { access: 'installation', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(storageStatusSchema.parse(service.get(context, workspaceId)));
    },
  );
  app.post<{ Body: BodyOf<typeof saveStorageRequestSchema> }>(
    '/api/workspaces/:workspaceId/storage',
    {
      config: {
        access: 'installation',
        params: WORKSPACE_PARAMS,
        tag: 'config',
        body: saveStorageRequestSchema,
        invalidBody: 'Invalid storage settings',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        storageStatusSchema.parse(service.save(context, workspaceId, request.body)),
      );
    },
  );
  // Storage's manual commands share one route (R-H5, H5-2): the same access, none carries authority.
  app.post<{
    Body: BodyOf<typeof storageControlRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/storage/control',
    {
      config: {
        access: 'installation',
        params: WORKSPACE_PARAMS,
        tag: 'control',
        body: storageControlRequestSchema,
        invalidBody: 'Invalid storage command',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      const body = request.body;
      return noStore(reply).send(
        storageStatusSchema.parse(
          body.action === 'clean'
            ? await service.clean(context, workspaceId, body.scanId)
            : await service[body.action](context, workspaceId),
        ),
      );
    },
  );
}
