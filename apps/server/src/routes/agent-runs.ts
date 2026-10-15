import {
  agentRunCommandResponseSchema,
  agentRunControlRequestSchema,
  agentRunDetailResponseSchema,
  agentRunIdSchema,
  authenticationExpiredEventSchema,
  runEventEnvelopeSchema,
  runEventPageResponseSchema,
  SSE_AUTHENTICATION_EXPIRED_EVENT_NAME,
  SSE_RUN_EVENT_NAME,
  startAgentRunRequestSchema,
  startAgentRunResponseSchema,
  workItemIdSchema,
  toolResultDigestSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import { type ServerConfig, sessionCookieName } from '../config.js';
import { isAllowedBrowserRequest } from '../security/origin-policy.js';
import type { AgentRunService } from '../services/agent-run-service.js';
import { ForbiddenError } from '../services/errors.js';
import type { RunEventStreamService } from '../services/run-event-stream-service.js';
import { parseEventCursor, selectEventCursor } from '../services/workspace-event-stream-service.js';
import type { WorkspaceService } from '../services/workspace-service.js';
import { eventStreamHeaders } from './browser-security.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf, workspaceParams, paramsOf } from './route-access.js';
import { runDetail, runSummary } from './run-summary.js';

/** Each route's path parameters (R-H7). */
const WORK_ITEM = workspaceParams({ workItemId: workItemIdSchema });
const RUN = workspaceParams({ runId: agentRunIdSchema });
const RUN_DIGEST = workspaceParams({ runId: agentRunIdSchema, digest: toolResultDigestSchema });

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

  app.post<{
    Body: BodyOf<typeof startAgentRunRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/work-items/:workItemId/runs',
    {
      config: {
        access: 'editor',
        params: WORK_ITEM,
        tag: 'control',
        body: startAgentRunRequestSchema,
        invalidBody: 'Invalid run request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, workItemId } = paramsOf(request, WORK_ITEM);
      const run = await agentRunService.start(
        context,
        workspaceId,
        workItemId,
        request.body,
        request.id,
      );
      return noStore(reply).send(startAgentRunResponseSchema.parse({ run: runSummary(run) }));
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/runs/:runId',
    { config: { access: 'member', params: RUN } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, runId } = paramsOf(request, RUN);
      const detail = agentRunService.detail(context, workspaceId, runId, request.id);
      return noStore(reply).send(agentRunDetailResponseSchema.parse(runDetail(detail)));
    },
  );

  // The full output of a tool result the journal keeps as a preview (R-H2). Plain text, so
  // the browser shows it as-is; 404 once it expires with the run's scratch retention.
  app.get(
    '/api/workspaces/:workspaceId/runs/:runId/tool-results/:digest',
    { config: { access: 'member', params: RUN_DIGEST } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, runId, digest } = paramsOf(request, RUN_DIGEST);
      const body = agentRunService.toolResult(context, workspaceId, runId, digest, request.id);
      return noStore(reply)
        .header('content-type', 'text/plain; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .send(body);
    },
  );

  // `?includeRaw=true` is the explicit diagnostics read of the retained vendor lines.
  app.get<{
    Querystring: { after?: string; includeRaw?: string };
  }>(
    '/api/workspaces/:workspaceId/runs/:runId/event-page',
    { config: { access: 'member', params: RUN } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, runId } = paramsOf(request, RUN);
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
        workspaceId,
        runId,
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

  // A run's manual commands share one route (R-H5, H5-2): the same access, none carries authority.
  app.post<{
    Body: BodyOf<typeof agentRunControlRequestSchema>;
  }>(
    '/api/workspaces/:workspaceId/runs/:runId/control',
    {
      config: {
        access: 'editor',
        params: RUN,
        tag: 'control',
        body: agentRunControlRequestSchema,
        invalidBody: 'Invalid run command',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, runId } = paramsOf(request, RUN);
      const body = request.body;
      const result =
        body.action === 'message'
          ? agentRunService.sendMessage(context, workspaceId, runId, body.text, request.id)
          : body.action === 'end'
            ? agentRunService.end(context, workspaceId, runId, request.id)
            : agentRunService.cancel(context, workspaceId, runId, request.id);
      return noStore(reply).send(
        agentRunCommandResponseSchema.parse({
          run: runSummary(result.run),
          accepted: result.accepted,
        }),
      );
    },
  );

  app.get<{ Querystring: { after?: string } }>(
    '/api/workspaces/:workspaceId/runs/:runId/events',
    {
      config: { access: 'member', params: RUN },
      // The stream's origin check runs after the access check and before a run id that does not
      // parse is refused, as it did in the handler (R-H7): route hooks follow the daemon's own.
      preParsing: async (request) => {
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
      },
    },
    (request, reply) => {
      const rawSessionToken = request.cookies[sessionCookieName(config)];
      const context = contextOf(request);
      const { workspaceId, runId } = paramsOf(request, RUN);
      let cursor: number;
      try {
        cursor = selectEventCursor(request.query.after, request.headers['last-event-id']);
      } catch {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid event cursor');
      }
      workspaceService.requireAuthorized(context, workspaceId, request.id);
      // Proves the run exists in this workspace before hijacking the reply.
      agentRunService.detail(context, workspaceId, runId, request.id);
      if (rawSessionToken === undefined) {
        return sendApiError(reply, 401, 'unauthenticated', 'Authentication required');
      }

      const controller = new AbortController();
      activeStreams.add(controller);
      reply.hijack();
      reply.raw.writeHead(200, eventStreamHeaders());
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
            workspaceId,
            runId,
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
