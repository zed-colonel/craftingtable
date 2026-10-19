import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import { workCycleResponseSchema } from '@craftingtable/contracts';
import { DEFAULT_COMPLETION_POLICY, heldStop } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  designDone,
  mutationHeaders,
  type Ready,
  runToFinish,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C17 part 4 (found live 2026-10-16 on WIP-07): the `step-time-limit` stop's controls, through
 * the daemon. Increment 1 characterized them (the stop offered Resume and Stop; the guided resume
 * it did not offer was accepted); since increment 2 the stop offers Continue with guidance beside
 * Resume, and the guided resume relaunches the step with a fresh window from the cycle's policy.
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

const actions = async (state: Ready, cycleId: string) =>
  (
    await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/cycles`,
      headers: { cookie: state.cookie },
    })
  )
    .json()
    .cycles.find((view: { cycle: { id: string } }) => view.cycle.id === cycleId)?.projection
    .actions;

/** A cycle whose implementation works on until its step's deadline cancels it. */
async function atTimeLimit() {
  let now = new Date('2026-10-18T12:00:00Z');
  const { state, backend, worktree } = await cycleFixture(
    [
      designDone,
      {
        resultText: '',
        claudeStream: [
          { type: 'assistant', message: { content: [{ type: 'text', text: 'Still testing.' }] } },
        ],
      },
      { resultText: 'Implemented and checks passed.' },
    ],
    () => now,
  );
  // Not the default 120, so the fresh window is read from the cycle's own policy (inc 1 review L-1).
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRunMinutes: 45 },
  });
  await waitFor(() => backend.sessions.length === 2, 'the implementation');
  await waitFor(() => {
    const run = state.context.storage.execution.runEvents.latestOfKind(
      state.workspaceId,
      currentCycle(state, cycle).currentRunId,
      'assistant-message',
    );
    return run !== undefined;
  }, 'the implementation at work');
  now = new Date(Date.parse(currentCycle(state, cycle).runDeadlineAt) + 1);
  await waitFor(
    () => heldStop(currentCycle(state, cycle))?.code === 'step-time-limit',
    'the step time limit',
  );
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(
        state.workspaceId,
        currentCycle(state, cycle).currentRunId,
      )?.status === 'cancelled',
    'the run cancelled',
  );
  return {
    state,
    backend,
    cycle,
    worktree,
    clock: { set: (at: Date) => (now = at), now: () => now },
  };
}

const control = (state: Ready, cycleId: string, payload: Record<string, unknown>) =>
  state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycleId}/control`,
    headers: mutationHeaders(state),
    payload,
  });

it('offers Continue with guidance at the time-limit stop, and continues the step with it (R-C17 part 4, increments 1 and 2)', async () => {
  const { state, backend, cycle, clock } = await atTimeLimit();
  expect(await actions(state, cycle.id)).toEqual([
    'resume',
    'continue-with-guidance',
    'change-settings',
    'stop',
  ]);
  const stopped = currentCycle(state, cycle);
  expect(stopped).toMatchObject({ status: 'needs-attention', step: 'implement' });

  const resumed = await control(state, cycle.id, {
    action: 'resume',
    expectedVersion: stopped.version,
    instructions: 'Run flow_capacity alone under a timeout first.',
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  const after = workCycleResponseSchema.parse(resumed.json()).cycle;
  expect(after).toMatchObject({ status: 'running', step: 'implement' });
  expect(after.attempt?.stepGuidance).toBe('Run flow_capacity alone under a timeout first.');
  // A fresh window from the cycle's own policy.
  expect(after.policy.maxRunMinutes).toBe(45);
  expect(Date.parse(after.runDeadlineAt)).toBe(clock.now().getTime() + 45 * 60_000);
  await waitFor(() => backend.launches.length === 3, 'the guided implementation');
  const brief = readFileSync(join(runDirectory(backend.launches[2]!), 'brief.md'), 'utf8');
  expect(brief).toContain('Run flow_capacity alone under a timeout first.');
});

it('offers the same at the time-limit stop a pause kept (R-C17 part 4, increments 1 and 2)', async () => {
  const { state, cycle } = await atTimeLimit();
  const paused = await control(state, cycle.id, {
    action: 'pause',
    expectedVersion: currentCycle(state, cycle).version,
  });
  expect(paused.statusCode, paused.body).toBe(200);
  expect(heldStop(currentCycle(state, cycle))?.code).toBe('step-time-limit');
  expect(await actions(state, cycle.id)).toEqual([
    'resume',
    'continue-with-guidance',
    'change-settings',
    'stop',
  ]);
});

// Increment 1 review M-2: the offer reads the worktree's newest run, as the command does.
it('offers no guidance once a newer manual run outside the lineage is the worktree’s newest (R-C17 part 4, increment 2)', async () => {
  const { state, cycle, worktree } = await atTimeLimit();
  await runToFinish(state, worktree.id, { role: 'implement' });
  expect(await actions(state, cycle.id)).toEqual(['change-settings', 'stop']);
});

// Increment 1 re-check RL-1: a newer run inside the lineage keeps Resume (it adopts the run), but
// the guided resume needs the cycle's own run to be the newest, so no guidance is offered: the
// projection reads the tree's newest run, as the command does.
it('offers no guidance once a newer run in the lineage is the worktree’s newest, while Resume adopts it (R-C17 part 4, increment 2)', async () => {
  const { state, cycle, worktree } = await atTimeLimit();
  await runToFinish(state, worktree.id, {
    role: 'implement',
    parentRunId: currentCycle(state, cycle).currentRunId,
  });
  expect(await actions(state, cycle.id)).toEqual(['resume', 'change-settings', 'stop']);
});

// Increment 2 review L-1: the offer reads whether a run is live, as the command does (a paused
// cycle can keep its own session): with one live, no guidance is offered.
it('offers no guidance while a run in the worktree is live (R-C17 part 4, increment 2)', async () => {
  const { state, cycle } = await atTimeLimit();
  const own = state.context.storage.execution.runs.find(
    state.workspaceId,
    currentCycle(state, cycle).currentRunId,
  )!;
  vi.spyOn(state.context.storage.execution.runs, 'liveForWorktree').mockReturnValue([
    { ...own, status: 'waiting' },
  ]);
  expect(await actions(state, cycle.id)).toEqual(['resume', 'change-settings', 'stop']);
});
