import {
  applyRoadmapAgentsSchema,
  applyRoadmapDelegationSchema,
  controlRoadmapRequestSchema,
  decisionPreparationSettingsSchema,
  prepareRoadmapDecisionSchema,
  roadmapAgentsSchema,
  roadmapCapacitiesSchema,
  roadmapHistoryResponseSchema,
  roadmapIdSchema,
  roadmapsResponseSchema,
  roadmapStatusListSchema,
  roadmapViewSchema,
  saveRoadmapCapacitySchema,
  saveRoadmapRequestSchema,
  decisionPreparationGrantRequestSchema,
  scopeRecoveryPolicyRequestSchema,
  workspaceIdSchema,
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
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparations',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        decisionPreparationSettingsSchema.parse(
          roadmaps.decisionSettings(context, ws.data, id.data),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/prepare-decision',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId),
        input = prepareRoadmapDecisionSchema.safeParse(request.body);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      if (!input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Choose a decision, model and bounded preparation time.',
        );
      return noStore(reply).send(
        roadmapViewSchema.parse(
          await roadmaps.prepareDecision(context, ws.data, id.data, input.data),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/delegation',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId),
        input = applyRoadmapDelegationSchema.safeParse(request.body);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      if (!input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Choose current entries, delegation and a reason.',
        );
      return noStore(reply).send(
        roadmapViewSchema.parse(roadmaps.applyDelegation(context, ws.data, id.data, input.data)),
      );
    },
  );
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/agent-profiles',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapAgentsSchema.parse(roadmaps.agentSettings(context, ws.data)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId),
        body = applyRoadmapAgentsSchema.safeParse(request.body);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      if (!body.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Choose valid model profiles and current roadmap entries; permissions and policy cannot be changed here.',
        );
      return noStore(reply).send(
        roadmapAgentsSchema.parse(
          roadmaps.applyAgentSettings(context, ws.data, id.data, body.data),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/capacities',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapCapacitiesSchema.parse(roadmaps.capacities(context, workspace.data)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/capacity',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const id = roadmapIdSchema.safeParse(request.params.roadmapId);
      const input = saveRoadmapCapacitySchema.safeParse(request.body);
      if (!workspace.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      if (!input.success)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Roadmap capacities must be integers from 1 to 16 with the current roadmap version.',
        );
      return noStore(reply).send(
        roadmapCapacitiesSchema.parse(
          roadmaps.saveCapacity(context, workspace.data, id.data, input.data),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps',
    { config: { access: 'member' } },
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
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/status',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!workspace.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapStatusListSchema.parse(roadmaps.statusList(context, workspace.data, id.data)),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/history',
    { config: { access: 'member' } },
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
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparation-grant',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = decisionPreparationGrantRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid decision preparation grant');
      return noStore(reply).send(
        roadmapViewSchema.parse(
          roadmaps.configureDecisionPreparation(
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
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/scope-recovery',
    { config: { access: 'editor' } },
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
    { config: { access: 'editor' }, bodyLimit: 2 * 1024 * 1024 },
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
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = controlRoadmapRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid roadmap command');
      if (body.data.entryId) {
        if (body.data.action === 'reverify')
          return noStore(reply).send(
            roadmapViewSchema.parse(
              await roadmaps.reverifyEntry(
                context,
                workspace.data,
                request.params.roadmapId,
                body.data.entryId,
                body.data.expectedVersion,
              ),
            ),
          );
        if (body.data.action !== 'pause' && body.data.action !== 'resume')
          return sendApiError(
            reply,
            400,
            'invalid-request',
            'Items support pause, resume and re-verify.',
          );
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
      if (body.data.action === 'reverify')
        return sendApiError(reply, 400, 'invalid-request', 'Re-verify applies to one item.');
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
