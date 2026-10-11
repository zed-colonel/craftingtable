import {
  cleanupStorageRequestSchema,
  saveStorageRequestSchema,
  storageCommandSchema,
  storageStatusSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { StorageService } from '../services/storage-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf } from './route-access.js';
export function registerStorageRoutes(app: FastifyInstance, service: StorageService): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/storage',
    { config: { access: 'installation' } },
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
  app.post<{
    Params: { workspaceId: string };
    Body: BodyOf<typeof cleanupStorageRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/storage/clean',
    {
      config: {
        access: 'installation',
        tag: 'control',
        body: cleanupStorageRequestSchema,
        invalidBody: 'A current cleanup preview is required',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        storageStatusSchema.parse(
          await service.clean(context, workspace.data, request.body.scanId),
        ),
      );
    },
  );
  for (const action of ['scan', 'backup'] as const) {
    app.post<{ Params: { workspaceId: string } }>(
      `/api/workspaces/:workspaceId/storage/${action}`,
      {
        config: {
          access: 'installation',
          tag: 'control',
          body: storageCommandSchema,
          invalidBody: 'Invalid storage command',
        },
      },
      async (request, reply) => {
        const context = contextOf(request);
        const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
        if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
        return noStore(reply).send(
          storageStatusSchema.parse(await service[action](context, workspace.data)),
        );
      },
    );
  }
}
