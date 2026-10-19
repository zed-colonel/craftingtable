import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('craftingtable-server'),
  version: z.string().min(1),
  time: z.iso.datetime(),
});

const milliseconds = z.number().nonnegative();

/** Delay percentiles of the daemon's event loop over one sampling window. */
const eventLoopDelaySummarySchema = z.strictObject({
  windowMs: milliseconds,
  samples: z.number().int().nonnegative(),
  meanMs: milliseconds,
  p50Ms: milliseconds,
  p95Ms: milliseconds,
  p99Ms: milliseconds,
  maxMs: milliseconds,
});

/** Recent cost of one route, over its last bounded set of completed requests. */
const routeTimingSummarySchema = z.strictObject({
  method: z.string().min(1).max(16),
  route: z.string().min(1).max(512),
  count: z.number().int().nonnegative(),
  sampled: z.number().int().nonnegative(),
  p50Ms: milliseconds,
  p95Ms: milliseconds,
  maxMs: milliseconds,
  meanBytes: z.number().nonnegative(),
  maxBytes: z.number().int().nonnegative(),
});

const count = z.number().int().nonnegative();

/**
 * The cycle controller's figures (R-B5, decision 9): counters since start, so a measured phase's
 * are the difference of two reads, and the last minute's round durations.
 */
const controllerSummarySchema = z.strictObject({
  rounds: count,
  /** At most the last 4,096 rounds: above about 68 a second, less than a minute (review L-4). */
  lastMinute: z.strictObject({
    rounds: count,
    p50Ms: milliseconds,
    p95Ms: milliseconds,
    maxMs: milliseconds,
  }),
  marks: z.array(z.strictObject({ cause: z.string().min(1).max(32), count })).max(32),
  lane: z.strictObject({
    jobs: count,
    running: z.boolean(),
    runningForMs: milliseconds.optional(),
    waiting: count,
  }),
  timers: z.strictObject({ due: count, nextDueInMs: milliseconds.optional() }),
  lastSweepAgoMs: milliseconds.optional(),
});

/**
 * Owner-only daemon diagnostics (R-D3): event-loop delay and per-route request
 * cost, so the effect of browser load on the controller can be measured on the
 * live daemon; and the cycle controller's own figures (R-B5).
 */
export const daemonDiagnosticsResponseSchema = z.strictObject({
  time: z.iso.datetime(),
  uptimeMs: milliseconds,
  eventLoopDelay: z.strictObject({
    sinceStart: eventLoopDelaySummarySchema,
    lastMinute: eventLoopDelaySummarySchema.optional(),
  }),
  routes: z.array(routeTimingSummarySchema).max(1000),
  controller: controllerSummarySchema.optional(),
});

export type EventLoopDelaySummary = z.infer<typeof eventLoopDelaySummarySchema>;
export type RouteTimingSummary = z.infer<typeof routeTimingSummarySchema>;
export type ControllerSummary = z.infer<typeof controllerSummarySchema>;
export type DaemonDiagnosticsResponse = z.infer<typeof daemonDiagnosticsResponseSchema>;
