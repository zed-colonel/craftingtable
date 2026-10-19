import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import { workCycleResponseSchema } from '@craftingtable/contracts';
import { heldStop } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  designDone,
  mutationHeaders,
  type Ready,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C17 part 4 (found live 2026-10-16 on WIP-07): the `step-time-limit` stop's controls, through
 * the daemon. Increment 1 characterizes them before the part changes them: the stop offers Resume
 * and Stop, the guided resume the browser never offers is accepted and relaunches the step with a
 * fresh window from the cycle's own policy.
 */

afterEach(cleanupExecutionFixtures);

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
  const cycle = await startCycle(state, worktree.id);
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
  return { state, backend, cycle, clock: { set: (at: Date) => (now = at), now: () => now } };
}

const control = (state: Ready, cycleId: string, payload: Record<string, unknown>) =>
  state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycleId}/control`,
    headers: mutationHeaders(state),
    payload,
  });

it('offers Resume and Stop at the time-limit stop, and accepts the guided resume it does not offer (R-C17 part 4, increment 1)', async () => {
  const { state, backend, cycle, clock } = await atTimeLimit();
  expect(await actions(state, cycle.id)).toEqual(['resume', 'stop']);
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
  expect(Date.parse(after.runDeadlineAt)).toBe(
    clock.now().getTime() + after.policy.maxRunMinutes * 60_000,
  );
  await waitFor(() => backend.launches.length === 3, 'the guided implementation');
  const brief = readFileSync(join(runDirectory(backend.launches[2]!), 'brief.md'), 'utf8');
  expect(brief).toContain('Run flow_capacity alone under a timeout first.');
});

it('offers Resume and Stop at the time-limit stop a pause kept (R-C17 part 4, increment 1)', async () => {
  const { state, cycle } = await atTimeLimit();
  const paused = await control(state, cycle.id, {
    action: 'pause',
    expectedVersion: currentCycle(state, cycle).version,
  });
  expect(paused.statusCode, paused.body).toBe(200);
  expect(heldStop(currentCycle(state, cycle))?.code).toBe('step-time-limit');
  expect(await actions(state, cycle.id)).toEqual(['resume', 'stop']);
});
