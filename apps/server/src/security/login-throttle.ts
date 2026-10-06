/**
 * Failed sign-ins, counted per key: a username and a client address (R-G9, SEC-04; operator
 * decision 2026-10-05). `limit` failures of a key within `windowMs` refuse further attempts on
 * it for `lockMs`. Held in memory: a restart forgets it, as it forgets sessions' step-ups.
 *
 * An attempt counts as a failure from the moment it begins, before its password is verified,
 * and a success takes its own count back. Attempts made at once therefore cannot pass the limit
 * between being admitted and being verified (R-G9 review).
 */
export interface LoginAttempt {
  /** It opened its username's window: one audit row can stand for the window. */
  readonly first: boolean;
  /** It locked a key. */
  readonly locked: boolean;
  /** The password matched: the username's count is cleared, and this attempt's own elsewhere. */
  succeeded(): void;
  /** The attempt was never verified (refused for load): its own count is taken back. */
  withdrawn(): void;
}

interface KeyState {
  failures: number[];
  lockedUntil?: number;
}

export class LoginThrottle {
  private readonly keys = new Map<string, KeyState>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly maxKeys: number;

  constructor(
    private readonly now: () => Date,
    options: {
      readonly limit?: number;
      readonly windowMs?: number;
      readonly lockMs?: number;
      readonly maxKeys?: number;
    } = {},
  ) {
    this.limit = options.limit ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.lockMs = options.lockMs ?? 15 * 60_000;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  get size(): number {
    return this.keys.size;
  }

  /**
   * Admits an attempt on these keys and counts it, or says until when they are refused. The
   * first key is the username's. When the bound is full of keys still remembering something, a
   * key not yet known is refused for a window rather than one remembered being dropped.
   */
  begin(
    keys: readonly string[],
  ): { readonly attempt: LoginAttempt } | { readonly refusedUntil: number } {
    const at = this.now().getTime();
    const states = keys.map((key) => this.current(key, at));
    const until = states
      .map((state) => state?.lockedUntil)
      .filter((value): value is number => value !== undefined);
    if (until.length > 0) return { refusedUntil: Math.max(...until) };
    if (states.some((state) => state === undefined) && !this.room(at, keys))
      return { refusedUntil: at + this.windowMs };
    let first = false;
    let locked = false;
    keys.forEach((key, index) => {
      const state = states[index] ?? { failures: [] };
      if (index === 0 && state.failures.length === 0) first = true;
      state.failures.push(at);
      if (state.failures.length >= this.limit) {
        state.lockedUntil = at + this.lockMs;
        locked = true;
      }
      this.keys.delete(key);
      this.keys.set(key, state);
    });
    const takeBack = (from: readonly string[]) => {
      for (const key of from) {
        const state = this.keys.get(key);
        const index = state?.failures.indexOf(at) ?? -1;
        if (state === undefined || index < 0) continue;
        state.failures.splice(index, 1);
        if (state.failures.length < this.limit) state.lockedUntil = undefined;
      }
    };
    return {
      attempt: {
        first,
        locked,
        succeeded: () => {
          this.keys.delete(keys[0] as string);
          takeBack(keys.slice(1));
        },
        withdrawn: () => takeBack(keys),
      },
    };
  }

  /** A key's state now: a lock that ended, and failures that left the window, are forgotten. */
  private current(key: string, at: number): KeyState | undefined {
    const state = this.keys.get(key);
    if (state === undefined) return undefined;
    if (state.lockedUntil !== undefined && state.lockedUntil <= at) {
      state.failures = [];
      state.lockedUntil = undefined;
    }
    state.failures = state.failures.filter((time) => time > at - this.windowMs);
    if (state.failures.length === 0 && state.lockedUntil === undefined) {
      this.keys.delete(key);
      return undefined;
    }
    return state;
  }

  /** Whether the new keys fit: keys with nothing left to remember are dropped to make room. */
  private room(at: number, keys: readonly string[]): boolean {
    const adding = keys.filter((key) => !this.keys.has(key)).length;
    if (this.keys.size + adding <= this.maxKeys) return true;
    for (const key of [...this.keys.keys()]) {
      this.current(key, at);
      if (this.keys.size + adding <= this.maxKeys) return true;
    }
    return false;
  }
}

/** A sign-in refused because too many are already waiting for a verification. */
export class QueueFullError extends Error {
  constructor() {
    super('Too many sign-ins are waiting');
    this.name = 'QueueFullError';
  }
}

/**
 * Runs at most `limit` tasks at once; at most `maxWaiting` more wait, in order, and the rest are
 * refused (R-G9, SEC-04). Password verification takes about 64 MiB each, so concurrent sign-ins
 * cannot exhaust memory, and a flood cannot make the operator's own sign-in wait behind it.
 */
export class ConcurrencyLimit {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxWaiting = 32,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      if (this.waiting.length >= this.maxWaiting) throw new QueueFullError();
      await new Promise<void>((go) => this.waiting.push(go));
    } else this.running += 1;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
