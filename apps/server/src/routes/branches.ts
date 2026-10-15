import {
  gitBranchNameSchema,
  planBranchSettingsResponseSchema,
  planVersionIdSchema,
  recordIntegrationEvidenceRequestSchema,
  repositoryPolicyEvidenceSchema,
  savePlanBranchSettingsRequestSchema,
  saveRepositoryPolicyRequestSchema,
  workItemIdSchema,
  worktreeBranchStatusResponseSchema,
  worktreeIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { BranchService } from '../services/branch-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf, workspaceParams, paramsOf } from './route-access.js';

/** Each route's path parameters (R-H7). */
const PLAN_VERSION = workspaceParams({ planVersionId: planVersionIdSchema });
const WORKTREE = workspaceParams({ worktreeId: worktreeIdSchema });
const WORK_ITEM = workspaceParams({ workItemId: workItemIdSchema });

export function registerBranchRoutes(app: FastifyInstance, branches: BranchService) {
  app.get<{
    Querystring: { freezeBranch?: string };
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy',
    { config: { access: 'member', params: PLAN_VERSION, notFound: 'Plan not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, planVersionId } = paramsOf(request, PLAN_VERSION);
      const freeze = gitBranchNameSchema.optional().safeParse(request.query.freezeBranch);
      if (!freeze.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid freeze branch');
      return noStore(reply).send(
        repositoryPolicyEvidenceSchema.parse(
          await branches.policyPreview(context, workspaceId, planVersionId, freeze.data),
        ),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof saveRepositoryPolicyRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/repository-policy',
    {
      config: {
        access: 'editor',
        params: PLAN_VERSION,
        notFound: 'Plan not found',
        tag: 'config',
        body: saveRepositoryPolicyRequestSchema,
        invalidBody: 'Invalid repository policy',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, planVersionId } = paramsOf(request, PLAN_VERSION);
      return noStore(reply).send(
        repositoryPolicyEvidenceSchema.parse(
          await branches.savePolicy(context, workspaceId, planVersionId, request.body),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
    { config: { access: 'member', params: PLAN_VERSION } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, planVersionId } = paramsOf(request, PLAN_VERSION);
      return noStore(reply).send(
        planBranchSettingsResponseSchema.parse(
          await branches.settings(context, workspaceId, planVersionId),
        ),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof savePlanBranchSettingsRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
    {
      config: {
        access: 'editor',
        params: PLAN_VERSION,
        tag: 'config',
        body: savePlanBranchSettingsRequestSchema,
        invalidBody: 'Invalid branch settings',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, planVersionId } = paramsOf(request, PLAN_VERSION);
      return noStore(reply).send(
        planBranchSettingsResponseSchema.parse(
          await branches.save(context, workspaceId, planVersionId, request.body),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/branch-status',
    { config: { access: 'member', params: WORKTREE } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, worktreeId } = paramsOf(request, WORKTREE);
      return noStore(reply).send(
        worktreeBranchStatusResponseSchema.parse(
          await branches.status(context, workspaceId, worktreeId),
        ),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof recordIntegrationEvidenceRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/integration-evidence',
    {
      config: {
        access: 'editor',
        params: WORK_ITEM,
        tag: 'control',
        body: recordIntegrationEvidenceRequestSchema,
        invalidBody: 'Invalid integration evidence',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, workItemId } = paramsOf(request, WORK_ITEM);
      return noStore(reply).send(
        planBranchSettingsResponseSchema.parse(
          await branches.recordEvidence(context, workspaceId, workItemId, request.body.commitSha),
        ),
      );
    },
  );
}
