import type { AttentionOwner, CycleAttentionCode } from './attention.js';
import type { CycleStatus } from './work-cycle.js';

/**
 * Operator wait as a first-class metric (R-C1, HIST-02).
 *
 * A cycle waits on the operator while it is paused or stopped at attention the operator
 * owns. The headline number is the wall time in which at least one cycle waited on the
 * operator and no agent was running: work that could not move until the operator acted.
 * Stop kinds are ranked by the cycle-hours spent in them, which is what the remaining
 * automation work is prioritized by.
 */

/** One recorded cycle transition: the state the cycle entered at `at`. */
export interface CycleTransitionRecord {
  readonly cycleId: string;
  readonly at: string;
  readonly status: CycleStatus;
  /** The stop's declared (or, for older records, recovered) attention. */
  readonly attention?: { readonly code: CycleAttentionCode; readonly owner: AttentionOwner };
}

export interface AgentActivityInterval {
  readonly startedAt: string;
  /** Absent while the run is live. */
  readonly endedAt?: string;
}

/** `paused` is the operator's own pause; every other kind is an attention code. */
export type OperatorWaitKind = CycleAttentionCode | 'paused';

export interface OperatorWaitReport {
  readonly from: string;
  readonly to: string;
  /** Wall hours with at least one cycle waiting on the operator. */
  readonly waitingHours: number;
  /** Of those, the wall hours in which no agent was running (the HIST-02 headline). */
  readonly idleWaitingHours: number;
  /** Wall hours with at least one agent running. */
  readonly agentHours: number;
  /** Operator stops by kind, most cycle-hours first. */
  readonly kinds: readonly {
    readonly kind: OperatorWaitKind;
    /** Stops of this kind that began inside the window. */
    readonly stops: number;
    /** Cycle-hours spent in this kind inside the window (overlapping cycles add up). */
    readonly cycleHours: number;
  }[];
}

type Interval = readonly [number, number];

const HOUR_MS = 3_600_000;

function union(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).toSorted((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function length(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
}

/** Time in `left` not covered by `right`; both are disjoint and sorted. */
function subtract(left: readonly Interval[], right: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const [start, end] of left) {
    let cursor = start;
    for (const [a, b] of right) {
      if (b <= cursor || a >= end) continue;
      if (a > cursor) result.push([cursor, a]);
      cursor = Math.max(cursor, b);
      if (cursor >= end) break;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

function waitKind(record: CycleTransitionRecord): OperatorWaitKind | undefined {
  if (record.status === 'paused') return 'paused';
  if (record.status !== 'needs-attention' && record.status !== 'awaiting-merge') return undefined;
  return record.attention?.owner === 'operator' ? record.attention.code : undefined;
}

const hours = (ms: number) => Math.round((ms / HOUR_MS) * 10) / 10;

export function summarizeOperatorWait(
  transitions: readonly CycleTransitionRecord[],
  runs: readonly AgentActivityInterval[],
  window: { readonly from: Date; readonly to: Date },
): OperatorWaitReport {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const clip = (start: number, end: number): Interval => [Math.max(start, from), Math.min(end, to)];

  const byCycle = new Map<string, CycleTransitionRecord[]>();
  for (const record of transitions) {
    const list = byCycle.get(record.cycleId) ?? [];
    list.push(record);
    byCycle.set(record.cycleId, list);
  }
  const waiting: Interval[] = [];
  const kinds = new Map<OperatorWaitKind, { stops: number; ms: number }>();
  for (const records of byCycle.values()) {
    const ordered = records.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const [index, record] of ordered.entries()) {
      const kind = waitKind(record);
      if (kind === undefined) continue;
      const start = Date.parse(record.at);
      const next = ordered[index + 1];
      const interval = clip(start, next ? Date.parse(next.at) : to);
      if (interval[1] <= interval[0]) continue;
      waiting.push(interval);
      const entry = kinds.get(kind) ?? { stops: 0, ms: 0 };
      entry.ms += interval[1] - interval[0];
      // A stop that continues under the same kind across a bookkeeping write is one stop.
      const previous = ordered[index - 1];
      if (start >= from && (!previous || waitKind(previous) !== kind)) entry.stops += 1;
      kinds.set(kind, entry);
    }
  }
  const waitingUnion = union(waiting);
  const agentUnion = union(
    runs.map((run) => clip(Date.parse(run.startedAt), run.endedAt ? Date.parse(run.endedAt) : to)),
  );
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    waitingHours: hours(length(waitingUnion)),
    idleWaitingHours: hours(length(subtract(waitingUnion, agentUnion))),
    agentHours: hours(length(agentUnion)),
    kinds: [...kinds.entries()]
      .map(([kind, entry]) => ({ kind, stops: entry.stops, cycleHours: hours(entry.ms) }))
      .toSorted((a, b) => b.cycleHours - a.cycleHours || b.stops - a.stops),
  };
}
