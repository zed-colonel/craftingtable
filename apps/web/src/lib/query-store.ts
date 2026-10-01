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
  /** Watches a key: reads it now if it has nothing yet or is stale. Returns the unwatch. */
  subscribe<T>(key: QueryKey, loader: () => Promise<T>, listener: () => void): () => void;
  view<T>(key: QueryKey): QueryView<T>;
  read<T>(key: QueryKey): QueryState<T>;
  /** A background change: keys under these prefixes are stale; watched ones re-read soon. */
  invalidate(prefixes: readonly QueryKey[]): void;
  /** The operator's own command: watched keys under these prefixes re-read at once. */
  refreshNow(prefixes: readonly QueryKey[]): void;
  /** A command's response is the key's new data. */
  set<T>(key: QueryKey, data: T): void;
  visibilityChanged(): void;
  /** Forgets every key's data (sign-out, another workspace); watched keys read again. */
  clear(): void;
  dispose(): void;
}

export interface QueryStoreOptions {
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly hidden?: () => boolean;
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
  loader?: () => Promise<unknown>;
  readonly listeners: Set<() => void>;
}

const IDLE: QueryView = Object.freeze({ status: 'idle', data: undefined, error: undefined });

const keyId = (key: QueryKey): string => JSON.stringify(key);
const under = (key: QueryKey, prefix: QueryKey): boolean =>
  prefix.length <= key.length && prefix.every((part, index) => key[index] === part);

export function createQueryStore(options: QueryStoreOptions): QueryStore {
  const hidden = options.hidden ?? (() => false);
  const entries = new Map<string, Entry>();
  let epoch = 0;

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
        listeners: new Set(),
      };
      entries.set(id, found);
    }
    return found;
  };
  const show = (target: Entry, view: QueryView): void => {
    if (
      view.status === target.view.status &&
      view.data === target.view.data &&
      view.error === target.view.error
    )
      return;
    target.view = view;
    for (const listener of [...target.listeners]) listener();
  };
  const fetch = (target: Entry): void => {
    if (!target.loader) return;
    if (target.fetching) {
      target.dirty = true;
      return;
    }
    const loader = target.loader;
    const token = ++target.token;
    const started = epoch;
    target.fetching = true;
    target.stale = false;
    if (target.view.status === 'idle') show(target, { ...IDLE, status: 'loading' });
    const finish = (apply: () => void): void => {
      // Cleared since: the read the clear started owns the entry now.
      if (started !== epoch) return;
      // A command's response arrived since: this read is out of date, and is dropped.
      if (token === target.token) apply();
      target.fetching = false;
      if (target.dirty) {
        target.dirty = false;
        if (target.listeners.size > 0) fetch(target);
        else target.stale = true;
      }
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
        finish(() =>
          show(target, {
            status: target.view.data === undefined ? 'error' : 'ready',
            data: target.view.data,
            error,
          }),
        ),
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
        if (target && target.listeners.size > 0) fetch(target);
      }
      return Promise.resolve();
    },
  });
  const matching = (prefixes: readonly QueryKey[]): Entry[] =>
    [...entries.values()].filter((target) => prefixes.some((prefix) => under(target.key, prefix)));

  return {
    subscribe(key, loader, listener) {
      const target = entry(key);
      target.loader = loader;
      target.listeners.add(listener);
      if (!target.fetching && (target.view.status === 'idle' || target.stale)) fetch(target);
      return () => {
        target.listeners.delete(listener);
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
      const watched: string[] = [];
      for (const target of matching(prefixes)) {
        target.stale = true;
        if (target.listeners.size > 0) watched.push(keyId(target.key));
      }
      if (watched.length) scheduler.invalidate(watched);
    },
    refreshNow(prefixes) {
      const watched: string[] = [];
      for (const target of matching(prefixes)) {
        target.stale = true;
        if (target.listeners.size > 0) watched.push(keyId(target.key));
      }
      if (watched.length) scheduler.refreshNow(watched);
    },
    set(key, data) {
      const target = entry(key);
      // A read already under way started before this response: its result is out of date.
      target.token++;
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
    clear() {
      epoch++;
      scheduler.reset();
      for (const target of entries.values()) {
        target.fetching = false;
        target.dirty = false;
        target.stale = true;
        show(target, IDLE);
        if (target.listeners.size > 0) fetch(target);
      }
    },
    dispose() {
      epoch++;
      scheduler.dispose();
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
    merged[name] = replaceEqualDeep(before[name], after[name]);
    if (!(name in before) || merged[name] !== before[name]) same = false;
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

/** The app's store. */
export function useQueryStore(): QueryStore {
  return useContext(QueryStoreContext) ?? fallback;
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
