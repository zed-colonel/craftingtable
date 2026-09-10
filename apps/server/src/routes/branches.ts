import {
  createWorktreeResponseSchema,
  planBranchSettingsResponseSchema,
  planVersionIdSchema,
  recordIntegrationEvidenceRequestSchema,
  retargetWorktreeRequestSchema,
  savePlanBranchSettingsRequestSchema,
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
  app.get<{ Params: { workspaceId: string; planVersionId: string } }>(
    '/api/workspaces/:workspaceId/plan-versions/:planVersionId/branch-settings',
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
