import { type IntervalHistogram, monitorEventLoopDelay } from 'node:perf_hooks';
import {
  type DaemonDiagnosticsResponse,
  daemonDiagnosticsResponseSchema,
  type EventLoopDelaySummary,
  type RouteTimingSummary,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import type { WorkspaceService } from '../services/workspace-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate } from './request-security.js';

/** Completed requests kept per route for percentiles; older ones are overwritten. */
const SAMPLES_PER_ROUTE = 512;
/** Rotation period of the recent event-loop delay window. */
const WINDOW_MS = 60_000;
/** Event-loop delay sampling resolution. */
const RESOLUTION_MS = 20;
/** Requests that matched no route share one entry, so arbitrary URLs cannot grow the table. */
const UNMATCHED_ROUTE = '(unmatched)';

function routeOf(request: FastifyRequest): string {
  return request.routeOptions.url ?? UNMATCHED_ROUTE;
}

/** Response body size as sent, when the reply declared it. */
function responseBytes(reply: FastifyReply): number | undefined {
  const header = reply.getHeader('content-length');
  const bytes = typeof header === 'string' ? Number(header) : header;
  return typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : undefined;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const round = (value: number): number => Math.round(value * 100) / 100;

class RouteSamples {
  count = 0;
  private readonly durations: number[] = [];
  private readonly bytes: number[] = [];

  add(durationMs: number, bytes: number): void {
    const slot = this.count % SAMPLES_PER_ROUTE;
    this.durations[slot] = durationMs;
    this.bytes[slot] = bytes;
    this.count += 1;
  }

  summary(method: string, route: string): RouteTimingSummary {
    const durations = this.durations.toSorted((a, b) => a - b);
    const totalBytes = this.bytes.reduce((sum, value) => sum + value, 0);
    return {
      method,
      route,
      count: this.count,
      sampled: durations.length,
      p50Ms: round(percentile(durations, 50)),
      p95Ms: round(percentile(durations, 95)),
      maxMs: round(durations.at(-1) ?? 0),
      meanBytes: round(this.bytes.length === 0 ? 0 : totalBytes / this.bytes.length),
      maxBytes: Math.max(0, ...this.bytes),
    };
  }
}

function delaySummary(histogram: IntervalHistogram, windowMs: number): EventLoopDelaySummary {
  const ms = (nanoseconds: number): number =>
    Number.isFinite(nanoseconds) ? round(nanoseconds / 1e6) : 0;
  const samples = histogram.count;
  return {
    windowMs: Math.round(windowMs),
    samples,
    meanMs: samples === 0 ? 0 : ms(histogram.mean),
    p50Ms: samples === 0 ? 0 : ms(histogram.percentile(50)),
    p95Ms: samples === 0 ? 0 : ms(histogram.percentile(95)),
    p99Ms: samples === 0 ? 0 : ms(histogram.percentile(99)),
    maxMs: samples === 0 ? 0 : ms(histogram.max),
  };
}

/**
 * Read-cost instrumentation for the daemon (R-D3, PERF-07, PERF-19).
 *
 * Browser reads and the controller share one event loop, so request cost and
 * event-loop delay are the two numbers that show whether UI load is slowing
 * automation. Both are kept in memory only, bounded, and reset on restart.
 */
export class DaemonDiagnostics {
  private readonly startedAt = performance.now();
  private readonly sinceStart = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  private readonly window = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  private windowStartedAt = performance.now();
  private lastMinute: EventLoopDelaySummary | undefined;
  private rotation: ReturnType<typeof setInterval> | undefined;
  private readonly routes = new Map<
    string,
    { method: string; route: string; samples: RouteSamples }
  >();

  start(): void {
    if (this.rotation !== undefined) return;
    this.sinceStart.enable();
    this.window.enable();
    this.windowStartedAt = performance.now();
    this.rotation = setInterval(() => this.rotate(), WINDOW_MS);
    this.rotation.unref();
  }

  stop(): void {
    clearInterval(this.rotation);
    this.rotation = undefined;
    this.sinceStart.disable();
    this.window.disable();
  }

  record(method: string, route: string, durationMs: number, bytes: number): void {
    const key = `${method} ${route}`;
    let entry = this.routes.get(key);
    if (entry === undefined) {
      entry = { method, route, samples: new RouteSamples() };
      this.routes.set(key, entry);
    }
    entry.samples.add(durationMs, bytes);
  }

  summary(): DaemonDiagnosticsResponse {
    return {
      time: new Date().toISOString(),
      uptimeMs: Math.round(performance.now() - this.startedAt),
      eventLoopDelay: {
        sinceStart: delaySummary(this.sinceStart, performance.now() - this.startedAt),
        ...(this.lastMinute === undefined ? {} : { lastMinute: this.lastMinute }),
      },
      routes: [...this.routes.values()]
        .map((entry) => entry.samples.summary(entry.method, entry.route))
        .toSorted((a, b) => b.p95Ms - a.p95Ms)
        .slice(0, 1000),
    };
  }

  private rotate(): void {
    const now = performance.now();
    this.lastMinute = delaySummary(this.window, now - this.windowStartedAt);
    this.window.reset();
    this.windowStartedAt = now;
  }
}

/**
 * Fastify's completion log line, extended with the matched route and the
 * response size, so one line per request carries route, status, duration and
 * bytes.
 */
export class RequestLogController extends LogController {
  override requestCompleted(
    error: Error | null,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) return;
    const details = {
      res: reply,
      responseTime: reply.elapsedTime,
      route: routeOf(request),
      bytes: responseBytes(reply),
    };
    if (error) reply.log.error({ ...details, err: error }, 'request errored');
    else reply.log.info(details, 'request completed');
  }
}

/**
 * Records every completed request and serves the owner-only diagnostics read.
 *
 * The daemon-wide numbers are exposed under a workspace the caller owns, so
 * the existing workspace authorization decides who may read them.
 */
export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  auth: AuthService,
  workspaces: WorkspaceService,
  diagnostics: DaemonDiagnostics,
): void {
  app.addHook('onReady', async () => diagnostics.start());
  app.addHook('onClose', async () => diagnostics.stop());
  app.addHook('onResponse', async (request, reply) => {
    diagnostics.record(
      request.method,
      routeOf(request),
      reply.elapsedTime,
      responseBytes(reply) ?? 0,
    );
  });
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/diagnostics',
    async (request, reply) => {
      const context = authenticate(request, auth);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      workspaces.requireRole(context, workspace.data, ['owner'], { requestId: request.id });
      return noStore(reply).send(daemonDiagnosticsResponseSchema.parse(diagnostics.summary()));
    },
  );
}
