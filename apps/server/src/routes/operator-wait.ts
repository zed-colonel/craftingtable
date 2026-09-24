import { operatorWaitReportSchema, workspaceIdSchema } from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import type { OperatorWaitService } from '../services/operator-wait-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate } from './request-security.js';

export function registerOperatorWaitRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: OperatorWaitService,
) {
  app.get<{ Params: { workspaceId: string }; Querystring: { days?: string } }>(
    '/api/workspaces/:workspaceId/operator-wait',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth);
      const id = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!id.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      const days = request.query.days === undefined ? 7 : Number(request.query.days);
      if (!Number.isInteger(days) || days < 1 || days > 30)
        return sendApiError(reply, 400, 'invalid-request', 'days must be an integer from 1 to 30.');
      return noStore(reply).send(
        operatorWaitReportSchema.parse(service.report(context, id.data, days)),
      );
    },
  );
}
