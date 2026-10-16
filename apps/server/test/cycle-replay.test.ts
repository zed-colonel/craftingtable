import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkCycleReplay, type CycleReplay, replayCycleSnapshot } from '../src/cycle-replay.js';
import { createCycleFixture, type CycleFixture } from './cycle-test-support.js';
import {
  cleanupExecutionFixtures,
  openQuestions,
  startCycle,
  stepDaemon,
} from './execution-test-support.js';
import { testDataRoot } from './test-support.js';

/**
 * The cycles replay (R-B4) runs one real cycle pass over a copy of a snapshot, and a second with
 * every stopped or paused cycle lifted to `running`, and records what each did to every cycle
 * that had not ended, without launching anything or changing the snapshot.
 */

const directories: string[] = [];
afterEach(async () => {
  await cleanupExecutionFixtures();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function snapshot(f: CycleFixture): Promise<string> {
  const directory = mkdtempSync(join(testDataRoot(), 'cycle-replay-test-'));
  directories.push(directory);
  const path = join(directory, 'snapshot.sqlite');
  await f.context.storage.backup(path);
  return path;
}

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

it('records what one pass does to each cycle, and with its stop lifted, without writing the snapshot', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);

  // A step reserved but not launched: the pass launches it, and writes nothing else.
  const reserved = await snapshot(f);
  const before = digest(reserved);
  const launching = await replayCycleSnapshot(reserved, new Date());
  expect(digest(reserved)).toBe(before);
  expect(launching.cycles).toEqual([
    {
      cycleId: cycle.id,
      before: { status: 'running', step: 'design', reason: expect.stringMatching(/^sha256:/) },
      pass: { calls: ['start-run'] },
    },
  ]);

  // A design that asks a question stops for the operator. The pass leaves the stop alone; lifted
  // to running, the same report stops it again with the same code.
  await stepDaemon(f.services);
  f.backend.latest.release(openQuestions);
  await stepDaemon(f.services, 2);
  const stopped = await snapshot(f);
  const replay = await replayCycleSnapshot(stopped, new Date());
  const stop = {
    status: 'needs-attention',
    step: 'design',
    code: 'design-open-questions',
    owner: 'operator',
    reason: expect.stringMatching(/^sha256:/),
  };
  expect(replay.cycles).toEqual([
    {
      cycleId: cycle.id,
      before: stop,
      pass: {},
      resumed: { actions: ['advance'], after: stop },
    },
  ]);

  // The same snapshot replays the same way; a golden that differs is reported by its cycle.
  const again = await replayCycleSnapshot(stopped, new Date());
  expect(checkCycleReplay(replay, again)).toMatchObject({
    records: 1,
    changed: [],
    missing: [],
    duplicates: [],
  });
  const altered: CycleReplay = {
    cycles: replay.cycles.map((record) => ({ ...record, pass: { calls: ['start-run'] } })),
  };
  expect(checkCycleReplay(altered, again).changed.map((change) => change.key)).toEqual([
    `cycle:${cycle.id}`,
  ]);
});
