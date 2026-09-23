/**
 * What a refresh round re-reads.
 *
 * `workspace` is the page's authoritative queries (snapshot, cycles, route
 * detail and the panels wired to them); `roadmaps` the roadmap, map and
 * runtime-evidence panels; `notifications` the notification settings panel.
 */
export type RefreshTopic = 'workspace' | 'roadmaps' | 'notifications';

export const ALL_REFRESH_TOPICS: readonly RefreshTopic[] = [
  'workspace',
  'roadmaps',
  'notifications',
];

export interface RefreshSchedulerOptions {
  /** Quiet period after the last invalidation before a background round starts. */
  readonly debounceMs: number;
  /** Longest a background invalidation waits while events keep arriving. */
  readonly maxWaitMs: number;
  /** Performs one round; the returned promise settles when its reads have. */
  readonly run: (topics: ReadonlySet<RefreshTopic>) => Promise<void>;
  /** Whether the page is hidden; hidden pages defer rounds until visible. */
  readonly hidden?: () => boolean;
}

export interface RefreshScheduler {
  /** A background change: coalesced by debounce and max-wait. */
  invalidate(topics: Iterable<RefreshTopic>): void;
  /** The operator's own command: refresh without waiting for the debounce. */
  refreshNow(topics?: Iterable<RefreshTopic>): void;
  /** Call on `visibilitychange`; a page becoming visible catches up once. */
  visibilityChanged(): void;
  /** Drops pending work, e.g. when the workspace changes. */
  reset(): void;
  dispose(): void;
}

/**
 * Coalesces workspace events into refresh rounds (PERF-02, NOTIF-11).
 *
 * A controller transition emits its events 0.3 to 6 s apart, so the former
 * fixed 200 ms window started a full refetch for almost every event, and
 * rounds overlapped on the daemon's event loop. This scheduler:
 *
 * - waits for a quiet period (trailing debounce), but never longer than the
 *   max-wait, so a steady stream of events still refreshes the page;
 * - keeps at most one round in flight; invalidations that arrive during a
 *   round cause exactly one follow-up round once it settles;
 * - defers rounds while the page is hidden and runs one when it is shown.
 */
export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
  const hidden = options.hidden ?? (() => false);
  const pending = new Set<RefreshTopic>();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let followUp = false;
  let disposed = false;

  const clearTimers = (): void => {
    clearTimeout(debounce);
    clearTimeout(deadline);
    debounce = undefined;
    deadline = undefined;
  };

  const flush = (): void => {
    clearTimers();
    if (disposed || pending.size === 0) return;
    if (inFlight) {
      followUp = true;
      return;
    }
    const topics = new Set(pending);
    pending.clear();
    inFlight = true;
    const settled = (): void => {
      inFlight = false;
      if (disposed || !followUp) return;
      followUp = false;
      if (!hidden()) flush();
    };
    options.run(topics).then(settled, settled);
  };

  return {
    invalidate(topics) {
      if (disposed) return;
      for (const topic of topics) pending.add(topic);
      if (pending.size === 0) return;
      if (hidden()) {
        // Nothing is read for a hidden page; the pending set is the catch-up.
        clearTimers();
        return;
      }
      clearTimeout(debounce);
      debounce = setTimeout(flush, options.debounceMs);
      deadline ??= setTimeout(flush, options.maxWaitMs);
    },
    refreshNow(topics = ALL_REFRESH_TOPICS) {
      if (disposed) return;
      for (const topic of topics) pending.add(topic);
      flush();
    },
    visibilityChanged() {
      if (disposed) return;
      if (hidden()) clearTimers();
      else flush();
    },
    reset() {
      clearTimers();
      pending.clear();
      followUp = false;
    },
    dispose() {
      disposed = true;
      clearTimers();
      pending.clear();
    },
  };
}
