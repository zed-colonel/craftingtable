import type { WriteObserver } from '@craftingtable/storage';

/**
 * The event streams' channels (R-B5 part 3, NOTIF-14): a committed workspace event notifies its
 * workspace's key and a run event its run's, once the outermost transaction commits (a write
 * outside one, when its task ends); a transaction that rolls back notifies nothing. Every write
 * of either record goes through the storage guard, so no site that appends one is missed. A
 * journal compaction rewrites run events too: a wake that finds nothing (accepted).
 */
export function streamChannels(
  notify: (keys: Iterable<string>) => void,
  inTransaction: () => boolean,
): WriteObserver {
  // A transaction's keys, and those of writes outside any, kept apart: a rollback drops only the
  // former (increment 15 review LOW-2).
  const keys = new Set<string>();
  const outside = new Set<string>();
  let queued = false;
  const flush = (from: Set<string>) => {
    if (from.size === 0) return;
    const notified = [...from];
    from.clear();
    notify(notified);
  };
  return {
    written(kind, record) {
      const key =
        kind === 'workspace-event'
          ? `workspace:${(record as { workspaceId: string }).workspaceId}`
          : kind === 'run-event'
            ? `run:${(record as { runId: string }).runId}`
            : undefined;
      if (key === undefined) return;
      if (inTransaction()) {
        keys.add(key);
        return;
      }
      outside.add(key);
      if (!queued) {
        queued = true;
        queueMicrotask(() => {
          queued = false;
          flush(outside);
        });
      }
    },
    beforeCommit() {},
    ended(committed) {
      if (committed) flush(keys);
      else keys.clear();
    },
  };
}
