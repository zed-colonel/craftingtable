import {
  createWorktreeResponseSchema,
  gitBranchNameSchema,
  planBranchSettingsResponseSchema,
  planVersionIdSchema,
  recordIntegrationEvidenceRequestSchema,
  repositoryPolicyEvidenceSchema,
  retargetWorktreeRequestSchema,
  savePlanBranchSettingsRequestSchema,
  saveRepositoryPolicyRequestSchema,
  updateWorktreeRequestSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeBranchStatusResponseSchema,
  worktreeIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { BranchService } from '../services/branch-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';

export function registerBranchRoutes(
  app: FastifyInstance,
  auth: AuthService,
  branches: BranchService,
  config: ServerConfig,
) {
  app.get<{
    Params: { workspaceId: string; planVersionId: string };
    Querystring: { freezeBranch?: string };
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      const freeze = gitBranchNameSchema.optional().safeParse(request.query.freezeBranch);
      if (!ws.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Plan not found');
      if (!freeze.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid freeze branch');
      return noStore(reply).send(
        repositoryPolicyEvidenceSchema.parse(
          await branches.policyPreview(context, ws.data, plan.data, freeze.data),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      const input = saveRepositoryPolicyRequestSchema.safeParse(request.body);
      if (!ws.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Plan not found');
      if (!input.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid repository policy');
      return noStore(reply).send(
        repositoryPolicyEvidenceSchema.parse(
          await branches.savePolicy(context, ws.data, plan.data, input.data),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      if (!ws.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      return noStore(reply).send(
        planBranchSettingsResponseSchema.parse(
          await branches.settings(context, ws.data, plan.data),
        ),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      if (!ws.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      const body = savePlanBranchSettingsRequestSchema.safeParse(request.body);
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid branch settings');
      return noStore(reply).send(
        planBranchSettingsResponseSchema.parse(
          await branches.save(context, ws.data, plan.data, body.data),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; worktreeId: string } }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/branch-status',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const wt = worktreeIdSchema.safeParse(request.params.worktreeId);
      if (!ws.success || !wt.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      return noStore(reply).send(
        worktreeBranchStatusResponseSchema.parse(await branches.status(context, ws.data, wt.data)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/integration-evidence',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const item = workItemIdSchema.safeParse(request.params.workItemId);
      if (!ws.success || !item.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      const body = recordIntegrationEvidenceRequestSchema.safeParse(request.body);
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid integration evidence');
      return noStore(reply).send(
        planBranchSettingsResponseSchema.parse(
          await branches.recordEvidence(context, ws.data, item.data, body.data.commitSha),
        ),
      );
    },
  );
  for (const action of ['retarget', 'update'] as const) {
    app.post<{ Params: { workspaceId: string; worktreeId: string } }>(
      `/api/workspaces/:workspaceId/worktrees/:worktreeId/${action}`,
      { config: { access: 'editor' } },
      async (request, reply) => {
        const context = authorizeMutation(request, auth, config);
        const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
        const wt = worktreeIdSchema.safeParse(request.params.worktreeId);
        if (!ws.success || !wt.success)
          return sendApiError(reply, 404, 'not-found', 'Resource not found');
        const body = (
          action === 'update' ? updateWorktreeRequestSchema : retargetWorktreeRequestSchema
        ).safeParse(request.body);
        if (!body.success)
          return sendApiError(reply, 400, 'invalid-request', 'Invalid worktree branch request');
        return noStore(reply).send(
          createWorktreeResponseSchema.parse(
            await branches.changeWorktree(
              context,
              ws.data,
              wt.data,
              body.data,
              action === 'update',
            ),
          ),
        );
      },
    );
  }
}
