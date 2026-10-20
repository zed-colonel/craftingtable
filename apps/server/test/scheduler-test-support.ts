import { expect } from 'vitest';
import { ManualClock } from './cycle-test-support.js';
import {
  openQuestions,
  type Ready,
  roadmapControl,
  roadmapFixture,
  saveRoadmapRequest,
  storedRoadmap,
  waitUntil,
} from './execution-test-support.js';

/**
 * The roadmap scheduler's and delivery's free-running tests (R-B5 part 2). Their daemons run on a
 * kernel clock the test moves, so no sweep and no due time comes unless the test moves it: a
 * round that follows a release is the release's mark, not the sweep (increment 8 review HIGH-1).
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Passes = { readonly idle: ReadonlyMap<string, () => boolean> };

/** Both controllers have nothing marked and no round in flight, three looks running. */
export async function quiet(state: Ready): Promise<void> {
  const idle = (state.context.services.controllerPasses as unknown as Passes).idle;
  let calm = 0;
  await waitUntil(() => {
    calm = idle.get('roadmaps')?.() !== false && idle.get('cycles')?.() !== false ? calm + 1 : 0;
    return calm >= 3;
  }, 'the controllers are quiet');
}

/**
 * A free-running daemon on a manual clock whose sequential roadmap runs, waiting on its first
 * entry's cycle, which stopped on its design's open questions (R-C10's decision 1: the roadmap
 * keeps running).
 */
export async function waitingRoadmap(clock = new ManualClock()) {
  const fixture = await roadmapFixture([openQuestions], {
    workers: true,
    now: clock.date,
    kernelClock: clock,
  });
  const { state } = fixture;
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  await waitUntil(() => {
    const attempt = storedRoadmap(state, false)?.attempts[0];
    return (
      attempt !== undefined &&
      state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)?.status ===
        'needs-attention'
    );
  }, 'the design stopped on its questions');
  expect(storedRoadmap(state).status).toBe('running');
  await quiet(state);
  return { ...fixture, clock };
}

/** Counts calls of one of the service's methods; the loop looks each up as it calls it. */
export function counted<T extends object>(
  service: T,
  method: string,
): { readonly calls: () => number } {
  const target = service as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = target[method];
  if (typeof original !== 'function') throw new Error(`No method ${method}`);
  let calls = 0;
  target[method] = function (this: unknown, ...args: unknown[]) {
    calls += 1;
    return original.apply(this, args);
  };
  return { calls: () => calls };
}

/** The roadmap drain's kernel and waiters, as the tests read them. */
export function drainOf(state: Ready) {
  const service = state.context.services.roadmapService as unknown as {
    kernel: { causes: ReadonlyMap<string, number>; nextDue(): number | undefined };
    lockWaiters: ReadonlyMap<string, ReadonlySet<string>>;
  };
  return {
    /** Every mark made so far, of any cause. */
    marks: () => [...service.kernel.causes.values()].reduce((sum, n) => sum + n, 0),
    /** Marks of one cause made so far. */
    cause: (cause: string) => service.kernel.causes.get(cause) ?? 0,
    /** The earliest due time armed, if any. */
    nextDue: () => service.kernel.nextDue(),
    /** The roadmaps waiting on a lock's release. */
    waiters: (key: string) => [...(service.lockWaiters.get(key) ?? [])],
  };
}
