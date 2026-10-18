import type {
  CycleAttention,
  CycleEndCode,
  CycleWaits,
  StepAttempt,
  WorkCycle,
} from '@craftingtable/domain';

/**
 * The cycle's explicit state machine (R-B4 increment 6), over the stop, waits and attempt records
 * (R-B4b): the status changes a write may make, and what each status may carry. `change()` checks
 * every write against it and refuses one outside it as a programming error, which the tests and
 * replays catch; it is not an operator's refusal.
 *
 * - The stop a status carries: `running` none; `needs-attention` an operator stop (`attention`);
 *   `awaiting-merge` one of its gates (`gate`, `AWAITING_MERGE_GATES`); `paused` none, or the
 *   operator stop it was taken at; `stopped` and `completed` their end record (`ended`). A stop's
 *   kind follows its code (the contract holds it), so a gate never stands at `needs-attention`.
 * - The status half comes from what the code does (every status change the server suite makes,
 *   recorded by action); the stop half is derived from the code, not recorded.
 * - Waits sit beside the stop on every status, as stored: nothing clears them when a cycle stops,
 *   pauses or ends, and clearing them would be a change of behaviour.
 * - `stopped` is terminal; `completed` is reopened only by review again on an independent review
 *   (`review-again`), which clears its end record.
 * - A write that keeps the status is not a status change; it is checked only for what it carries.
 */

type Status = WorkCycle['status'];

/** What a write records or clears of the waits: a value records one, `null` clears it. */
export interface WaitChanges {
  readonly phase?: CycleWaits['phase'] | null;
  readonly design?: CycleWaits['design'] | null;
}

/**
 * Field changes that keep the cycle's status and stop as they are. `attempt` names the attempt
 * fields a write changes (an `undefined` value drops one); a write that reserves another run
 * writes the attempt it declares and nothing of the last one, unless it carries it on
 * (`keepAttempt`: a run adopted or resumed within the same attempt).
 */
export type CycleFieldChanges = Omit<
  Partial<WorkCycle>,
  'status' | 'stop' | 'attempt' | 'waits'
> & {
  readonly attempt?: { readonly [K in keyof StepAttempt]?: StepAttempt[K] | undefined };
  readonly waits?: WaitChanges;
  readonly keepAttempt?: true;
};

/**
 * A cycle write. Entering `needs-attention` or `awaiting-merge` must declare its attention,
 * so a new stop cannot be written without a code; attention alone may be refreshed while the
 * status stays; a pause taken at a stop keeps that stop, so resuming can return to it (R-A7);
 * ending a cycle declares how it ended (R-B4 decision 7); any other status clears the stop.
 */
export type CycleChanges = CycleFieldChanges &
  (
    | {
        readonly status: 'needs-attention' | 'awaiting-merge';
        readonly attention: CycleAttention;
        readonly end?: undefined;
      }
    | { readonly status: 'paused'; readonly attention?: CycleAttention; readonly end?: undefined }
    | {
        readonly status: 'stopped' | 'completed';
        readonly end: CycleEndCode;
        readonly attention?: undefined;
      }
    | { readonly status?: 'running'; readonly attention?: undefined; readonly end?: undefined }
    | { readonly status?: undefined; readonly attention: CycleAttention; readonly end?: undefined }
  );

/** A status's allowed next statuses, and what it may carry. */
interface StatusRule {
  readonly to: readonly Status[];
  readonly stop: 'none' | 'operator' | 'gate' | 'kept' | 'ended';
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
  completed: { to: ['running'], stop: 'ended' },
  stopped: { to: [], stop: 'ended' },
};

/** The status changes only one action may make. */
const ONLY_BY: Partial<Record<`${Status}>${Status}`, string>> = {
  'completed>running': 'review-again',
};

/** A write outside `CYCLE_TRANSITIONS`: a programming error, never an operator's refusal. */
export class CycleTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleTransitionError';
  }
}

/** Refuses a write from `from` to `to` by `action` that the table does not allow. */
export function checkTransition(
  from: Pick<WorkCycle, 'status' | 'stop'>,
  to: Pick<WorkCycle, 'status' | 'stop'>,
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
  const kind = to.stop?.kind;
  const carried = CYCLE_TRANSITIONS[to.status].stop;
  const fits =
    carried === 'none'
      ? kind === undefined
      : carried === 'gate'
        ? kind === 'gate'
        : carried === 'operator'
          ? kind === 'attention'
          : carried === 'ended'
            ? kind === 'ended'
            : kind === undefined || kind === 'attention';
  if (!fits)
    throw new CycleTransitionError(
      `A ${to.status} cycle cannot carry ${to.stop === undefined ? 'no stop' : `the ${to.stop.kind} ${to.stop.code}`} (${action}).`,
    );
}
