import {
  cleanupRequestSchema,
  repositoryCleanupViewSchema,
  roadmapWindDownViewSchema,
  windDownRequestSchema,
  applyRoadmapAgentsSchema,
  applyRoadmapDelegationSchema,
  controlRoadmapRequestSchema,
  decisionPreparationSettingsSchema,
  prepareRoadmapDecisionSchema,
  roadmapAgentSettingsSchema,
  roadmapCapacitiesSchema,
  roadmapDefinitionSchema,
  roadmapGraphSchema,
  roadmapHistoryResponseSchema,
  roadmapIdSchema,
  roadmapPageSchema,
  roadmapRevisionParamSchema,
  roadmapSummariesSchema,
  roadmapsResponseSchema,
  roadmapStatusListSchema,
  roadmapViewSchema,
  saveRoadmapCapacitySchema,
  saveRoadmapRequestSchema,
  decisionPreparationGrantRequestSchema,
  scopeRecoveryPolicyRequestSchema,
  workspaceIdSchema,
  roadmapIdLookupSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { RepositoryCleanupService } from '../services/repository-cleanup.js';
import type { RoadmapService } from '../services/roadmap-service.js';
import { noStore, sendApiError } from './http.js';
import {
  type BodyOf,
  contextOf,
  stepUpForStoredWork,
  WORKSPACE_PARAMS,
  workspaceParams,
} from './route-access.js';

/** Each route's path parameters (R-H7). */
const ROADMAP = workspaceParams({ roadmapId: roadmapIdSchema });
const ROADMAP_REVISION = workspaceParams({
  roadmapId: roadmapIdSchema,
  revision: roadmapRevisionParamSchema,
});
const ROADMAP_LOOKUP = workspaceParams({ roadmapId: roadmapIdLookupSchema });
export function registerRoadmapRoutes(
  app: FastifyInstance,
  roadmaps: RoadmapService,
  cleanups: RepositoryCleanupService,
): void {
  // Winding down (R-B11, ADR-073): `control` routes, so R-A6's decision boundary is unchanged.
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/wind-down',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapWindDownViewSchema.parse(roadmaps.windDownView(context, ws.data, id.data)),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof windDownRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/wind-down',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        notFound: 'Roadmap not found',
        tag: 'control',
        body: windDownRequestSchema,
        invalidBody: 'Choose the preview you reviewed and the plan versions to retire.',
        // Retiring a plan version asks for the password again (R-B11 decision 5).
        stepUpRule: 'retiring a plan version',
        stepUp: (body) =>
          typeof body === 'object' &&
          body !== null &&
          Array.isArray((body as { readonly retire?: unknown }).retire) &&
          (body as { readonly retire: readonly unknown[] }).retire.length > 0,
      },
    },
    async (request, reply) => {
      const context = contextOf(request),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapWindDownViewSchema.parse(
          await roadmaps.windDown(context, ws.data, id.data, request.body),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/cleanup',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        repositoryCleanupViewSchema.parse(await cleanups.view(context, ws.data, id.data)),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof cleanupRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/cleanup',
    {
      config: {
        access: 'owner',
        params: ROADMAP,
        notFound: 'Roadmap not found',
        tag: 'control',
        body: cleanupRequestSchema,
        invalidBody: 'Choose the cleanup plan you reviewed.',
        // It deletes branches and worktrees: always the password again (R-B11 decision 5).
        stepUpRule: 'always',
        stepUp: () => true,
      },
    },
    async (request, reply) => {
      const context = contextOf(request),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        repositoryCleanupViewSchema.parse(
          await cleanups.clean(context, ws.data, id.data, request.body),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparations',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request),
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
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof prepareRoadmapDecisionSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/prepare-decision',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        notFound: 'Roadmap not found',
        tag: 'decision',
        body: prepareRoadmapDecisionSchema,
        invalidBody: 'Choose a decision, model and bounded preparation time.',
      },
    },
    async (request, reply) => {
      const context = contextOf(request),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapViewSchema.parse(
          await roadmaps.prepareDecision(context, ws.data, id.data, request.body),
        ),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof applyRoadmapDelegationSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/delegation',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        notFound: 'Roadmap not found',
        tag: 'decision',
        body: applyRoadmapDelegationSchema,
        invalidBody: 'Choose current entries, delegation and a reason.',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapViewSchema.parse(roadmaps.applyDelegation(context, ws.data, id.data, request.body)),
      );
    },
  );
  // A roadmap's agents as its setup edits them (R-E5b); it replaced the workspace-wide read.
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapAgentSettingsSchema.parse(roadmaps.agentSettings(context, ws.data, id.data)),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof applyRoadmapAgentsSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        notFound: 'Roadmap not found',
        tag: 'config',
        body: applyRoadmapAgentsSchema,
        invalidBody:
          'Choose valid model profiles and current roadmap entries; permissions and policy cannot be changed here.',
      },
    },
    async (request, reply) => {
      const context = contextOf(request),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!ws.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapAgentSettingsSchema.parse(
          roadmaps.applyAgentSettings(context, ws.data, id.data, request.body),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/capacities',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapCapacitiesSchema.parse(roadmaps.capacities(context, workspace.data)),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof saveRoadmapCapacitySchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/capacity',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        notFound: 'Roadmap not found',
        tag: 'config',
        body: saveRoadmapCapacitySchema,
        invalidBody:
          'Roadmap capacities must be integers from 1 to 16 with the current roadmap version.',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!workspace.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapCapacitiesSchema.parse(
          roadmaps.saveCapacity(context, workspace.data, id.data, request.body),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapsResponseSchema.parse({ roadmaps: roadmaps.list(context, workspace.data) }),
      );
    },
  );
  // The roadmaps list page's light rows (R-D5).
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/summaries',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapSummariesSchema.parse({ roadmaps: roadmaps.summaries(context, workspace.data) }),
      );
    },
  );
  // A roadmap page's region in one read (R-D5).
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/view',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!workspace.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapPageSchema.parse(roadmaps.page(context, workspace.data, id.data)),
      );
    },
  );
  // One revision of a roadmap's definition, which never changes (R-D5).
  app.get<{ Params: { workspaceId: string; roadmapId: string; revision: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/definitions/:revision',
    { config: { access: 'member', params: ROADMAP_REVISION, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const id = roadmapIdSchema.safeParse(request.params.roadmapId);
      const revision = roadmapRevisionParamSchema.safeParse(request.params.revision);
      if (!workspace.success || !id.success || !revision.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapDefinitionSchema.parse(
          roadmaps.definition(context, workspace.data, id.data, revision.data),
        ),
      );
    },
  );
  // A roadmap's dependency structure at one revision, which never changes (R-E3b).
  app.get<{ Params: { workspaceId: string; roadmapId: string; revision: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/graph/:revision',
    { config: { access: 'member', params: ROADMAP_REVISION, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const id = roadmapIdSchema.safeParse(request.params.roadmapId);
      const revision = roadmapRevisionParamSchema.safeParse(request.params.revision);
      if (!workspace.success || !id.success || !revision.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapGraphSchema.parse(roadmaps.graph(context, workspace.data, id.data, revision.data)),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; roadmapId: string } }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/status',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
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
    { config: { access: 'member', params: ROADMAP_LOOKUP } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapHistoryResponseSchema.parse({
          definitions: roadmaps.history(context, workspace.data, request.params.roadmapId),
        }),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof decisionPreparationGrantRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparation-grant',
    {
      config: {
        access: 'editor',
        params: ROADMAP_LOOKUP,
        tag: 'decision',
        body: decisionPreparationGrantRequestSchema,
        invalidBody: 'Invalid decision preparation grant',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapViewSchema.parse(
          roadmaps.configureDecisionPreparation(
            context,
            workspace.data,
            request.params.roadmapId,
            request.body,
          ),
        ),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof scopeRecoveryPolicyRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/scope-recovery',
    {
      config: {
        access: 'editor',
        params: ROADMAP_LOOKUP,
        tag: 'config',
        body: scopeRecoveryPolicyRequestSchema,
        invalidBody: 'Invalid recovery delegation',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        roadmapViewSchema.parse(
          roadmaps.configureScopeRecovery(
            context,
            workspace.data,
            request.params.roadmapId,
            request.body,
          ),
        ),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof saveRoadmapRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        notFound: 'Roadmap not found',
        tag: 'config',
        body: saveRoadmapRequestSchema,
        invalidBody: 'Invalid roadmap settings; choose unique work items and entries.',
      },
      bodyLimit: 2 * 1024 * 1024,
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const id = roadmapIdSchema.safeParse(request.params.roadmapId);
      if (!workspace.success || !id.success)
        return sendApiError(reply, 404, 'not-found', 'Roadmap not found');
      return noStore(reply).send(
        roadmapViewSchema.parse(roadmaps.save(context, workspace.data, id.data, request.body)),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; roadmapId: string };
    Body: BodyOf<typeof controlRoadmapRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/control',
    {
      config: {
        access: 'editor',
        params: ROADMAP_LOOKUP,
        tag: 'control',
        body: controlRoadmapRequestSchema,
        invalidBody: 'Invalid roadmap command',
        // Starting or resuming work under settings that grant unrestricted asks again (R-G9).
        stepUpRule:
          'an action that starts or resumes work under stored settings granting unrestricted',
        stepUp: stepUpForStoredWork((request) => {
          const { workspaceId, roadmapId } = request.params as {
            readonly workspaceId: string;
            readonly roadmapId: string;
          };
          return roadmaps.storedWork(workspaceId, roadmapId);
        }),
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (request.body.entryId) {
        if (request.body.action === 'reverify')
          return noStore(reply).send(
            roadmapViewSchema.parse(
              await roadmaps.reverifyEntry(
                context,
                workspace.data,
                request.params.roadmapId,
                request.body.entryId,
                request.body.expectedVersion,
              ),
            ),
          );
        if (request.body.action !== 'pause' && request.body.action !== 'resume')
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
              request.body.entryId,
              request.body.action,
              request.body.expectedVersion,
            ),
          ),
        );
      }
      if (request.body.action === 'reverify')
        return sendApiError(reply, 400, 'invalid-request', 'Re-verify applies to one item.');
      return noStore(reply).send(
        roadmapViewSchema.parse(
          await roadmaps.control(
            context,
            workspace.data,
            request.params.roadmapId,
            request.body.action,
            request.body.expectedVersion,
          ),
        ),
      );
    },
  );
}
