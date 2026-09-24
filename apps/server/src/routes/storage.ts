import {
  cleanupStorageRequestSchema,
  saveStorageRequestSchema,
  storageCommandSchema,
  storageStatusSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { StorageService } from '../services/storage-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
export function registerStorageRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: StorageService,
  config: ServerConfig,
): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/storage',
    { config: { access: 'installation' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(storageStatusSchema.parse(service.get(context, workspace.data)));
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/storage',
    { config: { access: 'installation' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = saveStorageRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid storage settings');
      return noStore(reply).send(
        storageStatusSchema.parse(service.save(context, workspace.data, body.data)),
      );
    },
  );
  for (const action of ['scan', 'clean', 'backup'] as const) {
    app.post<{ Params: { workspaceId: string } }>(
      `/api/workspaces/:workspaceId/storage/${action}`,
      { config: { access: 'installation' } },
      async (request, reply) => {
        const context = authorizeMutation(request, auth, config);
        const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
        if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
        if (action === 'clean') {
          const body = cleanupStorageRequestSchema.safeParse(request.body);
          if (!body.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'A current cleanup preview is required',
            );
          return noStore(reply).send(
            storageStatusSchema.parse(
              await service.clean(context, workspace.data, body.data.scanId),
            ),
          );
        }
        if (!storageCommandSchema.safeParse(request.body).success)
          return sendApiError(reply, 400, 'invalid-request', 'Invalid storage command');
        return noStore(reply).send(
          storageStatusSchema.parse(await service[action](context, workspace.data)),
        );
      },
    );
  }
}
