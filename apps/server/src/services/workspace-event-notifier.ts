export interface WorkspaceEventWaitOptions {
  readonly generation: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly channel?: 'workflow';
}

interface Waiter {
  readonly channel?: 'workflow';
  readonly generation: number;
  readonly resolve: () => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export class WorkspaceEventNotifier {
  private currentGeneration = 0;
  private currentWorkflowGeneration = 0;
  private readonly waiters = new Set<Waiter>();
  private readonly workflowListeners = new Set<() => void>();

  get generation(): number {
    return this.currentGeneration;
  }

  get workflowGeneration(): number {
    return this.currentWorkflowGeneration;
  }

  notify(kind: 'workflow' | 'activity' = 'workflow'): void {
    this.currentGeneration += 1;
    if (kind === 'workflow') this.currentWorkflowGeneration += 1;
    if (kind === 'workflow') for (const listener of this.workflowListeners) listener();
    for (const waiter of [...this.waiters]) {
      if (waiter.generation !== this.generationFor(waiter.channel)) {
        this.finish(waiter);
      }
    }
  }

  /** Called on every workflow notification: the controller kernel's mark (R-B5). */
  onWorkflow(listener: () => void): () => void {
    this.workflowListeners.add(listener);
    return () => this.workflowListeners.delete(listener);
  }

  waitForChangeOrTimeout(options: WorkspaceEventWaitOptions): Promise<void> {
    if (options.signal.aborted || options.generation !== this.generationFor(options.channel)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = {
        ...(options.channel ? { channel: options.channel } : {}),
        generation: options.generation,
        resolve,
        signal: options.signal,
        timer: setTimeout(() => this.finish(waiter), options.timeoutMs),
        abort: () => this.finish(waiter),
      } satisfies Waiter;
      this.waiters.add(waiter);
      options.signal.addEventListener('abort', waiter.abort, { once: true });
      if (options.generation !== this.generationFor(options.channel)) {
        this.finish(waiter);
      }
    });
  }

  private generationFor(channel?: 'workflow'): number {
    return channel === 'workflow' ? this.currentWorkflowGeneration : this.currentGeneration;
  }

  private finish(waiter: Waiter): void {
    if (!this.waiters.delete(waiter)) {
      return;
    }
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  }

  /**
   * Channels by key (R-B5 part 3, NOTIF-14): `workspace:<id>` for a workspace's events,
   * `run:<id>` for a run's, `session:<id>` for a session revoked. Each key keeps the sequence at
   * which it was last notified, so a waiter that took `keySequence` before its query and waits
   * after it misses no notification in between (part 3 review MEDIUM-1). Separate from the
   * counters above, which the controllers and the scheduler's caches read.
   */
  get keySequence(): number {
    return this.currentKeySequence;
  }

  notifyKeys(keys: Iterable<string>): void {
    this.currentKeySequence += 1;
    const at = this.currentKeySequence;
    for (const key of keys) {
      this.keyed.delete(key);
      this.keyed.set(key, at);
      for (const waiter of [...(this.keyWaiters.get(key) ?? [])]) this.finishKeyed(waiter);
    }
    // The oldest half goes once the map is large: a key that old was notified long before any
    // live waiter's query (map order is notification order).
    if (this.keyed.size > MAX_KEYS) {
      let drop = this.keyed.size / 2;
      for (const key of this.keyed.keys()) {
        if (drop-- <= 0) break;
        this.keyed.delete(key);
      }
    }
  }

  /**
   * Resolves at a notification of any of `keys` after `after` (at once if one came already), at
   * `timeoutMs`, or at the abort.
   */
  waitForKeys(options: {
    readonly keys: readonly string[];
    readonly after: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<void> {
    if (
      options.signal.aborted ||
      options.keys.some((key) => (this.keyed.get(key) ?? 0) > options.after)
    )
      return Promise.resolve();
    return new Promise((resolve) => {
      const waiter: KeyedWaiter = {
        keys: options.keys,
        resolve,
        signal: options.signal,
        timer: setTimeout(() => this.finishKeyed(waiter), options.timeoutMs),
        abort: () => this.finishKeyed(waiter),
      };
      for (const key of options.keys) {
        const set = this.keyWaiters.get(key) ?? new Set<KeyedWaiter>();
        set.add(waiter);
        this.keyWaiters.set(key, set);
      }
      options.signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  private finishKeyed(waiter: KeyedWaiter): void {
    let present = false;
    for (const key of waiter.keys) {
      const set = this.keyWaiters.get(key);
      if (set?.delete(waiter)) present = true;
      if (set?.size === 0) this.keyWaiters.delete(key);
    }
    if (!present) return;
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  }

  private currentKeySequence = 0;
  private readonly keyed = new Map<string, number>();
  private readonly keyWaiters = new Map<string, Set<KeyedWaiter>>();
}

/** Keys remembered before the oldest half is dropped. */
const MAX_KEYS = 10_000;

interface KeyedWaiter {
  readonly keys: readonly string[];
  readonly resolve: () => void;
  readonly signal: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abort: () => void;
}
