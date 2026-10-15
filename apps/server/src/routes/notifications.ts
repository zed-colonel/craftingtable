import {
  notificationStatusSchema,
  saveNotificationsRequestSchema,
  testNotificationsRequestSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { NotificationService } from '../services/notification-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf, WORKSPACE_PARAMS } from './route-access.js';
export function registerNotificationRoutes(
  app: FastifyInstance,
  notifications: NotificationService,
): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/notifications',
    { config: { access: 'owner', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.get(context, workspace.data)),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string };
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
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.save(context, workspace.data, request.body)),
      );
    },
  );
  app.post<{
    Params: { workspaceId: string };
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
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.test(context, workspace.data)),
      );
    },
  );
}
