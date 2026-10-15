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
  paramsOf,
  parsedParamsOf,
} from './route-access.js';

/** Each route's path parameters (R-H7). */
const ROADMAP = workspaceParams({ roadmapId: roadmapIdSchema });
const ROADMAP_REVISION = workspaceParams({
  roadmapId: roadmapIdSchema,
  revision: roadmapRevisionParamSchema,
});
export function registerRoadmapRoutes(
  app: FastifyInstance,
  roadmaps: RoadmapService,
  cleanups: RepositoryCleanupService,
): void {
  // Winding down (R-B11, ADR-073): `control` routes, so R-A6's decision boundary is unchanged.
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/wind-down',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapWindDownViewSchema.parse(roadmaps.windDownView(context, workspaceId, roadmapId)),
      );
    },
  );
  app.post<{
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
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapWindDownViewSchema.parse(
          await roadmaps.windDown(context, workspaceId, roadmapId, request.body),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/cleanup',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        repositoryCleanupViewSchema.parse(await cleanups.view(context, workspaceId, roadmapId)),
      );
    },
  );
  app.post<{
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
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        repositoryCleanupViewSchema.parse(
          await cleanups.clean(context, workspaceId, roadmapId, request.body),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparations',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        decisionPreparationSettingsSchema.parse(
          roadmaps.decisionSettings(context, workspaceId, roadmapId),
        ),
      );
    },
  );
  app.post<{
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
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapViewSchema.parse(
          await roadmaps.prepareDecision(context, workspaceId, roadmapId, request.body),
        ),
      );
    },
  );
  app.post<{
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
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapViewSchema.parse(
          roadmaps.applyDelegation(context, workspaceId, roadmapId, request.body),
        ),
      );
    },
  );
  // A roadmap's agents as its setup edits them (R-E5b); it replaced the workspace-wide read.
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/agent-profiles',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapAgentSettingsSchema.parse(roadmaps.agentSettings(context, workspaceId, roadmapId)),
      );
    },
  );
  app.post<{
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
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapAgentSettingsSchema.parse(
          roadmaps.applyAgentSettings(context, workspaceId, roadmapId, request.body),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/capacities',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        roadmapCapacitiesSchema.parse(roadmaps.capacities(context, workspaceId)),
      );
    },
  );
  app.post<{
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
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapCapacitiesSchema.parse(
          roadmaps.saveCapacity(context, workspaceId, roadmapId, request.body),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/roadmaps',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        roadmapsResponseSchema.parse({ roadmaps: roadmaps.list(context, workspaceId) }),
      );
    },
  );
  // The roadmaps list page's light rows (R-D5).
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/summaries',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        roadmapSummariesSchema.parse({ roadmaps: roadmaps.summaries(context, workspaceId) }),
      );
    },
  );
  // A roadmap page's region in one read (R-D5).
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/view',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapPageSchema.parse(roadmaps.page(context, workspaceId, roadmapId)),
      );
    },
  );
  // One revision of a roadmap's definition, which never changes (R-D5).
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/definitions/:revision',
    { config: { access: 'member', params: ROADMAP_REVISION, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, revision, roadmapId } = paramsOf(request, ROADMAP_REVISION);
      return noStore(reply).send(
        roadmapDefinitionSchema.parse(
          roadmaps.definition(context, workspaceId, roadmapId, revision),
        ),
      );
    },
  );
  // A roadmap's dependency structure at one revision, which never changes (R-E3b).
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/graph/:revision',
    { config: { access: 'member', params: ROADMAP_REVISION, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, revision, roadmapId } = paramsOf(request, ROADMAP_REVISION);
      return noStore(reply).send(
        roadmapGraphSchema.parse(roadmaps.graph(context, workspaceId, roadmapId, revision)),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/status',
    { config: { access: 'member', params: ROADMAP, notFound: 'Roadmap not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapStatusListSchema.parse(roadmaps.statusList(context, workspaceId, roadmapId)),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/history',
    { config: { access: 'member', params: ROADMAP } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapHistoryResponseSchema.parse({
          definitions: roadmaps.history(context, workspaceId, roadmapId),
        }),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof decisionPreparationGrantRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/decision-preparation-grant',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        tag: 'decision',
        body: decisionPreparationGrantRequestSchema,
        invalidBody: 'Invalid decision preparation grant',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapViewSchema.parse(
          roadmaps.configureDecisionPreparation(context, workspaceId, roadmapId, request.body),
        ),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof scopeRecoveryPolicyRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/scope-recovery',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        tag: 'config',
        body: scopeRecoveryPolicyRequestSchema,
        invalidBody: 'Invalid recovery delegation',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapViewSchema.parse(
          roadmaps.configureScopeRecovery(context, workspaceId, roadmapId, request.body),
        ),
      );
    },
  );
  app.post<{
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
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      return noStore(reply).send(
        roadmapViewSchema.parse(roadmaps.save(context, workspaceId, roadmapId, request.body)),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof controlRoadmapRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/roadmaps/:roadmapId/control',
    {
      config: {
        access: 'editor',
        params: ROADMAP,
        tag: 'control',
        body: controlRoadmapRequestSchema,
        invalidBody: 'Invalid roadmap command',
        // Starting or resuming work under settings that grant unrestricted asks again (R-G9).
        stepUpRule:
          'an action that starts or resumes work under stored settings granting unrestricted',
        stepUp: stepUpForStoredWork((request) => {
          const params = parsedParamsOf(request, ROADMAP);
          return params && roadmaps.storedWork(params.workspaceId, params.roadmapId);
        }),
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, roadmapId } = paramsOf(request, ROADMAP);
      if (request.body.entryId) {
        if (request.body.action === 'reverify')
          return noStore(reply).send(
            roadmapViewSchema.parse(
              await roadmaps.reverifyEntry(
                context,
                workspaceId,
                roadmapId,
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
              workspaceId,
              roadmapId,
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
            workspaceId,
            roadmapId,
            request.body.action,
            request.body.expectedVersion,
          ),
        ),
      );
    },
  );
}
