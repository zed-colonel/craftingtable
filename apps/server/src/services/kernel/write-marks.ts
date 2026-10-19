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
 * outermost transaction with how many rows it changed: a committed transaction that reported no
 * guarded write but changed rows wrote only tables the guard does not see (phase reservations,
 * repositories, sessions), and counts as waking; one that changed nothing wakes nothing
 * (increment 3 review MEDIUM-1: delivery's and the scheduler's empty transactions). A guarded
 * write outside any transaction has no `ended`: it wakes once the task that made it ends, apart
 * from any transaction's flags (LOW-1).
 */
export function writeMarks(wake: () => void, inTransaction: () => boolean): WriteObserver {
  let wrote = false;
  let waking = false;
  let outside = false;
  const waken = (record: { readonly kind?: unknown }, kind: string): boolean => {
    if (QUIET_KINDS.has(kind)) return false;
    if (kind !== 'run-event') return true;
    return WAKING_RUN_EVENTS.has(String(record.kind));
  };
  return {
    written(kind, record) {
      const wakes = waken(record as { readonly kind?: unknown }, kind);
      if (!inTransaction()) {
        if (!wakes || outside) return;
        outside = true;
        queueMicrotask(() => {
          outside = false;
          wake();
        });
        return;
      }
      wrote = true;
      if (wakes) waking = true;
    },
    beforeCommit() {
      // Nothing: the commit may still fail.
    },
    ended(committed, changed) {
      const wakes = committed && (waking || (!wrote && changed > 0));
      wrote = false;
      waking = false;
      if (wakes) wake();
    },
  };
}
