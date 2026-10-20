import type { ControllerSummary } from '@craftingtable/contracts';
import type { ControllerKernel } from './controller-kernel.js';

/** One more drain on the kernel, as the figures show it (R-B5 part 2). */
export type DrainSummary = NonNullable<ControllerSummary['drains']>[number];

/** A drain's figures: its rounds since start, its marks by cause, its armed due times. */
export function drainSummary(
  name: DrainSummary['name'],
  rounds: number,
  kernel: ControllerKernel,
  now: number,
): DrainSummary {
  const nextDue = kernel.nextDue();
  return {
    name,
    rounds,
    marks: [...kernel.causes]
      .map(([cause, count]) => ({ cause, count }))
      .toSorted((a, b) => a.cause.localeCompare(b.cause))
      .slice(0, 32),
    timers: {
      due: kernel.dueCount(),
      ...(nextDue === undefined ? {} : { nextDueInMs: Math.max(0, Math.round(nextDue - now)) }),
    },
  };
}

/** Round durations kept for the last minute's percentiles; older ones are dropped. */
const RECENT_ROUNDS = 4096;
const MINUTE_MS = 60_000;

const round = (value: number): number => Math.round(value * 100) / 100;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

/**
 * The controller's figures for the owner-only diagnostics (R-B5, decision 9): its rounds, the
 * marks by cause, the slow lane and the timers. Counters are cumulative since start, so a
 * measurement's phase reads its own as the difference of two reads; durations are the last
 * minute's. In memory only, bounded, reset on restart, as R-D3's figures are.
 */
export class ControllerFigures {
  private rounds = 0;
  private jobs = 0;
  /** Each recent round's end (monotonic milliseconds) and its duration. */
  private readonly recent: { readonly at: number; readonly ms: number }[] = [];

  constructor(private readonly monotonic: () => number = () => performance.now()) {}

  /** A round that began at `startedAt` (monotonic) has ended. */
  rounded(startedAt: number): void {
    const at = this.monotonic();
    this.rounds += 1;
    this.recent.push({ at, ms: at - startedAt });
    if (this.recent.length > RECENT_ROUNDS) this.recent.shift();
  }

  /** The slow lane took a job. */
  jobStarted(): void {
    this.jobs += 1;
  }

  /** Now, on the same clock `rounded` reads. */
  started(): number {
    return this.monotonic();
  }

  summary(
    kernel: ControllerKernel,
    lane: { readonly runningForMs: number | undefined; readonly waiting: number },
    now: number,
  ): ControllerSummary {
    const since = this.monotonic() - MINUTE_MS;
    while (this.recent.length > 0 && (this.recent[0]?.at ?? 0) < since) this.recent.shift();
    const durations = this.recent.map((entry) => entry.ms).toSorted((a, b) => a - b);
    const nextDue = kernel.nextDue();
    return {
      rounds: this.rounds,
      lastMinute: {
        rounds: durations.length,
        p50Ms: round(percentile(durations, 50)),
        p95Ms: round(percentile(durations, 95)),
        maxMs: round(durations.at(-1) ?? 0),
      },
      marks: [...kernel.causes]
        .map(([cause, count]) => ({ cause, count }))
        .toSorted((a, b) => a.cause.localeCompare(b.cause))
        .slice(0, 32),
      lane: {
        jobs: this.jobs,
        running: lane.runningForMs !== undefined,
        ...(lane.runningForMs === undefined
          ? {}
          : { runningForMs: Math.max(0, Math.round(lane.runningForMs)) }),
        waiting: lane.waiting,
      },
      timers: {
        due: kernel.dueCount(),
        ...(nextDue === undefined ? {} : { nextDueInMs: Math.max(0, Math.round(nextDue - now)) }),
      },
      ...(kernel.lastSweepAt === undefined
        ? {}
        : { lastSweepAgoMs: Math.max(0, Math.round(now - kernel.lastSweepAt)) }),
    };
  }
}
