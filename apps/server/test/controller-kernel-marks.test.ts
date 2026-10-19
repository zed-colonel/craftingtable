import type { WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import type { WorktreeMutationGuard } from '../src/services/worktree-mutation-guard.js';
import {
  type CycleFixture,
  createCycleFixture,
  ManualClock,
  storedCycle,
  storedRun,
} from './cycle-test-support.js';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  parallelFixture,
  roadmapControl,
  saveRoadmapRequest,
  startCycle,
  waitUntil,
} from './execution-test-support.js';

/**
 * What wakes the cycle controller now that it does not look every second (R-B5 increment 3): a
 * write, a due time, a lock's release. The kernel's clock is moved by hand, so no sweep and no
 * due time fires unless the test moves it: each test shows the one mark that woke the cycle.
 */

afterEach(cleanupExecutionFixtures);

async function freeRunning(): Promise<{ readonly f: CycleFixture; readonly clock: ManualClock }> {
  const clock = new ManualClock();
  const f = await createCycleFixture({ workers: true, now: clock.date, kernelClock: clock });
  return { f, clock };
}

const runLive = (f: CycleFixture, cycle: WorkCycle) =>
  storedRun(f, storedCycle(f, cycle.id).currentRunId)?.status === 'running';

const kernelOf = (f: CycleFixture) =>
  (
    f.services.workCycleService as unknown as {
      kernel: { readonly causes: ReadonlyMap<string, number>; nextDue(): number | undefined };
    }
  ).kernel;

it('wakes on a direct write that notified nothing, and stops at the deadline it wrote', async () => {
  const { f, clock } = await freeRunning();
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(() => runLive(f, cycle), 'the design run is live');
  const current = storedCycle(f, cycle.id);
  expect(
    f.context.storage.execution.cycles.replace(
      {
        ...current,
        runDeadlineAt: new Date(clock.now() - 1000).toISOString(),
        version: current.version + 1,
      },
      current.version,
    ),
  ).toBeTruthy();
  await waitUntil(() => storedCycle(f, cycle.id).stop?.code === 'step-time-limit', 'the stop');
});

it('finds a passed step deadline by its due time, with nothing written', async () => {
  const { f, clock } = await freeRunning();
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(() => runLive(f, cycle), 'the design run is live');
  const deadline = Date.parse(storedCycle(f, cycle.id).runDeadlineAt);
  await waitUntil(() => kernelOf(f).nextDue() === deadline, 'the deadline armed');
  clock.advance(deadline - clock.now() - 1);
  expect(storedCycle(f, cycle.id).status).toBe('running');
  clock.advance(1);
  await waitUntil(() => storedCycle(f, cycle.id).stop?.code === 'step-time-limit', 'the stop');
});

it("marks the cycles when a worktree's guard or a repository's merge lane is released", async () => {
  const { f } = await freeRunning();
  const guard = (f.services.storageService as unknown as { mutations: WorktreeMutationGuard })
    .mutations;
  const released = () => kernelOf(f).causes.get('release') ?? 0;
  let count = released();
  // A cycle that found its worktree or repository held idled; nothing else would wake it.
  await guard.during(f.worktreeId, 'merge', async () => undefined);
  expect(released()).toBe(++count);
  let end: () => void = () => undefined;
  guard.hold(
    f.worktreeId,
    new Promise<void>((resolve) => {
      end = resolve;
    }),
  );
  expect(released()).toBe(count);
  end();
  await new Promise((resolve) => setImmediate(resolve));
  expect(released()).toBe(++count);
  await guard.untilExited(f.worktreeId, Promise.resolve());
  expect(released()).toBe(++count);
  await f.services.executionService.branches.duringMerge('/repository', async () => undefined);
  expect(released()).toBe(++count);
});

it("marks a cycle when a command's transition on it ends", async () => {
  const { f } = await freeRunning();
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(() => runLive(f, cycle), 'the design run is live');
  const locks = (
    f.services.workCycleService as unknown as {
      locks: { duringTransition<T>(id: string, operation: () => Promise<T>): Promise<T> };
    }
  ).locks;
  const before = kernelOf(f).causes.get('release') ?? 0;
  await locks.duringTransition(cycle.id, async () => undefined);
  expect(kernelOf(f).causes.get('release')).toBe(before + 1);
});

it('takes a cycle once the investigation a command launches has started (its hold released)', async () => {
  const { f } = await freeRunning();
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(() => runLive(f, cycle), 'the design run is live');
  const locks = (
    f.services.workCycleService as unknown as {
      locks: {
        holdForCommand(id: string): void;
        releaseCommand(id: string): void;
        heldByCommand(id: string): boolean;
      };
    }
  ).locks;
  const before = kernelOf(f).causes.get('release') ?? 0;
  locks.holdForCommand(cycle.id);
  expect(locks.heldByCommand(cycle.id)).toBe(true);
  locks.releaseCommand(cycle.id);
  expect(locks.heldByCommand(cycle.id)).toBe(false);
  expect(kernelOf(f).causes.get('release')).toBe(before + 1);
});

it('does not run an awaiting-merge cycle with a refresh owner again and again (review HIGH-1)', async () => {
  const { state, root, input } = await parallelFixture({ workers: true });
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await awaitRoadmapMerge(state, 0);
  const causes = (
    state.context.services.workCycleService as unknown as {
      kernel: { readonly causes: ReadonlyMap<string, number> };
    }
  ).kernel.causes;
  const total = () => [...causes.values()].reduce((sum, n) => sum + n, 0);
  // Its refresh finds nothing new: before the fix every round marked its own cycle again,
  // about twenty rounds a second, three Git commands each.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const before = total();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(total() - before).toBeLessThan(10);
  // A refresh that returns before any I/O (the repository's merge lane held) never starves the
  // event loop: a timer beside it fires while the lane is held.
  let fired = false;
  const held = state.context.services.executionService.branches.duringMerge(
    root,
    () => new Promise<void>((resolve) => setTimeout(resolve, 300)),
  );
  setTimeout(() => {
    fired = true;
  }, 50);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(fired).toBe(true);
  await held;
});

it("marks a cycle when the scheduler's own integration refresh of it ends", async () => {
  const { f } = await freeRunning();
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(() => runLive(f, cycle), 'the design run is live');
  const before = kernelOf(f).causes.get('release') ?? 0;
  await f.services.workCycleService.refreshIntegration(storedCycle(f, cycle.id));
  await new Promise((resolve) => setImmediate(resolve));
  expect(kernelOf(f).causes.get('release')).toBe(before + 1);
});

it('wakes on a commit of tables the guard does not see, and not on one that changed nothing', async () => {
  const { f } = await freeRunning();
  const writes = () => kernelOf(f).causes.get('write') ?? 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = writes();
  // Nothing changed: no wake (delivery's and the scheduler's empty transactions, MEDIUM-1).
  f.context.storage.transaction(() => undefined);
  expect(writes()).toBe(before);
  // A phase reservation's release, a repository's registration: unguarded rows changed.
  f.context.storage.transaction((tx) => {
    tx.execution.sourceRepositories.retire({
      workspaceId: f.workspaceId,
      repositoryId: f.repositoryId as never,
      occurredAt: new Date().toISOString(),
    });
  });
  expect(writes()).toBe(before + 1);
});

it("counts the cycle controller quiet once it has nothing to look at (the push's quiescence)", async () => {
  // On the manual clock nothing but an event can start a round; the roadmap worker runs its
  // own loop. With nothing marked the cycles worker does not hold a first push back.
  const { f } = await freeRunning();
  const passes = f.services.controllerPasses;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const opened = passes.current;
  await waitUntil(() => passes.quietSince(opened), 'quiet: the roadmap worker passed once more');
});
