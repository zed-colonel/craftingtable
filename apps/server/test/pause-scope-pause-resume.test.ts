import { afterEach, expect, it, vi } from 'vitest';
import { agentSelections, roadmapAttention } from '@craftingtable/domain';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  controlCycle,
  cycleProfiles,
  designDone,
  implementationDone,
  mergeRoadmapAttempt,
  mutationHeaders,
  parallelFixture,
  reviewText,
  roadmapControl,
  roadmapId,
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

it('an agent change while the roadmap runs reaches each entry’s next launch, not its live run (R-B6, decision 1)', async () => {
  const fx = await fixture();
  const entryIds = storedRoadmap(fx.state).attempts.map((a) => a.entryId);
  const applied = await fx.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${fx.ws}/roadmaps/${roadmapId}/agent-profiles`,
    headers: mutationHeaders(fx.state),
    payload: {
      expectedVersion: storedRoadmap(fx.state).version,
      entryIds,
      selections: {
        ...agentSelections(cycleProfiles),
        design: { backend: 'claude-code', model: 'design-new-model' },
        implement: { backend: 'claude-code', model: 'implement-new-model' },
      },
    },
  });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(storedRoadmap(fx.state).status).toBe('running');
  // The design runs already working keep their agent and their sessions.
  expect(fx.runs().map((r) => [r.model, r.status])).toEqual([
    ['design-model', 'running'],
    ['design-model', 'running'],
  ]);
  expect(fx.backend.sessions.map((s) => s.endCount)).toEqual([0, 0]);
  expect(fx.cycles().map((c) => c.status)).toEqual(['running', 'running']);
  fx.release();
  await waitFor(() => fx.launched('implement-new-model') === 2, 'both implement on the new agent');
  expect(fx.launched('implement-model')).toBe(0);
});

it('a capacity cut while the roadmap runs stops nothing and admits nothing new (R-B6, decision 3)', async () => {
  const fx = await fixture();
  const cut = await fx.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${fx.ws}/roadmaps/${roadmapId}/capacity`,
    headers: mutationHeaders(fx.state),
    payload: {
      expectedVersion: storedRoadmap(fx.state).version,
      expectedRevision: storedRoadmap(fx.state).definition.revision,
      maxInFlight: 1,
      maxPerRepository: 1,
    },
  });
  expect(cut.statusCode, cut.body).toBe(200);
  expect(storedRoadmap(fx.state)).toMatchObject({
    status: 'running',
    definition: { scheduling: { maxInFlight: 1, maxPerRepository: 1 } },
  });
  // Both items already in flight run on.
  expect(fx.cycles().map((c) => c.status)).toEqual(['running', 'running']);
  fx.release();
  const [first] = storedRoadmap(fx.state).attempts;
  await awaitRoadmapMerge(fx.state, 0);
  await mergeRoadmapAttempt(fx.state, first!.worktreeId);
  // The first item's successor is now eligible, but one item is still in flight: it waits.
  const successor = fx.input.entries[1]!.id;
  const started = () => storedRoadmap(fx.state).attempts.some((a) => a.entryId === successor);
  for (let pass = 0; pass < 3; pass++) {
    await fx.state.context.services.workCycleService.tick();
    await fx.state.context.services.roadmapService.tick();
  }
  expect(storedRoadmap(fx.state).attempts.map((a) => a.status)).toEqual(['completed', 'active']);
  expect(started()).toBe(false);
  // Raised again while running, the limit admits it: capacity was what held it.
  const raised = await fx.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${fx.ws}/roadmaps/${roadmapId}/capacity`,
    headers: mutationHeaders(fx.state),
    payload: {
      expectedVersion: storedRoadmap(fx.state).version,
      expectedRevision: storedRoadmap(fx.state).definition.revision,
      maxInFlight: 2,
      maxPerRepository: 2,
    },
  });
  expect(raised.statusCode, raised.body).toBe(200);
  await waitFor(started, 'the successor starts once the limit allows');
});

it('a save while the roadmap runs supersedes an admission in flight, which the next pass takes up on its pinned revision (R-B6, review M-2)', async () => {
  // The default fixture: only the first item is eligible at first; the others follow it.
  const fx = await parallelFixture();
  fx.backend.replyForRequest = () => ({ resultText: 'Working.\n\n## Open questions\nnone' });
  expect((await saveRoadmapRequest(fx.state, fx.input)).statusCode).toBe(200);
  const execution = fx.state.context.services.executionService;
  const create = execution.createWorktree.bind(execution);
  let saved: { statusCode: number; body: string } | undefined;
  vi.spyOn(execution, 'createWorktree').mockImplementation(async (...args) => {
    // The admission awaits here, between its `preparing` write and its cycle: the operator
    // removes a queued entry and renames the roadmap.
    if (!saved) {
      const roadmap = storedRoadmap(fx.state);
      saved = await saveRoadmapRequest(fx.state, {
        ...fx.input,
        name: 'Renamed while admitting',
        entries: fx.input.entries.slice(0, 2),
        expectedVersion: roadmap.version,
        expectedRevision: roadmap.definition.revision,
      });
    }
    return create(...args);
  });
  await roadmapControl(fx.state, 'start');
  const tx = fx.state.context.storage,
    ws = fx.state.workspaceId;
  await waitFor(() => !!saved, 'the save lands during the admission');
  expect(saved!.statusCode, saved!.body).toBe(200);
  // The admission stood down: no cycle; its attempt waits, `preparing`, on the revision it was
  // reserved under, and its entry is frozen in the saved one.
  let roadmap = storedRoadmap(fx.state);
  expect(roadmap.definition).toMatchObject({ revision: 2, name: 'Renamed while admitting' });
  expect(roadmap.definition.entries).toHaveLength(2);
  expect(roadmap.attempts).toMatchObject([{ status: 'preparing', definitionRevision: 1 }]);
  expect(tx.execution.cycles.find(ws, roadmap.attempts[0]!.cycleId)).toBeUndefined();
  // The next pass admits it, as reserved.
  await waitFor(
    () => !!tx.execution.cycles.find(ws, storedRoadmap(fx.state).attempts[0]!.cycleId),
    'the next pass admits it',
  );
  roadmap = storedRoadmap(fx.state);
  expect(roadmap.attempts).toMatchObject([{ status: 'active', definitionRevision: 1 }]);
  expect(roadmap.status).toBe('running');
});

it('a save while the roadmap runs is held to the revision it was made from, and names a started entry it would change (R-B6, review L-6)', async () => {
  const fx = await fixture();
  const roadmap = storedRoadmap(fx.state);
  const started = fx.input.entries[0]!;
  const save = (changes: Record<string, unknown>) =>
    saveRoadmapRequest(fx.state, { ...fx.input, expectedVersion: roadmap.version, ...changes });
  // Another revision than the current one is refused, whatever the version.
  const outdated = await save({ expectedRevision: roadmap.definition.revision + 1 });
  expect(outdated.statusCode, outdated.body).toBe(409);
  expect(outdated.json().error.message).toBe('Roadmap changed; refresh before saving.');
  // A started entry keeps its settings, and the refusal names it.
  const frozen = await save({
    expectedRevision: roadmap.definition.revision,
    entries: fx.input.entries.map((e) =>
      e.id === started.id ? { ...e, instructions: 'Changed after it started.' } : e,
    ),
  });
  expect(frozen.statusCode, frozen.body).toBe(409);
  expect(frozen.json().error.message).toBe(
    'AQ-01 has started, so it keeps its original work item and settings. Refresh to see the current roadmap.',
  );
  expect(storedRoadmap(fx.state).definition.revision).toBe(roadmap.definition.revision);
  fx.release();
});
