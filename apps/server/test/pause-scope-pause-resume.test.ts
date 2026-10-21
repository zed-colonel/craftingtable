import { afterEach, expect, it } from 'vitest';
import { roadmapAttention } from '@craftingtable/domain';
import {
  cleanupExecutionFixtures,
  controlCycle,
  designDone,
  implementationDone,
  parallelFixture,
  reviewText,
  roadmapControl,
  saveRoadmapRequest,
  storedRoadmap,
  waitFor,
} from './execution-test-support.js';

/**
 * R-B6 characterization (step 2): what a whole-roadmap Pause and Resume do today, which is what
 * every pause-gated command relies on. A Pause pauses each running cycle of the roadmap and
 * leaves its live session working; Resume resumes every paused cycle of an unfinished attempt,
 * one the operator paused by hand included. A roadmap that needs attention, which every
 * pause-gated command accepts as paused, still has its cycles driven.
 */

afterEach(cleanupExecutionFixtures);

/** Two independent entries start at once; every design turn answers only once released. */
async function fixture() {
  const fx = await parallelFixture({ independentThird: true });
  let release!: () => void;
  const designs = new Promise<void>((resolve) => {
    release = resolve;
  });
  fx.backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? { ...designDone, release: designs }
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  expect((await saveRoadmapRequest(fx.state, fx.input)).statusCode).toBe(200);
  await roadmapControl(fx.state, 'start');
  const tx = fx.state.context.storage,
    ws = fx.state.workspaceId;
  await waitFor(
    () =>
      storedRoadmap(fx.state).attempts.length === 2 &&
      fx.backend.launches.filter((l) => l.model === 'design-model').length === 2,
    'both designs launched',
  );
  const cycles = () =>
    storedRoadmap(fx.state).attempts.map((a) => tx.execution.cycles.find(ws, a.cycleId)!);
  const runs = () => cycles().map((c) => tx.execution.runs.find(ws, c.currentRunId!)!);
  const launched = (model: string) => fx.backend.launches.filter((l) => l.model === model).length;
  return { ...fx, tx, ws, release, cycles, runs, launched };
}

it('Pause pauses the running cycles and keeps their sessions; Resume resumes every paused cycle, one paused by hand included', async () => {
  const fx = await fixture();
  const second = fx.cycles()[1]!;
  // The operator pauses the second item's cycle by hand first.
  await controlCycle(fx.state, second, 'pause');
  await roadmapControl(fx.state, 'pause');
  expect(storedRoadmap(fx.state).status).toBe('paused');
  expect(fx.cycles().map((c) => c.status)).toEqual(['paused', 'paused']);
  expect(fx.cycles()[0]!.reason).toBe(
    'Automation paused by operator. The current session remains available for manual work.',
  );
  // Neither session was ended: each design run still works, and finishes its turn.
  expect(fx.runs().map((r) => r.status)).toEqual(['running', 'running']);
  expect(fx.backend.sessions.map((s) => s.endCount)).toEqual([0, 0]);
  fx.release();
  await waitFor(
    () => fx.runs().every((r) => r.status === 'waiting'),
    'both design turns complete while paused',
  );
  // Nothing goes on to implement while the roadmap and its cycles are paused.
  expect(fx.launched('implement-model')).toBe(0);
  expect(fx.cycles().map((c) => c.status)).toEqual(['paused', 'paused']);
  await roadmapControl(fx.state, 'resume');
  expect(storedRoadmap(fx.state)).toMatchObject({
    status: 'running',
    delegatedByUserId: fx.state.userId,
  });
  // Resume does not know which cycles its pause paused: the one paused by hand runs again too.
  expect(fx.cycles().map((c) => c.status)).toEqual(['running', 'running']);
  await waitFor(() => fx.launched('implement-model') === 2, 'both cycles implement');
});

it('a roadmap that needs attention still has its cycles driven', async () => {
  const fx = await fixture();
  const roadmap = storedRoadmap(fx.state);
  fx.tx.roadmaps.save(
    {
      ...roadmap,
      status: 'needs-attention',
      attention: roadmapAttention('scheduler-error'),
      version: roadmap.version + 1,
    },
    roadmap.version,
  );
  fx.release();
  // The cycle controller drives `running` cycles whatever their roadmap's status: both go on
  // from design to implement with the roadmap still stopped.
  await waitFor(() => fx.launched('implement-model') === 2, 'both cycles implement');
  expect(storedRoadmap(fx.state).status).toBe('needs-attention');
});
