import type { WorkCycleId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import {
  ConcurrentModificationError,
  RepositoryMutationBusyError,
} from '../src/services/errors.js';
import { PhaseGateError } from '../src/services/phase-resources.js';
import { ManualClock } from './cycle-test-support.js';
import {
  cleanupExecutionFixtures,
  roadmapControl,
  roadmapFixture,
  saveRoadmapRequest,
  storedRoadmap,
  waitUntil,
} from './execution-test-support.js';
import {
  counted,
  moduleOf,
  drainOf,
  quiet,
  sleep,
  waitingRoadmap,
} from './scheduler-test-support.js';

/**
 * What wakes the roadmap scheduler now that it does not look every second (R-B5 part 2,
 * increment 9), and that nothing makes it spin (the part 2 design review's HIGH-1, HIGH-2 and
 * MEDIUM-5): a lock it met busy wakes it at that lock's release, a lost race a second on, a gate
 * that waits by the write that clears it; its own locks and an admissions hold never wake it.
 * The daemons run on a kernel clock the test moves, so no sweep and no due time comes by itself;
 * the assertions read the drain's own due times and waiters, and a stray write elsewhere in the
 * daemon (its storage timers) can only add a round that a mark explains.
 */

afterEach(cleanupExecutionFixtures);

type Advance = { advance: (...args: unknown[]) => Promise<void> };

/** Makes the roadmap's units throw `error` while `when` holds; its rounds are counted. */
async function failing(error: () => Error, when: () => boolean = () => true) {
  const fixture = await waitingRoadmap();
  const service = fixture.state.context.services.roadmapService;
  const rounds = counted(moduleOf(service, 'drain'), 'roundBody');
  const target = moduleOf(service, 'admission') as Advance;
  const advance = target.advance.bind(target);
  target.advance = async (...args: unknown[]) => {
    if (when()) throw error();
    return advance(...args);
  };
  return { ...fixture, service, rounds, drain: drainOf(fixture.state) };
}

/** A 50 ms timer fires beside the scheduler: its rounds never starve the event loop. */
async function timerFires(): Promise<void> {
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 50);
  await sleep(200);
  expect(fired).toBe(true);
}

it('looks again a second after a lost race, by a due time', async () => {
  let lost = true;
  const { state, service, rounds, clock, drain } = await failing(
    () => new ConcurrentModificationError('A newer version'),
    () => lost,
  );
  service.wake('test');
  await waitUntil(() => rounds.calls() >= 1, 'the round that lost');
  await quiet(state);
  expect(drain.nextDue()).toBe(clock.now() + 1000);
  lost = false;
  const due = drain.cause('due');
  clock.advance(1000);
  await waitUntil(() => drain.cause('due') === due + 1, 'the look a second on');
  await quiet(state);
  // Once: nothing more is due.
  expect(drain.nextDue()).toBeUndefined();
});

it('takes no due time for a gate that waits: its clearing write wakes the roadmap (review HIGH-2)', async () => {
  const { state, service, rounds, drain } = await failing(
    () =>
      new PhaseGateError([
        { code: 'resource-busy', message: 'The host is busy', resource: 'cpu' } as never,
      ]),
  );
  service.wake('test');
  await waitUntil(() => rounds.calls() >= 1, 'the round that waited');
  await quiet(state);
  expect(drain.nextDue()).toBeUndefined();
  const marks = drain.marks();
  const looked = rounds.calls();
  await sleep(1_000);
  // No round without a mark: nothing polls it.
  expect(rounds.calls() - looked).toBeLessThanOrEqual(drain.marks() - marks);
  expect(rounds.calls() - looked).toBeLessThanOrEqual(2);
  await timerFires();
});

it('looks again when a lock it met busy is released, and only then (review HIGH-1, HIGH-2)', async () => {
  const { state, repository, service, rounds, drain } = await failing(
    () => new RepositoryMutationBusyError(),
  );
  const branches = state.context.services.executionService.branches;
  let release: () => void = () => undefined;
  const held = branches.duringMerge(
    repository.rootPath,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const id = storedRoadmap(state).id;
  service.wake('test');
  await waitUntil(() => rounds.calls() >= 1, 'the round that met the lane');
  await quiet(state);
  expect(drain.nextDue()).toBeUndefined();
  expect(drain.waiters('lane')).toEqual([id]);
  const released = drain.cause('release');
  const looked = rounds.calls();
  release();
  await held;
  await waitUntil(() => rounds.calls() > looked, "the look at the lane's release");
  expect(drain.cause('release')).toBe(released + 1);
  // Once: it met the lane again (the test's throw), and waits on its next release.
  await quiet(state);
  expect(drain.waiters('lane')).toEqual([id]);
});

it('is not woken by the locks its own round takes and releases (review HIGH-1)', async () => {
  // As a settled preparation's worktree that cannot be removed: the unit takes the merge lane,
  // writes nothing and releases it, every round.
  const fixture = await waitingRoadmap();
  const { state, repository } = fixture;
  const service = state.context.services.roadmapService;
  const drain = drainOf(state);
  const rounds = counted(moduleOf(service, 'drain'), 'roundBody');
  const branches = state.context.services.executionService.branches;
  const target = moduleOf(service, 'admission') as Advance;
  const advance = target.advance.bind(target);
  target.advance = async (...args: unknown[]) => {
    await branches.duringMerge(repository.rootPath, async () => undefined);
    return advance(...args);
  };
  // Another roadmap waits on the lane: the own round's release does not wake it either.
  (
    service as unknown as { state: { lockWaiters: Map<string, Set<string>> } }
  ).state.lockWaiters.set('lane', new Set(['another-roadmap']));
  const released = drain.cause('release');
  service.wake('test');
  await waitUntil(() => rounds.calls() >= 1, 'a round');
  await quiet(state);
  const settled = rounds.calls();
  await sleep(1_000);
  expect(rounds.calls() - settled).toBeLessThanOrEqual(2);
  expect(drain.cause('release')).toBe(released);
  expect(drain.waiters('lane')).toEqual(['another-roadmap']);
  await timerFires();
});

it("looks again when its cycle's transition ends (a release, not a write)", async () => {
  const fixture = await waitingRoadmap();
  const { state } = fixture;
  const service = state.context.services.roadmapService;
  const drain = drainOf(state);
  const rounds = counted(moduleOf(service, 'drain'), 'roundBody');
  const cycleId = storedRoadmap(state).attempts[0]?.cycleId as WorkCycleId;
  const locks = (
    state.context.services.workCycleService as unknown as {
      locks: { duringTransition<T>(id: WorkCycleId, operation: () => Promise<T>): Promise<T> };
    }
  ).locks;
  let release: () => void = () => undefined;
  const transition = locks.duringTransition(
    cycleId,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  service.wake('test');
  await waitUntil(() => rounds.calls() >= 1, 'the round that met the transition');
  await quiet(state);
  expect(drain.waiters(`cycle:${cycleId}`)).toEqual([storedRoadmap(state).id]);
  const released = drain.cause('release');
  const looked = rounds.calls();
  release();
  await transition;
  await waitUntil(() => rounds.calls() > looked, "the look at the transition's end");
  expect(drain.cause('release')).toBeGreaterThan(released);
  expect(drain.waiters(`cycle:${cycleId}`)).toEqual([]);
});

it('runs no round and does not spin while admissions are held; their release looks again (review MEDIUM-5)', async () => {
  const { state } = await waitingRoadmap();
  const service = state.context.services.roadmapService;
  const rounds = counted(moduleOf(service, 'drain'), 'roundBody');
  service.holdAdmissions(true);
  await waitUntil(
    () =>
      (service as unknown as { state: { rounding?: Promise<void> } }).state.rounding === undefined,
    'no round in flight',
  );
  const before = rounds.calls();
  for (let i = 0; i < 3; i++) service.wake('test');
  await sleep(1_000);
  // The marks are taken and dropped: no round, whatever marks it meanwhile.
  expect(rounds.calls()).toBe(before);
  await timerFires();
  // Not quiet: a first push waits during a drain, as before.
  const passes = state.context.services.controllerPasses;
  expect(passes.quietSince(passes.current)).toBe(false);
  service.holdAdmissions(false);
  await waitUntil(() => rounds.calls() > before, 'the round at the release');
});

it('asks no due time for a wind-down past its session limit, and does not spin on it (review HIGH-1)', async () => {
  const { state, clock } = await waitingRoadmap();
  const service = state.context.services.roadmapService;
  const drain = drainOf(state);
  const rounds = counted(moduleOf(service, 'drain'), 'roundBody');
  const roadmap = storedRoadmap(state);
  // A wind-down still settling (its step failing, or waiting on a session that never ends), its
  // request eleven minutes old.
  const record = {
    workspaceId: roadmap.workspaceId,
    roadmapId: roadmap.id,
    status: 'settling',
    requestedAt: new Date(clock.now() - 11 * 60_000).toISOString(),
  };
  const windDowns = state.context.storage.windDowns as unknown as {
    settling: () => unknown[];
    find: () => unknown;
  };
  windDowns.settling = () => [record];
  windDowns.find = () => record;
  const settlement = (service as unknown as { settlement: { resume: () => Promise<void> } })
    .settlement;
  settlement.resume = async () => undefined;
  service.wake('test');
  await waitUntil(() => rounds.calls() >= 1, 'a round');
  await quiet(state);
  expect(drain.nextDue()).toBeUndefined();
  const settled = rounds.calls();
  await sleep(1_000);
  expect(rounds.calls() - settled).toBeLessThanOrEqual(2);
  // Before its limit, it is looked at when the limit comes.
  record.requestedAt = new Date(clock.now() - 60_000).toISOString();
  service.wake('test');
  await waitUntil(() => rounds.calls() > settled, 'a round');
  await quiet(state);
  expect(drain.nextDue()).toBe(Date.parse(record.requestedAt) + 10 * 60_000 + 1);
});

it("is swept with the cycle controller's sweep, delivery too: one timer for every drain", async () => {
  const { state, clock } = await waitingRoadmap();
  const drain = drainOf(state);
  const delivery = state.context.services.notificationService.kernel;
  const swept = drain.cause('sweep');
  const deliverySwept = delivery.causes.get('sweep') ?? 0;
  clock.advance(30_000);
  await waitUntil(() => drain.cause('sweep') === swept + 1, "the scheduler's sweep");
  expect(delivery.causes.get('sweep') ?? 0).toBe(deliverySwept + 1);
});

it("looks again when a roadmap command's hold on it ends (endControl)", async () => {
  const { state } = await waitingRoadmap();
  const service = (
    state.context.services.roadmapService as unknown as {
      state: { controlling: Set<string>; endControl(id: string): void };
    }
  ).state;
  const drain = drainOf(state);
  const id = storedRoadmap(state).id;
  service.controlling.add(id);
  const released = drain.cause('release');
  service.endControl(id);
  expect(drain.cause('release')).toBe(released + 1);
});

it('marks at the round end the roadmaps that met a lock after its release in that round (releasedMeanwhile)', async () => {
  // The refresh answers after an await: a lock released during that await is released before the
  // roadmap records its wait on it.
  const fixture = await waitingRoadmap();
  const { state } = fixture;
  const service = state.context.services.roadmapService;
  const rounds = counted(moduleOf(service, 'drain'), 'roundBody');
  const target = moduleOf(service, 'admission') as Advance;
  const roadmapState = (
    service as unknown as { state: { waitOnLock(id: string, key: string): void } }
  ).state;
  // Its units write nothing, so only the release can bring another round.
  let gate: () => void = () => undefined;
  let entered = false;
  let once = true;
  target.advance = async () => {
    if (once) {
      once = false;
      entered = true;
      await new Promise<void>((resolve) => {
        gate = resolve;
      });
      roadmapState.waitOnLock(storedRoadmap(state).id, 'lane');
    }
  };
  const drain = drainOf(state);
  service.wake('test');
  await waitUntil(() => entered, 'the round is in its await');
  const looked = rounds.calls();
  const released = drain.cause('release');
  // Released outside the round, while it awaits; the roadmap records its wait after.
  service.lockReleased('lane');
  // No waiter yet: the release itself marks nothing.
  expect(drain.cause('release')).toBe(released);
  gate();
  // The round's end marks the roadmap that met the lane after its release, once.
  await waitUntil(() => drain.cause('release') === released + 1, 'the mark at the round end');
  await waitUntil(() => rounds.calls() > looked, 'the look the release owes it');
});

it('lets timers run between rounds that mark themselves (the macrotask between rounds)', async () => {
  const fixture = await waitingRoadmap();
  const { state } = fixture;
  const service = state.context.services.roadmapService;
  const target = moduleOf(service, 'admission') as Advance;
  const advance = target.advance.bind(target);
  let marking = true;
  target.advance = async (...args: unknown[]) => {
    if (marking) service.wake('test');
    return advance(...args);
  };
  try {
    service.wake('test');
    await timerFires();
  } finally {
    marking = false;
  }
});

it("takes no marks while a test's tick runs, so none is lost (the loop waits for it)", async () => {
  const fixture = await waitingRoadmap();
  const { state } = fixture;
  const service = state.context.services.roadmapService;
  const rounds = counted(moduleOf(service, 'drain'), 'roundBody');
  const target = moduleOf(service, 'admission') as Advance;
  // Its units write nothing, so only the mark made during the tick can bring another round.
  let gate: () => void = () => undefined;
  let held = true;
  target.advance = async () => {
    if (held) {
      held = false;
      await new Promise<void>((resolve) => {
        gate = resolve;
      });
    }
  };
  // Every batch of marks the loop takes reaches a round: none is taken and dropped.
  const kernel = (service as unknown as { state: { kernel: { take(): unknown } } }).state.kernel;
  const taken: unknown[] = [];
  const take = kernel.take.bind(kernel);
  kernel.take = () => {
    const marked = take();
    if (marked !== undefined) taken.push(marked);
    return marked;
  };
  const ran: unknown[] = [];
  const drainModule = moduleOf(service, 'drain') as { roundBody(marked: unknown): Promise<void> };
  const body = drainModule.roundBody;
  drainModule.roundBody = function (this: unknown, marked: unknown) {
    ran.push(marked);
    return body.call(this, marked);
  };
  const tick = service.tick();
  await waitUntil(() => rounds.calls() === 1, "the test's tick is in flight");
  // Marked by key, so the loop takes a set of its own, not the `'all'` every round shares
  // (increment 12 review MEDIUM-2).
  (
    service as unknown as { state: { kernel: { mark(cause: string, keys: string[]): void } } }
  ).state.kernel.mark('test', [storedRoadmap(state).id]);
  await sleep(100);
  gate();
  await tick;
  await waitUntil(() => taken.length >= 1, 'the mark taken after the tick');
  await quiet(state);
  // Every batch taken ran a round of its own: the rounds are the test's tick and one per batch
  // (a batch taken while the tick ran, and dropped, would leave one fewer).
  expect(ran.length).toBe(taken.length + 1);
});

it("waits on the merge lane an entry's blocker found busy, and starts it at the release", async () => {
  // No attempt yet: the blocker asks whether the repository is busy before starting the entry.
  const clock = new ManualClock();
  const fixture = await roadmapFixture(undefined, {
    workers: true,
    now: clock.date,
    kernelClock: clock,
  });
  const { state, repository } = fixture;
  const branches = state.context.services.executionService.branches;
  let release: () => void = () => undefined;
  const held = branches.duringMerge(
    repository.rootPath,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  await quiet(state);
  expect(storedRoadmap(state).attempts).toHaveLength(0);
  expect(drainOf(state).waiters('lane')).toEqual([storedRoadmap(state).id]);
  release();
  await held;
  await waitUntil(() => storedRoadmap(state).attempts.length === 1, 'the entry started');
});

it('is not idle for the pushes while a retry is due within seconds (increment 9 review LOW-5)', async () => {
  const { state, service, rounds, clock } = await failing(
    () => new ConcurrentModificationError('A newer version'),
  );
  const idle = (
    state.context.services.controllerPasses as unknown as {
      idle: ReadonlyMap<string, () => boolean>;
    }
  ).idle;
  service.wake('test');
  await waitUntil(() => rounds.calls() >= 1, 'the round that lost');
  await quiet(state);
  expect(idle.get('roadmaps')?.()).toBe(false);
  // Its look is now more than five seconds off: idle again.
  clock.step(-10_000);
  expect(idle.get('roadmaps')?.()).toBe(true);
});

it('records no waiter outside a round: a read of the board waits on nothing (increment 9 review LOW-4)', async () => {
  const { state } = await waitingRoadmap();
  const service = (
    state.context.services.roadmapService as unknown as {
      state: { waitOnLock(id: string, key: string): void };
    }
  ).state;
  service.waitOnLock(storedRoadmap(state).id, 'lane');
  expect(drainOf(state).waiters('lane')).toEqual([]);
});

it("does not mark the cycle for a refresh the scheduler's call found in flight (increment 9 review M-1)", async () => {
  const { state } = await waitingRoadmap();
  const cycles = state.context.services.workCycleService;
  const cycleId = storedRoadmap(state).attempts[0]?.cycleId as WorkCycleId;
  const kernel = (cycles as unknown as { kernel: { causes: ReadonlyMap<string, number> } }).kernel;
  const locks = (cycles as unknown as { locks: { refreshing: Set<string> } }).locks;
  const released = kernel.causes.get('release') ?? 0;
  locks.refreshing.add(cycleId);
  try {
    const cycle = state.context.storage.execution.cycles.find(state.workspaceId, cycleId);
    if (!cycle) throw new Error('no cycle');
    expect(await cycles.refreshIntegration(cycle)).toBe(true);
    await sleep(50);
    expect(kernel.causes.get('release') ?? 0).toBe(released);
  } finally {
    locks.refreshing.delete(cycleId);
  }
});

it('keeps the cycle controller from counting as idle while a look is due within seconds (increment 9 review LOW-5)', async () => {
  const { state, clock } = await waitingRoadmap();
  const idle = (
    state.context.services.controllerPasses as unknown as {
      idle: ReadonlyMap<string, () => boolean>;
    }
  ).idle;
  const kernel = (
    state.context.services.workCycleService as unknown as {
      kernel: { dueAt(key: string, at: number | undefined): void };
    }
  ).kernel;
  expect(idle.get('cycles')?.()).toBe(true);
  kernel.dueAt('a-retry', clock.now() + 1000);
  expect(idle.get('cycles')?.()).toBe(false);
  kernel.dueAt('a-retry', undefined);
  expect(idle.get('cycles')?.()).toBe(true);
});
