/**
 * Failed sign-ins, counted per key: a username and a client address (R-G9, SEC-04; operator
 * decision 2026-10-05). `limit` failures of a key within `windowMs` refuse further attempts on
 * it for `lockMs`. Held in memory: a restart forgets it, as it forgets sessions' step-ups.
 */
export class LoginThrottle {
  private readonly keys = new Map<string, { failures: number[]; lockedUntil?: number }>();
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

  /** When an attempt on these keys may next be made, or undefined when it may now. */
  blockedUntil(keys: readonly string[]): number | undefined {
    const at = this.now().getTime();
    const until = keys
      .map((key) => this.keys.get(key)?.lockedUntil)
      .filter((value): value is number => value !== undefined && value > at);
    return until.length === 0 ? undefined : Math.max(...until);
  }

  /**
   * Records a failure on each key. `first`: it opened its username's window, so one audit row
   * can stand for the window; `locked`: it locked a key.
   */
  failed(keys: readonly string[]): { readonly first: boolean; readonly locked: boolean } {
    const at = this.now().getTime();
    let first = false;
    let locked = false;
    for (const key of keys) {
      const entry = this.keys.get(key) ?? { failures: [] };
      if (entry.lockedUntil !== undefined && entry.lockedUntil <= at) {
        entry.failures = [];
        entry.lockedUntil = undefined;
      }
      entry.failures = entry.failures.filter((time) => time > at - this.windowMs);
      if (key === keys[0] && entry.failures.length === 0) first = true;
      entry.failures.push(at);
      if (entry.failures.length >= this.limit && entry.lockedUntil === undefined) {
        entry.lockedUntil = at + this.lockMs;
        locked = true;
      }
      this.keys.delete(key);
      this.keys.set(key, entry);
    }
    this.prune(at);
    return { first, locked };
  }

  /** A successful sign-in clears its keys' failures. */
  succeeded(keys: readonly string[]): void {
    for (const key of keys) this.keys.delete(key);
  }

  /** Drops keys with nothing left to remember, then the oldest beyond the bound. */
  private prune(at: number): void {
    for (const [key, entry] of this.keys) {
      if (this.keys.size <= this.maxKeys) break;
      const live =
        (entry.lockedUntil ?? 0) > at || entry.failures.some((time) => time > at - this.windowMs);
      if (!live || this.keys.size > this.maxKeys) this.keys.delete(key);
    }
  }
}

/**
 * Runs at most `limit` tasks at once; the rest wait in order (R-G9, SEC-04). Password
 * verification takes about 64 MiB each, so concurrent sign-ins cannot exhaust memory.
 */
export class ConcurrencyLimit {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((go) => this.waiting.push(go));
    else this.running += 1;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
