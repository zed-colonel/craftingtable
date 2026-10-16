import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkCycleReplay, type CycleReplay, replayCycleSnapshot } from '../src/cycle-replay.js';
import { asAgentRunId, asWorkCycleId, asWorkItemId, asWorktreeId } from '@craftingtable/domain';
import { createCycleFixture, type CycleFixture, storedCycle } from './cycle-test-support.js';
import {
  cleanupExecutionFixtures,
  designDone,
  git,
  implementationDone,
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
  expect(launching).toEqual({
    format: 2,
    cycles: [
      {
        cycleId: cycle.id,
        before: { status: 'running', step: 'design', reason: expect.stringMatching(/^sha256:/) },
        pass: { decision: { kind: 'start-run', guard: 'no-run' }, calls: ['start-run'] },
      },
    ],
  });

  // A design that asks a question stops for the operator. The pass leaves the stop alone; lifted
  // to running, the same report stops it again with the same code.
  await stepDaemon(f.services);
  f.backend.latest.release(openQuestions);
  await stepDaemon(f.services, 2);
  const stopped = await snapshot(f);
  const at = new Date();
  const replay = await replayCycleSnapshot(stopped, at);
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
      pass: { decision: { kind: 'idle', guard: 'not-active', code: 'not-active' } },
      resumed: {
        decision: { kind: 'attention', guard: 'step-outcome', code: 'design-open-questions' },
        actions: ['advance'],
        after: { ...stop, cycle: expect.stringMatching(/^sha256:/) },
      },
    },
  ]);

  // The same snapshot replays the same way; a golden that differs is reported by its cycle.
  const again = await replayCycleSnapshot(stopped, at);
  expect(checkCycleReplay(replay, again)).toMatchObject({
    records: 1,
    changed: [],
    missing: [],
    duplicates: [],
  });
  const altered: CycleReplay = {
    ...replay,
    cycles: replay.cycles.map((record) => ({ ...record, pass: { calls: ['start-run'] } })),
  };
  expect(checkCycleReplay(altered, again).changed.map((change) => change.key)).toEqual([
    `cycle:${cycle.id}`,
  ]);
  // A golden recorded before decisions (format 1) is compared without them, and says so; a
  // decision that differs is reported only against a golden that has decisions.
  const undecided = (record: CycleReplay['cycles'][number]['pass']) => {
    const { decision: _decision, ...rest } = record;
    return rest;
  };
  const predated: CycleReplay = {
    cycles: replay.cycles.map((record) => ({
      ...record,
      pass: undecided(record.pass),
      ...(record.resumed ? { resumed: undecided(record.resumed) } : {}),
    })),
  };
  expect(checkCycleReplay(predated, again)).toMatchObject({
    changed: [],
    notCompared: ['decisions (the golden predates them)'],
  });
  const redecided: CycleReplay = {
    ...replay,
    cycles: replay.cycles.map((record) => ({
      ...record,
      pass: { ...record.pass, decision: { kind: 'idle', guard: 'roadmap-settling' } },
    })),
  };
  expect(checkCycleReplay(redecided, again).changed).toHaveLength(1);
  expect(checkCycleReplay({ ...redecided, format: 1 }, again).changed).toEqual([]);
});

it('records each cycle’s own commands, ended turns, a reservation and the whole stored cycle', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  await stepDaemon(f.services);
  const ofCycle = (replay: CycleReplay, id: string = cycle.id) =>
    replay.cycles.find((record) => record.cycleId === id);

  // A live design past its time limit is cancelled and stops; within it, it is left to run.
  const live = await snapshot(f);
  expect(ofCycle(await replayCycleSnapshot(live, new Date()))?.pass).toEqual({
    decision: { kind: 'idle', guard: 'step-outcome', code: 'run-live' },
  });
  const late = ofCycle(await replayCycleSnapshot(live, new Date(Date.now() + 2 * 86_400_000)));
  expect(late?.pass).toMatchObject({
    calls: ['cancel-turn'],
    actions: ['advance'],
    after: { status: 'needs-attention', code: 'step-time-limit' },
  });

  // A finished turn whose session is still open is ended.
  f.backend.latest.release(designDone);
  await f.services.agentRunService.quiesce();
  expect(ofCycle(await replayCycleSnapshot(await snapshot(f), new Date()))?.pass).toEqual({
    decision: { kind: 'effect', guard: 'step-outcome', code: 'end-turn' },
    calls: ['end-turn'],
  });

  // The finished design reserves the implementation: a run id the pass mints, which the
  // record's digest reads as minted, so two replays agree.
  await stepDaemon(f.services);
  const designed = await snapshot(f);
  const at = new Date();
  const reserving = ofCycle(await replayCycleSnapshot(designed, at));
  expect(reserving?.pass).toMatchObject({
    actions: ['advance'],
    after: { status: 'running', step: 'implement', reserved: true },
  });
  expect(reserving?.pass.after?.cycle).toMatch(/^sha256:/);
  expect(ofCycle(await replayCycleSnapshot(designed, at))).toEqual(reserving);

  // Two cycles in one pass: each record holds only its own commands. The finished
  // implementation's checkpoint reaches Git.
  await stepDaemon(f.services, 2);
  const tree = f.backend.latest.request.cwd;
  writeFileSync(join(tree, 'change.txt'), 'change');
  git(['add', '.'], tree);
  git(['commit', '--no-gpg-sign', '-m', 'change'], tree);
  f.backend.latest.release(implementationDone);
  await stepDaemon(f.services);
  // A second cycle, later in the pass, on the second item: its predecessor gate refuses it, so
  // it reaches no command, and one left over from the first cycle would show in its record.
  const first = f.context.storage.execution.worktrees.find(f.workspaceId, f.worktreeId)!;
  const second = asWorktreeId('00000000-0000-4000-8000-000000000004');
  f.context.storage.execution.worktrees.insert({
    ...first,
    id: second,
    workItemId: asWorkItemId('item-2'),
    branchName: `${first.branchName}-second`,
    path: `${first.path}-second`,
  });
  const other = asWorkCycleId('00000000-0000-4000-8000-000000000002');
  f.context.storage.execution.cycles.insert({
    ...storedCycle(f, cycle.id),
    id: other,
    workItemId: asWorkItemId('item-2'),
    worktreeId: second,
    version: 1,
    step: 'design',
    currentRunId: asAgentRunId('00000000-0000-4000-8000-000000000003'),
  });
  const two = await replayCycleSnapshot(await snapshot(f), new Date());
  expect(ofCycle(two)?.pass).toMatchObject({
    calls: ['git:inspectWorktreeChanges'],
    after: { code: 'implementation-commit-failed' },
  });
  expect(ofCycle(two, other)?.pass).toMatchObject({
    actions: ['advance'],
    after: { code: 'controller-error' },
  });
  expect(ofCycle(two, other)?.pass).not.toHaveProperty('calls');
});
