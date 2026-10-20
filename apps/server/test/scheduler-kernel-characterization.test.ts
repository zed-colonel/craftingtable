import type { WriteObserver } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { ManualClock } from './cycle-test-support.js';
import {
  cleanupExecutionFixtures,
  roadmapControl,
  roadmapFixture,
  roadmapInput,
  saveRoadmapRequest,
  storedRoadmap,
  useIntegration,
  waitUntil,
} from './execution-test-support.js';
import { counted, drainOf, quiet, sleep, waitingRoadmap } from './scheduler-test-support.js';

/**
 * What the roadmap scheduler's and delivery's timing are on a free-running daemon, where the
 * replays and the stepped tests cannot pin them (R-B5 part 2, increment 8; characterize before
 * refactoring). Their time windows (a preparation's retry, the re-verify's settle, delivery's
 * settle, quiescence and grace) are pinned by stepped tests, which part 2 leaves as they are;
 * these pin the poll itself and what only the poll found. The daemons run on a kernel clock the
 * test moves, so no sweep comes. Assertions that part 2 flipped say what they were before.
 */

afterEach(cleanupExecutionFixtures);

it('looks at a running roadmap only on a mark, with nothing written (flipped by increment 9)', async () => {
  // Before increment 9 the one-second wake (R-C10 decision 1) advanced it twice or three times
  // in this window, with nothing written.
  const { state } = await waitingRoadmap();
  const service = state.context.services.roadmapService;
  const drain = drainOf(state);
  const advances = counted(service, 'advance');
  const marks = drain.marks();
  await sleep(2_600);
  // No look without a mark (a stray write elsewhere in the daemon would be one), and none due.
  expect(advances.calls()).toBeLessThanOrEqual(drain.marks() - marks);
  expect(drain.nextDue()).toBeUndefined();
  const looked = advances.calls();
  service.wake('test');
  await waitUntil(() => advances.calls() === looked + 1, 'a look on the mark');
});

it('tries a swallowed failure again at the next mark, not on every pass (flipped by increment 9, decision 19)', async () => {
  // Before increment 9 a decision preparation that failed was tried again on every pass.
  const { state } = await waitingRoadmap();
  const service = state.context.services.roadmapService as unknown as {
    prepareNeededDecisions: () => Promise<void>;
    wake: (cause: 'test') => void;
  };
  let failed = 0;
  service.prepareNeededDecisions = async () => {
    failed += 1;
    throw new Error('a decision preparation failed');
  };
  const drain = drainOf(state);
  const marks = drain.marks();
  await sleep(2_600);
  // Tried again only when something marks the roadmap: no due time is armed for it.
  expect(failed).toBeLessThanOrEqual(drain.marks() - marks);
  expect(drain.nextDue()).toBeUndefined();
  const tried = failed;
  service.wake('test');
  await waitUntil(() => failed === tried + 1, 'tried again at the mark');
  await quiet(state);
  expect(drain.nextDue()).toBeUndefined();
  // The roadmap keeps running: the failure is swallowed, not a stop.
  expect(storedRoadmap(state).status).toBe('running');
});

it('wakes delivery every five seconds with nothing to deliver (flips: delivery runs only on marks)', async () => {
  const { state } = await waitingRoadmap();
  const rounds = counted(state.context.services.notificationService, 'deliverDue');
  await sleep(5_600);
  expect(rounds.calls()).toBeGreaterThanOrEqual(1);
});

it('completes no roadmap pass while admissions are held, and passes again at their release', async () => {
  const { state } = await waitingRoadmap();
  const service = state.context.services.roadmapService;
  const passes = state.context.services.controllerPasses;
  const completed = () =>
    (passes as unknown as { workers: ReadonlyMap<string, number> }).workers.get('roadmaps') ?? -1;
  service.holdAdmissions(true);
  // No round is in flight once the hold is set (the scheduler is not idle while it holds).
  await waitUntil(
    () => (service as unknown as { rounding?: Promise<void> }).rounding === undefined,
    'no round in flight',
  );
  const opened = passes.current;
  const held = completed();
  service.wake('test');
  await sleep(1_000);
  expect(completed()).toBe(held);
  // So the scheduler does not count as quiet during a drain: a first push waits.
  expect(passes.quietSince(opened)).toBe(false);
  service.holdAdmissions(false);
  await waitUntil(() => passes.quietSince(opened), 'quiet once a pass follows the release');
  expect(completed()).toBeGreaterThan(held);
});

/** A roadmap whose single entry the scheduler merges itself, on a manual kernel clock. */
async function delegatedMerge() {
  const clock = new ManualClock();
  const fixture = await roadmapFixture(undefined, {
    workers: true,
    now: clock.date,
    kernelClock: clock,
  });
  await useIntegration(fixture);
  const start = async () => {
    await saveRoadmapRequest(fixture.state, {
      ...roadmapInput(fixture.state, [fixture.state.workItemId]),
      automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
    });
    await roadmapControl(fixture.state, 'start');
  };
  const repositoryPath = fixture.repository.rootPath;
  return { ...fixture, clock, start, repositoryPath };
}

it('merges once a merge lane it met is released, with nothing written (a release mark since increment 9)', async () => {
  const { state, start, repositoryPath } = await delegatedMerge();
  const execution = state.context.services.executionService;
  // The lane is taken as the scheduler first tries the merge, so the review is done and only
  // the merge meets it: the merge is refused as busy.
  let release: () => void = () => undefined;
  let held: Promise<void> | undefined;
  let attempts = 0;
  const merge = execution.mergeWorktree.bind(execution);
  execution.mergeWorktree = (...args: Parameters<typeof merge>) => {
    attempts += 1;
    held ??= execution.branches.duringMerge(
      repositoryPath,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    return merge(...args);
  };
  const advances = counted(state.context.services.roadmapService, 'advance');
  try {
    await start();
    await waitUntil(() => attempts >= 1, 'the delegated merge was tried');
    const looked = advances.calls();
    // Each look meanwhile finds the lane held in its integration refresh, before the merge.
    await sleep(1_500);
    expect(attempts).toBe(1);
    expect(storedRoadmap(state).status).toBe('running');
    expect(advances.calls()).toBe(looked);
  } finally {
    release();
  }
  await held;
  // No sweep comes on this clock: only the release's mark can bring the merge.
  await waitUntil(() => storedRoadmap(state).status === 'completed', 'merged once the lane freed');
});

it('merges once a merge lane its first look met in the refresh is released (the silent path)', async () => {
  // The lane is taken as the review's cycle reaches its merge, before the scheduler looks: its
  // integration refresh answers that the lane is held and the entry moves on, nothing thrown
  // (increment 8 review MEDIUM-4).
  const { state, start, repositoryPath } = await delegatedMerge();
  const execution = state.context.services.executionService;
  let release: () => void = () => undefined;
  let held: Promise<void> | undefined;
  let merges = 0;
  const merge = execution.mergeWorktree.bind(execution);
  execution.mergeWorktree = (...args: Parameters<typeof merge>) => {
    merges += 1;
    return merge(...args);
  };
  const observer: WriteObserver = {
    written(kind, record) {
      if (
        held === undefined &&
        kind === 'work-cycle' &&
        (record as { status?: string }).status === 'awaiting-merge'
      )
        held = execution.branches.duringMerge(
          repositoryPath,
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
    },
    beforeCommit() {},
    ended() {},
  };
  state.context.storage.observeWrites(observer);
  const advances = counted(state.context.services.roadmapService, 'advance');
  try {
    await start();
    await waitUntil(() => held !== undefined, 'the review reached its merge');
    await waitUntil(() => advances.calls() >= 1, 'the scheduler looked');
    await quiet(state);
    expect(merges).toBe(0);
    expect(storedRoadmap(state).status).toBe('running');
  } finally {
    release();
  }
  await held;
  await waitUntil(() => storedRoadmap(state).status === 'completed', 'merged once the lane freed');
  expect(merges).toBe(1);
});
