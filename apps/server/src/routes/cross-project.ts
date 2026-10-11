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
import type { CrossProjectService } from '../services/cross-project-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf } from './route-access.js';
export function registerCrossProjectRoutes(app: FastifyInstance, service: CrossProjectService) {
  app.post<{
    Params: { workspaceId: string; id: string };
    Body: BodyOf<typeof mapSelectionSchema>;
  }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/preview',
    {
      config: {
        access: 'editor',
        tag: 'config',
        body: mapSelectionSchema,
        invalidBody: 'Select an exact binding and declared target.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId);
      if (!ws.success || req.body.definitionId !== req.params.id)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Select an exact binding and declared target.',
        );
      return noStore(reply).send(
        crossProjectViewSchema.parse(service.view(context, ws.data, req.body)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; id: string }; Body: BodyOf<typeof adoptMapSchema> }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/adopt',
    {
      config: {
        access: 'editor',
        tag: 'decision',
        body: adoptMapSchema,
        invalidBody: 'Review the exact decisions and give an adoption rationale.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.id);
      if (!ws.success || !id.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Review the exact decisions and give an adoption rationale.',
        );
      return noStore(reply).send(service.adopt(context, ws.data, id.data, req.body));
    },
  );
  app.post<{
    Params: { workspaceId: string; id: string };
    Body: BodyOf<typeof saveCrossProjectSchema>;
  }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/roadmap',
    {
      config: {
        access: 'editor',
        tag: 'config',
        body: saveCrossProjectSchema,
        invalidBody: 'Invalid cross-project roadmap configuration.',
      },
      bodyLimit: 2 * 1024 * 1024,
    },
    async (req, reply) => {
      const context = contextOf(req),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId);
      if (!ws.success || req.body.configuration.definitionId !== req.params.id)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Invalid cross-project roadmap configuration.',
        );
      return noStore(reply).send(roadmapViewSchema.parse(service.save(context, ws.data, req.body)));
    },
  );
}
