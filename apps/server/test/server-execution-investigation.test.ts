import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startAgentRunResponseSchema,
  workCycleResponseSchema,
  workCyclesResponseSchema,
} from '@craftingtable/contracts';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import {
  asAgentRunEventId,
  asAgentRunId,
  cycleAttention,
  type WorkCycle,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  designDone,
  entryIds,
  git,
  implementationDone,
  mutationHeaders,
  type Ready,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  type ScriptedReply,
  ScriptedSession,
  startCycle,
  stepDaemons,
  storedRoadmap,
  waitFor,
  waitUntil,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * R-C16 16a: a question stop's read-only investigation. It runs beside the cycle, which keeps
 * its stop; the operator answers through the stop's own control.
 */
const QUESTION = 'Which format should it use?';
const asked = { resultText: `Partly implemented.\n\n## Open questions\n- ${QUESTION}` };
const report = (status: 'proposed' | 'open' = 'proposed') =>
  [
    'The format spec settles it.',
    '',
    '```craftingtable-investigation',
    JSON.stringify({
      version: 1,
      questions: [
        status === 'proposed'
          ? {
              question: QUESTION,
              status,
              answer: 'Use JSON lines.',
              sources: ['docs/format.md:12'],
            }
          : { question: QUESTION, status, answer: '', sources: [], reason: 'Nothing says.' },
      ],
    }),
    '```',
  ].join('\n');

/** A cycle stopped on its implementation's question, and a way to script the investigation. */
async function atQuestionStop(now?: () => Date, gitOperations?: GitOperations) {
  const f = await cycleFixture([], now, gitOperations);
  let investigation: ScriptedReply = { resultText: report() };
  let implementations = 0;
  f.backend.replyForRequest = (request: AgentLaunchRequest) =>
    request.readOnly
      ? investigation
      : request.model === 'design-model'
        ? designDone
        : implementations++ === 0
          ? asked
          : implementationDone;
  const cycle = await startCycle(f.state, f.worktree.id);
  await waitFor(
    () => currentCycle(f.state, cycle).attention?.code === 'implementation-open-questions',
    'implementation question',
  );
  return {
    ...f,
    cycle,
    script: (next: typeof investigation) => {
      investigation = next;
    },
  };
}
const post = (state: Ready, path: string, payload: unknown) =>
  state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}${path}`,
    headers: mutationHeaders(state),
    payload: payload as Record<string, unknown>,
  });
async function investigateView(
  state: Ready,
  cycle: WorkCycle,
  payload: Record<string, unknown> = {},
) {
  const response = await post(state, `/cycles/${cycle.id}/investigation`, {
    expectedVersion: currentCycle(state, cycle).version,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  return workCycleResponseSchema.parse(response.json());
}
async function investigate(state: Ready, cycle: WorkCycle, payload: Record<string, unknown> = {}) {
  return (await investigateView(state, cycle, payload)).cycle;
}
/** The cycle's projection as the work item's read returns it. */
async function presented(state: Ready, cycle: WorkCycle) {
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/cycles?workItemId=${state.workItemId}`,
    headers: mutationHeaders(state),
  });
  expect(response.statusCode, response.body).toBe(200);
  const found = workCyclesResponseSchema
    .parse(response.json())
    .cycles.find((v) => v.cycle.id === cycle.id);
  if (!found) throw new Error('Missing cycle');
  return found.projection;
}
const launchesReadOnly = (launches: readonly AgentLaunchRequest[]) =>
  launches.filter((launch) => launch.readOnly);
/**
 * A refused command's error. These refusals share the API's `conflict` code and carry no typed
 * reason of their own, so each is told apart by the message the daemon returns (TS-M3).
 */
const refusal = (response: { json: () => unknown }) =>
  (response.json() as { error: { code: string; message: string } }).error;
/** Starting an investigation is refused with `message`, and nothing is recorded or launched. */
async function refusedStart(
  f: Awaited<ReturnType<typeof atQuestionStop>>,
  message: string,
): Promise<void> {
  const { state, cycle, backend } = f;
  const response = await post(state, `/cycles/${cycle.id}/investigation`, {
    expectedVersion: currentCycle(state, cycle).version,
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(refusal(response)).toEqual({ code: 'conflict', message });
  expect(currentCycle(state, cycle).investigation).toBeUndefined();
  expect(launchesReadOnly(backend.launches)).toEqual([]);
}
/**
 * The worktree as an investigation must leave it (R-C16 done-when, TS-M3): its commit, its
 * branch and every file Git sees, untracked and ignored ones included.
 */
const treeState = (path: string) => ({
  head: git(['rev-parse', 'HEAD'], path).trim(),
  branch: git(['symbolic-ref', '--short', 'HEAD'], path).trim(),
  status: git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], path),
});

describe('question stop investigations (R-C16)', () => {
  it('investigates read-only beside the cycle, refuses the stop while it runs, and returns to the same stop', async () => {
    let release = () => {};
    const f = await atQuestionStop();
    const { state, backend, cycle } = f;
    f.script({ resultText: report(), release: new Promise<void>((done) => (release = done)) });
    const stopped = currentCycle(state, cycle);
    expect((await presented(state, cycle)).actions).toEqual([
      'continue-with-guidance',
      'investigate',
      'stop',
    ]);
    const tree = treeState(f.worktree.path);

    const view = await investigateView(state, cycle, { instructions: 'Check the format spec.' });
    const started = view.cycle;
    const record = started.investigation;
    if (!record) throw new Error('No investigation');
    expect(record).toMatchObject({
      sourceRunId: stopped.currentRunId,
      code: 'implementation-open-questions',
      minutes: 30,
      instructions: 'Check the format spec.',
      profile: { backend: 'claude-code', model: 'design-model' },
    });
    expect(view.projection.actions).toEqual(['end-investigation']);
    expect(started.status).toBe('needs-attention');
    expect(started.currentRunId).toBe(stopped.currentRunId);

    // A read-only, deadline-bound run on the cycle's worktree, from the stop's run.
    await waitFor(() => launchesReadOnly(backend.launches).length === 1, 'investigation launch');
    const launch = launchesReadOnly(backend.launches)[0]!;
    expect(launch.deadlineAt).toBe(record.deadlineAt);
    expect(launch.cwd).toBe(f.worktree.path);
    expect(launch.prompt).toContain('craftingtable-investigation');
    expect(launch.prompt).toContain('investigation/questions.md');
    expect(launch.prompt).toContain('Check the format spec.');
    // Briefed as an investigation, not as the design step it runs as (review M2).
    expect(launch.prompt).toContain('You are investigating the questions a stopped step asked');
    expect(launch.prompt).not.toContain('craftingtable-design');
    expect(launch.prompt).not.toContain('You are exploring and designing');
    const run = state.context.storage.execution.runs.find(state.workspaceId, record.runId);
    expect(run).toMatchObject({
      parentRunId: stopped.currentRunId,
      role: 'design',
      profileSelection: { purpose: 'investigation', investigationId: record.id },
    });
    const directory = join(state.context.config.execution.runsRoot, record.runId, 'investigation');
    expect(readFileSync(join(directory, 'questions.md'), 'utf8')).toContain(QUESTION);
    expect(JSON.parse(readFileSync(join(directory, 'context.json'), 'utf8'))).toMatchObject({
      stop: 'implementation-open-questions',
      sourceRunId: stopped.currentRunId,
    });
    expect(existsSync(join(directory, 'branch.json'))).toBe(true);

    // While it runs, the stop takes no command but ending it, and nothing else may launch.
    const guidance = await post(state, `/cycles/${cycle.id}/control`, {
      action: 'resume',
      expectedVersion: currentCycle(state, cycle).version,
      instructions: 'JSON lines.',
    });
    expect(guidance.statusCode).toBe(409);
    expect(guidance.body).toContain('investigation of this stop is running');
    // One at a time (TS-M3): refused by its own guard, not only by the live run it started.
    const again = await post(state, `/cycles/${cycle.id}/investigation`, {
      expectedVersion: currentCycle(state, cycle).version,
    });
    expect(again.statusCode).toBe(409);
    expect(refusal(again)).toEqual({
      code: 'conflict',
      message: 'An investigation of this stop is running. Wait for it, or end it, first.',
    });
    const grant = await post(state, `/cycles/${cycle.id}/control`, {
      action: 'authorize-remediation',
      expectedVersion: currentCycle(state, cycle).version,
      additionalRounds: 1,
      instructions: '',
    });
    expect(grant.statusCode).toBe(409);
    expect(grant.body).toContain('investigation of this stop is running');
    // Its one turn is its report: no message may add another (review LOW).
    const message = await post(state, `/runs/${record.runId}/messages`, { text: 'Also check X.' });
    expect(message.statusCode).toBe(409);
    expect(message.body).toContain('takes no messages');
    const manual = await post(state, `/work-items/${state.workItemId}/runs`, {
      worktreeId: f.worktree.id,
      role: 'implement',
    });
    expect(manual.statusCode).toBe(409);
    // The stop's item says so, and its reminders wait for the investigation.
    const item = () =>
      state.context.storage.attention
        .open(state.workspaceId)
        .find((i) => i.subjectKey === `cycle:${cycle.id}`);
    await waitFor(() => !!item()?.message.includes('Investigating'), 'investigating item');
    expect(
      state.context.services.workCycleService.holdsReminders(state.workspaceId, cycle.id),
    ).toBe(true);
    // The worktree's lineage still ends at the stop's run.
    expect(
      state.context.storage.execution.runs.latestIdForWorktree(state.workspaceId, f.worktree.id),
    ).toBe(stopped.currentRunId);

    release();
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'investigation result');
    const ended = currentCycle(state, cycle);
    expect(ended.investigation?.result).toMatchObject({
      outcome: 'finished',
      findings: [{ question: QUESTION, status: 'proposed', answer: 'Use JSON lines.' }],
    });
    // The item pages again with what it found, and its reminders resume.
    await waitFor(
      () => !!item()?.members?.includes(`investigation:${record.id}:finished`),
      'finished item',
    );
    expect(item()?.message).toContain(
      'The investigation finished: 1 proposed answer, 0 still open.',
    );
    expect(
      state.context.services.workCycleService.holdsReminders(state.workspaceId, cycle.id),
    ).toBe(false);
    // The worktree is as the investigation found it: no commit, no change, no file left behind.
    expect(treeState(f.worktree.path)).toEqual(tree);
    // The same stop, the same run: nothing moved but the record.
    expect(ended).toMatchObject({
      status: 'needs-attention',
      step: 'implement',
      currentRunId: stopped.currentRunId,
      remediationRounds: stopped.remediationRounds,
      attention: { code: 'implementation-open-questions' },
    });
    expect((await presented(state, cycle)).actions).toEqual([
      'continue-with-guidance',
      'investigate',
      'stop',
    ]);
    // The workspace list leaves the proposals to the item's own read.
    const listed = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/cycles`,
      headers: mutationHeaders(state),
    });
    const brief = workCyclesResponseSchema
      .parse(listed.json())
      .cycles.find((v) => v.cycle.id === cycle.id)?.cycle;
    expect(brief?.investigation?.result).toEqual({
      endedAt: ended.investigation?.result?.endedAt,
      outcome: 'finished',
    });

    // The operator answers through the stop's own control; the next run continues the stop's
    // run, never the investigation, and the record ends with the stop.
    const answered = await post(state, `/cycles/${cycle.id}/control`, {
      action: 'resume',
      expectedVersion: ended.version,
      instructions: 'Use JSON lines.',
    });
    expect(answered.statusCode, answered.body).toBe(200);
    await waitFor(
      () =>
        currentCycle(state, cycle).currentRunId !== stopped.currentRunId &&
        !!state.context.storage.execution.runs.find(
          state.workspaceId,
          currentCycle(state, cycle).currentRunId,
        ),
      'the answered step',
    );
    const resumed = currentCycle(state, cycle);
    expect(resumed.investigation).toBeUndefined();
    const next = state.context.storage.execution.runs.find(state.workspaceId, resumed.currentRunId);
    expect(next?.parentRunId).toBe(stopped.currentRunId);
  });

  it('ends a live investigation on request, and a stop with no questions offers none', async () => {
    const f = await atQuestionStop();
    const { state, cycle } = f;
    f.script({ resultText: report(), release: new Promise<void>(() => {}) });
    const started = await investigate(state, cycle);
    await waitFor(() => launchesReadOnly(f.backend.launches).length === 1, 'investigation launch');
    const response = await post(state, `/cycles/${cycle.id}/investigation/end`, {
      expectedVersion: started.version,
    });
    expect(response.statusCode, response.body).toBe(200);
    // End only asks the run to end: the result is written once its process has exited and the
    // worktree has been compared (R-C16).
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'investigation ended');
    expect(currentCycle(state, cycle).investigation?.result).toMatchObject({
      outcome: 'cancelled',
      message: 'Ended by the operator.',
    });
    expect(currentCycle(state, cycle).investigation?.result?.code).toBeUndefined();
    const runId = started.investigation!.runId;
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, runId)?.status === 'cancelled',
      'investigation cancelled',
    );
    // The operator's own End is no news: the item does not page again for it.
    await stepDaemons(2);
    const item = state.context.storage.attention
      .open(state.workspaceId)
      .find((i) => i.subjectKey === `cycle:${cycle.id}`);
    expect(item?.members ?? []).not.toContain(
      `investigation:${started.investigation!.id}:cancelled`,
    );
    // The stop takes its commands again; ending twice is refused.
    expect((await presented(state, cycle)).actions).toContain('investigate');
    const twice = await post(state, `/cycles/${cycle.id}/investigation/end`, {
      expectedVersion: currentCycle(state, cycle).version,
    });
    expect(twice.statusCode).toBe(409);

    // A design stop keeps Resolve design questions (R-C3a); it offers no investigation.
    const g = await cycleFixture([
      { resultText: 'Design drafted.\n\n## Open questions\n- Which store should it use?' },
    ]);
    const other = await startCycle(g.state, g.worktree.id);
    await waitFor(
      () => currentCycle(g.state, other).attention?.code === 'design-open-questions',
      'design stop',
    );
    expect((await presented(g.state, other)).actions).not.toContain('investigate');
    const refused = await post(g.state, `/cycles/${other.id}/investigation`, {
      expectedVersion: currentCycle(g.state, other).version,
    });
    expect(refused.statusCode).toBe(409);
    expect(refusal(refused)).toEqual({
      code: 'conflict',
      message: 'This stop holds no questions to investigate.',
    });
    // An investigation stop offers it only while its report asks something: a stop at the
    // round limit whose review asked nothing has nothing to investigate.
    const stored = currentCycle(g.state, other);
    g.state.context.storage.execution.cycles.replace(
      {
        ...stored,
        version: stored.version + 1,
        attention: cycleAttention('remediation-exhausted'),
      },
      stored.version,
    );
    expect((await presented(g.state, other)).actions).toContain('investigate');
    g.state.context.storage.execution.runEvents.append({
      id: asAgentRunEventId(randomUUID()),
      workspaceId: g.state.workspaceId,
      runId: stored.currentRunId,
      occurredAt: new Date().toISOString(),
      kind: 'turn-completed',
      payload: {
        outcome: 'success',
        resultText: 'Reviewed.\n\n## Open questions\nnone',
        turns: 1,
        durationMs: 1,
      },
    });
    expect((await presented(g.state, other)).actions).not.toContain('investigate');
  });

  it('fails at its deadline, and reports a run that returned no block', async () => {
    let now = new Date('2026-10-02T12:00:00Z');
    const f = await atQuestionStop(() => now);
    const { state, cycle, backend } = f;
    f.script({ resultText: report(), release: new Promise<void>(() => {}) });
    backend.onLaunch = (request) => {
      if (request.readOnly) now = new Date(now.getTime() + 31 * 60_000);
    };
    await investigate(state, cycle);
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'deadline');
    expect(currentCycle(state, cycle).investigation?.result).toMatchObject({
      outcome: 'failed',
      message: expect.stringContaining('time limit'),
    });
    backend.onLaunch = undefined;
    f.script({ resultText: 'I looked around but wrote no block.' });
    await investigate(state, cycle);
    await waitFor(
      () => currentCycle(state, cycle).investigation?.result?.outcome === 'finished',
      'second investigation',
    );
    expect(currentCycle(state, cycle).investigation?.result).toMatchObject({
      outcome: 'finished',
      message: expect.stringContaining('without a craftingtable-investigation block'),
    });
    expect(currentCycle(state, cycle).investigation?.result?.findings).toBeUndefined();
  });

  it('leaves a roadmap item at its stop while investigated, and ends the investigation when the roadmap stops', async () => {
    const { state, backend } = await roadmapFixture();
    const ws = state.workspaceId;
    let implementations = 0;
    backend.replyForRequest = (request: AgentLaunchRequest) =>
      request.readOnly
        ? { resultText: report(), release: new Promise<void>(() => {}) }
        : request.model === 'design-model'
          ? designDone
          : implementations++ === 0
            ? asked
            : implementationDone;
    const saved = await saveRoadmapRequest(state, {
      ...roadmapInput(state, [state.workItemId]),
      scheduling: {
        mode: 'parallel',
        maxInFlight: 1,
        maxPerRepository: 1,
        maxIntegrationRefreshes: 3,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await roadmapControl(state, 'start');
    const cycleOf = () => {
      const attempt = storedRoadmap(state).attempts[0];
      return attempt && state.context.storage.execution.cycles.find(ws, attempt.cycleId);
    };
    await waitFor(
      () => cycleOf()?.attention?.code === 'implementation-open-questions',
      'implementation question',
    );
    const cycle = cycleOf()!;
    const started = await investigate(state, cycle);
    await waitFor(() => launchesReadOnly(backend.launches).length === 1, 'investigation launch');

    // Pausing the item holds it; its cycle stays at the stop with the investigation running.
    const paused = await post(state, `/roadmaps/${roadmapId}/control`, {
      action: 'pause',
      entryId: entryIds[0],
      expectedVersion: storedRoadmap(state).version,
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(currentCycle(state, cycle)).toMatchObject({
      status: 'needs-attention',
      investigation: { id: started.investigation!.id },
    });
    expect(currentCycle(state, cycle).investigation?.result).toBeUndefined();
    const resumed = await post(state, `/roadmaps/${roadmapId}/control`, {
      action: 'resume',
      entryId: entryIds[0],
      expectedVersion: storedRoadmap(state).version,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(currentCycle(state, cycle).status).toBe('needs-attention');

    // Stopping the roadmap ends the investigation with the cycle.
    await roadmapControl(state, 'stop');
    expect(currentCycle(state, cycle).status).toBe('stopped');
    expect(currentCycle(state, cycle).investigation).toBeUndefined();
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(ws, started.investigation!.runId)?.status ===
        'cancelled',
      'investigation cancelled',
    );
  });

  it('refuses an unavailable backend before recording anything, and settles a run that never started or never ended', async () => {
    let now = new Date('2026-10-02T12:00:00Z');
    const f = await atQuestionStop(() => now);
    const { state, cycle } = f;
    const before = currentCycle(state, cycle);
    const refused = await post(state, `/cycles/${cycle.id}/investigation`, {
      expectedVersion: before.version,
      profile: { backend: 'codex' },
    });
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refusal(refused)).toEqual({
      code: 'unavailable',
      message: 'The investigation profile’s agent backend is not available on this workstation.',
    });
    expect(currentCycle(state, cycle)).toEqual(before);

    // A record whose launch never recorded its run (a restart in between) is over at once,
    // not at its deadline (review M3).
    const record = {
      id: randomUUID(),
      runId: randomUUID(),
      sourceRunId: before.currentRunId,
      code: 'implementation-open-questions',
      questionsDigest: '0'.repeat(64),
      profile: { backend: 'claude-code' },
      instructions: '',
      minutes: 30,
      deadlineAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      startedAt: now.toISOString(),
      startedByUserId: before.createdByUserId,
    } as NonNullable<WorkCycle['investigation']>;
    const write = (investigation: NonNullable<WorkCycle['investigation']>) => {
      const current = currentCycle(state, cycle);
      state.context.storage.execution.cycles.replace(
        { ...current, version: current.version + 1, investigation },
        current.version,
      );
    };
    write(record);
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'never started');
    expect(currentCycle(state, cycle).investigation?.result).toMatchObject({
      outcome: 'failed',
      message: expect.stringContaining('did not start'),
    });

    // A run left unfinished with no process, well past its deadline, is closed.
    const source = state.context.storage.execution.runs.find(
      state.workspaceId,
      before.currentRunId,
    )!;
    const stuck = asAgentRunId(randomUUID());
    state.context.storage.execution.runs.insert({
      id: stuck,
      workspaceId: state.workspaceId,
      worktreeId: source.worktreeId,
      repositoryId: source.repositoryId,
      projectId: source.projectId,
      ...(source.workItemId ? { workItemId: source.workItemId } : {}),
      parentRunId: source.id,
      backend: 'claude-code',
      role: 'design',
      permissionMode: 'edit-only',
      profileSelection: { purpose: 'investigation', investigationId: randomUUID() },
      brief: 'Investigate.',
      createdAt: now.toISOString(),
      createdByUserId: source.createdByUserId,
    });
    write({
      ...record,
      id: state.context.storage.execution.runs.find(state.workspaceId, stuck)!.profileSelection!
        .investigationId!,
      runId: stuck,
    });
    // Before its deadline it waits on the run.
    await stepDaemons(3);
    expect(currentCycle(state, cycle).investigation?.result).toBeUndefined();
    now = new Date(now.getTime() + 33 * 60_000);
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'closed');
    expect(currentCycle(state, cycle).investigation?.result).toMatchObject({
      outcome: 'cancelled',
      message: expect.stringContaining('outlived its time limit'),
    });
  });

  it('waits for a launch in flight before reading back a record that has no run yet', async () => {
    const f = await atQuestionStop();
    const { state, cycle } = f;
    f.script({ resultText: report(), release: new Promise<void>(() => {}) });
    const pending = post(state, `/cycles/${cycle.id}/investigation`, {
      expectedVersion: currentCycle(state, cycle).version,
    });
    // Catch the moment the record is written and its run is not yet, and run the controller.
    let observed = false;
    for (let i = 0; i < 2000 && !observed; i += 1) {
      const record = currentCycle(state, cycle).investigation;
      if (record && !state.context.storage.execution.runs.find(state.workspaceId, record.runId)) {
        observed = true;
        await state.context.services.workCycleService.tick();
        expect(currentCycle(state, cycle).investigation?.result).toBeUndefined();
      } else await new Promise((resolve) => setImmediate(resolve));
    }
    expect(observed).toBe(true);
    expect((await pending).statusCode).toBe(200);
    expect(currentCycle(state, cycle).investigation?.result).toBeUndefined();
  });

  // TS-M3: each guard on starting an investigation refuses on its own, records nothing and
  // launches nothing.
  it('refuses to start beside a live session, a reserved merge or a removed worktree', async () => {
    const f = await atQuestionStop();
    const { state, cycle, backend } = f;
    const stopped = currentCycle(state, cycle);
    const refused = (message: string) => refusedStart(f, message);

    // A manual session works in the worktree: a read-only run would read a tree that another
    // agent is rewriting.
    backend.replyForRequest = () => ({
      resultText: 'Still working.',
      release: new Promise<void>(() => {}),
    });
    const manual = await post(state, `/work-items/${state.workItemId}/runs`, {
      worktreeId: f.worktree.id,
      role: 'implement',
    });
    expect(manual.statusCode, manual.body).toBe(200);
    const { run } = startAgentRunResponseSchema.parse(manual.json());
    await waitFor(
      () =>
        state.context.storage.execution.runs.liveForWorktree(state.workspaceId, f.worktree.id)
          .length === 1,
      'manual session',
    );
    await refused('End the live session in this worktree before starting an investigation.');
    const cancelled = await post(state, `/runs/${run.id}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await waitFor(
      () =>
        state.context.storage.execution.runs.liveForWorktree(state.workspaceId, f.worktree.id)
          .length === 0,
      'manual session ended',
    );

    // An integration merge reserved on the worktree owns it until it is recovered.
    const merge = {
      id: randomUUID(),
      workspaceId: state.workspaceId,
      worktreeId: f.worktree.id,
      status: 'reserved' as const,
      sourceSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      targetBranch: 'main',
      reviewRunId: stopped.currentRunId,
      createdAt: new Date().toISOString(),
      authorizedByUserId: stopped.createdByUserId,
    };
    state.context.storage.transaction((tx) => tx.execution.merges.save(merge));
    await refused('Recover the reserved integration merge before starting an investigation.');
    // Recovered (here, as failed), it no longer holds the worktree: the next case stands alone.
    state.context.storage.transaction((tx) =>
      tx.execution.merges.save({ ...merge, status: 'failed' }),
    );

    // A worktree no longer active has nothing to investigate.
    state.context.storage.execution.worktrees.markRemoved({
      workspaceId: state.workspaceId,
      worktreeId: f.worktree.id,
      occurredAt: new Date().toISOString(),
    });
    await refused('The worktree is no longer active.');
    // Throughout, the stop stayed where it was.
    expect(currentCycle(state, cycle)).toMatchObject({
      status: 'needs-attention',
      currentRunId: stopped.currentRunId,
      attention: { code: 'implementation-open-questions' },
    });
  });

  // TS-M3 review L-1: the worktree's mutation guard (`requireAvailable`) refuses too.
  it('refuses to start while the worktree is being updated, or an agent that lost supervision is still exiting', async () => {
    // An update from the integration branch waits inside its Git step until the test lets it go.
    const real = createGitOperations({ gitExecutable: 'git' });
    let updating = false;
    let finishUpdate = () => {};
    const updateHeld = new Promise<void>((done) => (finishUpdate = done));
    const f = await atQuestionStop(undefined, {
      ...real,
      updateWorktree: async (input) => {
        updating = true;
        await updateHeld;
        return real.updateWorktree(input);
      },
    });
    const { state, cycle, backend } = f;
    const stopped = currentCycle(state, cycle);

    // A merge, removal or update in progress holds the worktree.
    const update = post(state, `/worktrees/${f.worktree.id}/update`, {
      expectedVersion: state.context.storage.execution.worktrees.find(
        state.workspaceId,
        f.worktree.id,
      )!.version,
    });
    await waitUntil(() => updating, 'the update holding the worktree');
    await refusedStart(f, 'A merge or removal is already in progress for this worktree');
    finishUpdate();
    const updated = await update;
    expect(updated.statusCode, updated.body).toBe(200);

    // An agent whose supervision failed was killed, but its process has not exited: a read-only
    // run would read a tree that agent may still be editing.
    class Unexiting extends ScriptedSession {
      override kill(): void {}
    }
    let unexiting: Unexiting | undefined;
    const launch = backend.launch.bind(backend);
    backend.launch = (request: AgentLaunchRequest) => {
      if (request.readOnly || unexiting) return launch(request);
      backend.launches.push(request);
      // A message the daemon cannot store fails supervision (AGT-01).
      unexiting = new Unexiting(request, 'claude-code', [
        { resultText: 'Lost.', messages: [1n as unknown as string] },
      ]);
      return Promise.resolve(unexiting);
    };
    const manual = await post(state, `/work-items/${state.workItemId}/runs`, {
      worktreeId: f.worktree.id,
      role: 'implement',
    });
    expect(manual.statusCode, manual.body).toBe(200);
    const { run } = startAgentRunResponseSchema.parse(manual.json());
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'failed',
      'supervision failure',
    );
    await refusedStart(
      f,
      'An agent that lost supervision is still being terminated in this worktree; wait for its process to exit',
    );
    unexiting?.end();
    expect(currentCycle(state, cycle)).toMatchObject({
      status: 'needs-attention',
      currentRunId: stopped.currentRunId,
      attention: { code: 'implementation-open-questions' },
    });
  });
});

/**
 * R-C16 (TS-M3, RC F-7): the daemon records the worktree as an investigation starts and compares
 * it once the run has ended and its agent has exited. A change fails the investigation as
 * `worktree-changed`, pages the stop's item, and holds the stop's commands until the operator
 * acknowledges it or the tree matches its record again. The daemon never resets the tree.
 */
describe('the investigated worktree (R-C16)', () => {
  const stopItem = (state: Ready, cycle: WorkCycle) =>
    state.context.storage.attention
      .open(state.workspaceId)
      .find((i) => i.subjectKey === `cycle:${cycle.id}`);
  /** An investigation agent that writes in the worktree it was told only to read. */
  const plantOnReadOnlyLaunch = (f: Awaited<ReturnType<typeof atQuestionStop>>) => {
    f.backend.onLaunch = (request) => {
      if (request.readOnly) writeFileSync(join(request.cwd, 'planted.txt'), 'written by a reader');
    };
  };

  it('fails an investigation whose worktree changed, pages the stop, and holds its commands until acknowledged', async () => {
    const f = await atQuestionStop();
    const { state, cycle } = f;
    plantOnReadOnlyLaunch(f);
    const started = await investigate(state, cycle);
    expect(started.investigation?.worktree).toMatchObject({
      headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      trackedClean: true,
    });
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'investigation result');
    const id = started.investigation!.id;
    const result = currentCycle(state, cycle).investigation!.result!;
    expect(result).toMatchObject({
      outcome: 'failed',
      code: 'worktree-changed',
      worktreeChange: { parts: ['untracked'], paths: ['planted.txt'] },
      // Its proposals are kept to be read; the browser does not offer them for use.
      findings: [{ question: QUESTION, status: 'proposed' }],
    });
    expect(result.worktreeChange?.headAfter).toBe(result.worktreeChange?.headBefore);
    await waitFor(
      () => !!stopItem(state, cycle)?.members?.includes(`investigation:${id}:worktree-changed`),
      'worktree change paged',
    );
    expect(stopItem(state, cycle)?.message).toContain(
      'The worktree changed while the investigation ran: untracked files. Now differing from HEAD: planted.txt.',
    );
    // Only the acknowledgement, or ending the cycle, until then; each other command is refused
    // with its typed reason.
    expect((await presented(state, cycle)).actions).toEqual([
      'acknowledge-worktree-change',
      'stop',
    ]);
    const held = {
      code: 'conflict',
      reason: 'investigation-worktree-changed',
      paths: ['planted.txt'],
    };
    const guidance = await post(state, `/cycles/${cycle.id}/control`, {
      action: 'resume',
      expectedVersion: currentCycle(state, cycle).version,
      instructions: 'Use JSON lines.',
    });
    expect(guidance.statusCode).toBe(409);
    expect(refusal(guidance)).toMatchObject(held);
    const grant = await post(state, `/cycles/${cycle.id}/control`, {
      action: 'authorize-remediation',
      expectedVersion: currentCycle(state, cycle).version,
      additionalRounds: 1,
      instructions: '',
    });
    expect(grant.statusCode).toBe(409);
    expect(refusal(grant)).toMatchObject(held);
    // A new investigation would replace the record, and the change with it.
    const again = await post(state, `/cycles/${cycle.id}/investigation`, {
      expectedVersion: currentCycle(state, cycle).version,
    });
    expect(again.statusCode).toBe(409);
    expect(refusal(again)).toMatchObject(held);
    // The daemon never resets the tree.
    expect(existsSync(join(f.worktree.path, 'planted.txt'))).toBe(true);
    // Reminders are not held: the item has news.
    expect(
      state.context.services.workCycleService.holdsReminders(state.workspaceId, cycle.id),
    ).toBe(false);

    const acknowledged = await post(state, `/cycles/${cycle.id}/investigation/acknowledge-change`, {
      expectedVersion: currentCycle(state, cycle).version,
    });
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    expect(
      workCycleResponseSchema.parse(acknowledged.json()).cycle.investigation?.result,
    ).toMatchObject({ code: 'worktree-changed', acknowledgedByUserId: state.userId });
    expect((await presented(state, cycle)).actions).toEqual([
      'continue-with-guidance',
      'investigate',
      'stop',
    ]);
    const twice = await post(state, `/cycles/${cycle.id}/investigation/acknowledge-change`, {
      expectedVersion: currentCycle(state, cycle).version,
    });
    expect(twice.statusCode).toBe(409);
    expect(existsSync(join(f.worktree.path, 'planted.txt'))).toBe(true);
    const answered = await post(state, `/cycles/${cycle.id}/control`, {
      action: 'resume',
      expectedVersion: currentCycle(state, cycle).version,
      instructions: 'Use JSON lines.',
    });
    expect(answered.statusCode, answered.body).toBe(200);
  });

  it('compares after the agent has exited when End is pressed on a live run, and pages even then', async () => {
    const f = await atQuestionStop();
    const { state, cycle } = f;
    let exit!: () => void;
    f.script({
      resultText: report(),
      release: new Promise<void>(() => {}),
      exitAfterKill: new Promise<void>((resolve) => {
        exit = resolve;
      }),
    });
    const started = await investigate(state, cycle);
    await waitFor(() => launchesReadOnly(f.backend.launches).length === 1, 'investigation launch');
    const ended = await post(state, `/cycles/${cycle.id}/investigation/end`, {
      expectedVersion: started.version,
    });
    expect(ended.statusCode, ended.body).toBe(200);
    // The process has not exited: nothing is written, and the stop still waits for it.
    await stepDaemons(3);
    expect(currentCycle(state, cycle).investigation?.result).toBeUndefined();
    expect((await presented(state, cycle)).actions).toEqual(['end-investigation']);
    const refused = await post(state, `/cycles/${cycle.id}/control`, {
      action: 'resume',
      expectedVersion: currentCycle(state, cycle).version,
      instructions: 'Use JSON lines.',
    });
    expect(refused.statusCode).toBe(409);
    // What RC F-7 feared: the agent goes on writing after End, then exits.
    writeFileSync(join(f.worktree.path, 'after-end.txt'), 'still writing');
    exit();
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'investigation ended');
    expect(currentCycle(state, cycle).investigation?.result).toMatchObject({
      outcome: 'failed',
      code: 'worktree-changed',
      message: 'Ended by the operator.',
      worktreeChange: { parts: ['untracked'], paths: ['after-end.txt'] },
    });
    // End is recorded with the operator who asked (review L6).
    const requested = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 200 })
      .find(
        (entry) =>
          entry.targetId === cycle.id &&
          (entry.metadata as { action?: string } | undefined)?.action ===
            'investigation-end-requested',
      );
    expect(requested).toMatchObject({ actorKind: 'user', actorUserId: state.userId });
    // The operator's own End is no news, but a changed tree is.
    const id = started.investigation!.id;
    await waitFor(
      () => !!stopItem(state, cycle)?.members?.includes(`investigation:${id}:worktree-changed`),
      'worktree change paged after End',
    );
  });

  it('releases the hold once the worktree matches its record again, checking at most once a minute', async () => {
    let clock = Date.now();
    const f = await atQuestionStop(() => new Date(clock));
    const { state, cycle } = f;
    plantOnReadOnlyLaunch(f);
    await investigate(state, cycle);
    await waitFor(
      () => currentCycle(state, cycle).investigation?.result?.code === 'worktree-changed',
      'worktree change',
    );
    // Still changed: the hold stays however often the controller looks.
    clock += 61_000;
    await stepDaemons(2);
    expect(currentCycle(state, cycle).investigation?.result?.restoredAt).toBeUndefined();
    rmSync(join(f.worktree.path, 'planted.txt'));
    // Within the minute since the last look, nothing reads the tree again.
    clock += 30_000;
    await stepDaemons(3);
    expect(currentCycle(state, cycle).investigation?.result?.restoredAt).toBeUndefined();
    clock += 31_000;
    await waitFor(
      () => !!currentCycle(state, cycle).investigation?.result?.restoredAt,
      'worktree restored',
    );
    expect((await presented(state, cycle)).actions).toEqual([
      'continue-with-guidance',
      'investigate',
      'stop',
    ]);
    expect(stopItem(state, cycle)?.message).toContain('It matches its record again.');
  });

  it('ends a run asked to end while it launched, and compares only once its process has exited (review H1)', async () => {
    const f = await atQuestionStop();
    const { state, cycle, backend } = f;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    let ended: { statusCode: number; body: string } | undefined;
    backend.replyForRequest = async (request: AgentLaunchRequest) => {
      if (!request.readOnly) return implementationDone;
      // The operator presses End while the backend is still starting the run.
      ended = await post(state, `/cycles/${cycle.id}/investigation/end`, {
        expectedVersion: currentCycle(state, cycle).version,
      });
      return { resultText: report(), release: new Promise<void>(() => {}), exitAfterKill: exited };
    };
    const started = post(state, `/cycles/${cycle.id}/investigation`, {
      expectedVersion: currentCycle(state, cycle).version,
    });
    await waitFor(() => ended !== undefined, 'End during the launch');
    expect(ended?.statusCode, ended?.body).toBe(200);
    expect(currentCycle(state, cycle).investigation?.endRequestedByUserId).toBe(state.userId);
    // The session the backend started is told to end; until it exits, nothing is written and
    // the stop waits.
    await waitFor(() => launchesReadOnly(backend.launches).length === 1, 'the session');
    await stepDaemons(3);
    expect(currentCycle(state, cycle).investigation?.result).toBeUndefined();
    expect((await presented(state, cycle)).actions).toEqual(['end-investigation']);
    writeFileSync(join(f.worktree.path, 'during-launch.txt'), 'still writing');
    exit();
    expect((await started).statusCode).toBe(200);
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'investigation ended');
    expect(currentCycle(state, cycle).investigation?.result).toMatchObject({
      outcome: 'failed',
      code: 'worktree-changed',
      worktreeChange: { parts: ['untracked'], paths: ['during-launch.txt'] },
    });
    expect(
      state.context.storage.execution.runs.liveForWorktree(state.workspaceId, cycle.worktreeId),
    ).toEqual([]);
  });

  it('compares a run ended at its deadline only once its process has exited (review M1)', async () => {
    let now = new Date('2026-10-02T12:00:00Z');
    const f = await atQuestionStop(() => now);
    const { state, cycle, backend } = f;
    let exit!: () => void;
    f.script({
      resultText: report(),
      release: new Promise<void>(() => {}),
      exitAfterKill: new Promise<void>((resolve) => {
        exit = resolve;
      }),
    });
    // The clock passes the deadline as the run launches, so its timer fires at once.
    backend.onLaunch = (request) => {
      if (request.readOnly) now = new Date(now.getTime() + 31 * 60_000);
    };
    await investigate(state, cycle);
    await waitFor(() => launchesReadOnly(backend.launches).length === 1, 'investigation launch');
    await stepDaemons(3);
    expect(currentCycle(state, cycle).investigation?.result).toBeUndefined();
    writeFileSync(join(f.worktree.path, 'after-deadline.txt'), 'still writing');
    exit();
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'deadline result');
    expect(currentCycle(state, cycle).investigation?.result).toMatchObject({
      outcome: 'failed',
      code: 'worktree-changed',
      message: expect.stringContaining('time limit'),
    });
  });

  it("fails on the agent's own commit, and on a tree it cannot read (review M20, M21)", async () => {
    const f = await atQuestionStop();
    const { state, cycle } = f;
    // A commit leaves the diff against the new HEAD clean: only HEAD shows it.
    f.backend.onLaunch = (request) => {
      if (!request.readOnly) return;
      writeFileSync(join(request.cwd, 'committed.txt'), 'x');
      git(['add', 'committed.txt'], request.cwd);
      git(
        ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'agent'],
        request.cwd,
      );
    };
    await investigate(state, cycle);
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'investigation result');
    const change = currentCycle(state, cycle).investigation?.result?.worktreeChange;
    expect(change?.parts).toEqual(['head']);
    expect(change?.headAfter).not.toBe(change?.headBefore);

    // A worktree the daemon cannot read when it compares counts as changed.
    const real = createGitOperations({ gitExecutable: 'git' });
    let snapshots = 0;
    const g = await atQuestionStop(undefined, {
      ...real,
      snapshotWorktree: async (path) =>
        snapshots++ === 0
          ? real.snapshotWorktree(path)
          : { ok: false, failure: { kind: 'git-failed', message: 'unreadable' } },
    });
    await investigate(g.state, g.cycle);
    await waitFor(
      () => !!currentCycle(g.state, g.cycle).investigation?.result,
      'investigation result',
    );
    expect(currentCycle(g.state, g.cycle).investigation?.result).toMatchObject({
      code: 'worktree-changed',
      worktreeChange: { parts: ['unreadable'] },
    });
  });

  it('lets the operator stop a cycle whose worktree changed, and holds a roadmap item as an operator wait (review M2)', async () => {
    const { state, backend } = await roadmapFixture();
    const ws = state.workspaceId;
    let implementations = 0;
    backend.replyForRequest = (request: AgentLaunchRequest) =>
      request.readOnly
        ? { resultText: report() }
        : request.model === 'design-model'
          ? designDone
          : implementations++ === 0
            ? asked
            : implementationDone;
    backend.onLaunch = (request) => {
      if (request.readOnly) writeFileSync(join(request.cwd, 'planted.txt'), 'x');
    };
    const saved = await saveRoadmapRequest(state, {
      ...roadmapInput(state, [state.workItemId]),
      scheduling: {
        mode: 'parallel',
        maxInFlight: 1,
        maxPerRepository: 1,
        maxIntegrationRefreshes: 3,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await roadmapControl(state, 'start');
    const cycleOf = () => {
      const attempt = storedRoadmap(state).attempts[0];
      return attempt && state.context.storage.execution.cycles.find(ws, attempt.cycleId);
    };
    await waitFor(
      () => cycleOf()?.attention?.code === 'implementation-open-questions',
      'implementation question',
    );
    const cycle = cycleOf()!;
    await investigate(state, cycle);
    await waitFor(
      () => currentCycle(state, cycle).investigation?.result?.code === 'worktree-changed',
      'worktree change',
    );
    // The scheduler records the stop's operator wait, not work in progress.
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).entryWaits?.[entryIds[0]!]).toMatchObject({
      code: 'cycle-attention',
      refs: { cycleId: cycle.id },
    });
    // Resuming the item does not move the held stop.
    const resumed = await post(state, `/roadmaps/${roadmapId}/control`, {
      action: 'resume',
      entryId: entryIds[0],
      expectedVersion: storedRoadmap(state).version,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    await stepDaemons(2);
    expect(currentCycle(state, cycle)).toMatchObject({ status: 'needs-attention' });
    expect(currentCycle(state, cycle).investigation?.result?.acknowledgedAt).toBeUndefined();
    // Stopping the cycle ends it; it never builds on the changed tree.
    const stopped = await post(state, `/cycles/${cycle.id}/control`, {
      action: 'stop',
      expectedVersion: currentCycle(state, cycle).version,
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(currentCycle(state, cycle).status).toBe('stopped');
  });

  it('retires a held cycle for an amendment, since retiring ends it (review L1)', async () => {
    const f = await atQuestionStop();
    const { state, cycle } = f;
    plantOnReadOnlyLaunch(f);
    await investigate(state, cycle);
    await waitFor(
      () => currentCycle(state, cycle).investigation?.result?.code === 'worktree-changed',
      'worktree change',
    );
    const user = state.context.storage.users.findById(state.userId)!;
    state.context.services.workCycleService.retireForAmendment(
      { user },
      currentCycle(state, cycle),
      'amendment-1',
    );
    expect(currentCycle(state, cycle).status).toBe('stopped');
    // Nothing reset the tree.
    expect(existsSync(join(f.worktree.path, 'planted.txt'))).toBe(true);
  });

  it('settles a record without a worktree, started before the check, as before', async () => {
    const f = await atQuestionStop();
    const { state, cycle } = f;
    let release!: () => void;
    f.script({
      resultText: report(),
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    await investigate(state, cycle);
    await waitFor(() => launchesReadOnly(f.backend.launches).length === 1, 'investigation launch');
    const stored = currentCycle(state, cycle);
    const { worktree: _recorded, ...older } = stored.investigation!;
    state.context.storage.execution.cycles.replace(
      { ...stored, investigation: older },
      stored.version,
    );
    writeFileSync(join(f.worktree.path, 'planted.txt'), 'not compared');
    release();
    await waitFor(() => !!currentCycle(state, cycle).investigation?.result, 'investigation result');
    const result = currentCycle(state, cycle).investigation!.result!;
    expect(result).toMatchObject({ outcome: 'finished', findings: [{ question: QUESTION }] });
    expect(result.code).toBeUndefined();
    expect((await presented(state, cycle)).actions).toContain('continue-with-guidance');
  });
});
