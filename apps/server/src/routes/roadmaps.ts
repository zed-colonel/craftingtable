import {
  roadmapIdSchema,
  saveRoadmapRequestSchema,
  controlRoadmapRequestSchema,
  roadmapsResponseSchema,
  roadmapViewSchema,
  roadmapHistoryResponseSchema,
  workspaceIdSchema,
  scopeRecoveryPolicyRequestSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { RoadmapService } from '../services/roadmap-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
export function registerRoadmapRoutes(
  app: FastifyInstance,
  auth: AuthService,
  roadmaps: RoadmapService,
  config: ServerConfig,
): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapsResponseSchema.parse({ roadmaps: roadmaps.list(context, workspace.data) }),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/history',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapHistoryResponseSchema.parse({
          definitions: roadmaps.history(context, workspace.data, request.params.roadmapId),
        }),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/scope-recovery',
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = scopeRecoveryPolicyRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid recovery delegation');
      return noStore(reply).send(
        roadmapViewSchema.parse(
          roadmaps.configureScopeRecovery(
            context,
            workspace.data,
            request.params.roadmapId,
            body.data,
          ),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId',
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const id = roadmapIdSchema.safeParse(request.params.roadmapId);
      const body = saveRoadmapRequestSchema.safeParse(request.body);
      if (!workspace.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      if (!body.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Invalid roadmap settings; choose unique work items and entries.',
        );
      return noStore(reply).send(
        roadmapViewSchema.parse(roadmaps.save(context, workspace.data, id.data, body.data)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/control',
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = controlRoadmapRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid roadmap command');
      if (body.data.entryId) {
        if (body.data.action !== 'pause' && body.data.action !== 'resume')
          return sendApiError(reply, 400, 'invalid-request', 'Items support pause and resume.');
        return noStore(reply).send(
          roadmapViewSchema.parse(
            await roadmaps.controlEntry(
              context,
              workspace.data,
              request.params.roadmapId,
              body.data.entryId,
              body.data.action,
              body.data.expectedVersion,
            ),
          ),
        );
      }
      return noStore(reply).send(
        roadmapViewSchema.parse(
          await roadmaps.control(
            context,
            workspace.data,
            request.params.roadmapId,
            body.data.action,
            body.data.expectedVersion,
          ),
        ),
      );
    },
  );
}
