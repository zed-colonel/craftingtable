import { describe, expect, it } from 'vitest';
import {
  ConcurrencyLimit,
  type LoginAttempt,
  LoginThrottle,
  QueueFullError,
} from '../../src/security/login-throttle.js';

/**
 * Failed sign-ins per username and per client address (R-G9, operator decision 2026-10-05):
 * 5 within 15 minutes refuse further attempts for 15 minutes. An attempt counts as a failure
 * from the moment it begins, so attempts made at once cannot pass the limit (R-G9 review).
 */
describe('login throttle (R-G9)', () => {
  const minutes = (n: number) => n * 60_000;
  const begun = (throttle: LoginThrottle, keys: readonly string[]): LoginAttempt => {
    const outcome = throttle.begin(keys);
    if (!('attempt' in outcome)) throw new Error(`refused until ${outcome.refusedUntil}`);
    return outcome.attempt;
  };

  it('locks a key after its fifth failure within the window, for fifteen minutes', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => new Date(now));
    const keys = ['user:keith', 'address:10.0.0.2'];
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(begun(throttle, keys).locked).toBe(false);
      now += minutes(1);
    }
    expect(begun(throttle, keys).locked).toBe(true);
    const refused = throttle.begin(keys);
    expect(refused).toEqual({ refusedUntil: now + minutes(15) });
    const locked = now + minutes(15);
    // Another address is refused for the username, another username for the address.
    expect(throttle.begin(['user:keith', 'address:10.0.0.3'])).toEqual({ refusedUntil: locked });
    expect(throttle.begin(['user:other', 'address:10.0.0.2'])).toEqual({ refusedUntil: locked });
    expect('attempt' in throttle.begin(['user:other', 'address:10.0.0.3'])).toBe(true);
    now = locked - 1;
    expect(throttle.begin(keys)).toEqual({ refusedUntil: locked });
    now = locked;
    // The lock's end starts a fresh count: four more do not lock.
    for (let attempt = 0; attempt < 4; attempt++) expect(begun(throttle, keys).locked).toBe(false);
  });

  it('counts attempts made at once before any of them is verified', () => {
    const throttle = new LoginThrottle(() => new Date(0));
    const keys = ['user:keith', 'address:10.0.0.2'];
    const inFlight = Array.from({ length: 5 }, () => begun(throttle, keys));
    expect(inFlight.map((attempt) => attempt.locked)).toEqual([false, false, false, false, true]);
    expect(throttle.begin(keys)).toEqual({ refusedUntil: 15 * 60_000 });
  });

  it('counts only failures inside the window, and a success takes back only its own count', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => new Date(now));
    const keys = ['user:keith', 'address:10.0.0.2'];
    for (let attempt = 0; attempt < 4; attempt++) begun(throttle, keys);
    now = minutes(15);
    // The window is fifteen minutes: the first four have just left it.
    for (let attempt = 0; attempt < 4; attempt++) expect(begun(throttle, keys).locked).toBe(false);
    // A success clears the username and its own attempt on the address, nothing more.
    begun(throttle, keys).succeeded();
    expect(begun(throttle, ['user:keith']).locked).toBe(false);
    expect(begun(throttle, ['user:other', 'address:10.0.0.2']).locked).toBe(true);
  });

  it('says which attempt opens a username window, so one audit row stands for the window', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => new Date(now));
    expect(begun(throttle, ['user:keith']).first).toBe(true);
    expect(begun(throttle, ['user:keith']).first).toBe(false);
    now += minutes(16);
    expect(begun(throttle, ['user:keith']).first).toBe(true);
  });

  it('keeps a bounded number of keys, never dropping a live one: new keys wait instead', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => new Date(now), { maxKeys: 3 });
    for (let attempt = 0; attempt < 5; attempt++) begun(throttle, ['user:keith']);
    begun(throttle, ['user:a']);
    begun(throttle, ['user:b']);
    // Full of live keys: a new one is refused, and the lock stays.
    expect('refusedUntil' in throttle.begin(['user:c'])).toBe(true);
    expect('refusedUntil' in throttle.begin(['user:keith'])).toBe(true);
    expect(throttle.size).toBe(3);
    // Once a key has nothing left to remember, it makes room.
    now = minutes(15);
    expect('attempt' in throttle.begin(['user:c'])).toBe(true);
    expect(throttle.size).toBeLessThanOrEqual(3);
  });
});

describe('concurrency limit (R-G9)', () => {
  it('runs at most its limit at once, and the rest in order as they finish', async () => {
    const limit = new ConcurrencyLimit(2);
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const releases: (() => void)[] = [];
    const task = (id: number) =>
      limit.run(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((release) => releases.push(release));
        order.push(id);
        running -= 1;
      });
    const all = [task(1), task(2), task(3), task(4)];
    await Promise.resolve();
    expect(running).toBe(2);
    while (releases.length) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(all);
    expect(most).toBe(2);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('frees its place when a task fails', async () => {
    const limit = new ConcurrencyLimit(1);
    await expect(limit.run(async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    await expect(limit.run(async () => 'ran')).resolves.toBe('ran');
  });

  it('refuses a task when its queue is full, rather than queue without end', async () => {
    const limit = new ConcurrencyLimit(1, 1);
    let release!: () => void;
    const first = limit.run(() => new Promise<void>((resolve) => (release = resolve)));
    const second = limit.run(async () => 'queued');
    await expect(limit.run(async () => 'third')).rejects.toBeInstanceOf(QueueFullError);
    release();
    await first;
    await expect(second).resolves.toBe('queued');
  });
});
