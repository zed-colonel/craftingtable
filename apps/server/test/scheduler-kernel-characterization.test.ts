import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  openQuestions,
  roadmapControl,
  roadmapFixture,
  roadmapInput,
  saveRoadmapRequest,
  storedRoadmap,
  useIntegration,
  waitUntil,
} from './execution-test-support.js';

/**
 * What the roadmap scheduler's and delivery's timing are today on a free-running daemon, where
 * the replays and the stepped tests cannot pin them (R-B5 part 2, increment 8; characterize
 * before refactoring). Their time windows (a preparation's retry, the re-verify's settle,
 * delivery's settle, quiescence and grace) are pinned by stepped tests on a clock the test moves,
 * which part 2 leaves as they are; these pin the poll itself and what only the poll finds. The
 * assertions marked "flips" change with part 2, as R-B5's entry says.
 */

afterEach(cleanupExecutionFixtures);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A free-running daemon whose sequential roadmap runs, waiting on its first entry's cycle, which
 * stopped on its design's open questions (R-C10's decision 1: the roadmap keeps running).
 */
async function waitingRoadmap() {
  const fixture = await roadmapFixture([openQuestions], { workers: true });
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
  // Whatever followed the stop has settled.
  await sleep(500);
  return fixture;
}

/** Counts calls of one of the service's methods; the loop looks each up as it calls it. */
function counted<T extends object>(service: T, method: string): { readonly calls: () => number } {
  const target = service as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = target[method] as (...args: unknown[]) => unknown;
  let calls = 0;
  target[method] = function (this: unknown, ...args: unknown[]) {
    calls += 1;
    return original.apply(this, args);
  };
  return { calls: () => calls };
}

it('ticks a running roadmap about once a second with nothing written (flips: rounds only on marks)', async () => {
  const { state } = await waitingRoadmap();
  const ticks = counted(state.context.services.roadmapService, 'tick');
  await sleep(2_600);
  // Today's one-second wake (R-C10 decision 1): two or three ticks. Part 2: none but the sweep's.
  expect(ticks.calls()).toBeGreaterThanOrEqual(2);
});

it('tries a swallowed failure again on the next pass (flips with decision 19: at the next mark)', async () => {
  const { state } = await waitingRoadmap();
  const service = state.context.services.roadmapService as unknown as {
    prepareNeededDecisions: () => Promise<void>;
  };
  let failed = 0;
  service.prepareNeededDecisions = async () => {
    failed += 1;
    throw new Error('a decision preparation failed');
  };
  await sleep(2_600);
  expect(failed).toBeGreaterThanOrEqual(2);
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
  const passes = state.context.services.controllerPasses as unknown as {
    workers: ReadonlyMap<string, number>;
  };
  service.holdAdmissions(true);
  await sleep(300);
  const held = passes.workers.get('roadmaps');
  await sleep(2_300);
  expect(passes.workers.get('roadmaps')).toBe(held);
  // So the scheduler does not count as quiet during a drain: first pushes wait.
  expect(
    state.context.services.controllerPasses.quietSince(
      state.context.services.controllerPasses.current,
    ),
  ).toBe(false);
  service.holdAdmissions(false);
  await waitUntil(
    () => (passes.workers.get('roadmaps') ?? -1) > (held ?? -1),
    'a pass after the release',
  );
});

it('finds a released merge lane by itself and merges, with nothing written (a release mark after part 2)', async () => {
  const fixture = await roadmapFixture(undefined, { workers: true });
  const { state, root } = fixture;
  await useIntegration(fixture);
  const execution = state.context.services.executionService;
  // The lane is taken just as the scheduler first tries the delegated merge, so the review is
  // done and only the merge meets it.
  let release: () => void = () => undefined;
  let held: Promise<void> | undefined;
  let attempts = 0;
  const merge = execution.mergeWorktree.bind(execution);
  execution.mergeWorktree = (...args: Parameters<typeof merge>) => {
    attempts += 1;
    held ??= execution.branches.duringMerge(
      root,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    return merge(...args);
  };
  try {
    await saveRoadmapRequest(state, {
      ...roadmapInput(state, [state.workItemId]),
      automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
    });
    await roadmapControl(state, 'start');
    await waitUntil(() => attempts >= 1, 'the delegated merge was tried');
    // It met the held lane; each look meanwhile finds the repository busy (the blocker's
    // `repositoryBusy`) and does not try again, so part 2's release mark must reach a roadmap
    // the blocker held back too.
    await sleep(2_500);
    expect(attempts).toBe(1);
    expect(storedRoadmap(state).status).toBe('running');
  } finally {
    release();
  }
  await held;
  await waitUntil(() => storedRoadmap(state).status === 'completed', 'merged once the lane freed');
});
