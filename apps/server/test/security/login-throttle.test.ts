import { describe, expect, it } from 'vitest';
import { ConcurrencyLimit, LoginThrottle } from '../../src/security/login-throttle.js';

/**
 * Failed sign-ins per username and per client address (R-G9, operator decision 2026-10-05):
 * 5 within 15 minutes refuse further attempts for 15 minutes.
 */
describe('login throttle (R-G9)', () => {
  const minutes = (n: number) => n * 60_000;

  it('locks a key after its fifth failure within the window, for fifteen minutes', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => new Date(now));
    const keys = ['user:keith', 'address:10.0.0.2'];
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(throttle.blockedUntil(keys)).toBeUndefined();
      expect(throttle.failed(keys).locked).toBe(false);
      now += minutes(1);
    }
    expect(throttle.failed(keys).locked).toBe(true);
    const locked = throttle.blockedUntil(keys);
    expect(locked).toBe(now + minutes(15));
    // Another address is refused for the username, another username for the address.
    expect(throttle.blockedUntil(['user:keith', 'address:10.0.0.3'])).toBe(locked);
    expect(throttle.blockedUntil(['user:other', 'address:10.0.0.2'])).toBe(locked);
    expect(throttle.blockedUntil(['user:other', 'address:10.0.0.3'])).toBeUndefined();
    now = locked! - 1;
    expect(throttle.blockedUntil(keys)).toBe(locked);
    now = locked!;
    expect(throttle.blockedUntil(keys)).toBeUndefined();
    // The lock's end starts a fresh count.
    expect(throttle.failed(keys).locked).toBe(false);
  });

  it('counts only failures inside the window, and forgets a key on success', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => new Date(now));
    const keys = ['user:keith'];
    for (let attempt = 0; attempt < 4; attempt++) throttle.failed(keys);
    now += minutes(16);
    // The first four left the window: four more do not lock.
    for (let attempt = 0; attempt < 4; attempt++) expect(throttle.failed(keys).locked).toBe(false);
    throttle.succeeded(keys);
    for (let attempt = 0; attempt < 4; attempt++) expect(throttle.failed(keys).locked).toBe(false);
    expect(throttle.failed(keys).locked).toBe(true);
  });

  it('says which failure opens a window, so one audit row stands for the window', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => new Date(now));
    expect(throttle.failed(['user:keith']).first).toBe(true);
    expect(throttle.failed(['user:keith']).first).toBe(false);
    now += minutes(16);
    expect(throttle.failed(['user:keith']).first).toBe(true);
  });

  it('keeps a bounded number of keys', () => {
    const throttle = new LoginThrottle(() => new Date(0), { maxKeys: 3 });
    for (const name of ['a', 'b', 'c', 'd']) throttle.failed([`user:${name}`]);
    expect(throttle.size).toBeLessThanOrEqual(3);
  });
});

describe('concurrency limit (R-G9)', () => {
  it('runs at most its limit at once, and the rest in order as they finish', async () => {
    const limit = new ConcurrencyLimit(2);
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const tasks = [0, 1, 2, 3].map((index) =>
      limit.run(
        () =>
          new Promise<number>((resolve) => {
            started.push(index);
            releases[index] = () => resolve(index);
          }),
      ),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    releases[1]!();
    await tasks[1];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    releases[0]!();
    releases[2]!();
    await Promise.all([tasks[0], tasks[2]]);
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    releases[3]!();
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
  });

  it('frees its place when a task fails', async () => {
    const limit = new ConcurrencyLimit(1);
    await expect(limit.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limit.run(async () => 'next')).toBe('next');
  });
});
