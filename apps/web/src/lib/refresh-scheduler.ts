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

export interface RefreshSchedulerOptions<T extends string = RefreshTopic> {
  /** Quiet period after the last invalidation before a background round starts. */
  readonly debounceMs: number;
  /** Longest a background invalidation waits while events keep arriving. */
  readonly maxWaitMs: number;
  /** Performs one round; the returned promise settles when its reads have. */
  readonly run: (topics: ReadonlySet<T>) => Promise<void>;
  /** Whether the page is hidden; hidden pages defer rounds until visible. */
  readonly hidden?: () => boolean;
  /** What `refreshNow()` without arguments refreshes; every topic by default. */
  readonly all?: () => Iterable<T>;
}

export interface RefreshScheduler<T extends string = RefreshTopic> {
  /** A background change: coalesced by debounce and max-wait. */
  invalidate(topics: Iterable<T>): void;
  /** The operator's own command: refresh without waiting for the debounce. */
  refreshNow(topics?: Iterable<T>): void;
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
export function createRefreshScheduler<T extends string = RefreshTopic>(
  options: RefreshSchedulerOptions<T>,
): RefreshScheduler<T> {
  const hidden = options.hidden ?? (() => false);
  const all = options.all ?? (() => ALL_REFRESH_TOPICS as unknown as Iterable<T>);
  const pending = new Set<T>();
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
    refreshNow(topics = all()) {
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

/** Whether the document is currently hidden; `false` where there is no document. */
export function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
