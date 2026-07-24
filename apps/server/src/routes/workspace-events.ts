import {
  authenticationExpiredEventSchema,
  SSE_AUTHENTICATION_EXPIRED_EVENT_NAME,
  SSE_WORKSPACE_EVENT_NAME,
  workspaceEventEnvelopeSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE_NAME, type ServerConfig } from '../config.js';
import { isAllowedBrowserRequest } from '../security/origin-policy.js';
import type { AuthService } from '../services/auth-service.js';
import { ForbiddenError } from '../services/errors.js';
import {
  selectEventCursor,
  type WorkspaceEventStreamService,
} from '../services/workspace-event-stream-service.js';
import type { WorkspaceService } from '../services/workspace-service.js';
import { sendApiError } from './http.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

export function registerWorkspaceEventRoute(
  app: FastifyInstance,
  authService: AuthService,
  workspaceService: WorkspaceService,
  streamService: WorkspaceEventStreamService,
  config: ServerConfig,
): void {
  const activeStreams = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();

  app.addHook('onClose', async () => {
    for (const controller of activeStreams) {
      controller.abort();
    }
    await Promise.allSettled([...tasks]);
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { after?: string };
  }>('/api/workspaces/:workspaceId/events', (request, reply) => {
    const rawSessionToken = request.cookies[SESSION_COOKIE_NAME];
    const context = authService.authenticate(rawSessionToken);
    if (
      !isAllowedBrowserRequest(
        {
          ...(typeof request.headers.origin === 'string' ? { origin: request.headers.origin } : {}),
          ...(typeof request.headers['sec-fetch-site'] === 'string'
            ? { secFetchSite: request.headers['sec-fetch-site'] }
            : {}),
        },
        config.publicOrigin,
      )
    ) {
      throw new ForbiddenError();
    }
    const parsedWorkspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
    if (!parsedWorkspaceId.success) {
      return sendApiError(reply, 404, 'not-found', 'Resource not found');
    }
    let cursor: number;
    try {
      cursor = selectEventCursor(request.query.after, request.headers['last-event-id']);
    } catch {
      return sendApiError(reply, 400, 'invalid-request', 'Invalid event cursor');
    }
    workspaceService.requireAuthorized(context, parsedWorkspaceId.data, request.id);
    if (rawSessionToken === undefined) {
      return sendApiError(reply, 401, 'unauthenticated', 'Authentication required');
    }

    const controller = new AbortController();
    activeStreams.add(controller);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 1000\n:connected\n\n');
    const heartbeat = setInterval(() => {
      reply.raw.write(':hb\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(heartbeat);
      activeStreams.delete(controller);
      controller.abort();
      reply.raw.end();
    };
    request.raw.on('close', finish);

    const task = (async () => {
      try {
        for await (const item of streamService.stream({
          rawSessionToken,
          workspaceId: parsedWorkspaceId.data,
          after: cursor,
          signal: controller.signal,
        })) {
          if (item.type === 'authentication-expired') {
            const data = authenticationExpiredEventSchema.parse({
              reason: 'session-invalid',
            });
            reply.raw.write(
              `event: ${SSE_AUTHENTICATION_EXPIRED_EVENT_NAME}\ndata: ${JSON.stringify(data)}\n\n`,
            );
            return;
          }
          const event = workspaceEventEnvelopeSchema.parse(item.event);
          const writable = reply.raw.write(
            `event: ${SSE_WORKSPACE_EVENT_NAME}\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          if (!writable && reply.raw.writableEnded) {
            return;
          }
        }
      } catch (error) {
        request.log.error(
          { err: { name: error instanceof Error ? error.name : 'Error' } },
          'workspace event stream failed',
        );
      } finally {
        finish();
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
}
