import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  entryIds,
  parallelFixture,
  type Ready,
  roadmapControl,
  roadmapFixture,
  saveRoadmapRequest,
  storedRoadmap,
  useIntegration,
} from './execution-test-support.js';
import { openDaemonStorage } from './persisted-records.js';
import { replaySchedulerDecisions, replaySchedulerSnapshot } from './scheduler-replay.js';
import { testDataRoot } from './test-data-root.js';

/**
 * The scheduler replay (R-I10) runs one real roadmap pass over a copy of a snapshot and
 * records each entry's decision, without launching anything or changing the snapshot.
 */

const directories: string[] = [];
afterEach(async () => {
  await cleanupExecutionFixtures();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function snapshot(state: Ready): Promise<string> {
  const directory = mkdtempSync(join(testDataRoot(), 'scheduler-replay-test-'));
  directories.push(directory);
  const path = join(directory, 'snapshot.sqlite');
  await state.context.storage.backup(path);
  return path;
}

const decisionsOf = (replay: Awaited<ReturnType<typeof replaySchedulerSnapshot>>) =>
  Object.fromEntries(
    replay.entries.map((e) => [
      e.entryId,
      { decision: e.decision, action: e.action, code: e.code },
    ]),
  );

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

it('records each roadmap entry’s decision for one pass without launching or writing', async () => {
  const { state, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  const source = await snapshot(state);
  const before = digest(source);

  const started = await replaySchedulerSnapshot(source, new Date());
  expect(digest(source)).toBe(before);
  expect(started.roadmaps).toEqual([
    expect.objectContaining({ before: 'running', after: 'running' }),
  ]);
  // The first item starts; the two that need its merge wait on it with a typed blocker.
  const first = entryIds[0]!;
  const second = entryIds[1]!;
  expect(decisionsOf(started)).toEqual({
    [first]: { decision: 'start', action: 'createWorktree', code: undefined },
    [second]: { decision: 'wait', action: undefined, code: 'dependency-blocked' },
    [input.entries[2]!.id]: { decision: 'wait', action: undefined, code: 'dependency-blocked' },
  });

  // The replay's own copy: the pass reserved the attempt, but created no worktree, cycle or run.
  const copyDirectory = mkdtempSync(join(testDataRoot(), 'scheduler-replay-copy-'));
  directories.push(copyDirectory);
  const copy = join(copyDirectory, 'copy.sqlite');
  copyFileSync(source, copy);
  await replaySchedulerDecisions(copy, copyDirectory, new Date());
  const replayed = openDaemonStorage(copy);
  try {
    expect(replayed.roadmaps.find(state.workspaceId, storedRoadmap(state).id)?.attempts).toEqual([
      expect.objectContaining({ entryId: first, status: 'preparing' }),
    ]);
    expect(replayed.execution.worktrees.listActive(state.workspaceId)).toEqual([]);
    expect(replayed.execution.cycles.listForWorkspace(state.workspaceId)).toEqual([]);
    expect(replayed.execution.runs.listRecent(state.workspaceId, 10)).toEqual([]);
  } finally {
    replayed.close();
  }

  // At the merge boundary the pass leaves the first item to the operator's merge approval,
  // and says so with a typed wait (R-C12) instead of returning silently.
  await awaitRoadmapMerge(state, 0);
  const merging = await replaySchedulerSnapshot(await snapshot(state), new Date());
  expect(decisionsOf(merging)[first]).toEqual({
    decision: 'wait',
    action: undefined,
    code: 'cycle-attention',
  });
  expect(merging.cycles).toEqual([]);
});

it('replays a snapshot taken while a run is live as the next pass, not as a restart', async () => {
  const { state, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await state.context.services.roadmapService.tick();
  await state.context.services.workCycleService.tick();
  const cycle = state.context.storage.execution.cycles.find(
    state.workspaceId,
    storedRoadmap(state).attempts[0]!.cycleId,
  )!;
  expect(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status,
  ).toBe('waiting');

  const replay = await replaySchedulerSnapshot(await snapshot(state), new Date());
  expect(replay.roadmaps).toEqual([
    expect.objectContaining({ before: 'running', after: 'running' }),
  ]);
  expect(decisionsOf(replay)[entryIds[0]!]).toEqual({
    decision: 'running',
    action: undefined,
    code: undefined,
  });
});

it('reports the entry a sequential roadmap acts on', async () => {
  const fixture = await roadmapFixture();
  const { state } = fixture;
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  // A sequential pass acts on its first unfinished entry only.
  expect(decisionsOf(await replaySchedulerSnapshot(await snapshot(state), new Date()))).toEqual({
    [entryIds[0]!]: { decision: 'start', action: 'createWorktree', code: undefined },
    [entryIds[1]!]: { decision: 'not-scheduled', action: undefined, code: 'not-reached' },
  });
});

it('reports the typed hold a pass records', async () => {
  // The plan's branch settings moved: a parallel pass holds each entry, and says with what.
  const parallel = await parallelFixture();
  expect((await saveRoadmapRequest(parallel.state, parallel.input)).statusCode).toBe(200);
  await roadmapControl(parallel.state, 'start');
  await useIntegration(parallel);
  const held = await replaySchedulerSnapshot(await snapshot(parallel.state), new Date());
  expect(decisionsOf(held)[entryIds[0]!]).toEqual({
    decision: 'hold',
    action: 'new-hold',
    code: 'entry-preparation-failed',
  });
});
