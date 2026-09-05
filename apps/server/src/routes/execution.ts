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
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
import { runSummary } from './run-summary.js';

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
  app.get('/api/execution-status', async (request, reply) => {
    authenticate(request, authService);
    void agentRunService;
    return noStore(reply).send(executionStatusResponseSchema.parse(status()));
  });

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
      const result = executionService.workItemExecution(
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

  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/runs',
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspaceId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const result = executionService.listRuns(context, workspaceId.data, request.id);
      return noStore(reply).send(
        workspaceRunsResponseSchema.parse({
          runs: result.runs.map((entry) => ({
            ...runSummary(entry.run),
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
