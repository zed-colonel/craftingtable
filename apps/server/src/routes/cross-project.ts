import {
  adoptMapSchema,
  crossProjectViewSchema,
  mapSelectionSchema,
  concurrencyDefinitionIdSchema,
  roadmapViewSchema,
  saveCrossProjectSchema,
  concurrencyDefinitionIdLookupSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { CrossProjectService } from '../services/cross-project-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf, paramsOf, workspaceParams } from './route-access.js';

/** Each route's path parameters (R-H7). */
const DEFINITION = workspaceParams({ id: concurrencyDefinitionIdLookupSchema });
const ADOPTION = workspaceParams({ id: concurrencyDefinitionIdSchema });
export function registerCrossProjectRoutes(app: FastifyInstance, service: CrossProjectService) {
  app.post<{
    Body: BodyOf<typeof mapSelectionSchema>;
  }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/preview',
    {
      config: {
        access: 'editor',
        params: DEFINITION,
        tag: 'config',
        body: mapSelectionSchema,
        invalidBody: 'Select an exact binding and declared target.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req);
      const { workspaceId, id } = paramsOf(req, DEFINITION);
      if (req.body.definitionId !== id)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Select an exact binding and declared target.',
        );
      return noStore(reply).send(
        crossProjectViewSchema.parse(service.view(context, workspaceId, req.body)),
      );
    },
  );
  app.post<{ Body: BodyOf<typeof adoptMapSchema> }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/adopt',
    {
      config: {
        access: 'editor',
        params: ADOPTION,
        paramsRefusedAsBody: true,
        tag: 'decision',
        body: adoptMapSchema,
        invalidBody: 'Review the exact decisions and give an adoption rationale.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req);
      const { workspaceId, id } = paramsOf(req, ADOPTION);
      return noStore(reply).send(service.adopt(context, workspaceId, id, req.body));
    },
  );
  app.post<{
    Body: BodyOf<typeof saveCrossProjectSchema>;
  }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/supervision/roadmap',
    {
      config: {
        access: 'editor',
        params: DEFINITION,
        tag: 'config',
        body: saveCrossProjectSchema,
        invalidBody: 'Invalid cross-project roadmap configuration.',
      },
      bodyLimit: 2 * 1024 * 1024,
    },
    async (req, reply) => {
      const context = contextOf(req);
      const { workspaceId, id } = paramsOf(req, DEFINITION);
      if (req.body.configuration.definitionId !== id)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Invalid cross-project roadmap configuration.',
        );
      return noStore(reply).send(
        roadmapViewSchema.parse(service.save(context, workspaceId, req.body)),
      );
    },
  );
}
