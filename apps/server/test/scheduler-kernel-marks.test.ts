import type { WorkCycleId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import {
  ConcurrentModificationError,
  RepositoryMutationBusyError,
} from '../src/services/errors.js';
import { PhaseGateError } from '../src/services/phase-resources.js';
import { cleanupExecutionFixtures, storedRoadmap, waitUntil } from './execution-test-support.js';
import { counted, drainOf, quiet, sleep, waitingRoadmap } from './scheduler-test-support.js';

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
  const rounds = counted(service, 'roundBody');
  const target = service as unknown as Advance;
  const advance = target.advance.bind(service);
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
  const rounds = counted(service, 'roundBody');
  const branches = state.context.services.executionService.branches;
  const target = service as unknown as Advance;
  const advance = target.advance.bind(service);
  target.advance = async (...args: unknown[]) => {
    await branches.duringMerge(repository.rootPath, async () => undefined);
    return advance(...args);
  };
  // Another roadmap waits on the lane: the own round's release does not wake it either.
  (service as unknown as { waitOnLock(id: string, key: string): void }).waitOnLock(
    'another-roadmap',
    'lane',
  );
  const released = drain.cause('release');
  service.wake('test');
  await waitUntil(() => rounds.calls() >= 1, 'a round');
  await quiet(state);
  await sleep(1_000);
  expect(drain.cause('release')).toBe(released);
  expect(drain.waiters('lane')).toEqual(['another-roadmap']);
  await timerFires();
});

it("looks again when its cycle's transition ends (a release, not a write)", async () => {
  const fixture = await waitingRoadmap();
  const { state } = fixture;
  const service = state.context.services.roadmapService;
  const drain = drainOf(state);
  const rounds = counted(service, 'roundBody');
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
  const rounds = counted(service, 'roundBody');
  service.holdAdmissions(true);
  await waitUntil(
    () => (service as unknown as { rounding?: Promise<void> }).rounding === undefined,
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
