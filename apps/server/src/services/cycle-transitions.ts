import {
  AWAITING_MERGE_GATES,
  type CycleAttention,
  type CycleAttentionCode,
  type WorkCycle,
} from '@craftingtable/domain';

/**
 * The cycle's explicit state machine over today's fields (R-B4 increment 6): the status changes
 * a write may make, and what each status may carry. `change()` checks every write against it and
 * refuses one outside it as a programming error, which the tests and replays catch; it is not an
 * operator's refusal. R-B4b restates it over the stop, waits and attempt records.
 *
 * - The stop a status carries: `running`, `stopped` and `completed` none (their end record is
 *   R-B4b's); `needs-attention` an operator stop, never a merge gate; `awaiting-merge` one of
 *   its gates (`AWAITING_MERGE_GATES`, or a record from before codes); `paused` none, or the
 *   stop it was taken at.
 * - Waits (`phaseWait`, `designWait`) sit beside the stop on every status, as stored today:
 *   nothing clears them when a cycle stops, pauses or ends, and clearing them would be a change
 *   of behaviour.
 * - `stopped` is terminal; `completed` is reopened only by review again on an independent review
 *   (`review-again`).
 * - A write that keeps the status is not a status change; it is checked only for what it carries.
 */

type Status = WorkCycle['status'];

/** Field changes that keep the cycle's status and attention as they are. */
export type CycleFieldChanges = Omit<Partial<WorkCycle>, 'status' | 'attention'>;

/**
 * A cycle write. Entering `needs-attention` or `awaiting-merge` must declare its attention,
 * so a new stop cannot be written without a code; attention alone may be refreshed while
 * the status stays; a pause taken at a stop keeps that stop's attention, so resuming can
 * return to it (R-A7); any other status clears it.
 */
export type CycleChanges = CycleFieldChanges &
  (
    | {
        readonly status: 'needs-attention' | 'awaiting-merge';
        readonly attention: CycleAttention;
      }
    | { readonly status: 'paused'; readonly attention?: CycleAttention }
    | {
        readonly status?: Exclude<
          WorkCycle['status'],
          'needs-attention' | 'awaiting-merge' | 'paused'
        >;
        readonly attention?: undefined;
      }
    | { readonly status?: undefined; readonly attention: CycleAttention }
  );

/** A status's allowed next statuses, and what it may carry. */
interface StatusRule {
  readonly to: readonly Status[];
  readonly stop: 'none' | 'operator' | 'gate' | 'kept';
}

export const CYCLE_TRANSITIONS: Readonly<Record<Status, StatusRule>> = {
  running: {
    to: ['awaiting-merge', 'needs-attention', 'paused', 'stopped', 'completed'],
    stop: 'none',
  },
  'awaiting-merge': {
    to: ['running', 'needs-attention', 'paused', 'stopped', 'completed'],
    stop: 'gate',
  },
  'needs-attention': { to: ['running', 'paused', 'stopped', 'completed'], stop: 'operator' },
  paused: { to: ['running', 'needs-attention', 'stopped', 'completed'], stop: 'kept' },
  completed: { to: ['running'], stop: 'none' },
  stopped: { to: [], stop: 'none' },
};

/** The status changes only one action may make. */
const ONLY_BY: Partial<Record<`${Status}>${Status}`, string>> = {
  'completed>running': 'review-again',
};

const GATES: ReadonlySet<CycleAttentionCode> = new Set<CycleAttentionCode>([
  ...AWAITING_MERGE_GATES,
  // A record written before codes, put back by an undone reservation (`restoredStatus`).
  'legacy-attention',
]);

/** A write outside `CYCLE_TRANSITIONS`: a programming error, never an operator's refusal. */
export class CycleTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleTransitionError';
  }
}

/** Refuses a write from `from` to `to` by `action` that the table does not allow. */
export function checkTransition(
  from: Pick<WorkCycle, 'status' | 'attention'>,
  to: Pick<WorkCycle, 'status' | 'attention'>,
  action: string,
): void {
  if (from.status !== to.status) {
    const key = `${from.status}>${to.status}` as const;
    const only = ONLY_BY[key];
    if (!CYCLE_TRANSITIONS[from.status].to.includes(to.status) || (only && only !== action))
      throw new CycleTransitionError(
        `A cycle cannot go from ${from.status} to ${to.status} by ${action}.`,
      );
  }
  const code = to.attention?.code;
  const carried = CYCLE_TRANSITIONS[to.status].stop;
  const fits =
    carried === 'none'
      ? code === undefined
      : carried === 'gate'
        ? code !== undefined && GATES.has(code)
        : carried === 'operator'
          ? code !== undefined && !GATES.has(code)
          : code === undefined || !GATES.has(code);
  if (!fits)
    throw new CycleTransitionError(
      `A ${to.status} cycle cannot carry ${code === undefined ? 'no stop' : `the stop ${code}`} (${action}).`,
    );
}
