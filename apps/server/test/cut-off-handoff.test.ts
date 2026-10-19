import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import { type AgentRun, asAgentRunId, heldStop } from '@craftingtable/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BranchService } from '../src/services/branch-service.js';
import { CUT_OFF_BOUNDS, cutOffRecord, writeRunHandoff } from '../src/services/run-handoff.js';
import { runCutOff } from '../src/services/run-lineage.js';
import {
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  cycleFixture,
  designDone,
  git,
  present,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C17 part 2 (found live 2026-10-16): a run cut off at the step limit leaves no final message,
 * so the resumed step's handoff said only that, and the next agent rediscovered the problem from
 * scratch. The handoff of a run that ended with no completed turn now carries its last assistant
 * messages, bounded, its head commit and the worktree's uncommitted files, beside the warning.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

const runDirectory = (request: AgentLaunchRequest) => {
  const root = request.additionalDirectories?.[0];
  if (root === undefined) throw new Error('Missing run directory');
  return root;
};

it("hands a resumed step the cut-off run's last messages, head commit and uncommitted files (R-C17 part 2)", async () => {
  let now = new Date('2026-10-16T10:00:00Z');
  const progress = Array.from(
    { length: 7 },
    (_, index) => `Progress ${index + 1}: rerunning runtime-test after the fix.`,
  );
  const { state, backend, worktree } = await cycleFixture(
    [
      designDone,
      // Messages, and no result: the turn never completes.
      {
        resultText: '',
        claudeStream: progress.map((text) => ({
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        })),
      },
      // The resumed run is cut off too.
      {
        resultText: '',
        claudeStream: [1, 2].map((n) => ({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `Second attempt ${n}: bisecting the slow test.` }],
          },
        })),
      },
      { resultText: 'Implemented and checks passed.' },
    ],
    () => now,
  );
  let implementations = 0;
  backend.onLaunch = (request) => {
    // The cut-off run commits one fix and leaves work uncommitted, tracked and untracked.
    if (request.model === 'implement-model' && ++implementations === 1) {
      commitFile(request.cwd, 'fix.txt', 'fix\n');
      writeFileSync(join(request.cwd, 'README.md'), '# fixture, edited\n');
      writeFileSync(join(request.cwd, 'wip.txt'), 'half done\n');
    }
  };
  const cycle = await startCycle(state, worktree.id);
  const storage = state.context.storage;
  await waitFor(() => {
    const current = currentCycle(state, cycle);
    const last =
      current.step === 'implement' &&
      storage.execution.runEvents.latestOfKind(
        state.workspaceId,
        current.currentRunId,
        'assistant-message',
      );
    return last
      ? last.kind === 'assistant-message' && last.payload.text === progress.at(-1)
      : false;
  }, 'the implementation reports progress');
  const cutOff = currentCycle(state, cycle).currentRunId;
  now = new Date(Date.parse(currentCycle(state, cycle).runDeadlineAt) + 1);
  await waitFor(
    () => heldStop(currentCycle(state, cycle))?.code === 'step-time-limit',
    'the step time limit',
  );
  await waitFor(
    () => storage.execution.runs.find(state.workspaceId, cutOff)?.status === 'cancelled',
    'the run cancelled',
  );
  const head = git(['rev-parse', 'HEAD'], worktree.path).trim();

  // A run that completed its turn hands off as before: the design's handoff has no cut-off.
  const first = runDirectory(backend.launches[1]!);
  expect(existsSync(join(first, 'handoff', '0000-cut-off.md'))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(first, 'handoff', 'manifest.json'), 'utf8')).sources[0],
  ).not.toHaveProperty('cutOff');

  await controlCycle(state, currentCycle(state, cycle), 'resume');
  await waitFor(() => backend.launches.length === 3, 'the resumed implementation');
  const root = runDirectory(backend.launches[2]!);
  const handoff = join(root, 'handoff');
  const manifest = JSON.parse(readFileSync(join(handoff, 'manifest.json'), 'utf8'));
  expect(manifest.sourceRunId).toBe(cutOff);
  expect(manifest.sources[0]).toMatchObject({ runId: cutOff, cutOff: '0000-cut-off.md' });
  // Today's warning stays beside it.
  expect(manifest.warnings).toContain(
    `${cutOff}: no completed turn; the final-message file contains only the available summary.`,
  );
  const record = readFileSync(join(handoff, '0000-cut-off.md'), 'utf8');
  // Its last messages, bounded to the last five, oldest first.
  for (const message of progress.slice(2)) expect(record).toContain(message);
  expect(record.indexOf(progress[2]!)).toBeLessThan(record.indexOf(progress[6]!));
  for (const message of progress.slice(0, 2)) expect(record).not.toContain(message);
  // Its head commit and the worktree's uncommitted files, tracked and untracked.
  expect(record).toContain(head);
  expect(record).toContain('README.md');
  expect(record).toContain('wip.txt');
  expect(record).not.toContain('fix.txt');

  // The brief says where the run stopped, and points to the record.
  const brief = readFileSync(join(root, 'brief.md'), 'utf8');
  expect(brief).toContain('`handoff/0000-cut-off.md`');
  expect(brief).toContain(head.slice(0, 12));
  expect(brief).toContain('README.md');
  expect(brief).toContain('`wip.txt` (untracked)');

  // Cut off again: only the immediate parent gets a record; the older cut-off run, earlier in the
  // lineage, keeps only today's warning.
  const second = backend.launches[2]!;
  const secondRun = currentCycle(state, cycle).currentRunId;
  await waitFor(() => {
    const last = storage.execution.runEvents.latestOfKind(
      state.workspaceId,
      secondRun,
      'assistant-message',
    );
    return last?.kind === 'assistant-message' && last.payload.text.startsWith('Second attempt 2');
  }, 'the resumed implementation reports progress');
  expect(second.cwd).toBe(backend.launches[1]!.cwd);
  now = new Date(Date.parse(currentCycle(state, cycle).runDeadlineAt) + 1);
  await waitFor(
    () => storage.execution.runs.find(state.workspaceId, secondRun)?.status === 'cancelled',
    'the resumed run cancelled',
  );
  // Git failing as the worktree is read does not stop the launch; the record says why.
  const read = vi
    .spyOn(state.context.services.executionService.branches, 'uncommitted')
    .mockRejectedValue(new Error('git exploded'));
  await controlCycle(state, currentCycle(state, cycle), 'resume');
  await waitFor(() => backend.launches.length === 4, 'the second resume');
  expect(read).toHaveBeenCalledTimes(1);
  const third = join(runDirectory(backend.launches[3]!), 'handoff');
  const lineage = JSON.parse(readFileSync(join(third, 'manifest.json'), 'utf8'));
  expect(lineage.sources.map((source: { runId: string }) => source.runId).slice(0, 2)).toEqual([
    secondRun,
    cutOff,
  ]);
  expect(lineage.sources[0].cutOff).toBe('0000-cut-off.md');
  expect(lineage.sources[1]).not.toHaveProperty('cutOff');
  expect(existsSync(join(third, '0001-cut-off.md'))).toBe(false);
  expect(lineage.warnings).toContain(
    `${cutOff}: no completed turn; the final-message file contains only the available summary.`,
  );
  const latest = readFileSync(join(third, '0000-cut-off.md'), 'utf8');
  expect(latest).toContain('Second attempt 2: bisecting the slow test.');
  expect(latest).not.toContain('Progress 7');
  expect(latest).toContain('The worktree could not be read: git exploded');
  const thirdBrief = readFileSync(join(runDirectory(backend.launches[3]!), 'brief.md'), 'utf8');
  expect(thirdBrief).toContain(
    '`handoff/0000-cut-off.md`: its last 2 assistant messages; the worktree could not be read (git exploded).',
  );
});

it("hands a service retry after a turn that ended in error the run's last messages and worktree, and keeps the warnings as they were (R-C17 part 2 L-4)", async () => {
  let now = new Date('2026-10-17T12:00:00Z');
  const { state, backend, worktree } = await cycleFixture(
    [
      designDone,
      // The turn completes, in error: the provider is at capacity, and its final message is only
      // the turn's result.
      {
        resultText: 'Turn ended: error_during_execution',
        messages: ['Found the slow test: flow_capacity is quadratic.', 'Rewriting the loop now.'],
        providerFailure: {
          kind: 'capacity',
          message: 'The selected model is at capacity.',
          safeToRetry: true,
        },
      },
      { resultText: 'Implemented and checks passed.' },
    ],
    () => now,
  );
  let implementations = 0;
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model' && ++implementations === 1)
      writeFileSync(join(request.cwd, 'wip.txt'), 'half done\n');
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => !!currentCycle(state, cycle).attempt?.providerRecovery?.nextRetryAt,
    'the backoff',
  );
  const failed = backend.launches.length === 2 && currentCycle(state, cycle).currentRunId;
  expect(failed).toBeTruthy();
  const head = git(['rev-parse', 'HEAD'], worktree.path).trim();
  now = new Date('2026-10-17T12:01:01Z');
  await waitFor(() => backend.launches.length === 3, 'the service retry');
  expect(backend.launches[2]!.prompt).toContain('service retry 1 of 3');
  const root = runDirectory(backend.launches[2]!);
  const handoff = join(root, 'handoff');
  const manifest = JSON.parse(readFileSync(join(handoff, 'manifest.json'), 'utf8'));
  expect(manifest.sources[0]).toMatchObject({ runId: failed, cutOff: '0000-cut-off.md' });
  // The warnings stay as they were: the run completed a turn, so none says it did not.
  expect(manifest.warnings).toEqual([]);
  expect(readFileSync(join(handoff, '0000-final.md'), 'utf8')).toBe(
    'Turn ended: error_during_execution',
  );
  const record = readFileSync(join(handoff, '0000-cut-off.md'), 'utf8');
  expect(record).toContain('its last completed turn in error');
  expect(record).not.toContain('without completing a turn');
  expect(record).toContain('Found the slow test: flow_capacity is quadratic.');
  expect(record).toContain('Rewriting the loop now.');
  expect(record).toContain(head);
  expect(record).toContain('wip.txt (untracked)');
  const brief = readFileSync(join(root, 'brief.md'), 'utf8');
  expect(brief).toContain(
    "The previous run's last completed turn ended in error, so its final-message file holds only that turn's result. Where it stopped is in `handoff/0000-cut-off.md`: its last 2 assistant messages;",
  );
  expect(brief).toContain('`wip.txt` (untracked)');
});

it("hands a resumed step the record of a run cut off in a turn after its last completed one (R-C17 part 4, part 2's other half)", async () => {
  let now = new Date('2026-10-18T12:00:00Z');
  const { state, backend, worktree } = await cycleFixture(
    [
      designDone,
      // The turn completes while background work is pending, so the session stays open...
      {
        resultText: 'Started runtime-test in the background; waiting for it.',
        messages: ['Fixed the quadratic loop in flow_capacity.'],
        backgroundWorkPending: true,
      },
      { resultText: 'Implemented and checks passed.' },
    ],
    () => now,
  );
  let implementations = 0;
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model' && ++implementations === 1)
      writeFileSync(join(request.cwd, 'wip.txt'), 'half done\n');
  };
  const cycle = await startCycle(state, worktree.id);
  const storage = state.context.storage;
  const run = () =>
    storage.execution.runs.find(state.workspaceId, currentCycle(state, cycle).currentRunId);
  await waitFor(
    () => backend.sessions.length === 2 && run()?.status === 'waiting',
    "the implementation's completed turn",
  );
  const cutOff = currentCycle(state, cycle).currentRunId;
  // ...and the agent works on in a new turn, which never completes.
  present(backend.sessions[1]).workOn([
    'runtime-test still reports flow_capacity running after 60 seconds.',
    'Bisecting the slow test now.',
  ]);
  await waitFor(() => run()?.status === 'running', 'the later turn');
  now = new Date(Date.parse(currentCycle(state, cycle).runDeadlineAt) + 1);
  await waitFor(
    () => heldStop(currentCycle(state, cycle))?.code === 'step-time-limit',
    'the step time limit',
  );
  await waitFor(
    () => storage.execution.runs.find(state.workspaceId, cutOff)?.status === 'cancelled',
    'the run cancelled',
  );
  const head = git(['rev-parse', 'HEAD'], worktree.path).trim();

  await controlCycle(state, currentCycle(state, cycle), 'resume');
  await waitFor(() => backend.launches.length === 3, 'the resumed implementation');
  const root = runDirectory(backend.launches[2]!);
  const handoff = join(root, 'handoff');
  const manifest = JSON.parse(readFileSync(join(handoff, 'manifest.json'), 'utf8'));
  expect(manifest.sources[0]).toMatchObject({ runId: cutOff, cutOff: '0000-cut-off.md' });
  // The warnings stay as they were: the run completed a turn.
  expect(manifest.warnings).toEqual([]);
  // Its final message is the earlier turn's result.
  expect(readFileSync(join(handoff, '0000-final.md'), 'utf8')).toBe(
    'Started runtime-test in the background; waiting for it.',
  );
  const record = readFileSync(join(handoff, '0000-cut-off.md'), 'utf8');
  expect(record).toContain(
    "The implement run (cancelled) was cut off in a turn after its last completed one, so its final message holds only that earlier turn's result.",
  );
  expect(record).not.toContain('without completing a turn');
  expect(record).not.toContain('in error');
  expect(record).toContain('Fixed the quadratic loop in flow_capacity.');
  expect(record).toContain('Bisecting the slow test now.');
  expect(record).toContain(head);
  expect(record).toContain('wip.txt (untracked)');
  const brief = readFileSync(join(root, 'brief.md'), 'utf8');
  expect(brief).toContain(
    "The previous run was cut off in a turn after its last completed one, so its final-message file holds only that earlier turn's result. Where it stopped is in `handoff/0000-cut-off.md`: its last 3 assistant messages;",
  );
  expect(brief).toContain('`wip.txt` (untracked)');
});

it('hands on the record of a Claude run cut off while working past a result held for its background work (R-C17 part 4, decision 0)', async () => {
  let now = new Date('2026-10-18T12:00:00Z');
  const said = (text: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
  const { state, backend, worktree } = await cycleFixture(
    [
      designDone,
      // Through the real Claude normalizer: the result while tracked work runs is held, and the
      // session works on past it; the deadline ends it, and the held result is journaled last.
      {
        resultText: '',
        claudeStream: [
          said('Fixed the quadratic loop in flow_capacity.'),
          { type: 'system', subtype: 'task_started', task_id: 'rt' },
          {
            type: 'result',
            subtype: 'success',
            result: 'Started runtime-test in the background; waiting for it.',
          },
          { type: 'system', subtype: 'task_notification', task_id: 'rt', status: 'completed' },
          said('runtime-test still reports flow_capacity running after 60 seconds.'),
          said('Bisecting the slow test now.'),
        ],
      },
      { resultText: 'Implemented and checks passed.' },
    ],
    () => now,
  );
  let implementations = 0;
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model' && ++implementations === 1)
      writeFileSync(join(request.cwd, 'wip.txt'), 'half done\n');
  };
  const cycle = await startCycle(state, worktree.id);
  const storage = state.context.storage;
  await waitFor(() => backend.sessions.length === 2, 'the implementation');
  const cutOff = currentCycle(state, cycle).currentRunId;
  await waitFor(() => {
    const last = storage.execution.runEvents.latestOfKind(
      state.workspaceId,
      cutOff,
      'assistant-message',
    );
    return last?.kind === 'assistant-message' && last.payload.text.startsWith('Bisecting');
  }, 'the later work');
  now = new Date(Date.parse(currentCycle(state, cycle).runDeadlineAt) + 1);
  await waitFor(
    () => heldStop(currentCycle(state, cycle))?.code === 'step-time-limit',
    'the step time limit',
  );
  await waitFor(
    () => storage.execution.runs.find(state.workspaceId, cutOff)?.status === 'cancelled',
    'the run cancelled',
  );
  // The held result is the run's one completed turn, journaled after the later work, marked.
  const turn = storage.execution.runEvents.latestOfKind(
    state.workspaceId,
    cutOff,
    'turn-completed',
  );
  expect(turn?.kind === 'turn-completed' && turn.payload).toMatchObject({
    resultText: 'Started runtime-test in the background; waiting for it.',
    afterLaterWork: true,
  });

  await controlCycle(state, currentCycle(state, cycle), 'resume');
  await waitFor(() => backend.launches.length === 3, 'the resumed implementation');
  const root = runDirectory(backend.launches[2]!);
  const handoff = join(root, 'handoff');
  const manifest = JSON.parse(readFileSync(join(handoff, 'manifest.json'), 'utf8'));
  expect(manifest.sources[0]).toMatchObject({ runId: cutOff, cutOff: '0000-cut-off.md' });
  expect(manifest.warnings).toEqual([]);
  const record = readFileSync(join(handoff, '0000-cut-off.md'), 'utf8');
  expect(record).toContain('was cut off in a turn after its last completed one');
  expect(record).toContain('Bisecting the slow test now.');
  expect(record).toContain('wip.txt (untracked)');
  expect(readFileSync(join(root, 'brief.md'), 'utf8')).toContain(
    'The previous run was cut off in a turn after its last completed one',
  );
});

describe('the cut-off record (R-C17 part 2)', () => {
  const run = {
    id: asAgentRunId('run-1'),
    role: 'implement' as const,
    status: 'cancelled' as const,
  };
  const message = (sequence: number, text: string) => ({
    sequence,
    occurredAt: '2026-10-16T10:00:00.000Z',
    text,
  });

  it('cuts a long message on a character, says so, and keeps the rest of the record whole', () => {
    // One ASCII byte first, so the 4 KiB cut falls inside a two-byte character.
    const long = `x${'é'.repeat(CUT_OFF_BOUNDS.messageBytes)}TAIL`;
    const { text, summary } = cutOffRecord(run, [message(9, long)], 1, {
      headSha: 'c'.repeat(40),
      changed: [],
      untracked: [],
    });
    expect(text).not.toContain('TAIL');
    expect(text).not.toContain('\uFFFD');
    expect(text).toContain('[cut here; the conversation file has the rest]');
    expect(text).toContain('Nothing uncommitted: the worktree matched its head commit.');
    expect(text).toContain('The last 1 of its 1 assistant message, oldest first');
    expect(summary).toEqual({
      messages: 1,
      headSha: 'c'.repeat(40),
      uncommitted: { paths: [], total: 0 },
    });
  });

  it('lists at most 200 uncommitted files, and gives the brief the first ten', () => {
    const changed = Array.from({ length: 150 }, (_, i) => `src/changed-${i}.rs`);
    const untracked = Array.from({ length: 100 }, (_, i) => `tmp/new-${i}.txt`);
    const { text, summary } = cutOffRecord(run, [], 0, {
      headSha: 'd'.repeat(40),
      changed,
      untracked,
    });
    expect(text).toContain('250 uncommitted files, tracked then untracked:');
    expect(text).toContain('- src/changed-149.rs');
    expect(text).toContain('- tmp/new-49.txt (untracked)');
    expect(text).not.toContain('tmp/new-50.txt');
    expect(text).toContain('- and 50 more (git status in the worktree lists them)');
    expect(text).toContain('It recorded no assistant message.');
    const long = `deep/${'d'.repeat(400)}\u{1F600}.rs`;
    const cut = cutOffRecord(run, [], 0, {
      headSha: 'd'.repeat(40),
      changed: [long],
      untracked: [],
    });
    expect(cut.text).toContain(`- ${long.slice(0, 300)}…`);
    expect(cut.text).not.toContain(long);
    // A path cut inside a surrogate pair keeps the pair whole or drops it.
    const emoji = `${'e'.repeat(299)}\u{1F600}tail`;
    const kept = cutOffRecord(run, [], 0, {
      headSha: 'd'.repeat(40),
      changed: [emoji],
      untracked: [],
    });
    expect(kept.text).not.toContain('\uFFFD');
    expect(kept.text).toContain(`- ${'e'.repeat(299)}…`);
    expect(summary.uncommitted).toEqual({
      paths: changed.slice(0, 10).map((path) => ({ path, untracked: false })),
      total: 250,
    });
  });

  it('fences each message, notes a merge in progress, keeps the head when only the files are unreadable', () => {
    const { text, summary } = cutOffRecord(
      run,
      [message(5, 'Tried:\n```rust\nunfinished fence\n\n## Not a heading of the record')],
      1,
      { headSha: 'f'.repeat(40), changed: ['src/conflict.rs'], untracked: [], conflicted: true },
    );
    expect(text).toContain(
      '````text\nTried:\n```rust\nunfinished fence\n\n## Not a heading of the record\n````',
    );
    expect(text).toContain(
      'Git reports conflicts or an operation in progress (a merge, cherry-pick, revert or rebase).',
    );
    expect(summary.conflicted).toBe(true);
    const partial = cutOffRecord(run, [], 0, {
      headSha: 'a'.repeat(40),
      unreadable: 'output exceeds 16 MiB',
    });
    expect(partial.text).toContain(
      `Head commit: ${'a'.repeat(40)}\n\nIts uncommitted files could not be read: output exceeds 16 MiB`,
    );
    expect(partial.summary).toEqual({
      messages: 0,
      headSha: 'a'.repeat(40),
      unreadable: 'output exceeds 16 MiB',
    });
  });

  it('says when the last completed turn ended in error rather than never completing (R-C17 part 2 L-4)', () => {
    const { text, summary } = cutOffRecord(
      { ...run, status: 'failed' },
      [message(3, 'Working.')],
      1,
      { headSha: 'b'.repeat(40), changed: [], untracked: [] },
      'error-turn',
    );
    expect(text).toContain(
      "The implement run (failed) ended its last completed turn in error, so its final message holds only that turn's result.",
    );
    expect(text).not.toContain('without completing a turn');
    expect(summary).toMatchObject({ messages: 1, end: 'error-turn' });
    expect(cutOffRecord(run, [], 0, undefined).summary).not.toHaveProperty('end');
  });

  it("says when the run was cut off in a turn after its last completed one (R-C17 part 4, part 2's other half)", () => {
    const { text, summary } = cutOffRecord(
      run,
      [message(7, 'Bisecting.')],
      3,
      { headSha: 'c'.repeat(40), changed: [], untracked: [] },
      'later-turn',
    );
    expect(text).toContain(
      "The implement run (cancelled) was cut off in a turn after its last completed one, so its final message holds only that earlier turn's result.",
    );
    expect(text).not.toContain('without completing a turn');
    expect(text).not.toContain('in error');
    expect(summary).toMatchObject({ messages: 1, end: 'later-turn' });
  });

  it('records why the worktree could not be read, on one line', () => {
    const { text, summary } = cutOffRecord(run, [message(3, 'Working.')], 4, {
      unreadable: 'fatal:\nnot a `git` repository',
    });
    expect(text).toContain('The worktree could not be read: fatal:?not a ?git? repository');
    expect(text).toContain('The last 1 of its 4 assistant messages');
    expect(summary).toEqual({ messages: 1, unreadable: 'fatal:\nnot a `git` repository' });
  });
});

describe("reading where a run's worktree stands (R-C17 part 2 review L-2)", () => {
  const head = 'a'.repeat(40);
  const reader = (changes: unknown) =>
    new BranchService(
      {} as never,
      {} as never,
      {} as never,
      {
        inspectRepository: async () => ({
          ok: true,
          value: { topLevel: '/w', headSha: head, branch: 'b', clean: false },
        }),
        inspectWorktreeChanges: async () => changes,
      } as never,
      {} as never,
      () => new Date(),
    );

  it('keeps the head when Git cannot list the uncommitted files', async () => {
    const failed = { ok: false, failure: { kind: 'git-failed', message: 'output exceeds 16 MiB' } };
    expect(await reader(failed).uncommitted({ path: '/w' } as never)).toEqual({
      headSha: head,
      unreadable: 'output exceeds 16 MiB',
    });
  });

  it('says when a merge is in progress', async () => {
    const listed = {
      ok: true,
      value: {
        clean: false,
        trackedClean: false,
        headSha: head,
        branch: 'b',
        paths: ['src/conflict.rs'],
        untracked: ['notes.txt'],
        fingerprint: 'f',
        conflicted: true,
      },
    };
    expect(await reader(listed).uncommitted({ path: '/w' } as never)).toEqual({
      headSha: head,
      changed: ['src/conflict.rs'],
      untracked: ['notes.txt'],
      conflicted: true,
    });
  });
});

describe("which runs' handoffs carry the record (R-C17 part 2 L-4 review L-2, and part 4)", () => {
  type Event = { readonly kind: string; readonly payload: Record<string, unknown> };
  const run = (id: string, parentRunId?: string) =>
    ({
      id,
      workspaceId: 'ws',
      worktreeId: 'tree',
      workItemId: 'item',
      role: 'implement',
      status: 'failed',
      outcomeSummary: 'summary',
      ...(parentRunId ? { parentRunId } : {}),
    }) as unknown as AgentRun;
  /** The journal reads `writeRunHandoff` makes, over events held in memory. */
  const journal = (runs: readonly AgentRun[], events: Record<string, readonly Event[]>) => {
    const stored = (id: string) =>
      (events[id] ?? []).map((event, i) => ({
        ...event,
        sequence: i + 1,
        occurredAt: '2026-10-17T00:00:00Z',
        runId: id,
        workspaceId: 'ws',
      }));
    return {
      runs: { find: (_ws: string, id: string) => runs.find((r) => r.id === id) },
      runEvents: {
        listAfter: ({ runId, after, limit }: { runId: string; after: number; limit: number }) =>
          stored(runId)
            .filter((event) => event.sequence > after)
            .slice(0, limit),
        latestOfKind: (_ws: string, runId: string, kind: string) =>
          stored(runId)
            .filter((event) => event.kind === kind)
            .at(-1),
      },
      cycles: { activeForWorktree: () => undefined },
    } as never;
  };
  const turn = (outcome: 'success' | 'error', resultText: string): Event => ({
    kind: 'turn-completed',
    payload: { outcome, resultText, turns: 1, durationMs: 1 },
  });
  const said = (text: string): Event => ({ kind: 'assistant-message', payload: { text } });
  const asked = (text: string): Event => ({ kind: 'user-message', payload: { text } });
  const called = (name: string): Event => ({
    kind: 'tool-call',
    payload: { toolUseId: name, name, input: {}, summary: name },
  });
  const noted = (kind: 'notice' | 'stderr'): Event => ({
    kind,
    payload: kind === 'notice' ? { category: 'other', message: 'm' } : { text: 'e' },
  });
  const worktree = { headSha: 'a'.repeat(40), changed: [], untracked: ['wip.txt'] };
  /** The launch's reading: the cut-off, read once, and the worktree with it (as `materialize`). */
  const handoff = (execution: never, parent: AgentRun, dir: string) => {
    const end = runCutOff(execution, parent);
    return writeRunHandoff(execution, parent, dir, end && { end, worktree });
  };

  it.each([
    [
      'a completed turn and nothing after it',
      undefined,
      [asked('go'), said('a'), turn('success', 'Done.')],
    ],
    ['no completed turn', 'no-turn', [asked('go'), said('a'), called('Bash')]],
    ['nothing at all', 'no-turn', []],
    [
      'a latest completed turn in error',
      'error-turn',
      [asked('go'), said('a'), turn('error', 'Turn ended.')],
    ],
    [
      'an assistant message after the completed turn',
      'later-turn',
      [asked('go'), turn('success', 'Done.'), said('b')],
    ],
    [
      'a tool call after the completed turn',
      'later-turn',
      [asked('go'), turn('success', 'Done.'), called('Bash')],
    ],
    [
      'a message after an error turn',
      'later-turn',
      [asked('go'), turn('error', 'Turn ended.'), said('b')],
    ],
    [
      'only a follow-up asked after the completed turn',
      undefined,
      [asked('go'), turn('success', 'Done.'), asked('more')],
    ],
    [
      'only notices and stderr after the completed turn',
      undefined,
      [asked('go'), turn('success', 'Done.'), noted('notice'), noted('stderr')],
    ],
    [
      'a later turn that completed too',
      undefined,
      [asked('go'), turn('success', 'Done.'), said('b'), turn('success', 'Done again.')],
    ],
    [
      'a held result journaled at exit after later work',
      'later-turn',
      [
        asked('go'),
        said('a'),
        said('b'),
        {
          kind: 'turn-completed',
          payload: {
            outcome: 'success',
            resultText: 'Waiting.',
            turns: 1,
            durationMs: 1,
            afterLaterWork: true,
          },
        },
      ],
    ],
  ] as const)('reads %s as %s', (_label, expected, events) => {
    const parent = run('p');
    expect(runCutOff(journal([parent], { p: events }), parent)).toBe(expected);
  });

  it('reads past a page of events after the completed turn', () => {
    const parent = run('p');
    const quiet = Array.from({ length: 250 }, () => noted('stderr'));
    const events = { p: [asked('go'), turn('success', 'Done.'), ...quiet, called('Bash')] };
    expect(runCutOff(journal([parent], events), parent)).toBe('later-turn');
  });
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const directory = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cut-off-'));
    made.push(dir);
    return dir;
  };

  it('gives none after an error turn the run later completed a turn past', () => {
    const parent = run('p');
    const dir = directory();
    const files = handoff(
      journal([parent], {
        p: [
          asked('go'),
          said('a'),
          turn('error', 'Turn ended: error_during_execution'),
          asked('again'),
          said('b'),
          turn('success', 'Done.'),
        ],
      }),
      parent,
      dir,
    );
    expect(files.cutOff).toBeUndefined();
    expect(existsSync(join(dir, '0000-cut-off.md'))).toBe(false);
  });

  it("gives one to the immediate parent only, never an older run's error turn", () => {
    const older = run('old');
    const parent = run('p', 'old');
    const runs = [older, parent];
    const events = {
      old: [asked('go'), said('x'), turn('error', 'The selected model is at capacity.')],
      p: [asked('go'), said('y'), turn('success', 'Done.')],
    };
    const dir = directory();
    expect(handoff(journal(runs, events), parent, dir).cutOff).toBeUndefined();
    expect(existsSync(join(dir, '0001-cut-off.md'))).toBe(false);
    // Both errored: the record is the immediate parent's, at its own path.
    const both = directory();
    const files = handoff(
      journal(runs, { ...events, p: [asked('go'), said('y'), turn('error', 'Again.')] }),
      parent,
      both,
    );
    expect(files.cutOff?.path).toBe(join(both, '0000-cut-off.md'));
    expect(existsSync(join(both, '0001-cut-off.md'))).toBe(false);
  });
});
