import { expect, it } from 'vitest';
import { ControllerKernel, SWEEP_MS } from '../../src/services/kernel/controller-kernel.js';
import { ManualClock } from '../cycle-test-support.js';

/** The controller kernel's marks, due times and sweep (R-B5), on a clock the test moves. */

const kernel = (clock = new ManualClock()) => ({ clock, kernel: new ControllerKernel(clock) });

it('takes the keys marked since the last take, or every aggregate', () => {
  const { kernel: k } = kernel();
  expect(k.take()).toBeUndefined();
  k.mark('release', ['a']);
  k.mark('release', ['b', 'a']);
  expect(k.pending()).toBe(true);
  expect(k.take()).toEqual(new Set(['a', 'b']));
  expect(k.pending()).toBe(false);
  k.mark('release', ['a']);
  k.mark('workflow');
  expect(k.take()).toBe('all');
  expect(k.take()).toBeUndefined();
  expect(Object.fromEntries(k.causes)).toEqual({ release: 3, workflow: 1 });
});

it('wakes a waiting controller on a mark, at once when one is pending, and at its stop', async () => {
  const { kernel: k } = kernel();
  k.start();
  const stop = new AbortController();
  let woken = false;
  const waiting = k.marked(stop.signal).then(() => {
    woken = true;
  });
  await Promise.resolve();
  expect(woken).toBe(false);
  k.mark('write');
  await waiting;
  expect(woken).toBe(true);
  // Pending: resolves at once.
  await k.marked(stop.signal);
  k.take();
  const stopped = k.marked(stop.signal);
  stop.abort();
  await stopped;
});

it('marks an aggregate when its due time comes, and not before', () => {
  const { clock, kernel: k } = kernel();
  k.start();
  k.dueAt('a', clock.now() + 5000);
  k.dueAt('b', clock.now() + 2000);
  clock.advance(1999);
  expect(k.take()).toBeUndefined();
  clock.advance(1);
  expect(k.take()).toEqual(new Set(['b']));
  clock.advance(3000);
  expect(k.take()).toEqual(new Set(['a']));
  // A due time fires once.
  clock.advance(10_000);
  expect(k.take()).toBeUndefined();
  k.stop();
});

it('arms no timer before it starts or after it stops (review LOW-2)', () => {
  const { clock, kernel: k } = kernel();
  k.dueAt('a', clock.now() + 1000);
  clock.advance(SWEEP_MS * 2);
  expect(k.take()).toBeUndefined();
  k.start();
  clock.advance(0);
  expect(k.take()).toEqual(new Set(['a']));
  k.stop();
  k.dueAt('b', clock.now() + 1000);
  clock.advance(SWEEP_MS * 2);
  expect(k.take()).toBeUndefined();
});

it('replaces and forgets due times', () => {
  const { clock, kernel: k } = kernel();
  k.start();
  k.dueAt('a', clock.now() + 1000);
  k.dueAt('a', clock.now() + 4000);
  clock.advance(2000);
  expect(k.take()).toBeUndefined();
  k.dueAt('a', undefined);
  k.dueAt('b', clock.now() + 1000);
  k.keepDue(new Set(['a']));
  expect(k.nextDue()).toBeUndefined();
  clock.advance(5000);
  expect(k.take()).toBeUndefined();
  k.stop();
});

it('sweeps every aggregate at its interval', () => {
  const { clock, kernel: k } = kernel();
  k.start();
  clock.advance(SWEEP_MS - 1);
  expect(k.take()).toBeUndefined();
  clock.advance(1);
  expect(k.take()).toBe('all');
  clock.advance(SWEEP_MS);
  expect(k.take()).toBe('all');
  k.stop();
  clock.advance(SWEEP_MS * 3);
  expect(k.take()).toBeUndefined();
});

it('arms no timer past the sweep, and re-arms from the wall clock when it moves', () => {
  const { clock, kernel: k } = kernel();
  k.start();
  // Due well past the sweep: the sweep marks everything first, then the due time comes.
  k.dueAt('a', clock.now() + SWEEP_MS * 2 + 500);
  clock.advance(SWEEP_MS);
  expect(k.take()).toBe('all');
  clock.advance(SWEEP_MS);
  expect(k.take()).toBe('all');
  clock.advance(500);
  expect(k.take()).toEqual(new Set(['a']));
  // A due time beyond the sweep, then the wall clock stepped forward past it: the timer, never
  // armed further than the sweep, fires within one sweep interval and finds it due.
  k.dueAt('b', clock.now() + 20 * 60_000);
  clock.step(30 * 60_000);
  clock.advance(SWEEP_MS);
  expect(k.take()).toEqual('all');
  expect(k.nextDue()).toBeUndefined();
  k.stop();
});

it('re-arms a timer that fired before its due time (the wall clock stepped back)', () => {
  const { clock, kernel: k } = kernel();
  k.start();
  k.dueAt('a', clock.now() + 5000);
  // The clock steps back after the timer was armed: when it fires the time has not come.
  clock.step(-3000);
  clock.advance(5000);
  expect(k.take()).toBeUndefined();
  clock.advance(3000);
  expect(k.take()).toEqual(new Set(['a']));
  k.stop();
});
