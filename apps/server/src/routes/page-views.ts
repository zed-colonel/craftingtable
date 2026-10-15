import {
  agentRunIdSchema,
  runViewSchema,
  workItemIdSchema,
  workItemViewSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { PageViews } from '../services/page-views.js';
import { noStore } from './http.js';
import { contextOf, workspaceParams, paramsOf } from './route-access.js';
import { runDetail, runSummary } from './run-summary.js';

/** Each route's path parameters (R-H7). */
const WORK_ITEM = workspaceParams({ workItemId: workItemIdSchema });
const RUN = workspaceParams({ runId: agentRunIdSchema });

/** One read per page region (R-D5, PERF-14). */
export function registerPageViewRoutes(app: FastifyInstance, views: PageViews): void {
  app.get(
    '/api/workspaces/:workspaceId/work-items/:workItemId/view',
    { config: { access: 'member', params: WORK_ITEM } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, workItemId } = paramsOf(request, WORK_ITEM);
      const view = await views.workItem(context, workspaceId, workItemId, request.id, (part, err) =>
        request.log.error({ err, part }, 'A work item view part could not be read'),
      );
      return noStore(reply).send(
        workItemViewSchema.parse({
          ...view,
          execution: {
            workItemId,
            worktrees: view.execution.worktrees,
            runs: view.execution.runs.map(runSummary),
            mergeGates: view.execution.mergeGates,
          },
        }),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/runs/:runId/view',
    { config: { access: 'member', params: RUN } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, runId } = paramsOf(request, RUN);
      const view = views.run(context, workspaceId, runId, request.id);
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
