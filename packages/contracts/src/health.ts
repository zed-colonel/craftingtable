import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('craftingtable-server'),
  version: z.string().min(1),
  time: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

const milliseconds = z.number().nonnegative();

/** Delay percentiles of the daemon's event loop over one sampling window. */
export const eventLoopDelaySummarySchema = z.strictObject({
  windowMs: milliseconds,
  samples: z.number().int().nonnegative(),
  meanMs: milliseconds,
  p50Ms: milliseconds,
  p95Ms: milliseconds,
  p99Ms: milliseconds,
  maxMs: milliseconds,
});

/** Recent cost of one route, over its last bounded set of completed requests. */
export const routeTimingSummarySchema = z.strictObject({
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

/**
 * Owner-only daemon diagnostics (R-D3): event-loop delay and per-route request
 * cost, so the effect of browser load on the controller can be measured on the
 * live daemon.
 */
export const daemonDiagnosticsResponseSchema = z.strictObject({
  time: z.iso.datetime(),
  uptimeMs: milliseconds,
  eventLoopDelay: z.strictObject({
    sinceStart: eventLoopDelaySummarySchema,
    lastMinute: eventLoopDelaySummarySchema.optional(),
  }),
  routes: z.array(routeTimingSummarySchema).max(1000),
});

export type EventLoopDelaySummary = z.infer<typeof eventLoopDelaySummarySchema>;
export type RouteTimingSummary = z.infer<typeof routeTimingSummarySchema>;
export type DaemonDiagnosticsResponse = z.infer<typeof daemonDiagnosticsResponseSchema>;
