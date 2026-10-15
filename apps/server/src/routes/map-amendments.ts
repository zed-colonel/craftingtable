import {
  amendmentImpactSchema,
  crossProjectFinalizationSchema,
  decideMapAmendmentSchema,
  mapAmendmentsViewSchema,
  mapSelectionSchema,
  proposeMapAmendmentSchema,
  roadmapIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { MapAmendmentService } from '../services/map-amendment-service.js';
import { noStore } from './http.js';
import { type BodyOf, contextOf, paramsOf, workspaceParams } from './route-access.js';

/** Each route's path parameters (R-H7). */
const ROADMAP = workspaceParams({ roadmapId: roadmapIdSchema });
export function registerMapAmendmentRoutes(app: FastifyInstance, service: MapAmendmentService) {
  const base = '/api/workspaces/:workspaceId/roadmaps/:roadmapId';
  app.get(
    `${base}/amendments`,
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (req, reply) => {
      const context = contextOf(req);
      const { workspaceId, roadmapId } = paramsOf(req, ROADMAP);
      return noStore(reply).send(
        mapAmendmentsViewSchema.parse(service.view(context, workspaceId, roadmapId)),
      );
    },
  );
  app.get(
    `${base}/finalization-readiness`,
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (req, reply) => {
      const context = contextOf(req);
      const { workspaceId, roadmapId } = paramsOf(req, ROADMAP);
      return noStore(reply).send(
        crossProjectFinalizationSchema.parse(service.finalization(context, workspaceId, roadmapId)),
      );
    },
  );
  app.post<{ Body: BodyOf<typeof mapSelectionSchema> }>(
    `${base}/amendments/preview`,
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        paramsRefusedAsBody: true,
        tag: 'decision',
        body: mapSelectionSchema,
        invalidBody: 'Choose an exact map binding and target.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req);
      const { workspaceId, roadmapId } = paramsOf(req, ROADMAP);
      return noStore(reply).send(
        amendmentImpactSchema.parse(service.preview(context, workspaceId, roadmapId, req.body)),
      );
    },
  );
  app.post<{ Body: BodyOf<typeof proposeMapAmendmentSchema> }>(
    `${base}/amendments`,
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        paramsRefusedAsBody: true,
        tag: 'decision',
        body: proposeMapAmendmentSchema,
        invalidBody: 'Provide an exact candidate binding and proposal summary.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req);
      const { workspaceId, roadmapId } = paramsOf(req, ROADMAP);
      return noStore(reply).send(
        mapAmendmentsViewSchema.parse(
          await service.propose(context, workspaceId, roadmapId, req.body),
        ),
      );
    },
  );
  app.post<{ Body: BodyOf<typeof decideMapAmendmentSchema> }>(
    `${base}/amendments/decision`,
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        paramsRefusedAsBody: true,
        tag: 'decision',
        body: decideMapAmendmentSchema,
        invalidBody: 'Review the impact and provide a decision rationale.',
      },
    },
    async (req, reply) => {
      const context = contextOf(req);
      const { workspaceId, roadmapId } = paramsOf(req, ROADMAP);
      return noStore(reply).send(
        mapAmendmentsViewSchema.parse(
          await service.decide(context, workspaceId, roadmapId, req.body),
        ),
      );
    },
  );
}
