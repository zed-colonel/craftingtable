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

describe('query store, after the 4a review', () => {
  it('reads a key again for a watcher that comes back, showing what is cached meanwhile (F2)', async () => {
    const store = createQueryStore(options);
    let n = 0;
    const load = vi.fn(async () => ++n);
    const off = store.subscribe(['k'], load, () => undefined);
    await settle();
    off();
    store.subscribe(['k'], load, () => undefined);
    expect(store.read(['k'])).toMatchObject({ data: 1, fetching: true });
    await settle();
    expect(store.read(['k']).data).toBe(2);
  });

  it('leaves a failed read stale, so the next watcher reads it again (F2)', async () => {
    const store = createQueryStore(options);
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('daemon restarting'))
      .mockResolvedValue('back');
    const off = store.subscribe(['k'], load, () => undefined);
    await settle();
    expect(store.read(['k'])).toMatchObject({ status: 'error', stale: true });
    off();
    store.subscribe(['k'], load, () => undefined);
    await settle();
    expect(store.read(['k'])).toMatchObject({ status: 'ready', data: 'back' });
  });

  it("drops a read under way when a command's response arrives, and reads again after it (F4, M1)", async () => {
    const store = createQueryStore(options);
    const { load, pending } = controlled<string>();
    store.subscribe(['k'], load, () => undefined);
    pending[0]!.resolve('v1');
    await settle();
    store.refreshNow([['k']]);
    store.set(['k'], 'v2 from the command');
    // The older read lands: it never overwrites the response.
    pending[1]!.resolve('v1 again');
    await settle();
    expect(store.read(['k']).data).toBe('v2 from the command');
    // The read owed after it carries later changes.
    expect(load).toHaveBeenCalledTimes(3);
    pending[2]!.resolve('v3');
    await settle();
    expect(store.read(['k']).data).toBe('v3');
  });

  it('never lets a read begun before a clear repopulate it, watched or not (M3)', async () => {
    const store = createQueryStore(options);
    const { load, pending } = controlled<string>();
    const off = store.subscribe(['k'], load, () => undefined);
    off();
    store.clear();
    pending[0]!.resolve("the previous user's data");
    await settle();
    expect(store.read(['k']).data).toBeUndefined();
  });

  it('never lets a read begun before a clear end the read begun after it (R5)', async () => {
    const store = createQueryStore(options);
    const { load, pending } = controlled<string>();
    store.subscribe(['k'], load, () => undefined);
    store.clear();
    // Watched again: the read after the clear is under way.
    store.subscribe(['k'], load, () => undefined);
    expect(load).toHaveBeenCalledTimes(2);
    pending[0]!.resolve('before the clear');
    await settle();
    // Still one read at a time: a refresh owes a follow-up, it does not start a third.
    store.refreshNow([['k']]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.read(['k']).data).toBeUndefined();
  });

  it("keeps the keys a clear is told to keep, reads nothing itself, and a forgotten key's watcher reads it again (F6, M6)", async () => {
    const store = createQueryStore(options);
    const a = vi.fn(async () => 'a');
    const b = vi.fn(async () => 'b');
    store.subscribe(['f', 'ws-1'], a, () => undefined);
    const offB = store.subscribe(['f', 'ws-2'], b, () => undefined);
    await settle();
    store.clear((key) => key[1] === 'ws-1');
    await settle();
    expect(store.read(['f', 'ws-1']).data).toBe('a');
    expect(store.read(['f', 'ws-2']).data).toBeUndefined();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offB();
    store.subscribe(['f', 'ws-2'], b, () => undefined);
    await settle();
    expect(store.read(['f', 'ws-2']).data).toBe('b');
  });

  it('settles a refetch once a read begun after it has ended (F3, F8)', async () => {
    const store = createQueryStore(options);
    const { load, pending } = controlled<string>();
    store.subscribe(['k'], load, () => undefined);
    let done = false;
    // A read is under way: the refetch waits for the one owed after it.
    void store.refetch(['k']).then(() => {
      done = true;
    });
    pending[0]!.resolve('before');
    await settle();
    expect(done).toBe(false);
    pending[1]!.resolve('after');
    await settle();
    expect(done).toBe(true);
    expect(store.read(['k']).data).toBe('after');
    // Nobody watches it: there is nothing to read.
    await expect(store.refetch(['unwatched'])).resolves.toBeUndefined();
  });

  it('drops a key nobody watches after a while, and keeps a watched one (F7)', async () => {
    const store = createQueryStore({ ...options, unwatchedMs: 60_000 });
    const off = store.subscribe(
      ['gone'],
      async () => 1,
      () => undefined,
    );
    store.subscribe(
      ['kept'],
      async () => 2,
      () => undefined,
    );
    await settle();
    off();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(store.read(['gone']).data).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.read(['gone']).data).toBeUndefined();
    expect(store.read(['kept']).data).toBe(2);
  });

  it("reads with the newest remaining watcher's loader, never a gone one's (NIT)", async () => {
    const store = createQueryStore(options);
    const first = vi.fn(async () => 'first');
    const second = vi.fn(async () => 'second');
    store.subscribe(['k'], first, () => undefined);
    await settle();
    const off = store.subscribe(['k'], second, () => undefined);
    off();
    store.refreshNow([['k']]);
    await settle();
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(2);
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
