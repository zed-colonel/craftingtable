import {
  saveStorageRequestSchema,
  storageControlRequestSchema,
  storageStatusSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { StorageService } from '../services/storage-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf, WORKSPACE_PARAMS } from './route-access.js';
export function registerStorageRoutes(app: FastifyInstance, service: StorageService): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/storage',
    { config: { access: 'installation', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(storageStatusSchema.parse(service.get(context, workspace.data)));
    },
  );
  app.post<{ Params: { workspaceId: string }; Body: BodyOf<typeof saveStorageRequestSchema> }>(
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
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        storageStatusSchema.parse(service.save(context, workspace.data, request.body)),
      );
    },
  );
  // Storage's manual commands share one route (R-H5, H5-2): the same access, none carries authority.
  app.post<{
    Params: { workspaceId: string };
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
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      const body = request.body;
      return noStore(reply).send(
        storageStatusSchema.parse(
          body.action === 'clean'
            ? await service.clean(context, workspace.data, body.scanId)
            : await service[body.action](context, workspace.data),
        ),
      );
    },
  );
}
