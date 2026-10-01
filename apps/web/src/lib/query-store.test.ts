import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryStore, type QueryKey, replaceEqualDeep } from './query-store.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A loader that resolves when told, counting its calls. */
function controlled<T>() {
  const pending: { resolve: (value: T) => void; reject: (error: unknown) => void }[] = [];
  const load = vi.fn(
    () =>
      new Promise<T>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { load, pending };
}
const options = { debounceMs: 400, maxWaitMs: 2000 };
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('query store (R-D4)', () => {
  it('loads a key once for every subscriber, and shares the result', async () => {
    const store = createQueryStore(options);
    const { load, pending } = controlled<{ n: number }>();
    const key: QueryKey = ['roadmaps', 'ws'];
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(key, load, a);
    store.subscribe(key, load, b);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.read(key)).toMatchObject({ status: 'loading', data: undefined });
    pending[0]!.resolve({ n: 1 });
    await settle();
    expect(store.read(key)).toMatchObject({ status: 'ready', data: { n: 1 } });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('marks keys stale by prefix and re-reads only those with subscribers, after the debounce', async () => {
    const store = createQueryStore(options);
    const one = vi.fn(async () => 1);
    const two = vi.fn(async () => 2);
    const other = vi.fn(async () => 3);
    const offOne = store.subscribe(['runtime', 'ws', 'd1'], one, () => undefined);
    store.subscribe(['runtime', 'ws', 'd2'], two, () => undefined);
    store.subscribe(['roadmaps', 'ws'], other, () => undefined);
    await settle();
    offOne();
    store.invalidate([['runtime', 'ws']]);
    await vi.advanceTimersByTimeAsync(399);
    expect(two).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    // d2 is watched and re-read; d1 has no subscriber, so it is only marked stale.
    expect(two).toHaveBeenCalledTimes(2);
    expect(one).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    expect(store.read(['runtime', 'ws', 'd1']).stale).toBe(true);
    // Watched again: a stale key re-reads at once.
    store.subscribe(['runtime', 'ws', 'd1'], one, () => undefined);
    expect(one).toHaveBeenCalledTimes(2);
  });

  it('keeps the data on screen while re-reading, and after a failed re-read', async () => {
    const store = createQueryStore(options);
    const { load, pending } = controlled<string>();
    store.subscribe(['k'], load, () => undefined);
    pending[0]!.resolve('first');
    await settle();
    store.refreshNow([['k']]);
    expect(store.read(['k'])).toMatchObject({ data: 'first', fetching: true });
    pending[1]!.reject(new Error('daemon away'));
    await settle();
    expect(store.read(['k'])).toMatchObject({ data: 'first', fetching: false });
    expect(String(store.read(['k']).error)).toContain('daemon away');
  });

  it('runs one read per key at a time and one follow-up for any number of invalidations meanwhile', async () => {
    const store = createQueryStore(options);
    const { load, pending } = controlled<number>();
    store.subscribe(['k'], load, () => undefined);
    store.refreshNow([['k']]);
    store.refreshNow([['k']]);
    store.refreshNow([['k']]);
    expect(load).toHaveBeenCalledTimes(1);
    pending[0]!.resolve(1);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(2);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.read(['k']).data).toBe(2);
  });

  it('keeps an unchanged result, and unchanged parts, as they were, so nothing re-renders', async () => {
    const store = createQueryStore(options);
    let value = { a: { x: 1 }, b: [{ y: 1 }, { y: 2 }] };
    const listener = vi.fn();
    store.subscribe(['k'], async () => structuredClone(value), listener);
    await settle();
    const first = store.read(['k']).data;
    listener.mockClear();
    store.refreshNow([['k']]);
    await settle();
    expect(store.read(['k']).data).toBe(first);
    expect(listener).not.toHaveBeenCalled();
    value = { a: { x: 1 }, b: [{ y: 1 }, { y: 3 }] };
    store.refreshNow([['k']]);
    await settle();
    const second = store.read(['k']).data as typeof value;
    expect(second).not.toBe(first);
    expect(second.a).toBe((first as typeof value).a);
    expect(second.b[0]).toBe((first as typeof value).b[0]);
    expect(listener).toHaveBeenCalled();
  });

  it('reads nothing while the page is hidden, and catches up once when shown', async () => {
    let hidden = false;
    const store = createQueryStore({ ...options, hidden: () => hidden });
    const load = vi.fn(async () => 1);
    store.subscribe(['k'], load, () => undefined);
    await settle();
    hidden = true;
    store.invalidate([['k']]);
    store.invalidate([['k']]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(1);
    hidden = false;
    store.visibilityChanged();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('writes a command response into its key, and forgets everything on clear', async () => {
    const store = createQueryStore(options);
    const load = vi.fn(async () => 'loaded');
    const listener = vi.fn();
    store.subscribe(['k'], load, listener);
    await settle();
    store.set(['k'], 'from the command');
    expect(store.read(['k']).data).toBe('from the command');
    expect(listener).toHaveBeenCalled();
    store.clear();
    expect(store.read(['k']).data).toBeUndefined();
  });

  it('ignores a read that finished after the store was cleared', async () => {
    const store = createQueryStore(options);
    const { load, pending } = controlled<string>();
    store.subscribe(['k'], load, () => undefined);
    store.clear();
    pending[0]!.resolve('old workspace');
    await settle();
    expect(store.read(['k']).data).toBeUndefined();
  });
});

describe('replaceEqualDeep', () => {
  it('returns the previous value where nothing changed, at every level', () => {
    const previous = { a: [1, { b: 2 }], c: 'x' };
    expect(replaceEqualDeep(previous, structuredClone(previous))).toBe(previous);
    const next = replaceEqualDeep(previous, { a: [1, { b: 3 }], c: 'x' });
    expect(next).not.toBe(previous);
    expect(next.a).not.toBe(previous.a);
    expect(replaceEqualDeep(previous, { ...previous, d: 1 } as typeof previous)).not.toBe(previous);
  });
});
