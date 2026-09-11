import {
  notificationStatusSchema,
  testNotificationsRequestSchema,
  saveNotificationsRequestSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { NotificationService } from '../services/notification-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
export function registerNotificationRoutes(
  app: FastifyInstance,
  auth: AuthService,
  notifications: NotificationService,
  config: ServerConfig,
): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/notifications',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        notificationStatusSchema.parse(notifications.get(context, workspace.data)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/notifications',
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
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
    async (request, reply) => {
      const context = authorizeMutation(request, auth, config);
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
