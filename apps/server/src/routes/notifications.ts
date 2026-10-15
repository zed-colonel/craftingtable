import {
  notificationStatusSchema,
  saveNotificationsRequestSchema,
  testNotificationsRequestSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { NotificationService } from '../services/notification-service.js';
import { noStore } from './http.js';
import { type BodyOf, contextOf, paramsOf, WORKSPACE_PARAMS } from './route-access.js';
export function registerNotificationRoutes(
  app: FastifyInstance,
  notifications: NotificationService,
): void {
  app.get(
    '/api/workspaces/:workspaceId/notifications',
    { config: { access: 'owner', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.get(context, workspaceId)),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof saveNotificationsRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/notifications',
    {
      config: {
        access: 'owner',
        params: WORKSPACE_PARAMS,
        tag: 'config',
        body: saveNotificationsRequestSchema,
        invalidBody: 'Invalid notification settings',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.save(context, workspaceId, request.body)),
      );
    },
  );
  app.post<{
    Body: BodyOf<typeof testNotificationsRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/notifications/test',
    {
      config: {
        access: 'owner',
        params: WORKSPACE_PARAMS,
        tag: 'control',
        body: testNotificationsRequestSchema,
        invalidBody: 'Invalid test request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId } = paramsOf(request, WORKSPACE_PARAMS);
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.test(context, workspaceId)),
      );
    },
  );
}
