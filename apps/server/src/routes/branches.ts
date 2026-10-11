import {
  gitBranchNameSchema,
  planBranchSettingsResponseSchema,
  planVersionIdSchema,
  recordIntegrationEvidenceRequestSchema,
  repositoryPolicyEvidenceSchema,
  savePlanBranchSettingsRequestSchema,
  saveRepositoryPolicyRequestSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeBranchStatusResponseSchema,
  worktreeIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { BranchService } from '../services/branch-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf } from './route-access.js';

export function registerBranchRoutes(app: FastifyInstance, branches: BranchService) {
  app.get<{
    Params: { workspaceId: string; planVersionId: string };
    Querystring: { freezeBranch?: string };
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
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
  app.post<{
    Params: { workspaceId: string; planVersionId: string };
    Body: BodyOf<typeof saveRepositoryPolicyRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy',
    {
      config: {
        access: 'editor',
        tag: 'config',
        body: saveRepositoryPolicyRequestSchema,
        invalidBody: 'Invalid repository policy',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      if (!ws.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Plan not found');
      return noStore(reply).send(
        repositoryPolicyEvidenceSchema.parse(
          await branches.savePolicy(context, ws.data, plan.data, request.body),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
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
  app.post<{
    Params: { workspaceId: string; planVersionId: string };
    Body: BodyOf<typeof savePlanBranchSettingsRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
    {
      config: {
        access: 'editor',
        tag: 'config',
        body: savePlanBranchSettingsRequestSchema,
        invalidBody: 'Invalid branch settings',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const plan = planVersionIdSchema.safeParse(request.params.planVersionId);
      if (!ws.success || !plan.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      return noStore(reply).send(
        planBranchSettingsResponseSchema.parse(
          await branches.save(context, ws.data, plan.data, request.body),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; worktreeId: string } }>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/branch-status',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const wt = worktreeIdSchema.safeParse(request.params.worktreeId);
      if (!ws.success || !wt.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      return noStore(reply).send(
        worktreeBranchStatusResponseSchema.parse(await branches.status(context, ws.data, wt.data)),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string; workItemId: string };
    Body: BodyOf<typeof recordIntegrationEvidenceRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/integration-evidence',
    {
      config: {
        access: 'editor',
        tag: 'control',
        body: recordIntegrationEvidenceRequestSchema,
        invalidBody: 'Invalid integration evidence',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const item = workItemIdSchema.safeParse(request.params.workItemId);
      if (!ws.success || !item.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      return noStore(reply).send(
        planBranchSettingsResponseSchema.parse(
          await branches.recordEvidence(context, ws.data, item.data, request.body.commitSha),
        ),
      );
    },
  );
}
