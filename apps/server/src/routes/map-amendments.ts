import {
  amendmentImpactSchema,
  crossProjectFinalizationSchema,
  decideMapAmendmentSchema,
  mapAmendmentsViewSchema,
  mapSelectionSchema,
  proposeMapAmendmentSchema,
  roadmapIdSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { MapAmendmentService } from '../services/map-amendment-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf } from './route-access.js';
export function registerMapAmendmentRoutes(app: FastifyInstance, service: MapAmendmentService) {
  const base = '/api/workspaces/:workspaceId/roadmaps/:roadmapId';
  type Params = { workspaceId: string; roadmapId: string };
  app.get<{ Params: Params }>(
    `${base}/amendments`,
    { config: { access: 'member' } },
    async (req, reply) => {
      const context = contextOf(req),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        mapAmendmentsViewSchema.parse(service.view(context, ws.data, id.data)),
      );
    },
  );
  app.get<{ Params: Params }>(
    `${base}/finalization-readiness`,
    { config: { access: 'member' } },
    async (req, reply) => {
      const context = contextOf(req),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        crossProjectFinalizationSchema.parse(service.finalization(context, ws.data, id.data)),
      );
    },
  );
  app.post<{ Params: Params; Body: BodyOf<typeof mapSelectionSchema> }>(
    `${base}/amendments/preview`,
    {
      config: {
        access: 'editor',
        tag: 'decision',
        body: mapSelectionSchema,
        invalidBody: 'Choose an exact map binding and target.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Choose an exact map binding and target.',
        );
      return noStore(reply).send(
        amendmentImpactSchema.parse(service.preview(context, ws.data, id.data, req.body)),
      );
    },
  );
  app.post<{ Params: Params; Body: BodyOf<typeof proposeMapAmendmentSchema> }>(
    `${base}/amendments`,
    {
      config: {
        access: 'editor',
        tag: 'decision',
        body: proposeMapAmendmentSchema,
        invalidBody: 'Provide an exact candidate binding and proposal summary.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Provide an exact candidate binding and proposal summary.',
        );
      return noStore(reply).send(
        mapAmendmentsViewSchema.parse(await service.propose(context, ws.data, id.data, req.body)),
      );
    },
  );
  app.post<{ Params: Params; Body: BodyOf<typeof decideMapAmendmentSchema> }>(
    `${base}/amendments/decision`,
    {
      config: {
        access: 'editor',
        tag: 'decision',
        body: decideMapAmendmentSchema,
        invalidBody: 'Review the impact and provide a decision rationale.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Review the impact and provide a decision rationale.',
        );
      return noStore(reply).send(
        mapAmendmentsViewSchema.parse(await service.decide(context, ws.data, id.data, req.body)),
      );
    },
  );
}
