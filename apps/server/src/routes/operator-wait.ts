import { operatorWaitReportSchema } from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { OperatorWaitService } from '../services/operator-wait-service.js';
import { noStore, sendApiError } from './http.js';
import { contextOf, paramsOf, WORKSPACE_PARAMS } from './route-access.js';

export function registerOperatorWaitRoutes(app: FastifyInstance, service: OperatorWaitService) {
  app.get<{ Querystring: { days?: string } }>(
    '/api/workspaces/:workspaceId/operator-wait',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      const days = request.query.days === undefined ? 7 : Number(request.query.days);
      if (!Number.isInteger(days) || days < 1 || days > 30)
        return sendApiError(reply, 400, 'invalid-request', 'days must be an integer from 1 to 30.');
      return noStore(reply).send(
        operatorWaitReportSchema.parse(service.report(context, workspaceId, days)),
      );
    },
  );
}
