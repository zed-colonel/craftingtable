import {
  notificationStatusSchema,
  saveNotificationsRequestSchema,
  testNotificationsRequestSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { NotificationService } from '../services/notification-service.js';
import { noStore, sendApiError } from './http.js';
import { contextOf } from './route-access.js';
export function registerNotificationRoutes(
  app: FastifyInstance,
  notifications: NotificationService,
): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/notifications',
    { config: { access: 'owner' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.get(context, workspace.data)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/notifications',
    { config: { access: 'owner' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = saveNotificationsRequestSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid notification settings');
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.save(context, workspace.data, body.data)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/notifications/test',
    { config: { access: 'owner' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!testNotificationsRequestSchema.safeParse(request.body).success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid test request');
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.test(context, workspace.data)),
      );
    },
  );
}
