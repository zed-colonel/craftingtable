import {
  authorizeScopeSchedulingRequestSchema,
  createWorktreeRequestSchema,
  createWorktreeResponseSchema,
  executionScopeChoicesSchema,
  executionStatusResponseSchema,
  mergeWorktreeRequestSchema,
  mergeWorktreeResponseSchema,
  recordScopeReceiptRequestSchema,
  recordScopeReceiptResponseSchema,
  refreshModelsRequestSchema,
  registerSourceRepositoryRequestSchema,
  registerSourceRepositoryResponseSchema,
  worktreeControlRequestSchema,
  removeWorktreeResponseSchema,
  repositoryBranchesResponseSchema,
  retireSourceRepositoryRequestSchema,
  retireSourceRepositoryResponseSchema,
  runProfilesResponseSchema,
  saveRunProfilesRequestSchema,
  sourceRepositoryIdSchema,
  sourceRepositoryListResponseSchema,
  workItemIdSchema,
  workspaceRunsResponseSchema,
  worktreeDiffResponseSchema,
  worktreeIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { AgentRunService } from '../services/agent-run-service.js';
import type { ExecutionService, ExecutionStatus } from '../services/execution-service.js';
import type { ModelCatalogService } from '../services/model-catalog-service.js';
import { registerBranchRoutes } from './branches.js';
import { noStore, sendApiError } from './http.js';
import {
  type BodyOf,
  contextOf,
  WORKSPACE_PARAMS,
  workspaceParams,
  paramsOf,
  parsedParamsOf,
} from './route-access.js';
import { runListRow } from './run-summary.js';

/** Each route's path parameters (R-H7). */
const WORK_ITEM = workspaceParams({ workItemId: workItemIdSchema });
const WORKTREE = workspaceParams({ worktreeId: worktreeIdSchema });
const REPOSITORY = workspaceParams({ repositoryId: sourceRepositoryIdSchema });

/**
 * Repository, worktree, and diff routes.
 *
 * A route authenticates, applies CSRF and origin policy, validates the body
 * through the shared contract, and hands a service the typed input. No route
 * accepts a shell string, and the only host path accepted anywhere is the
 * repository root in the registration body, which the service verifies is a
 * Git top level before anything is stored.
 */
export function registerExecutionRoutes(
  app: FastifyInstance,
  executionService: ExecutionService,
  agentRunService: AgentRunService,
  status: () => ExecutionStatus,
  modelCatalogs: ModelCatalogService,
): void {
  registerBranchRoutes(app, executionService.branches);
  app.get(
    '/api/workspaces/:workspaceId/work-items/:workItemId/execution-scopes',
    { config: { access: 'member', params: WORK_ITEM } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, workItemId } = paramsOf(request, WORK_ITEM);
      return noStore(reply).send(
        executionScopeChoicesSchema.parse(
          executionService.executionScopes(context, workspaceId, workItemId),
        ),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof authorizeScopeSchedulingRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/scope-scheduling',
    {
      config: {
        access: 'editor',
        params: WORK_ITEM,
        tag: 'decision',
        body: authorizeScopeSchedulingRequestSchema,
        invalidBody: 'Invalid scheduling authorization',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, workItemId } = paramsOf(request, WORK_ITEM);
      return noStore(reply).send(
        executionScopeChoicesSchema.parse(
          executionService.authorizeEarlyDevelopment(
            context,
            workspaceId,
            workItemId,
            request.body.scope,
          ),
        ),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof recordScopeReceiptRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/scope-evidence',
    {
      config: {
        access: 'editor',
        params: WORKTREE,
        tag: 'decision',
        body: recordScopeReceiptRequestSchema,
        invalidBody: 'Invalid scope evidence request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, worktreeId } = paramsOf(request, WORKTREE);
      return noStore(reply).send(
        recordScopeReceiptResponseSchema.parse(
          await executionService.recordScopeReceipt(
            context,
            workspaceId,
            worktreeId,
            request.body.expectedWorktreeVersion,
          ),
        ),
      );
    },
  );
  app.get('/api/execution-status', { config: { access: 'session' } }, async (_request, reply) => {
    return noStore(reply).send(executionStatusResponseSchema.parse(status()));
  });
  // "Refresh models" (R-G15): reads each CLI's catalog now and answers with the new status.
  app.post<{ Body: BodyOf<typeof refreshModelsRequestSchema> }>(
    '/api/execution-status/refresh-models',
    {
      config: {
        access: 'session',
        tag: 'control',
        body: refreshModelsRequestSchema,
        invalidBody: 'Invalid model refresh request',
      },
    },
    async (_request, reply) => {
      await modelCatalogs.refresh();
      return noStore(reply).send(executionStatusResponseSchema.parse(status()));
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/run-profiles',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        runProfilesResponseSchema.parse(
          agentRunService.listRunProfiles(context, workspaceId, request.id),
        ),
      );
    },
  );

  app.post<{ Body: BodyOf<typeof saveRunProfilesRequestSchema> }>(
    '/api/workspaces/:workspaceId/run-profiles',
    {
      config: {
        access: 'editor',
        params: WORKSPACE_PARAMS,
        tag: 'config',
        body: saveRunProfilesRequestSchema,
        invalidBody: 'Invalid run profiles',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        runProfilesResponseSchema.parse(
          agentRunService.saveRunProfiles(context, workspaceId, request.body.profiles, request.id),
        ),
      );
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/repositories',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        sourceRepositoryListResponseSchema.parse({
          repositories: executionService.listRepositories(context, workspaceId, request.id),
        }),
      );
    },
  );

  app.post<{
    Body: BodyOf<typeof registerSourceRepositoryRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/repositories',
    {
      config: {
        access: 'editor',
        params: WORKSPACE_PARAMS,
        tag: 'config',
        body: registerSourceRepositoryRequestSchema,
        invalidBody: 'Invalid repository registration',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      const result = await executionService.registerRepository(
        context,
        workspaceId,
        request.body,
        request.id,
      );
      return noStore(reply).send(registerSourceRepositoryResponseSchema.parse(result));
    },
  );

  app.post<{
    Body: BodyOf<typeof retireSourceRepositoryRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/repositories/:repositoryId/retire',
    {
      config: {
        access: 'editor',
        params: REPOSITORY,
        tag: 'config',
        body: retireSourceRepositoryRequestSchema,
        invalidBody: 'Invalid request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, repositoryId } = paramsOf(request, REPOSITORY);
      const result = executionService.retireRepository(
        context,
        workspaceId,
        repositoryId,
        request.id,
      );
      return noStore(reply).send(retireSourceRepositoryResponseSchema.parse(result));
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/repositories/:repositoryId/branches',
    { config: { access: 'member', params: REPOSITORY } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, repositoryId } = paramsOf(request, REPOSITORY);
      const listing = await executionService.listBranches(
        context,
        workspaceId,
        repositoryId,
        request.id,
      );
      return noStore(reply).send(repositoryBranchesResponseSchema.parse(listing));
    },
  );

  // List rows omit the outcome summary (most of the body, and no list shows it);
  // `?status=live` returns only the runs the dashboard shows.
  app.get<{ Querystring: { status?: string } }>(
    '/api/workspaces/:workspaceId/runs',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      const status = request.query.status;
      if (status !== undefined && status !== 'live') {
        return sendApiError(reply, 400, 'invalid-request', 'Unsupported run status filter');
      }
      const result = executionService.listRuns(context, workspaceId, request.id, {
        live: status === 'live',
      });
      return noStore(reply).send(
        workspaceRunsResponseSchema.parse({
          runs: result.runs.map((entry) => ({
            ...runListRow(entry.run),
            workItemSourceId: entry.workItemSourceId,
            workItemTitle: entry.workItemTitle,
            projectName: entry.projectName,
            branchName: entry.branchName,
          })),
          liveCount: result.liveCount,
        }),
      );
    },
  );

  app.post<{
    Body: BodyOf<typeof createWorktreeRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/worktrees',
    {
      config: {
        access: 'editor',
        params: WORK_ITEM,
        tag: 'control',
        body: createWorktreeRequestSchema,
        invalidBody: 'Invalid worktree request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, workItemId } = paramsOf(request, WORK_ITEM);
      const worktree = await executionService.createWorktree(
        context,
        workspaceId,
        workItemId,
        request.body,
        request.id,
      );
      return noStore(reply).send(createWorktreeResponseSchema.parse({ worktree }));
    },
  );

  // A worktree's manual commands share one route (R-H5, H5-2): the same access, none carries
  // authority. Its merge is a decision and keeps its own route below.
  app.post<{
    Body: BodyOf<typeof worktreeControlRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/control',
    {
      config: {
        access: 'editor',
        params: WORKTREE,
        tag: 'control',
        body: worktreeControlRequestSchema,
        invalidBody: 'Invalid worktree command',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, worktreeId } = paramsOf(request, WORKTREE);
      const body = request.body;
      if (body.action === 'remove')
        return noStore(reply).send(
          removeWorktreeResponseSchema.parse(
            await executionService.removeWorktree(context, workspaceId, worktreeId, request.id, {
              discardChanges: body.discardChanges === true,
            }),
          ),
        );
      return noStore(reply).send(
        createWorktreeResponseSchema.parse(
          await executionService.branches.changeWorktree(
            context,
            workspaceId,
            worktreeId,
            body.action === 'retarget'
              ? { expectedVersion: body.expectedVersion, integrationBranch: body.integrationBranch }
              : { expectedVersion: body.expectedVersion },
            body.action === 'update',
          ),
        ),
      );
    },
  );

  /**
   * The one merge route. It carries no arguments: the daemon decides the
   * target branch and refuses unless the worktree's latest run is a review
   * with a mergeable verdict (the pull-request rule).
   */
  app.post<{
    Body: BodyOf<typeof mergeWorktreeRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/merge',
    {
      config: {
        access: 'editor',
        params: WORKTREE,
        tag: 'decision',
        body: mergeWorktreeRequestSchema,
        invalidBody: 'Invalid merge request',
        // A merge into the repository's default branch is a final promotion (R-G9).
        stepUpRule: "a merge into the repository's default branch (a final promotion)",
        stepUp: (_body, request) => {
          const params = parsedParamsOf(request, WORKTREE);
          return (
            params !== undefined &&
            executionService.mergesIntoDefaultBranch(params.workspaceId, params.worktreeId)
          );
        },
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, worktreeId } = paramsOf(request, WORKTREE);
      const result = await executionService.mergeWorktree(
        context,
        workspaceId,
        worktreeId,
        request.body,
        request.id,
      );
      return noStore(reply).send(mergeWorktreeResponseSchema.parse(result));
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/diff',
    { config: { access: 'member', params: WORKTREE } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, worktreeId } = paramsOf(request, WORKTREE);
      const { worktree, diff } = await executionService.worktreeDiff(
        context,
        workspaceId,
        worktreeId,
        request.id,
      );
      return noStore(reply).send(
        worktreeDiffResponseSchema.parse({
          worktree,
          baseSha: diff.baseSha,
          headSha: diff.headSha,
          commits: diff.commits,
          files: diff.files,
          patch: diff.patch,
          patchTruncated: diff.patchTruncated,
        }),
      );
    },
  );
}
