import {
  executionScopeChoicesSchema,
  authorizeScopeSchedulingRequestSchema,
  recordScopeReceiptRequestSchema,
  recordScopeReceiptResponseSchema,
} from '@craftingtable/contracts';
import {
  createWorktreeRequestSchema,
  createWorktreeResponseSchema,
  executionStatusResponseSchema,
  mergeWorktreeRequestSchema,
  mergeWorktreeResponseSchema,
  registerSourceRepositoryRequestSchema,
  registerSourceRepositoryResponseSchema,
  removeWorktreeRequestSchema,
  removeWorktreeResponseSchema,
  repositoryBranchesResponseSchema,
  retireSourceRepositoryRequestSchema,
  retireSourceRepositoryResponseSchema,
  runProfilesResponseSchema,
  saveRunProfilesRequestSchema,
  sourceRepositoryIdSchema,
  sourceRepositoryListResponseSchema,
  workItemExecutionResponseSchema,
  workItemIdSchema,
  workspaceIdSchema,
  workspaceRunsResponseSchema,
  worktreeDiffResponseSchema,
  worktreeIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AgentRunService } from '../services/agent-run-service.js';
import type { AuthService } from '../services/auth-service.js';
import type { ExecutionService, ExecutionStatus } from '../services/execution-service.js';
import { registerBranchRoutes } from './branches.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
import { runListRow, runSummary } from './run-summary.js';

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
  authService: AuthService,
  executionService: ExecutionService,
  agentRunService: AgentRunService,
  status: () => ExecutionStatus,
  config: ServerConfig,
): void {
  registerBranchRoutes(app, authService, executionService.branches, config);
  app.get<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/execution-scopes',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        item = workItemIdSchema.safeParse(request.params.workItemId);
      if (!ws.success || !item.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      return noStore(reply).send(
        executionScopeChoicesSchema.parse(
          executionService.executionScopes(context, ws.data, item.data),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/scope-scheduling',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        item = workItemIdSchema.safeParse(request.params.workItemId);
      if (!ws.success || !item.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      const body = authorizeScopeSchedulingRequestSchema.safeParse(request.body);
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid scheduling authorization');
      return noStore(reply).send(
        executionScopeChoicesSchema.parse(
          executionService.authorizeEarlyDevelopment(context, ws.data, item.data, body.data.scope),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; worktreeId: string } }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/scope-evidence',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId),
        tree = worktreeIdSchema.safeParse(request.params.worktreeId);
      if (!ws.success || !tree.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      const body = recordScopeReceiptRequestSchema.safeParse(request.body);
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid scope evidence request');
      return noStore(reply).send(
        recordScopeReceiptResponseSchema.parse(
          await executionService.recordScopeReceipt(
            context,
            ws.data,
            tree.data,
            body.data.expectedWorktreeVersion,
          ),
        ),
      );
    },
  );
  app.get('/api/execution-status', async (request, reply) => {
    authenticate(request, authService);
    return noStore(reply).send(executionStatusResponseSchema.parse(status()));
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/run-profiles',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        runProfilesResponseSchema.parse({
          profiles: agentRunService.listRunProfiles(context, workspaceId.data, request.id),
        }),
      );
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/run-profiles',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const body = saveRunProfilesRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid run profiles');
      }
      return noStore(reply).send(
        runProfilesResponseSchema.parse({
          profiles: agentRunService.saveRunProfiles(
            context,
            workspaceId.data,
            body.data.profiles,
            request.id,
          ),
        }),
      );
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/repositories',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        sourceRepositoryListResponseSchema.parse({
          repositories: executionService.listRepositories(context, workspaceId.data, request.id),
        }),
      );
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/repositories',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const body = registerSourceRepositoryRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid repository registration');
      }
      const result = await executionService.registerRepository(
        context,
        workspaceId.data,
        body.data,
        request.id,
      );
      return noStore(reply).send(registerSourceRepositoryResponseSchema.parse(result));
    },
  );

  app.post<{ Params: { workspaceId: string; repositoryId: string } }>(
    '/api/workspaces/:workspaceId/repositories/:repositoryId/retire',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const repositoryId = sourceRepositoryIdSchema.safeParse(request.params.repositoryId);
      if (!workspaceId.success || !repositoryId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      if (!retireSourceRepositoryRequestSchema.safeParse(request.body ?? {}).success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid request');
      }
      const result = executionService.retireRepository(
        context,
        workspaceId.data,
        repositoryId.data,
        request.id,
      );
      return noStore(reply).send(retireSourceRepositoryResponseSchema.parse(result));
    },
  );

  app.get<{ Params: { workspaceId: string; repositoryId: string } }>(
    '/api/workspaces/:workspaceId/repositories/:repositoryId/branches',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const repositoryId = sourceRepositoryIdSchema.safeParse(request.params.repositoryId);
      if (!workspaceId.success || !repositoryId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const listing = await executionService.listBranches(
        context,
        workspaceId.data,
        repositoryId.data,
        request.id,
      );
      return noStore(reply).send(repositoryBranchesResponseSchema.parse(listing));
    },
  );

  app.get<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/execution',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const workItemId = workItemIdSchema.safeParse(request.params.workItemId);
      if (!workspaceId.success || !workItemId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const result = await executionService.workItemExecution(
        context,
        workspaceId.data,
        workItemId.data,
        request.id,
      );
      return noStore(reply).send(
        workItemExecutionResponseSchema.parse({
          workItemId: workItemId.data,
          worktrees: result.worktrees,
          runs: result.runs.map(runSummary),
          mergeGates: result.mergeGates,
        }),
      );
    },
  );

  // List rows omit the outcome summary (most of the body, and no list shows it);
  // `?status=live` returns only the runs the dashboard shows.
  app.get<{ Params: { workspaceId: string }; Querystring: { status?: string } }>(
    '/api/workspaces/:workspaceId/runs',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const status = request.query.status;
      if (status !== undefined && status !== 'live') {
        return sendApiError(reply, 400, 'invalid-request', 'Unsupported run status filter');
      }
      const result = executionService.listRuns(context, workspaceId.data, request.id, {
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

  app.post<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/worktrees',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const workItemId = workItemIdSchema.safeParse(request.params.workItemId);
      if (!workspaceId.success || !workItemId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const body = createWorktreeRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid worktree request');
      }
      const worktree = await executionService.createWorktree(
        context,
        workspaceId.data,
        workItemId.data,
        body.data,
        request.id,
      );
      return noStore(reply).send(createWorktreeResponseSchema.parse({ worktree }));
    },
  );

  app.post<{ Params: { workspaceId: string; worktreeId: string } }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/remove',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const worktreeId = worktreeIdSchema.safeParse(request.params.worktreeId);
      if (!workspaceId.success || !worktreeId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      if (!removeWorktreeRequestSchema.safeParse(request.body ?? {}).success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid request');
      }
      const result = await executionService.removeWorktree(
        context,
        workspaceId.data,
        worktreeId.data,
        request.id,
      );
      return noStore(reply).send(removeWorktreeResponseSchema.parse(result));
    },
  );

  /**
   * The one merge route. It carries no arguments: the daemon decides the
   * target branch and refuses unless the worktree's latest run is a review
   * with a mergeable verdict (the pull-request rule).
   */
  app.post<{ Params: { workspaceId: string; worktreeId: string } }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/merge',
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const worktreeId = worktreeIdSchema.safeParse(request.params.worktreeId);
      if (!workspaceId.success || !worktreeId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const body = mergeWorktreeRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid merge request');
      }
      const result = await executionService.mergeWorktree(
        context,
        workspaceId.data,
        worktreeId.data,
        body.data,
        request.id,
      );
      return noStore(reply).send(mergeWorktreeResponseSchema.parse(result));
    },
  );

  app.get<{ Params: { workspaceId: string; worktreeId: string } }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/diff',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const worktreeId = worktreeIdSchema.safeParse(request.params.worktreeId);
      if (!workspaceId.success || !worktreeId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const { worktree, diff } = await executionService.worktreeDiff(
        context,
        workspaceId.data,
        worktreeId.data,
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
