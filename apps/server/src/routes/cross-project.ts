import {
  adoptMapSchema,
  crossProjectViewSchema,
  mapSelectionSchema,
  roadmapIdSchema,
  roadmapViewSchema,
  saveCrossProjectSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { CrossProjectService } from '../services/cross-project-service.js';
import { noStore, sendApiError } from './http.js';
import { authorizeMutation } from './request-security.js';
export function registerCrossProjectRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: CrossProjectService,
  config: ServerConfig,
) {
  app.post<{ Params: { workspaceId: string; id: string } }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/preview',
    { config: { access: 'editor' } },
    async (req, reply) => {
      const context = authorizeMutation(req, auth, config),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        input = mapSelectionSchema.safeParse(req.body);
      if (!ws.success || !input.success || input.data.definitionId !== req.params.id)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Select an exact binding and declared target.',
        );
      return noStore(reply).send(
        crossProjectViewSchema.parse(service.view(context, ws.data, input.data)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; id: string } }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/adopt',
    { config: { access: 'editor' } },
    async (req, reply) => {
      const context = authorizeMutation(req, auth, config),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.id),
        input = adoptMapSchema.safeParse(req.body);
      if (!ws.success || !id.success || !input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Review the exact decisions and give an adoption rationale.',
        );
      return noStore(reply).send(service.adopt(context, ws.data, id.data, input.data));
    },
  );
  app.post<{ Params: { workspaceId: string; id: string } }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/roadmap',
    { config: { access: 'editor' }, bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const context = authorizeMutation(req, auth, config),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        input = saveCrossProjectSchema.safeParse(req.body);
      if (!ws.success || !input.success || input.data.configuration.definitionId !== req.params.id)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Invalid cross-project roadmap configuration.',
        );
      return noStore(reply).send(
        roadmapViewSchema.parse(service.save(context, ws.data, input.data)),
      );
    },
  );
}
