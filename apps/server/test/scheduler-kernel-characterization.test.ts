import { createGitOperations } from '@craftingtable/git';
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
  expect(advances.calls()).toBeLessThanOrEqual(2);
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
  expect(failed).toBeLessThanOrEqual(2);
  expect(drain.nextDue()).toBeUndefined();
  const tried = failed;
  service.wake('test');
  await waitUntil(() => failed === tried + 1, 'tried again at the mark');
  await quiet(state);
  expect(drain.nextDue()).toBeUndefined();
  // The roadmap keeps running: the failure is swallowed, not a stop.
  expect(storedRoadmap(state).status).toBe('running');
});

it('runs delivery only on a mark or at its due time (flipped by increment 10)', async () => {
  // Before increment 10 delivery ran every five seconds with nothing to deliver.
  const { state, clock } = await waitingRoadmap();
  const delivery = state.context.services.notificationService;
  const rounds = counted(delivery, 'deliverDue');
  const marks = () => [...delivery.kernel.causes.values()].reduce((sum, n) => sum + n, 0);
  const before = marks();
  await sleep(5_600);
  expect(rounds.calls()).toBeLessThanOrEqual(marks() - before);
  // The stopped cycle's item waits for its settle window: delivery looks again when it ends.
  const due = delivery.kernel.nextDue();
  expect(due).toBeGreaterThan(clock.now());
  const looked = rounds.calls();
  clock.advance((due ?? 0) - clock.now());
  await waitUntil(() => rounds.calls() > looked, 'delivery at its due time');
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
  // the merge meets it: the merge is refused as busy. It is taken outside the scheduler's round,
  // as another operation's would be, or its release would count as the round's own (increment 9
  // review M-2).
  const ownRound = (
    state.context.services.roadmapService as unknown as {
      ownRound: { exit<T>(callback: () => T): T };
    }
  ).ownRound;
  let release: () => void = () => undefined;
  let held: Promise<void> | undefined;
  let attempts = 0;
  const merge = execution.mergeWorktree.bind(execution);
  execution.mergeWorktree = (...args: Parameters<typeof merge>) => {
    attempts += 1;
    held ??= ownRound.exit(() =>
      execution.branches.duringMerge(
        repositoryPath,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    );
    return merge(...args);
  };
  const advances = counted(state.context.services.roadmapService, 'advance');
  const drain = drainOf(state);
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
  const released = drain.cause('release');
  await held;
  // No sweep comes on this clock: the release's mark brings the merge.
  expect(drain.cause('release')).toBe(released + 1);
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

it("tries a merge refused as target-moved again a second on, not at its own refusal's writes", async () => {
  // Its reservation and refusal are waking writes: without its not-before time the three quick
  // retries would run back to back (part 2 review MEDIUM-2).
  const clock = new ManualClock();
  const real = createGitOperations({ gitExecutable: 'git' });
  let merges = 0;
  const fixture = await roadmapFixture(undefined, {
    workers: true,
    now: clock.date,
    kernelClock: clock,
    gitOperations: {
      ...real,
      mergeBranch: async (input) => {
        merges += 1;
        if (merges === 1)
          return {
            ok: false,
            failure: {
              kind: 'target-moved',
              message: 'The target moved while it was merged into.',
            },
          };
        return real.mergeBranch(input);
      },
    },
  });
  const { state } = fixture;
  await useIntegration(fixture);
  await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  await roadmapControl(state, 'start');
  await waitUntil(() => merges === 1, 'the merge refused as target-moved');
  const refusedAt = clock.now();
  await quiet(state);
  expect(merges).toBe(1);
  expect(drainOf(state).nextDue()).toBe(refusedAt + 1000);
  clock.advance(1000);
  await waitUntil(() => storedRoadmap(state).status === 'completed', 'merged a second on');
  expect(merges).toBe(2);
});
