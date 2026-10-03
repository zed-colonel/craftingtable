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
import {
  checkSchedulerReplay,
  commandArguments,
  type SchedulerEntryDecision,
  type SchedulerReplay,
  replaySchedulerDecisions,
  replaySchedulerSnapshot,
} from './scheduler-replay.js';
import { testDataRoot } from './test-support.js';

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
      { decision: e.decision, action: e.action, code: e.code, args: e.args },
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
  // The first item starts, with the worktree it asks for (GR F-3); the two that need its merge
  // wait on it with a typed blocker.
  const first = entryIds[0]!;
  const second = entryIds[1]!;
  const wait = { decision: 'wait', action: undefined, code: 'dependency-blocked', args: undefined };
  expect(decisionsOf(started)).toEqual({
    [first]: {
      decision: 'start',
      action: 'createWorktree',
      code: undefined,
      args: {
        workItemId: input.entries[0]!.workItemId,
        repositoryId: storedRoadmap(state).definition.entries[0]!.repositoryId,
      },
    },
    [second]: wait,
    [input.entries[2]!.id]: wait,
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
    args: undefined,
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
    args: undefined,
  });
});

it('reports the entry a sequential roadmap acts on', async () => {
  const fixture = await roadmapFixture();
  const { state } = fixture;
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  // A sequential pass acts on its first unfinished entry only.
  expect(decisionsOf(await replaySchedulerSnapshot(await snapshot(state), new Date()))).toEqual({
    [entryIds[0]!]: {
      decision: 'start',
      action: 'createWorktree',
      code: undefined,
      args: {
        workItemId: state.workItemId,
        repositoryId: storedRoadmap(state).definition.entries[0]!.repositoryId,
      },
    },
    [entryIds[1]!]: {
      decision: 'not-scheduled',
      action: undefined,
      code: 'not-reached',
      args: undefined,
    },
  });
});

it('records each command’s arguments as ids, kinds and digests, never free text or minted ids', () => {
  // GR F-3: a start with the wrong guidance or profile, or a control with the wrong action,
  // must change the golden; the caller, callbacks, fresh reservation ids and text must not.
  const context = { userId: 'operator-user' };
  const check = () => undefined;
  const owner = {
    roadmapId: 'roadmap-1',
    attemptId: 'fresh-attempt',
    entryId: 'entry-1',
    definitionRevision: 3,
  };
  const profile = { backend: 'codex', permissionMode: 'workspace-write', model: 'gpt-5' };
  const profiles = { design: profile, implement: profile, review: profile, remediate: profile };
  const policy = { maxNits: 3, maxRemediationRounds: 2, maxRunMinutes: 60 };
  const text = 'SECRET operator guidance';
  const pinned = `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
  const calls: [Parameters<typeof commandArguments>[0], string, unknown[], object][] = [
    [
      'workCycleService',
      'start',
      [
        context,
        'ws-1',
        'item-1',
        { worktreeId: 'fresh-worktree', profiles, policy, instructions: text },
        'fresh-cycle',
        true,
        owner,
      ],
      {
        workItemId: 'item-1',
        profiles,
        policy,
        instructions: pinned,
        allowScopeReview: true,
        owner: { roadmapId: 'roadmap-1', entryId: 'entry-1', definitionRevision: 3 },
      },
    ],
    [
      'workCycleService',
      'delegateScopeRepair',
      [
        context,
        'ws-1',
        'cycle-1',
        {
          expectedVersion: 4,
          snapshotDigest: 'd'.repeat(64),
          sourceId: 'wi/WI-1/domain',
          maxRemediationRounds: 2,
          instructions: text,
        },
        {
          worktreeId: 'fresh-worktree',
          cycleId: 'fresh-cycle',
          owner,
          profiles,
          policy,
          check,
          attach: check,
        },
      ],
      {
        cycleId: 'cycle-1',
        expectedVersion: 4,
        snapshotDigest: 'd'.repeat(64),
        sourceId: 'wi/WI-1/domain',
        maxRemediationRounds: 2,
        instructions: pinned,
        owner: { roadmapId: 'roadmap-1', entryId: 'entry-1', definitionRevision: 3 },
        profiles,
        policy,
      },
    ],
    [
      'workCycleService',
      'repeatScopeReview',
      [context, 'ws-1', 'cycle-1', 5, '', check, check],
      { cycleId: 'cycle-1', expectedVersion: 5 },
    ],
    [
      'workCycleService',
      'control',
      [context, 'ws-1', 'cycle-1', 'resume', 6, text, check, check],
      { cycleId: 'cycle-1', action: 'resume', expectedVersion: 6, guidance: pinned },
    ],
    [
      'workCycleService',
      'resolveIntegration',
      [context, 'ws-1', 'cycle-1', { action: 'start', expectedVersion: 7, profile }, check],
      { cycleId: 'cycle-1', action: 'start', expectedVersion: 7, profile },
    ],
    [
      'workCycleService',
      'refreshIntegration',
      [
        { id: 'cycle-1', version: 8, reason: text },
        { id: 'run-1', status: 'finished' },
      ],
      { cycleId: 'cycle-1', cycleVersion: 8, runId: 'run-1' },
    ],
    [
      'executionService',
      'createWorktree',
      [
        context,
        'ws-1',
        'item-1',
        {
          repositoryId: 'repo-1',
          executionScope: {
            kind: 'slice',
            definitionId: 'def-1',
            bindingRevision: 2,
            sourceId: 'wi/WI-1/domain',
          },
        },
        undefined,
        { id: 'fresh-worktree', check },
      ],
      {
        workItemId: 'item-1',
        repositoryId: 'repo-1',
        executionScope: {
          kind: 'slice',
          definitionId: 'def-1',
          bindingRevision: 2,
          sourceId: 'wi/WI-1/domain',
        },
      },
    ],
    [
      'executionService',
      'mergeWorktree',
      [
        context,
        'ws-1',
        'worktree-1',
        { adoptChecks: { proposalDigest: 'p', rationale: text, declarationId: 'decl-1' } },
        undefined,
        { roadmapId: 'roadmap-1', definitionRevision: 3, check },
      ],
      {
        worktreeId: 'worktree-1',
        adoptChecks: { proposalDigest: 'p', declarationId: 'decl-1', rationale: pinned },
        roadmapId: 'roadmap-1',
        definitionRevision: 3,
      },
    ],
    [
      'executionService',
      'recordScopeReceipt',
      [context, 'ws-1', 'worktree-1', 9, { check }],
      { worktreeId: 'worktree-1', expectedWorktreeVersion: 9 },
    ],
    [
      'runtimeEvidenceService',
      'assertSubjectsCurrent',
      ['ws-1', 'def-1', 2, [{ kind: 'checkpoint', sourceId: 'WI-G1' }]],
      {
        definitionId: 'def-1',
        bindingRevision: 2,
        subjects: [{ kind: 'checkpoint', sourceId: 'WI-G1' }],
      },
    ],
  ];
  for (const [service, method, args, expected] of calls) {
    const recorded = commandArguments(service, method, args);
    expect(recorded, `${service}.${method}`).toEqual(expected);
    expect(JSON.stringify(recorded), `${service}.${method}`).not.toMatch(
      /SECRET|fresh-|operator-user|ws-1/,
    );
  }
});

it('compares command arguments only against a golden that records them', () => {
  const entry: SchedulerEntryDecision = {
    roadmapId: 'r',
    entryId: 'e',
    sourceId: 'S-1',
    scope: 'item',
    decision: 'start',
    action: 'createWorktree',
    args: { workItemId: 'item-1', repositoryId: 'repo-1' },
  };
  const golden: SchedulerReplay = { format: 2, roadmaps: [], entries: [entry], cycles: [] };
  const elsewhere: SchedulerReplay = {
    ...golden,
    entries: [{ ...entry, args: { workItemId: 'item-1', repositoryId: 'repo-2' } }],
  };
  expect(checkSchedulerReplay(golden, golden)).toMatchObject({ changed: [], notCompared: [] });
  expect(checkSchedulerReplay(golden, elsewhere).changed.map((c) => c.key)).toEqual(['entry:r/e']);
  // A golden recorded before arguments were: the rest still compares, and the check says so.
  const { args: _args, ...unrecorded } = entry;
  const older: SchedulerReplay = { roadmaps: [], entries: [unrecorded], cycles: [] };
  expect(checkSchedulerReplay(older, elsewhere)).toMatchObject({
    changed: [],
    missing: [],
    notCompared: ['command arguments (the golden predates them)'],
  });
  expect(
    checkSchedulerReplay(older, { ...elsewhere, entries: [{ ...entry, action: 'start' }] }).changed,
  ).toHaveLength(1);
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
    args: undefined,
  });
});
