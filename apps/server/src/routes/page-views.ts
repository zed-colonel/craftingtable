import {
  agentRunIdSchema,
  runViewSchema,
  workItemIdSchema,
  workItemViewSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { PageViews } from '../services/page-views.js';
import { noStore, sendApiError } from './http.js';
import { contextOf } from './route-access.js';
import { runDetail, runSummary } from './run-summary.js';

/** One read per page region (R-D5, PERF-14). */
export function registerPageViewRoutes(app: FastifyInstance, views: PageViews): void {
  app.get<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/view',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const workItemId = workItemIdSchema.safeParse(request.params.workItemId);
      if (!workspaceId.success || !workItemId.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      const view = await views.workItem(
        context,
        workspaceId.data,
        workItemId.data,
        request.id,
        (part, err) => request.log.error({ err, part }, 'A work item view part could not be read'),
      );
      return noStore(reply).send(
        workItemViewSchema.parse({
          ...view,
          execution: {
            workItemId: workItemId.data,
            worktrees: view.execution.worktrees,
            runs: view.execution.runs.map(runSummary),
            mergeGates: view.execution.mergeGates,
          },
        }),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; runId: string } }>(
    '/api/workspaces/:workspaceId/runs/:runId/view',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const runId = agentRunIdSchema.safeParse(request.params.runId);
      if (!workspaceId.success || !runId.success)
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      const view = views.run(context, workspaceId.data, runId.data, request.id);
      return noStore(reply).send(
        runViewSchema.parse({
          ...view,
          detail: runDetail(view.detail),
          runs: view.runs.map(runSummary),
        }),
      );
    },
  );
}
