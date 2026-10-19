import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLaunchRequest, AgentSession } from '@craftingtable/agents';
import {
  asAgentRunEventId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  cycleAttention,
  DEFAULT_COMPLETION_POLICY,
  heldStop,
  stopRecord,
  type WorkCycle,
} from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRequestError } from '../src/services/errors.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  admit,
  cleanupExecutionFixtures,
  controlCycle,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  fixtureRepository,
  git,
  implementationDone,
  mutationHeaders,
  ready,
  registerAndWorktree,
  reviewText,
  runToFinish,
  ScriptedBackend,
  startCycle,
  stepDaemons,
  stepUp,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

describe('single work-item automation', () => {
  it('scopes guidance given on a review retry to that review only', async () => {
    const retryGuidance = 'For this retry of the review only, restate the report in full.';
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      {
        resultText: `## Open questions\nShould the report restate the boundary?\n\n## Review report\n${reviewText([])}`,
      },
      { resultText: reviewText([structuredFinding]) },
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Verified regression case.' },
        ]),
      },
    ]);
    const cycle = await startCycle(state, worktree.id, { instructions: 'Keep the approved API.' });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'review question');
    expect(currentCycle(state, cycle).step).toBe('review');
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'resume',
        expectedVersion: currentCycle(state, cycle).version,
        instructions: retryGuidance,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'remediated');
    const prompts = backend.launches.map((launch) => launch.prompt);
    expect(prompts).toHaveLength(6);
    expect(prompts[3]).toContain(`## Operator guidance for this step\n\n${retryGuidance}`);
    // The following implement (remediation) brief and the next review do not inherit it.
    for (const later of prompts.slice(4)) {
      expect(later).not.toContain(retryGuidance);
      expect(later).toContain('Keep the approved API.');
    }
    expect(currentCycle(state, cycle)).toMatchObject({ instructions: 'Keep the approved API.' });
    expect(currentCycle(state, cycle).attempt?.stepGuidance).toBeUndefined();
    // Controller-authored rules are labelled as such; the operator section holds only operator text.
    const operator = prompts[4]?.split('## Operator instructions\n\n')[1]?.split('\n## ')[0];
    expect(operator?.trim()).toBe('Keep the approved API.');
    expect(prompts[4]).toContain('## Step rules (from the controller)');
  });

  it('does not treat disappearing finding IDs as resolution', async () => {
    const { state, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([structuredFinding]) },
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'missing finding');
    expect(currentCycle(state, cycle).reason).toContain('structured');
  });

  it('rejects a stale reviewed commit at operator merge', async () => {
    const { state, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'merge approval');
    writeFileSync(join(worktree.path, 'later.txt'), 'unreviewed');
    git(['add', '.'], worktree.path);
    git(['commit', '-m', 'later'], worktree.path);
    // A merge into the repository's default branch needs the password again (R-G9).
    await stepUp(state);
    const merge = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/merge`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(merge.statusCode).toBe(409);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it('rejects duplicate starts, stale controls, missing CSRF and foreign-workspace controls', async () => {
    const { state, worktree } = await cycleFixture([{ resultText: '## Open questions\nQuestion' }]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'questions');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`;
    const stale = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: { action: 'resume', expectedVersion: cycle.version },
    });
    expect(stale.statusCode).toBe(409);
    const csrf = await state.context.app.inject({
      method: 'POST',
      url,
      headers: { cookie: state.cookie, origin: state.context.config.publicOrigin },
      payload: { action: 'resume', expectedVersion: currentCycle(state, cycle).version },
    });
    expect(csrf.statusCode).toBe(403);
    const foreign = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/foreign/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'stop', expectedVersion: currentCycle(state, cycle).version },
    });
    expect(foreign.statusCode).toBe(404);
    const duplicate = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/cycles`,
      headers: mutationHeaders(state),
      payload: {
        worktreeId: worktree.id,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
      },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('recovers a durable reservation without replaying it after restart', async () => {
    const { state, backend, worktree } = await cycleFixture([designDone]);
    await state.context.services.workCycleService.shutdown();
    const cycle = await startCycle(state, worktree.id);
    expect(backend.launches).toHaveLength(0);
    state.context.services.workCycleService.recoverInterrupted();
    expect(currentCycle(state, cycle).status).toBe('needs-attention');
    expect(currentCycle(state, cycle).reason).toContain('restarted');
    expect(backend.launches).toHaveLength(0);
    const stopped = await controlCycle(state, currentCycle(state, cycle), 'stop');
    expect(stopped.status).toBe('stopped');
    // Manual flow remains available after the cycle has relinquished ownership.
    await runToFinish(state, worktree.id, { role: 'design' });
    expect(backend.launches).toHaveLength(1);
  });

  it('requires completed required predecessors, while admission remains manual', async () => {
    const { state, backend, worktree } = await cycleFixture([designDone]);
    state.context.storage.planning.workItems.insertMany([
      {
        id: asWorkItemId('predecessor'),
        workspaceId: state.workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        sourceId: 'AQ-00',
        ordinal: 1,
        title: 'Prerequisite',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'Done',
        sourceFields: {},
      },
    ]);
    state.context.storage.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId('dependency-1'),
        workspaceId: state.workspaceId,
        planVersionId: asPlanVersionId('version-1'),
        predecessorWorkItemId: asWorkItemId('predecessor'),
        successorWorkItemId: state.workItemId,
        kind: 'required',
        ordinal: 0,
      },
    ]);
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/cycles`,
      headers: mutationHeaders(state),
      payload: {
        worktreeId: worktree.id,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('AQ-00');
    expect(backend.launches).toHaveLength(0);
  });
});

describe('cycle supervision and operator races', () => {
  it('cancels a timed-out run and leaves the quality gate closed', async () => {
    let time = new Date();
    const { state, backend, worktree } = await cycleFixture([designDone], () => time);
    const cycle = await startCycle(state, worktree.id, { instructions: 'DEFER-TURNS' });
    await waitFor(() => backend.launches.length === 1, 'launch');
    time = new Date(time.getTime() + 121 * 60_000);
    state.context.services.workspaceEventNotifier.notify();
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'timeout');
    expect(currentCycle(state, cycle).reason).toContain('time limit');
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'cancelled',
      'cancelled process',
    );
    expect(backend.launches).toHaveLength(1);
  });

  it('allows manual control only after pausing and resumes through the completed design', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id, { instructions: 'DEFER-TURNS' });
    await waitFor(() => backend.launches.length === 1, 'design launch');
    const blocked = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id },
    });
    expect(blocked.statusCode).toBe(409);
    const paused = await controlCycle(state, currentCycle(state, cycle), 'pause');
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'waiting',
      'manual waiting session',
    );
    expect(backend.launches).toHaveLength(1);
    const ended = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${cycle.currentRunId}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'end' },
    });
    expect(ended.statusCode).toBe(200);
    await controlCycle(state, paused, 'resume');
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'resumed cycle');
    expect(backend.launches).toHaveLength(3);
  });

  it('kills a delayed launch when the operator stops its reservation', async () => {
    let release: (() => void) | undefined;
    let launching = false;
    class DelayedBackend extends ScriptedBackend {
      override async launch(request: AgentLaunchRequest): Promise<AgentSession> {
        launching = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return super.launch(request);
      }
    }
    const backend = new DelayedBackend();
    const state = await ready({ backend, workers: true });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    await admit(state);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => launching, 'pending launch');
    try {
      await controlCycle(state, currentCycle(state, cycle), 'stop');
    } finally {
      release?.();
    }
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'cancelled',
      'delayed process cancellation',
    );
    expect(currentCycle(state, cycle).status).toBe('stopped');
    expect(backend.launches).toHaveLength(1);
  });
});

it('does not lose earlier cycle findings when an unrelated manual run is resumed', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
  ]);
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'policy stop');
  // The daemon returns the actions it offers with the cycle (R-A6): a newer manual run in the
  // worktree is new input that a resume adopts, so the offer follows the tree's newest run. One
  // outside the cycle's handoff lineage cannot be adopted, so Resume is not offered for it either
  // (R-B4, decision 14): the offer and the command agree.
  const listedActions = async () =>
    (
      await state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${state.workspaceId}/cycles`,
        headers: { cookie: state.cookie },
      })
    )
      .json()
      .cycles.find((v: { cycle: { id: string } }) => v.cycle.id === cycle.id)?.projection.actions;
  // A stopped cycle's settings change is offered beside the rest (R-C17 part 4, decision 3).
  expect(await listedActions()).toEqual(['authorize-remediation', 'change-settings', 'stop']);
  await runToFinish(state, worktree.id, { role: 'implement' });
  expect(await listedActions()).toEqual(['change-settings', 'stop']);
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'resume', expectedVersion: currentCycle(state, cycle).version },
  });
  expect(response.statusCode).toBe(409);
  expect(response.body).toContain('handoff lineage');
  expect(backend.launches).toHaveLength(4);
});

// R-B4, decision 14: a plain resume at the round limit, from a stop with no redirect of its own,
// is refused toward Authorize more remediation instead of recording the limit stop itself.
it('refuses a plain resume at the round limit toward Authorize more remediation', async () => {
  const { state, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
  ]);
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'policy stop');
  // A daemon restart stopped the cycle at the finished review instead (no redirect).
  const limit = currentCycle(state, cycle);
  expect(limit).toMatchObject({ step: 'review', stop: { code: 'remediation-exhausted' } });
  const restarted = {
    ...limit,
    stop: stopRecord(cycleAttention('restart-resume'), limit.updatedAt),
    reason: 'Daemon restarted. Inspect the interrupted step and resume explicitly.',
    version: limit.version + 1,
  };
  expect(state.context.storage.execution.cycles.replace(restarted, limit.version)).toBeTruthy();
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'resume', expectedVersion: restarted.version },
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.body).toContain('Authorize more remediation');
  expect(currentCycle(state, cycle)).toEqual(restarted);
  // The control it names is offered in Resume's place, there and at a plain pause, and grants
  // from either (increment 6 review, HIGH-1).
  const offered = async () =>
    (
      await state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${state.workspaceId}/cycles`,
        headers: { cookie: state.cookie },
      })
    )
      .json()
      .cycles.find((v: { cycle: { id: string } }) => v.cycle.id === cycle.id)?.projection.actions;
  expect(await offered()).toEqual(['authorize-remediation', 'change-settings', 'stop']);
  const { stop: _stop, ...unstopped } = restarted;
  const paused = { ...unstopped, status: 'paused' as const, version: restarted.version + 1 };
  expect(state.context.storage.execution.cycles.replace(paused, restarted.version)).toBeTruthy();
  expect(await offered()).toEqual(['authorize-remediation', 'change-settings', 'stop']);
  const grant = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: {
      action: 'authorize-remediation',
      expectedVersion: paused.version,
      additionalRounds: 1,
      instructions: '',
    },
  });
  expect(grant.statusCode, grant.body).toBe(200);
});

// R-B4 increment 6 re-check, NIT-4's turn half: the grant needs the review's turn to have
// succeeded untruncated (`remediationBlocker`), so a review whose turn failed but whose report is
// complete is not offered the grant in Resume's place, and its resume is not refused toward it.
it('offers Resume, not a grant it refuses, at the round limit when the review’s turn failed', async () => {
  const { state, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
  ]);
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'policy stop');
  const limit = currentCycle(state, cycle);
  // A failed turn with the complete report in its text and no stored assessment, as review turns
  // were recorded before the daemon assessed them (6cbc23b, 2026-09-10); the step stopped on it.
  state.context.storage.execution.runEvents.append({
    id: asAgentRunEventId(randomUUID()),
    workspaceId: state.workspaceId,
    runId: limit.currentRunId,
    occurredAt: new Date().toISOString(),
    kind: 'turn-completed',
    payload: {
      outcome: 'error',
      resultText: reviewText([structuredFinding]),
      turns: 1,
      durationMs: 1,
    },
  });
  const incomplete = {
    ...limit,
    stop: stopRecord(cycleAttention('step-incomplete'), limit.updatedAt),
    reason:
      'The step did not finish with a complete successful result. Inspect it before resuming.',
    version: limit.version + 1,
  };
  expect(state.context.storage.execution.cycles.replace(incomplete, limit.version)).toBeTruthy();
  const offered = async () =>
    (
      await state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${state.workspaceId}/cycles`,
        headers: { cookie: state.cookie },
      })
    )
      .json()
      .cycles.find((v: { cycle: { id: string } }) => v.cycle.id === cycle.id)?.projection.actions;
  // No guidance beside it: the review's turn failed, so the guided resume's remediation would be
  // refused (R-C17 part 4, increment 2 review M-1).
  expect(await offered()).toEqual(['resume', 'change-settings', 'stop']);
  // The same at a pause taken at that stop, which keeps it (review of a2fd3e5, R3).
  const paused = { ...incomplete, status: 'paused' as const, version: incomplete.version + 1 };
  expect(state.context.storage.execution.cycles.replace(paused, incomplete.version)).toBeTruthy();
  expect(await offered()).toEqual(['resume', 'change-settings', 'stop']);
  const control = (payload: Record<string, unknown>) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: { expectedVersion: paused.version, ...payload },
    });
  const grant = await control({
    action: 'authorize-remediation',
    additionalRounds: 1,
    instructions: '',
  });
  expect(grant.statusCode, grant.body).toBe(409);
  expect(grant.body).toContain('Resolve the questions or incomplete outcome');
  expect(currentCycle(state, cycle)).toEqual(paused);
  // Resume goes on as before decision 14: the remediation it reaches stops at the limit.
  const resumed = await control({ action: 'resume' });
  expect(resumed.statusCode, resumed.body).toBe(200);
  expect(currentCycle(state, cycle)).toMatchObject({
    status: 'needs-attention',
    step: 'review',
    stop: { code: 'remediation-exhausted' },
  });
});

// R-B4 increment 6 review, LOW-3 (W15): a review asked again for skipped adopted checks whose
// reservation is refused puts the cycle back at its gate, and the refusal is the one reported.
it('restores the merge gate when a review asked again for adopted checks is refused', async () => {
  const { state, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'approval');
  const approved = currentCycle(state, cycle);
  // W13: not while a session is live in the worktree.
  const live = vi
    .spyOn(state.context.storage.execution.runs, 'liveForWorktree')
    .mockReturnValue([{ id: 'run-live' } as never]);
  expect(
    await state.context.services.workCycleService.reviewForDeclaredChecks(approved, () => {}),
  ).toBe(false);
  expect(currentCycle(state, cycle)).toEqual(approved);
  live.mockRestore();
  let checks = 0;
  const refusal = new ExecutionRequestError(
    'conflict',
    'Delegation changed during the reservation.',
  );
  await expect(
    state.context.services.workCycleService.reviewForDeclaredChecks(approved, () => {
      if (++checks === 2) throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(currentCycle(state, cycle)).toMatchObject({
    status: 'awaiting-merge',
    stop: heldStop(approved),
    reason: approved.reason,
  });
});

it('refreshes a phase wait when its blockers change and records nothing for a controller write that changes nothing', async () => {
  const { state, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'approval');
  const cycleEvents = () =>
    state.context.storage.workspaceEvents
      .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 1000 })
      .filter((e) => e.kind === 'work-cycle-changed').length;
  const { PhaseGateError } = await import('../src/services/phase-resources.js');
  const service = state.context.services.workCycleService as unknown as {
    apply: (cycle: WorkCycle) => Promise<void>;
    // The cycle's one write path (R-B7 increment 6: the writer).
    writer: { change: (cycle: WorkCycle, changes: Partial<WorkCycle>) => WorkCycle };
  };
  let blockers: import('@craftingtable/domain').PhaseBlocker[] = [
    { kind: 'resource', code: 'resource-busy', message: 'Resource build capacity is in use.' },
  ];
  // Whatever the cycle decided, applying it meets a waiting phase gate, which `reconcile`
  // records as the phase wait (R-B4).
  vi.spyOn(service, 'apply').mockImplementation(async () => {
    throw new PhaseGateError(blockers);
  });
  await waitFor(
    () => currentCycle(state, cycle).waits?.phase?.blockers[0]?.kind === 'resource',
    'wait',
  );
  const first = currentCycle(state, cycle);
  await stepDaemons(3);
  expect(currentCycle(state, cycle).version).toBe(first.version);
  blockers = [
    {
      kind: 'dependency',
      code: 'slice-requirement',
      message: 'Predecessor AQ-00 is not merged yet.',
    },
  ];
  await waitFor(
    () => currentCycle(state, cycle).waits?.phase?.blockers[0]?.kind === 'dependency',
    'refreshed wait',
  );
  const refreshed = currentCycle(state, cycle);
  expect(refreshed).toMatchObject({
    status: 'awaiting-merge',
    reason: 'Predecessor AQ-00 is not merged yet.',
    waits: { phase: { since: first.waits?.phase?.since, blockers } },
  });
  const events = cycleEvents();
  expect(
    service.writer.change(refreshed, {
      reason: refreshed.reason,
      waits: { phase: refreshed.waits?.phase },
    }),
  ).toBe(refreshed);
  expect(currentCycle(state, cycle).version).toBe(refreshed.version);
  expect(cycleEvents()).toBe(events);
});

it.each(['pause', 'stop'] as const)(
  'honors %s while Git preflight is pending without launching an agent',
  async (action) => {
    const realGit = createGitOperations({ gitExecutable: 'git' });
    let blocking = false;
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = await ready({
      workers: true,
      gitOperations: {
        ...realGit,
        resolveBranch: async (path, branch) => {
          if (blocking) {
            entered = true;
            await gate;
          }
          return realGit.resolveBranch(path, branch);
        },
      },
    });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    await admit(state);
    blocking = true;
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => entered, 'Git preflight began');
    try {
      await controlCycle(state, currentCycle(state, cycle), action);
    } finally {
      release();
    }
    await state.context.services.workCycleService.shutdown();
    expect(state.backend.launches).toHaveLength(0);
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    ).toBeUndefined();
    expect(currentCycle(state, cycle).status).toBe(action === 'pause' ? 'paused' : 'stopped');
  },
);
