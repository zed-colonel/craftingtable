import { createContext, useContext, useEffect, useRef } from 'react';
import type { RefreshTopic } from './refresh-scheduler.js';

type Listener = () => void;

/**
 * Delivers refresh rounds to self-loading panels.
 *
 * Panels that load their own data (roadmaps, map preview, runtime evidence,
 * notifications, finalization) used to poll every 3-5 s, visible or not, and
 * ignored the events that describe their data (PERF-03, PERF-06, PERF-17).
 * They now subscribe to the topics whose rounds make them stale.
 */
export interface RefreshSignals {
  subscribe(topic: RefreshTopic, listener: Listener): () => void;
  emit(topics: Iterable<RefreshTopic>): void;
}

export function createRefreshSignals(): RefreshSignals {
  const listeners = new Map<RefreshTopic, Set<Listener>>();
  return {
    subscribe(topic, listener) {
      const set = listeners.get(topic) ?? new Set<Listener>();
      listeners.set(topic, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    emit(topics) {
      for (const topic of new Set(topics)) {
        for (const listener of [...(listeners.get(topic) ?? [])]) listener();
      }
    },
  };
}

/** Outside the app shell (isolated component tests) nothing ever signals. */
const RefreshSignalsContext = createContext<RefreshSignals>(createRefreshSignals());

export const RefreshSignalsProvider = RefreshSignalsContext.Provider;

/**
 * Calls `refresh` after each round of `topic`, never on mount: the panel's own
 * initial load stays where it is. The latest `refresh` is always the one used.
 */
export function useRefreshOn(topic: RefreshTopic, refresh: () => void): void {
  const signals = useContext(RefreshSignalsContext);
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => signals.subscribe(topic, () => latest.current()), [signals, topic]);
}

/** Whether the document is currently hidden; `false` where there is no document. */
export function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
