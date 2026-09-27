import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  entryIds,
  parallelFixture,
  type Ready,
  roadmapControl,
  saveRoadmapRequest,
  storedRoadmap,
} from './execution-test-support.js';
import { replaySchedulerSnapshot } from './scheduler-replay.js';

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
  const directory = mkdtempSync(join(tmpdir(), 'scheduler-replay-test-'));
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

it('records each roadmap entry’s decision for one pass without launching or writing', {
  timeout: 20000,
}, async () => {
  const { state, backend, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  const version = storedRoadmap(state).version;
  const launches = backend.launches.length;

  const started = await replaySchedulerSnapshot(await snapshot(state), new Date());
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
  expect(backend.launches).toHaveLength(launches);
  expect(storedRoadmap(state).version).toBe(version);

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
