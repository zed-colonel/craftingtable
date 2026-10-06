import {
  agentRunCommandResponseSchema,
  agentRunDetailResponseSchema,
  agentRunIdSchema,
  authenticationExpiredEventSchema,
  cancelAgentRunRequestSchema,
  endAgentRunRequestSchema,
  runEventEnvelopeSchema,
  runEventPageResponseSchema,
  SSE_AUTHENTICATION_EXPIRED_EVENT_NAME,
  SSE_RUN_EVENT_NAME,
  sendAgentRunMessageRequestSchema,
  startAgentRunRequestSchema,
  startAgentRunResponseSchema,
  workItemIdSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE_NAME, type ServerConfig } from '../config.js';
import { isAllowedBrowserRequest } from '../security/origin-policy.js';
import type { AgentRunService } from '../services/agent-run-service.js';
import type { AuthService } from '../services/auth-service.js';
import { ForbiddenError } from '../services/errors.js';
import type { RunEventStreamService } from '../services/run-event-stream-service.js';
import { parseEventCursor, selectEventCursor } from '../services/workspace-event-stream-service.js';
import type { WorkspaceService } from '../services/workspace-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
import { runDetail, runSummary } from './run-summary.js';

const HEARTBEAT_INTERVAL_MS = 15_000;
const EVENT_PAGE_LIMIT = 500;

/**
 * The browser never reads the retained vendor line, and it is more than half
 * of a run's bytes (PERF-11, AGT-03, DATA-01). It stays in the journal for
 * diagnostics and is sent only when explicitly requested.
 */
function withoutRaw<T extends { readonly raw?: string }>(event: T): Omit<T, 'raw'> {
  const { raw: _raw, ...rest } = event;
  return rest;
}

/**
 * Agent run routes: start, steer, stop, inspect, and follow live.
 *
 * The browser never sends a shell command. It sends a work item, a role, a
 * permission posture, and free text that becomes a user message to the agent.
 */
export function registerAgentRunRoutes(
  app: FastifyInstance,
  authService: AuthService,
  workspaceService: WorkspaceService,
  agentRunService: AgentRunService,
  streamService: RunEventStreamService,
  config: ServerConfig,
): void {
  const activeStreams = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();

  app.addHook('onClose', async () => {
    for (const controller of activeStreams) {
      controller.abort();
    }
    await Promise.allSettled([...tasks]);
    await agentRunService.shutdown();
  });

  app.post<{ Params: { workspaceId: string; workItemId: string } }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/runs',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const workItemId = workItemIdSchema.safeParse(request.params.workItemId);
      if (!workspaceId.success || !workItemId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const body = startAgentRunRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid run request');
      }
      const run = await agentRunService.start(
        context,
        workspaceId.data,
        workItemId.data,
        body.data,
        request.id,
      );
      return noStore(reply).send(startAgentRunResponseSchema.parse({ run: runSummary(run) }));
    },
  );

  app.get<{ Params: { workspaceId: string; runId: string } }>(
    '/api/workspaces/:workspaceId/runs/:runId',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const runId = agentRunIdSchema.safeParse(request.params.runId);
      if (!workspaceId.success || !runId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const detail = agentRunService.detail(context, workspaceId.data, runId.data, request.id);
      return noStore(reply).send(agentRunDetailResponseSchema.parse(runDetail(detail)));
    },
  );

  // The full output of a tool result the journal keeps as a preview (R-H2). Plain text, so
  // the browser shows it as-is; 404 once it expires with the run's scratch retention.
  app.get<{ Params: { workspaceId: string; runId: string; digest: string } }>(
    '/api/workspaces/:workspaceId/runs/:runId/tool-results/:digest',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const runId = agentRunIdSchema.safeParse(request.params.runId);
      if (!workspaceId.success || !runId.success || !/^[a-f0-9]{64}$/.test(request.params.digest)) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const body = agentRunService.toolResult(
        context,
        workspaceId.data,
        runId.data,
        request.params.digest,
        request.id,
      );
      return noStore(reply)
        .header('content-type', 'text/plain; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .send(body);
    },
  );

  // `?includeRaw=true` is the explicit diagnostics read of the retained vendor lines.
  app.get<{
    Params: { workspaceId: string; runId: string };
    Querystring: { after?: string; includeRaw?: string };
  }>(
    '/api/workspaces/:workspaceId/runs/:runId/event-page',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, authService);
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const runId = agentRunIdSchema.safeParse(request.params.runId);
      if (!workspaceId.success || !runId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      let after: number;
      try {
        after = parseEventCursor(request.query.after, 'after') ?? 0;
      } catch {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid event cursor');
      }
      const includeRaw = request.query.includeRaw;
      if (includeRaw !== undefined && includeRaw !== 'true' && includeRaw !== 'false') {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid raw-line option');
      }
      const events = agentRunService.listEvents(
        context,
        workspaceId.data,
        runId.data,
        after,
        EVENT_PAGE_LIMIT,
        request.id,
      );
      return noStore(reply).send(
        runEventPageResponseSchema.parse({
          events: includeRaw === 'true' ? events : events.map(withoutRaw),
          nextAfter: events.at(-1)?.sequence ?? after,
        }),
      );
    },
  );

  for (const [action, schema, handler] of [
    ['messages', sendAgentRunMessageRequestSchema, 'message'],
    ['end', endAgentRunRequestSchema, 'end'],
    ['cancel', cancelAgentRunRequestSchema, 'cancel'],
  ] as const) {
    app.post<{ Params: { workspaceId: string; runId: string } }>(
      `/api/workspaces/:workspaceId/runs/:runId/${action}`,
      { config: { access: 'editor' } },
      async (request, reply) => {
        const context = authorizeMutation(request, authService, config);
        const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
        const runId = agentRunIdSchema.safeParse(request.params.runId);
        if (!workspaceId.success || !runId.success) {
          return sendApiError(reply, 404, 'not-found', 'Resource not found');
        }
        const body = schema.safeParse(request.body ?? {});
        if (!body.success) {
          return sendApiError(reply, 400, 'invalid-request', 'Invalid run command');
        }
        const result =
          handler === 'message'
            ? agentRunService.sendMessage(
                context,
                workspaceId.data,
                runId.data,
                (body.data as { text: string }).text,
                request.id,
              )
            : handler === 'end'
              ? agentRunService.end(context, workspaceId.data, runId.data, request.id)
              : agentRunService.cancel(context, workspaceId.data, runId.data, request.id);
        return noStore(reply).send(
          agentRunCommandResponseSchema.parse({
            run: runSummary(result.run),
            accepted: result.accepted,
          }),
        );
      },
    );
  }

  app.get<{ Params: { workspaceId: string; runId: string }; Querystring: { after?: string } }>(
    '/api/workspaces/:workspaceId/runs/:runId/events',
    { config: { access: 'member' } },
    (request, reply) => {
      const rawSessionToken = request.cookies[SESSION_COOKIE_NAME];
      const context = authService.authenticate(rawSessionToken);
      if (
        !isAllowedBrowserRequest(
          {
            ...(typeof request.headers.origin === 'string'
              ? { origin: request.headers.origin }
              : {}),
            ...(typeof request.headers['sec-fetch-site'] === 'string'
              ? { secFetchSite: request.headers['sec-fetch-site'] }
              : {}),
          },
          config.publicOrigin,
        )
      ) {
        throw new ForbiddenError();
      }
      const workspaceId = workspaceIdSchema.safeParse(request.params.workspaceId);
      const runId = agentRunIdSchema.safeParse(request.params.runId);
      if (!workspaceId.success || !runId.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      let cursor: number;
      try {
        cursor = selectEventCursor(request.query.after, request.headers['last-event-id']);
      } catch {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid event cursor');
      }
      workspaceService.requireAuthorized(context, workspaceId.data, request.id);
      // Proves the run exists in this workspace before hijacking the reply.
      agentRunService.detail(context, workspaceId.data, runId.data, request.id);
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
            workspaceId: workspaceId.data,
            runId: runId.data,
            after: cursor,
            signal: controller.signal,
          })) {
            if (item.type === 'authentication-expired') {
              const data = authenticationExpiredEventSchema.parse({ reason: 'session-invalid' });
              reply.raw.write(
                `event: ${SSE_AUTHENTICATION_EXPIRED_EVENT_NAME}\ndata: ${JSON.stringify(data)}\n\n`,
              );
              return;
            }
            const event = runEventEnvelopeSchema.parse(withoutRaw(item.event));
            const writable = reply.raw.write(
              `event: ${SSE_RUN_EVENT_NAME}\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            if (!writable && reply.raw.writableEnded) {
              return;
            }
          }
        } catch (error) {
          request.log.error(
            { err: { name: error instanceof Error ? error.name : 'Error' } },
            'run event stream failed',
          );
        } finally {
          finish();
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    },
  );
}
