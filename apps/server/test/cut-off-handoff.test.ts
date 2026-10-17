import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  cycleFixture,
  designDone,
  git,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C17 part 2 (found live 2026-10-16): a run cut off at the step limit leaves no final message,
 * so the resumed step's handoff said only that, and the next agent rediscovered the problem from
 * scratch. The handoff of a run that ended with no completed turn now carries its last assistant
 * messages, bounded, its head commit and the worktree's uncommitted files, beside the warning.
 */

afterEach(cleanupExecutionFixtures);

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
    () => currentCycle(state, cycle).attention?.code === 'step-time-limit',
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
});
