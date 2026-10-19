import type { AgentLaunchRequest } from '@craftingtable/agents';
import { workCycleResponseSchema } from '@craftingtable/contracts';
import { heldStop, type WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { assignedReviewMatches } from '../src/services/agent-profile-policy.js';
import {
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  entryIds,
  implementationDone,
  mutationHeaders,
  type Ready,
  reviewText,
  roadmapControl,
  roadmapFixture,
  roadmapInput,
  saveRoadmapRequest,
  type ScriptedReply,
  startCycle,
  storedRoadmap,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C17 part 4, decisions 3 to 7 (found live 2026-10-16 on WIP-07: after two time-limit stops
 * neither the step's minutes nor its agents could change): a stopped cycle's settings change
 * leaves it where it stands, and its next launch uses them. A hand-started cycle's agents are its
 * profiles'; a roadmap's cycle's are an ADR-064 assignment for its entry, which its review
 * evidence accepts.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

const control = (state: Ready, cycleId: string, payload: Record<string, unknown>) =>
  state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycleId}/control`,
    headers: mutationHeaders(state),
    payload,
  });

const actions = async (state: Ready, cycleId: string) =>
  (
    await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/cycles`,
      headers: { cookie: state.cookie },
    })
  )
    .json()
    .cycles.find((view: { cycle: { id: string } }) => view.cycle.id === cycleId)?.projection;

/** An implementation that works on, with no result, until the step's deadline cancels it. */
const working: ScriptedReply = {
  resultText: '',
  claudeStream: [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Still testing.' }] } },
  ],
};

/** Waits until the cycle's current run has spoken, moves the clock past its deadline. */
async function toTimeLimit(
  state: Ready,
  cycle: () => WorkCycle,
  clock: { set: (at: Date) => void },
) {
  await waitFor(
    () =>
      state.context.storage.execution.runEvents.latestOfKind(
        state.workspaceId,
        cycle().currentRunId,
        'assistant-message',
      ) !== undefined,
    'the implementation at work',
  );
  clock.set(new Date(Date.parse(cycle().runDeadlineAt) + 1));
  await waitFor(() => heldStop(cycle())?.code === 'step-time-limit', 'the step time limit');
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(state.workspaceId, cycle().currentRunId)?.status ===
      'cancelled',
    'the run cancelled',
  );
}

const lastCycleAudit = (state: Ready, cycleId: string) =>
  state.context.storage.audit
    .listWorkspace({ workspaceId: state.workspaceId, limit: 500 })
    .filter((event) => event.action === 'work-cycle.updated' && event.targetId === cycleId)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || 0)[0];

it('changes a hand-started cycle’s time limit and agents at its stop, leaving it there, and its next run uses them (R-C17 part 4)', async () => {
  let now = new Date('2026-10-18T12:00:00Z');
  const { state, backend, worktree } = await cycleFixture(
    [designDone, working, implementationDone],
    () => now,
  );
  const started = await startCycle(state, worktree.id);
  const cycle = () => currentCycle(state, started);
  await waitFor(() => backend.sessions.length === 2, 'the implementation');
  await toTimeLimit(state, cycle, { set: (at) => (now = at) });
  const stopped = cycle();
  expect((await actions(state, started.id)).actions).toEqual([
    'resume',
    'continue-with-guidance',
    'change-settings',
    'stop',
  ]);
  const item = () =>
    state.context.storage.attention
      .open(state.workspaceId)
      .find((open) => open.subjectKey === `cycle:${started.id}`);
  const itemBefore = item();
  expect(itemBefore?.code).toBe('step-time-limit');

  // While another command's transition holds the cycle, the change is neither offered nor taken
  // (inc 3 review L-5 and its re-check).
  const locks = (
    state.context.services.workCycleService as unknown as { locks: { transitioning: Set<string> } }
  ).locks;
  locks.transitioning.add(started.id);
  expect((await actions(state, started.id)).actions).not.toContain('change-settings');
  const held = await control(state, started.id, {
    action: 'change-settings',
    expectedVersion: stopped.version,
    maxRunMinutes: 300,
  });
  locks.transitioning.delete(started.id);
  expect(held.statusCode).toBe(409);
  expect(cycle().version).toBe(stopped.version);
  const faster = { backend: 'claude-code' as const, model: 'faster-model' };
  const changed = await control(state, started.id, {
    action: 'change-settings',
    expectedVersion: stopped.version,
    maxRunMinutes: 300,
    agents: { implement: faster },
  });
  expect(changed.statusCode, changed.body).toBe(200);
  const after = workCycleResponseSchema.parse(changed.json()).cycle;
  // Where it stood: the status, the stop and its time, the reason, the deadline.
  expect(after).toMatchObject({
    status: 'needs-attention',
    step: 'implement',
    reason: stopped.reason,
    runDeadlineAt: stopped.runDeadlineAt,
    version: stopped.version + 1,
  });
  expect(after.stop).toEqual(stopped.stop);
  expect(after.policy).toEqual({ ...stopped.policy, maxRunMinutes: 300 });
  // The step keeps its permissions; the other steps keep their agents.
  expect(after.profiles).toEqual({
    ...cycleProfiles,
    implement: { ...faster, permissionMode: cycleProfiles.implement.permissionMode },
  });
  expect(item()?.id).toBe(itemBefore?.id);
  expect(item()?.code).toBe('step-time-limit');
  const audit = lastCycleAudit(state, started.id);
  expect(audit?.metadata).toMatchObject({
    action: 'change-settings',
    status: 'needs-attention',
    settings: {
      maxRunMinutes: { from: 120, to: 300 },
      agents: {
        implement: { from: { backend: 'claude-code', model: 'implement-model' }, to: faster },
      },
      through: 'cycle-profiles',
    },
  });
  // The status it left is the one it keeps: no transition.
  expect(audit?.metadata).toMatchObject({ previousStatus: 'needs-attention' });
  expect(audit?.actorKind).toBe('user');

  // The next launch uses both: the new agent, and a window of the new length.
  const resumed = await control(state, started.id, {
    action: 'resume',
    expectedVersion: after.version,
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  const running = workCycleResponseSchema.parse(resumed.json()).cycle;
  expect(Date.parse(running.runDeadlineAt)).toBe(now.getTime() + 300 * 60_000);
  await waitFor(() => backend.launches.length === 3, 'the relaunched implementation');
  expect(backend.launches[2]).toMatchObject({ model: 'faster-model' });
});

it('changes a plainly paused cycle’s settings, refuses a running one, an unknown backend and an empty change (R-C17 part 4)', async () => {
  const { state, backend, worktree } = await cycleFixture([designDone, working]);
  const started = await startCycle(state, worktree.id);
  const cycle = () => currentCycle(state, started);
  await waitFor(() => backend.sessions.length === 2, 'the implementation');
  // Running: not offered, refused.
  expect((await actions(state, started.id)).actions).toEqual(['pause', 'stop']);
  const refused = await control(state, started.id, {
    action: 'change-settings',
    expectedVersion: cycle().version,
    maxRunMinutes: 30,
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.message).toContain('Only a paused or stopped work item cycle');
  const paused = await control(state, started.id, {
    action: 'pause',
    expectedVersion: cycle().version,
  });
  expect(paused.statusCode, paused.body).toBe(200);
  expect((await actions(state, started.id)).actions).toEqual(['resume', 'change-settings', 'stop']);
  // The agents are checked as a start checks them: an unavailable backend is refused, and
  // nothing is written.
  const version = cycle().version;
  const unavailable = await control(state, started.id, {
    action: 'change-settings',
    expectedVersion: version,
    agents: { review: { backend: 'codex' } },
  });
  expect(unavailable.statusCode).not.toBe(200);
  expect(unavailable.json().error.message).toContain('codex is unavailable');
  expect(cycle().version).toBe(version);
  const empty = await control(state, started.id, {
    action: 'change-settings',
    expectedVersion: version,
  });
  expect(empty.statusCode).toBe(400);
  const changed = await control(state, started.id, {
    action: 'change-settings',
    expectedVersion: version,
    maxRunMinutes: 30,
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(workCycleResponseSchema.parse(changed.json()).cycle).toMatchObject({
    status: 'paused',
    policy: { maxRunMinutes: 30 },
  });
  expect(cycle().stop).toBeUndefined();
});

it('changes a roadmap cycle’s agents through an assignment for its entry, which its review run names and its evidence accepts (R-C17 part 4)', async () => {
  let now = new Date('2026-10-18T12:00:00Z');
  const { state, backend } = await roadmapFixture(
    [designDone, working, implementationDone, { resultText: reviewText([]) }],
    { now: () => now },
  );
  expect((await saveRoadmapRequest(state, roadmapInput(state))).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).attempts.length === 1, 'the first attempt');
  const attempt = () => storedRoadmap(state).attempts[0]!;
  const cycle = () => {
    const found = state.context.storage.execution.cycles.find(state.workspaceId, attempt().cycleId);
    if (!found) throw new Error('Missing cycle');
    return found;
  };
  await waitFor(
    () => backend.sessions.length === 2 && cycle().step === 'implement',
    'the implementation',
  );
  await toTimeLimit(state, cycle, { set: (at) => (now = at) });
  const stopped = cycle();
  const before = storedRoadmap(state).agentAssignments ?? [];
  const reviewer = { backend: 'claude-code' as const, model: 'changed-review' };
  // The roadmap's own conditions refuse its agents, and nothing is written (inc 3 review L-6):
  // a roadmap command running, an amendment pending.
  const attempt0 = {
    action: 'change-settings',
    expectedVersion: stopped.version,
    agents: { review: reviewer },
  };
  const roadmaps = state.context.services.roadmapService as unknown as {
    controlling: Set<string>;
  };
  roadmaps.controlling.add(storedRoadmap(state).id);
  const whileControlling = await control(state, stopped.id, attempt0);
  roadmaps.controlling.delete(storedRoadmap(state).id);
  expect(whileControlling.statusCode).toBe(409);
  expect(whileControlling.json().error.message).toContain('A roadmap command is running');
  const pending = vi
    .spyOn(state.context.storage.amendments, 'pending')
    .mockReturnValue({} as never);
  const whilePending = await control(state, stopped.id, attempt0);
  pending.mockRestore();
  expect(whilePending.statusCode).toBe(409);
  expect(whilePending.json().error.message).toContain('pending planning amendment');
  expect(cycle().version).toBe(stopped.version);
  expect(storedRoadmap(state).agentAssignments ?? []).toEqual(before);
  // The assignment and the cycle's write commit together (inc 3 review L-1): a cycle write that
  // fails leaves no assignment behind.
  const writer = (
    state.context.services.workCycleService as unknown as {
      writer: { change: (...args: unknown[]) => unknown };
    }
  ).writer;
  const write = vi.spyOn(writer, 'change').mockImplementationOnce(() => {
    throw new Error('The cycle write failed.');
  });
  const failed = await control(state, stopped.id, attempt0);
  write.mockRestore();
  expect(failed.statusCode).not.toBe(200);
  expect(storedRoadmap(state).agentAssignments ?? []).toEqual(before);
  expect(cycle().version).toBe(stopped.version);
  const changed = await control(state, stopped.id, {
    action: 'change-settings',
    expectedVersion: stopped.version,
    maxRunMinutes: 200,
    agents: { review: reviewer },
  });
  expect(changed.statusCode, changed.body).toBe(200);
  const after = workCycleResponseSchema.parse(changed.json()).cycle;
  // The cycle's own profiles stay as started; its minutes are its own.
  expect(after.profiles).toEqual(stopped.profiles);
  expect(after.policy.maxRunMinutes).toBe(200);
  // An assignment for this entry alone: every step's current agent, the review's changed.
  const assignments = storedRoadmap(state).agentAssignments ?? [];
  expect(assignments).toHaveLength(before.length + 1);
  const assignment = assignments.at(-1)!;
  expect(assignment).toMatchObject({
    entryIds: [entryIds[0]],
    selections: {
      design: { backend: 'claude-code', model: 'design-model' },
      implement: { backend: 'claude-code', model: 'implement-model' },
      review: reviewer,
      remediate: { backend: 'claude-code', model: 'remediate-model' },
    },
    appliedByUserId: state.userId,
  });
  // The definition is untouched (ADR-030): the entry keeps its saved profiles and minutes.
  expect(storedRoadmap(state).definition.entries[0]?.policy.maxRunMinutes).toBe(120);
  expect(storedRoadmap(state).definition.entries[0]?.profiles.review.model).toBe('review-model');
  expect((await actions(state, stopped.id)).agents.review).toMatchObject({
    selection: reviewer,
    source: { layer: 'roadmap-assignment', assignmentId: assignment.id },
  });
  expect(lastCycleAudit(state, stopped.id)?.metadata).toMatchObject({
    action: 'change-settings',
    settings: {
      maxRunMinutes: { from: 120, to: 200 },
      agents: { review: { to: reviewer } },
      through: 'roadmap-assignment',
    },
  });

  // Resumed, the step runs again and the review runs on the changed agent, naming the
  // assignment, so the roadmap's evidence check accepts it.
  const resumed = await control(state, stopped.id, {
    action: 'resume',
    expectedVersion: after.version,
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => backend.launches.some((launch: AgentLaunchRequest) => launch.model === 'changed-review'),
    'the review on the changed agent',
  );
  const review = await (async () => {
    let found: ReturnType<typeof state.context.storage.execution.runs.find>;
    await waitFor(() => {
      found = state.context.storage.execution.runs
        .listForWorktree(state.workspaceId, cycle().worktreeId)
        .find((run) => run.role === 'review');
      return found !== undefined;
    }, 'the review run');
    return found!;
  })();
  expect(review.model).toBe('changed-review');
  expect(review.profileSelection?.assignmentId).toBe(assignment.id);
  const roadmap = storedRoadmap(state);
  expect(assignedReviewMatches(roadmap, roadmap.definition.entries[0]!, review)).toBe(true);
});
