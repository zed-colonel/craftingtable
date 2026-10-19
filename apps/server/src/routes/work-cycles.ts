import {
  baselineEvidenceSchema,
  baselinePreviewSchema,
  controlWorkCycleRequestSchema,
  designRecoveryPreviewSchema,
  integrationResolutionRequestSchema,
  prepareBaselineRequestSchema,
  recoverDesignRequestSchema,
  investigationRequestSchema,
  scopeRepairPreviewSchema,
  scopeRepairRequestSchema,
  startWorkCycleRequestSchema,
  workCycleResponseSchema,
  workCyclesResponseSchema,
  workItemIdSchema,
  workCycleIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { RoadmapService } from '../services/roadmap-service.js';
import type { WorkCycleService } from '../services/work-cycle-service.js';
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
const CYCLE = workspaceParams({ cycleId: workCycleIdSchema });
const WORK_ITEM = workspaceParams({ workItemId: workItemIdSchema });

export function registerWorkCycleRoutes(
  app: FastifyInstance,
  cycles: WorkCycleService,
  /** Owns repairs of a roadmap's reviews as recovery rounds. */
  roadmaps: Pick<RoadmapService, 'delegateScopeRepair'>,
): void {
  app.get(
    '/api/workspaces/:workspaceId/cycles/:cycleId/scope-repair',
    { config: { access: 'member', params: CYCLE } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      return noStore(reply).send(
        scopeRepairPreviewSchema.parse(cycles.previewScopeRepair(context, workspaceId, cycleId)),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof scopeRepairRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/scope-repair',
    {
      config: {
        access: 'editor',
        params: CYCLE,
        tag: 'decision',
        body: scopeRepairRequestSchema,
        invalidBody: 'Invalid scope repair request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      return noStore(reply).send(
        workCycleResponseSchema.parse(
          cycles.present(
            await roadmaps.delegateScopeRepair(context, workspaceId, cycleId, request.body),
          ),
        ),
      );
    },
  );
  // Without `workItemId`: the cycles that have not ended, without design-recovery
  // detail (the shell's attention list). With it: that work item's full cycles.
  app.get<{ Querystring: { workItemId?: string } }>(
    '/api/workspaces/:workspaceId/cycles',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      const item =
        request.query.workItemId === undefined
          ? undefined
          : workItemIdSchema.safeParse(request.query.workItemId);
      if (item !== undefined && !item.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid work item');
      return noStore(reply).send(
        workCyclesResponseSchema.parse({
          cycles: cycles.list(
            context,
            workspaceId,
            item === undefined ? {} : { workItemId: item.data },
          ),
        }),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof startWorkCycleRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/cycles',
    {
      config: {
        access: 'editor',
        params: WORK_ITEM,
        notFound: 'Work item not found',
        tag: 'control',
        body: startWorkCycleRequestSchema,
        invalidBody: 'Invalid cycle settings',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, workItemId } = paramsOf(request, WORK_ITEM);
      return noStore(reply).send(
        workCycleResponseSchema.parse(
          cycles.present(cycles.startRequested(context, workspaceId, workItemId, request.body)),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/cycles/:cycleId/baseline-evidence',
    { config: { access: 'member', params: CYCLE } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      return noStore(reply).send(
        baselineEvidenceSchema.parse(cycles.baselineEvidence(context, workspaceId, cycleId)),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/cycles/:cycleId/design-recovery',
    { config: { access: 'editor', params: CYCLE } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      return noStore(reply).send(
        designRecoveryPreviewSchema.parse(
          cycles.previewDesignRecovery(context, workspaceId, cycleId),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/cycles/:cycleId/baseline-preparation',
    { config: { access: 'editor', params: CYCLE } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      return noStore(reply).send(
        baselinePreviewSchema.parse(await cycles.previewBaseline(context, workspaceId, cycleId)),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof prepareBaselineRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/baseline-preparation',
    {
      config: {
        access: 'editor',
        params: CYCLE,
        tag: 'decision',
        body: prepareBaselineRequestSchema,
        invalidBody: 'Invalid baseline preparation',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      return noStore(reply).send(
        workCycleResponseSchema.parse(
          cycles.present(await cycles.prepareBaseline(context, workspaceId, cycleId, request.body)),
        ),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof recoverDesignRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/design-recovery',
    {
      config: {
        access: 'editor',
        params: CYCLE,
        tag: 'decision',
        body: recoverDesignRequestSchema,
        invalidBody: 'Invalid design recovery request',
      },
      bodyLimit: 2 * 1024 * 1024,
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      const cycle = await cycles.recoverDesign(context, workspaceId, cycleId, request.body);
      return noStore(reply).send(workCycleResponseSchema.parse(cycles.present(cycle)));
    },
  );
  // A question stop's read-only investigation (R-C16): starting it, ending it, and acknowledging
  // that the worktree changed while it ran, in one route (R-H5, H5-2).
  app.post<{
    Body: BodyOf<typeof investigationRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/investigation',
    {
      config: {
        access: 'editor',
        params: CYCLE,
        tag: 'decision',
        body: investigationRequestSchema,
        invalidBody: 'Invalid investigation request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      const { action, ...body } = request.body;
      const cycle =
        action === 'start'
          ? await cycles.startInvestigation(
              context,
              workspaceId,
              cycleId,
              body as Omit<Extract<typeof request.body, { action: 'start' }>, 'action'>,
            )
          : action === 'end'
            ? await cycles.endInvestigation(context, workspaceId, cycleId, body.expectedVersion)
            : cycles.acknowledgeWorktreeChange(context, workspaceId, cycleId, body.expectedVersion);
      return noStore(reply).send(workCycleResponseSchema.parse(cycles.present(cycle)));
    },
  );
  app.post<{
    Body: BodyOf<typeof controlWorkCycleRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/control',
    {
      config: {
        access: 'editor',
        params: CYCLE,
        tag: 'decision',
        body: controlWorkCycleRequestSchema,
        invalidBody: 'Invalid cycle command',
        // Resuming work under profiles that grant unrestricted asks again (R-G9).
        stepUpRule:
          'an action that starts or resumes work under stored settings granting unrestricted',
        stepUp: stepUpForStoredWork((request) => {
          const params = parsedParamsOf(request, CYCLE);
          return params && cycles.storedWork(params.workspaceId, params.cycleId);
        }),
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      const cycle =
        request.body.action === 'change-settings'
          ? cycles.changeSettings(context, workspaceId, cycleId, request.body)
          : request.body.action === 'authorize-remediation'
            ? await cycles.authorizeWorkItemRemediation(context, workspaceId, cycleId, request.body)
            : request.body.action === 'review-again'
              ? await cycles.repeatScopeReview(
                  context,
                  workspaceId,
                  cycleId,
                  request.body.expectedVersion,
                  request.body.instructions ?? '',
                )
              : await cycles.control(
                  context,
                  workspaceId,
                  cycleId,
                  request.body.action,
                  request.body.expectedVersion,
                  request.body.action === 'resume' ? request.body.instructions : undefined,
                );
      return noStore(reply).send(workCycleResponseSchema.parse(cycles.present(cycle)));
    },
  );
  app.post<{
    Body: BodyOf<typeof integrationResolutionRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/cycles/:cycleId/integration-resolution',
    {
      config: {
        access: 'editor',
        params: CYCLE,
        tag: 'decision',
        body: integrationResolutionRequestSchema,
        invalidBody: 'Invalid integration resolution command',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, cycleId } = paramsOf(request, CYCLE);
      const cycle = await cycles.resolveIntegration(context, workspaceId, cycleId, request.body);
      return noStore(reply).send(workCycleResponseSchema.parse(cycles.present(cycle)));
    },
  );
}
