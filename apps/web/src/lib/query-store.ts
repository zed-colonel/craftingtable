import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react';
import { createRefreshScheduler } from './refresh-scheduler.js';

/**
 * A keyed query store (R-D4, operator decision 2026-10-01; ADR-003 amendment): each query has a
 * typed key and a loader, and components read it with `useQuery`. Workspace events are
 * invalidation signals only (`event-invalidations.ts` maps each to the keys it makes stale);
 * the event is never the model.
 *
 * - One read per key at a time, with at most one follow-up for any number of invalidations
 *   during it.
 * - The data stays while a key re-reads, and after a failed re-read.
 * - An unchanged result, or unchanged part of one, keeps its identity, so nothing re-renders.
 * - Invalidation marks keys stale by prefix; only keys a component watches are re-read, after
 *   the scheduler's debounce and max-wait, and a hidden page defers them until shown. A stale
 *   key nobody watches is re-read when next watched.
 */
export type QueryKey = readonly string[];

/** What a component renders from: changes only with the data, the error or the status. */
export interface QueryView<T = unknown> {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly data: T | undefined;
  readonly error: unknown;
}

/** The view and the store's bookkeeping, for tests and diagnostics. */
export interface QueryState<T = unknown> extends QueryView<T> {
  readonly fetching: boolean;
  readonly stale: boolean;
}

export interface QueryStore {
  /**
   * Watches a key. The first component to watch it reads it at once, showing what is cached
   * meanwhile: a page visited again is read again, whatever events it missed. Returns the unwatch.
   */
  subscribe<T>(key: QueryKey, loader: () => Promise<T>, listener: () => void): () => void;
  view<T>(key: QueryKey): QueryView<T>;
  read<T>(key: QueryKey): QueryState<T>;
  /** A background change: keys under these prefixes are stale; watched ones re-read soon. */
  invalidate(prefixes: readonly QueryKey[]): void;
  /** The operator's own command: watched keys under these prefixes re-read at once. */
  refreshNow(prefixes: readonly QueryKey[]): void;
  /** Reads a watched key now; settles once a read that began after this call has ended. */
  refetch(key: QueryKey): Promise<void>;
  /** A command's response is the key's new data; a read under way is followed by another. */
  set<T>(key: QueryKey, data: T): void;
  visibilityChanged(): void;
  /**
   * Forgets every key's data except those `keep` names (sign-out; another workspace). Nothing is
   * read here: a component that watches a forgotten key again reads it.
   */
  clear(keep?: (key: QueryKey) => boolean): void;
  dispose(): void;
}

export interface QueryStoreOptions {
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly hidden?: () => boolean;
  /** How long a key nobody watches keeps its data before it is dropped. */
  readonly unwatchedMs?: number;
}

interface Entry {
  readonly key: QueryKey;
  view: QueryView;
  fetching: boolean;
  stale: boolean;
  /** Another read is owed once the current one ends. */
  dirty: boolean;
  /** Increases with every read and every `set`; only the newest read's result is kept. */
  token: number;
  /** Increases when the entry is forgotten; a read begun before then touches nothing. */
  generation: number;
  /** Each watcher's loader, oldest first; a read uses the newest. */
  readonly watchers: Map<() => void, () => Promise<unknown>>;
  /** Settled when the current read and any it owes have ended. */
  waiters: (() => void)[];
  drop?: ReturnType<typeof setTimeout>;
}

const IDLE: QueryView = Object.freeze({ status: 'idle', data: undefined, error: undefined });
/** Five minutes: long enough for back and forward, short enough that tried drafts go. */
const UNWATCHED_MS = 5 * 60_000;

const keyId = (key: QueryKey): string => JSON.stringify(key);
const under = (key: QueryKey, prefix: QueryKey): boolean =>
  prefix.length <= key.length && prefix.every((part, index) => key[index] === part);

export function createQueryStore(options: QueryStoreOptions): QueryStore {
  const hidden = options.hidden ?? (() => false);
  const unwatchedMs = options.unwatchedMs ?? UNWATCHED_MS;
  const entries = new Map<string, Entry>();

  const entry = (key: QueryKey): Entry => {
    const id = keyId(key);
    let found = entries.get(id);
    if (!found) {
      found = {
        key,
        view: IDLE,
        fetching: false,
        stale: false,
        dirty: false,
        token: 0,
        generation: 0,
        watchers: new Map(),
        waiters: [],
      };
      entries.set(id, found);
    }
    return found;
  };
  const loaderOf = (target: Entry) => [...target.watchers.values()].at(-1);
  const show = (target: Entry, view: QueryView): void => {
    if (
      view.status === target.view.status &&
      view.data === target.view.data &&
      view.error === target.view.error
    )
      return;
    target.view = view;
    for (const listener of [...target.watchers.keys()]) listener();
  };
  const settle = (target: Entry): void => {
    const waiters = target.waiters;
    target.waiters = [];
    for (const resolve of waiters) resolve();
  };
  const fetch = (target: Entry): void => {
    const loader = loaderOf(target);
    if (!loader) {
      target.stale = true;
      settle(target);
      return;
    }
    if (target.fetching) {
      target.dirty = true;
      return;
    }
    const token = ++target.token;
    const generation = target.generation;
    target.fetching = true;
    target.stale = false;
    if (target.view.status === 'idle') show(target, { ...IDLE, status: 'loading' });
    const finish = (apply: () => void): void => {
      // Forgotten since: whatever read follows owns the entry now.
      if (generation !== target.generation) return;
      // A command's response arrived since: this read is out of date, and is dropped.
      if (token === target.token) apply();
      target.fetching = false;
      if (target.dirty) {
        target.dirty = false;
        if (target.watchers.size > 0) {
          fetch(target);
          return;
        }
        target.stale = true;
      }
      settle(target);
    };
    loader().then(
      (data) =>
        finish(() =>
          show(target, {
            status: 'ready',
            data: replaceEqualDeep(target.view.data, data),
            error: undefined,
          }),
        ),
      (error: unknown) =>
        finish(() => {
          // A failed read leaves the key stale: the next watcher or event reads it again.
          target.stale = true;
          show(target, {
            status: target.view.data === undefined ? 'error' : 'ready',
            data: target.view.data,
            error,
          });
        }),
    );
  };
  const scheduler = createRefreshScheduler<string>({
    debounceMs: options.debounceMs,
    maxWaitMs: options.maxWaitMs,
    hidden,
    all: () => [],
    // Each key keeps its own single read; a round does not wait for them.
    run: (ids) => {
      for (const id of ids) {
        const target = entries.get(id);
        if (target && target.watchers.size > 0) fetch(target);
      }
      return Promise.resolve();
    },
  });
  const matching = (prefixes: readonly QueryKey[]): Entry[] =>
    [...entries.values()].filter((target) => prefixes.some((prefix) => under(target.key, prefix)));
  const forget = (target: Entry): void => {
    target.generation++;
    target.token++;
    target.fetching = false;
    target.dirty = false;
    target.stale = true;
    clearTimeout(target.drop);
    settle(target);
  };
  const markStale = (prefixes: readonly QueryKey[]): string[] => {
    const watched: string[] = [];
    for (const target of matching(prefixes)) {
      target.stale = true;
      if (target.watchers.size > 0) watched.push(keyId(target.key));
    }
    return watched;
  };

  return {
    subscribe(key, loader, listener) {
      const target = entry(key);
      clearTimeout(target.drop);
      const first = target.watchers.size === 0;
      target.watchers.set(listener, loader);
      // A read under way serves a watcher that comes back (StrictMode mounts twice).
      if (!target.fetching && (first || target.view.status === 'idle' || target.stale))
        fetch(target);
      return () => {
        target.watchers.delete(listener);
        if (target.watchers.size > 0) return;
        // Nobody watches it: its data is kept a while for a page visited again, then dropped.
        target.drop = setTimeout(() => {
          if (target.watchers.size > 0 || entries.get(keyId(key)) !== target) return;
          forget(target);
          entries.delete(keyId(key));
        }, unwatchedMs);
      };
    },
    view<T>(key: QueryKey) {
      return (entries.get(keyId(key))?.view ?? IDLE) as QueryView<T>;
    },
    read<T>(key: QueryKey) {
      const target = entries.get(keyId(key));
      return {
        ...(target?.view ?? IDLE),
        fetching: target?.fetching ?? false,
        stale: target?.stale ?? false,
      } as QueryState<T>;
    },
    invalidate(prefixes) {
      const watched = markStale(prefixes);
      if (watched.length) scheduler.invalidate(watched);
    },
    refreshNow(prefixes) {
      const watched = markStale(prefixes);
      if (watched.length) scheduler.refreshNow(watched);
    },
    refetch(key) {
      const target = entries.get(keyId(key));
      if (!target || target.watchers.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        target.waiters.push(resolve);
        target.stale = true;
        fetch(target);
      });
    },
    set(key, data) {
      const target = entry(key);
      // A read under way is dropped, and read again after: it may have begun before the
      // command, or after it and carry later changes.
      target.token++;
      if (target.fetching) target.dirty = true;
      target.stale = false;
      show(target, {
        status: 'ready',
        data: replaceEqualDeep(target.view.data, data),
        error: undefined,
      });
    },
    visibilityChanged() {
      scheduler.visibilityChanged();
    },
    clear(keep = () => false) {
      scheduler.reset();
      for (const target of entries.values()) {
        if (keep(target.key)) continue;
        forget(target);
        show(target, IDLE);
      }
    },
    dispose() {
      scheduler.dispose();
      for (const target of entries.values()) forget(target);
      entries.clear();
    },
  };
}

/**
 * `next`, reusing `previous` wherever the two are equal, at every level of plain objects and
 * arrays (structural sharing): an unchanged result keeps its identity.
 */
export function replaceEqualDeep<T>(previous: unknown, next: T): T {
  if (previous === next) return next;
  const previousArray = Array.isArray(previous);
  if (previousArray !== Array.isArray(next)) return next;
  if (previousArray) {
    const before = previous as unknown[];
    const after = next as unknown as unknown[];
    const merged = after.map((item, index) => replaceEqualDeep(before[index], item));
    return (
      merged.length === before.length && merged.every((item, index) => item === before[index])
        ? previous
        : merged
    ) as T;
  }
  if (!isPlainObject(previous) || !isPlainObject(next)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  const merged: Record<string, unknown> = {};
  let same = keys.length === Object.keys(before).length;
  for (const name of keys) {
    // Own keys only, each defined as data: an own `__proto__` (as `JSON.parse` makes one) is a
    // key like any other, never the prototype (TS-M9 review N-1).
    const had = Object.hasOwn(before, name);
    const value = replaceEqualDeep(had ? before[name] : undefined, after[name]);
    Object.defineProperty(merged, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    if (!had || value !== before[name]) same = false;
  }
  return (same ? previous : merged) as T;
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const QueryStoreContext = createContext<QueryStore | undefined>(undefined);
export const QueryStoreProvider = QueryStoreContext.Provider;

/**
 * The store outside the app shell (isolated component tests): one, so a component's reads and
 * writes meet, replaced after every test (`resetFallbackQueryStore`, the web tests' setup), so
 * nothing cached is shared between tests.
 */
let fallback = createQueryStore({ debounceMs: 0, maxWaitMs: 0 });
export function resetFallbackQueryStore(): void {
  fallback.dispose();
  fallback = createQueryStore({ debounceMs: 0, maxWaitMs: 0 });
}

/**
 * The app's store. Outside its provider only tests may read (the fallback above); the app
 * itself never does, so nothing it shows can bypass sign-out or a change of workspace.
 */
export function useQueryStore(): QueryStore {
  const store = useContext(QueryStoreContext);
  if (store) return store;
  if (import.meta.env.MODE !== 'test')
    throw new Error('A query was read outside the app shell, which owns the query store.');
  return fallback;
}

/** Reads a key, loading it when first watched; `undefined` reads nothing. */
export function useQuery<T>(key: QueryKey | undefined, loader: () => Promise<T>): QueryView<T> {
  const store = useQueryStore();
  const latest = useRef(loader);
  latest.current = loader;
  const id = key === undefined ? undefined : keyId(key);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key's identity is its id.
  const subscribe = useCallback(
    (notify: () => void) =>
      key === undefined ? () => undefined : store.subscribe(key, () => latest.current(), notify),
    [store, id],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key's identity is its id.
  const snapshot = useCallback(
    () => (key === undefined ? (IDLE as QueryView<T>) : store.view<T>(key)),
    [store, id],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
