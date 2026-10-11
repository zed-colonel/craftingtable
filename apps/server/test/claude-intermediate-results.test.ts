import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeBackend } from '@craftingtable/agents';
import { startAgentRunResponseSchema } from '@craftingtable/contracts';
import type { AgentRunId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  fixtureRepository,
  mutationHeaders,
  type Ready,
  ready,
  registerAndWorktree,
  reviewText,
  stepUp,
  waitFor,
} from './execution-test-support.js';

/**
 * Claude background-task notifications through the real adapter and daemon (R-G11, AGT-62): a
 * stand-in `claude` process writes the stream a session with background tasks writes, and the
 * daemon journals and assesses what the adapter makes of it.
 */
const directories: string[] = [];
afterEach(async () => {
  await cleanupExecutionFixtures();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A daemon whose Claude backend runs a fake writing `messages`, `pause` ms apart. */
async function claudeDaemon(messages: readonly unknown[], exitAtEnd: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-claude-stream-'));
  directories.push(directory);
  const executable = join(directory, 'claude');
  writeFileSync(
    executable,
    `#!${process.execPath}
const lines = ${JSON.stringify(messages.map((message) => JSON.stringify(message)))};
process.stdin.once('data', () => {
  const next = () => {
    const line = lines.shift();
    if (line !== undefined) process.stdout.write(line + '\\n', () => setTimeout(next, 100));
    else if (${exitAtEnd}) process.exit(0);
  };
  next();
});
process.stdin.on('end', () => process.exit(0));
`,
  );
  chmodSync(executable, 0o755);
  const state = await ready({
    backends: new Map([['claude-code', new ClaudeCodeBackend({ executable })]]),
  });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  // Unrestricted, which needs a fresh password: the stand-in needs no command sandbox.
  await stepUp(state);
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'review', permissionMode: 'unrestricted' },
  });
  expect(started.statusCode, started.body).toBe(200);
  return { state, runId: startAgentRunResponseSchema.parse(started.json()).run.id };
}

function journal(state: Ready, runId: AgentRunId) {
  return state.context.storage.execution.runEvents.listAfter({
    workspaceId: state.workspaceId,
    runId,
    after: 0,
    limit: 500,
  });
}

/** The statuses the run moved to, in order. */
function statuses(state: Ready, runId: AgentRunId): string[] {
  return state.context.storage.workspaceEvents
    .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 500 })
    .flatMap((event) =>
      event.kind === 'agent-run-status-changed' && event.payload.runId === runId
        ? [event.payload.toStatus]
        : [],
    );
}

const init = { type: 'system', subtype: 'init', session_id: 'fake', model: 'fake-model' };
const task = (subtype: string, id: string) => ({
  type: 'system',
  subtype,
  task_id: id,
  status: 'completed',
});
const result = (text: string) => ({ type: 'result', subtype: 'success', result: text });
const said = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});

it('completes a review turn once, at the collected result, after N task-notification results (R-G11, AGT-62)', async () => {
  const tasks = ['a', 'b', 'c', 'd'];
  const { state, runId } = await claudeDaemon(
    [
      init,
      ...tasks.map((id) => task('task_started', id)),
      result('Started four checks. Waiting.'),
      ...tasks.flatMap((id, i) => [
        task('task_notification', id),
        said(`${id} passed.`),
        result(i < tasks.length - 1 ? `${id} passed. Waiting.` : reviewText()),
      ]),
    ],
    false,
  );
  const run = () => state.context.storage.execution.runs.find(state.workspaceId, runId);
  await waitFor(() => run()?.status === 'waiting', 'the collected result');
  const events = journal(state, runId);
  const turns = events.flatMap((event) => (event.kind === 'turn-completed' ? [event.payload] : []));
  // One turn, assessed once, as a valid report.
  expect(turns).toHaveLength(1);
  expect(turns[0]?.resultText).toBe(reviewText());
  expect(turns[0]?.reviewReport).toMatchObject({ status: 'complete' });
  expect(
    events.filter(
      (event) =>
        event.kind === 'notice' && event.payload.message.startsWith('Progress while background'),
    ),
  ).toHaveLength(tasks.length);
  // The run worked until the collected result, and only then waited.
  expect(statuses(state, runId)).toEqual(['running', 'waiting']);
  expect(run()).toMatchObject({ turnCount: 1, verdict: 'mergeable' });

  await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${runId}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'end' },
  });
  await waitFor(() => run()?.status === 'finished', 'the run to finish');
});

it("records the last result as the step's turn when the session exits with work uncollected (R-G11)", async () => {
  const { state, runId } = await claudeDaemon(
    [init, task('task_started', 'matrix'), result('Started the matrix. Waiting.')],
    true,
  );
  const run = () => state.context.storage.execution.runs.find(state.workspaceId, runId);
  await waitFor(() => run()?.status === 'failed', 'the session to exit');
  const events = journal(state, runId);
  const turns = events.flatMap((event) => (event.kind === 'turn-completed' ? [event.payload] : []));
  expect(turns).toEqual([
    expect.objectContaining({ outcome: 'success', resultText: 'Started the matrix. Waiting.' }),
  ]);
  expect(events.at(-1)).toMatchObject({
    kind: 'run-finished',
    payload: { status: 'failed', reason: 'background-work-incomplete' },
  });
});
