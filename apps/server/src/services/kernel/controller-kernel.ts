/**
 * The controller kernel (R-B5, ADR-077): what tells a controller which of its aggregates need a
 * look, and when, in place of a loop that looks at every one of them every second.
 *
 * An aggregate is marked dirty by an event (a write, a notification, a hold released), by its own
 * due time coming (a step deadline, a retry), or by the safety sweep, which marks every one at a
 * fixed interval so a change no event reports (Git moved outside the daemon, a user's role) is
 * still found. The controller takes the marks and runs a round over them; it waits for the next
 * mark when there is none. The kernel decides nothing: each round's unit is the controller's own.
 */

/** Time and timers, injected so tests set the clock (R-B5 design review M-13). */
export interface KernelClock {
  /** Wall-clock milliseconds, as the controller's `now`. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The clock of a daemon: its `now` and the event loop's timers, which never hold the process. */
export function systemClock(now: () => Date): KernelClock {
  return {
    now: () => now().getTime(),
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

/** What a round looks at: every aggregate, or the keys marked. */
export type Marked = 'all' | ReadonlySet<string>;

/** The safety sweep's interval (decision 3). */
export const SWEEP_MS = 30_000;

export class ControllerKernel {
  private everything = false;
  private readonly keys = new Set<string>();
  private readonly due = new Map<string, number>();
  private timer: { readonly handle: unknown; readonly at: number } | undefined;
  private sweepTimer: unknown;
  private wake: (() => void) | undefined;
  /** Timers are armed only between `start` and `stop` (increment 3 review LOW-2). */
  private running = false;
  /** How many marks each cause made, since start (decision 9's figures read them). */
  readonly causes = new Map<string, number>();
  /** When the sweep last marked everything (wall-clock milliseconds), for the figures. */
  lastSweepAt: number | undefined;

  constructor(
    private readonly clock: KernelClock,
    private readonly sweepMs = SWEEP_MS,
  ) {}

  /** Marks the given keys dirty, or every aggregate; wakes the controller if it waits. */
  mark(cause: string, keys?: Iterable<string>): void {
    if (keys === undefined) this.everything = true;
    else for (const key of keys) this.keys.add(key);
    this.causes.set(cause, (this.causes.get(cause) ?? 0) + 1);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** Whether anything is marked and not yet taken. */
  pending(): boolean {
    return this.everything || this.keys.size > 0;
  }

  /** The marks made since the last take, now taken. */
  take(): Marked | undefined {
    if (this.everything) {
      this.everything = false;
      this.keys.clear();
      return 'all';
    }
    if (this.keys.size === 0) return undefined;
    const taken = new Set(this.keys);
    this.keys.clear();
    return taken;
  }

  /** Resolves at the next mark (at once when one is pending) or at the stop. */
  marked(signal: AbortSignal): Promise<void> {
    if (this.pending() || signal.aborted || !this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.wake = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * When the aggregate next needs a look by itself; nothing clears it. A due time already past
   * marks it at once (the caller asks only for times ahead, `nextLook`).
   */
  dueAt(key: string, at: number | undefined): void {
    if (at === undefined) this.due.delete(key);
    else this.due.set(key, at);
    this.arm();
  }

  /** Forgets the due times of aggregates no longer driven (an ended cycle). */
  keepDue(live: ReadonlySet<string>): void {
    let changed = false;
    for (const key of this.due.keys())
      if (!live.has(key)) {
        this.due.delete(key);
        changed = true;
      }
    if (changed) this.arm();
  }

  /** How many aggregates have a due time, for the figures. */
  dueCount(): number {
    return this.due.size;
  }

  /** The earliest due time, for the figures and the tests. */
  nextDue(): number | undefined {
    let earliest: number | undefined;
    for (const at of this.due.values()) if (earliest === undefined || at < earliest) earliest = at;
    return earliest;
  }

  /** Starts the sweep (and the due timer, if anything is due). */
  start(): void {
    this.running = true;
    this.scheduleSweep();
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer) this.clock.clearTimeout(this.timer.handle);
    this.timer = undefined;
    if (this.sweepTimer !== undefined) this.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private scheduleSweep(): void {
    if (!this.running) return;
    this.sweepTimer = this.clock.setTimeout(() => {
      this.lastSweepAt = this.clock.now();
      this.mark('sweep');
      // Due times are wall-clock and the timer runs on the monotonic clock: a clock stepped
      // forward, or a suspend, would leave the timer late; the sweep re-arms it from the wall clock.
      this.rearm();
      this.scheduleSweep();
    }, this.sweepMs);
  }

  private rearm(): void {
    if (this.timer) this.clock.clearTimeout(this.timer.handle);
    this.timer = undefined;
    this.arm();
  }

  /** One timer for the earliest due time, never further than the sweep. */
  private arm(): void {
    if (!this.running) return;
    const earliest = this.nextDue();
    if (earliest === undefined) {
      if (this.timer) this.clock.clearTimeout(this.timer.handle);
      this.timer = undefined;
      return;
    }
    if (this.timer?.at === earliest) return;
    if (this.timer) this.clock.clearTimeout(this.timer.handle);
    const delay = Math.min(Math.max(0, earliest - this.clock.now()), this.sweepMs);
    this.timer = { handle: this.clock.setTimeout(() => this.fire(), delay), at: earliest };
  }

  private fire(): void {
    this.timer = undefined;
    const now = this.clock.now();
    const due: string[] = [];
    for (const [key, at] of this.due)
      if (at <= now) {
        due.push(key);
        this.due.delete(key);
      }
    if (due.length) this.mark('due', due);
    // A timer that fired early (the wall clock stepped back) or capped at the sweep re-arms.
    this.arm();
  }
}
