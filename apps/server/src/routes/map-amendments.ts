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
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { MapAmendmentService } from '../services/map-amendment-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
export function registerMapAmendmentRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: MapAmendmentService,
  config: ServerConfig,
) {
  const base = '/api/workspaces/:workspaceId/roadmaps/:roadmapId';
  type Params = { workspaceId: string; roadmapId: string };
  app.get<{ Params: Params }>(
    `${base}/amendments`,
    { config: { access: 'member' } },
    async (req, reply) => {
      const context = authenticate(req, auth),
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
      const context = authenticate(req, auth),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        crossProjectFinalizationSchema.parse(service.finalization(context, ws.data, id.data)),
      );
    },
  );
  app.post<{ Params: Params }>(
    `${base}/amendments/preview`,
    { config: { access: 'editor' } },
    async (req, reply) => {
      const context = authorizeMutation(req, auth, config),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId),
        input = mapSelectionSchema.safeParse(req.body);
      if (!ws.success || !id.success || !input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Choose an exact map binding and target.',
        );
      return noStore(reply).send(
        amendmentImpactSchema.parse(service.preview(context, ws.data, id.data, input.data)),
      );
    },
  );
  app.post<{ Params: Params }>(
    `${base}/amendments`,
    { config: { access: 'editor' } },
    async (req, reply) => {
      const context = authorizeMutation(req, auth, config),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId),
        input = proposeMapAmendmentSchema.safeParse(req.body);
      if (!ws.success || !id.success || !input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Provide an exact candidate binding and proposal summary.',
        );
      return noStore(reply).send(
        mapAmendmentsViewSchema.parse(await service.propose(context, ws.data, id.data, input.data)),
      );
    },
  );
  app.post<{ Params: Params }>(
    `${base}/amendments/decision`,
    { config: { access: 'editor' } },
    async (req, reply) => {
      const context = authorizeMutation(req, auth, config),
        ws = workspaceIdSchema.safeParse(req.params.workspaceId),
        id = roadmapIdSchema.safeParse(req.params.roadmapId),
        input = decideMapAmendmentSchema.safeParse(req.body);
      if (!ws.success || !id.success || !input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Review the impact and provide a decision rationale.',
        );
      return noStore(reply).send(
        mapAmendmentsViewSchema.parse(await service.decide(context, ws.data, id.data, input.data)),
      );
    },
  );
}
