import type { WriteObserver } from '@craftingtable/storage';

/**
 * Writes that alone wake no controller (R-B5, decision 2): an agent's activity, the attention
 * projection's own items and events, deliveries, audit rows and workspace events.
 */
const QUIET_KINDS: ReadonlySet<string> = new Set([
  'attention-item',
  'notification-delivery',
  'notification-record',
  'audit-event',
  'workspace-event',
]);
/** The run events that do wake the controller, as the journal's notification does today. */
const WAKING_RUN_EVENTS: ReadonlySet<string> = new Set([
  'session-started',
  'turn-completed',
  'run-finished',
]);

/**
 * The controller kernel's write observer (R-B5, decision 2): every committed write that is not
 * only quiet wakes it, whether or not its writer notified, so a write that wakes nothing today (a
 * merge's reservation, a phase reservation's release, a test's direct write) is seen at once.
 *
 * The storage reports `written` only for record kinds its guard checks, and `ended` for every
 * outermost transaction: a committed transaction that reported no write at all wrote only tables
 * the guard does not see (phase reservations, repositories, sessions), and counts as waking. A
 * guarded write outside any transaction has no `ended`; it wakes once the task that made it ends.
 */
export function writeMarks(wake: () => void): WriteObserver {
  let wrote = false;
  let waking = false;
  let settling = false;
  const settle = () => {
    if (settling) return;
    settling = true;
    queueMicrotask(() => {
      settling = false;
      // What a transaction wrote, its `ended` took already; what is left was written outside one.
      const outside = waking;
      wrote = false;
      waking = false;
      if (outside) wake();
    });
  };
  return {
    written(kind, record) {
      wrote = true;
      if (!QUIET_KINDS.has(kind)) {
        const event = kind === 'run-event' ? (record as { readonly kind: string }).kind : undefined;
        if (event === undefined || WAKING_RUN_EVENTS.has(event)) waking = true;
      }
      settle();
    },
    beforeCommit() {
      // Nothing: the commit may still fail.
    },
    ended(committed) {
      const wakes = committed && (waking || !wrote);
      wrote = false;
      waking = false;
      if (wakes) wake();
    },
  };
}
