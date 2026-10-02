import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workCycleResponseSchema, workCyclesResponseSchema } from '@craftingtable/contracts';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import { asAgentRunEventId, cycleAttention, type WorkCycle } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  designDone,
  entryIds,
  implementationDone,
  mutationHeaders,
  type Ready,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  startCycle,
  storedRoadmap,
  waitFor,
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
async function atQuestionStop(now?: () => Date) {
  const f = await cycleFixture([], now);
  let investigation: { resultText: string; release?: Promise<void> } = { resultText: report() };
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
async function investigate(state: Ready, cycle: WorkCycle, payload: Record<string, unknown> = {}) {
  const response = await post(state, `/cycles/${cycle.id}/investigation`, {
    expectedVersion: currentCycle(state, cycle).version,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  return workCycleResponseSchema.parse(response.json()).cycle;
}
async function presented(state: Ready, cycle: WorkCycle) {
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/cycles?workItemId=${state.workItemId}`,
    headers: mutationHeaders(state),
  });
  expect(response.statusCode, response.body).toBe(200);
  const found = workCyclesResponseSchema
    .parse(response.json())
    .cycles.find((c) => c.id === cycle.id);
  if (!found) throw new Error('Missing cycle');
  return found;
}
const launchesReadOnly = (launches: readonly AgentLaunchRequest[]) =>
  launches.filter((launch) => launch.readOnly);

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

    const started = await investigate(state, cycle, { instructions: 'Check the format spec.' });
    const record = started.investigation;
    if (!record) throw new Error('No investigation');
    expect(record).toMatchObject({
      sourceRunId: stopped.currentRunId,
      code: 'implementation-open-questions',
      minutes: 30,
      instructions: 'Check the format spec.',
      profile: { backend: 'claude-code', model: 'design-model' },
    });
    expect(started.actions).toEqual(['end-investigation']);
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
    const again = await post(state, `/cycles/${cycle.id}/investigation`, {
      expectedVersion: currentCycle(state, cycle).version,
    });
    expect(again.statusCode).toBe(409);
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
      .cycles.find((c) => c.id === cycle.id);
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
    expect(
      workCycleResponseSchema.parse(response.json()).cycle.investigation?.result,
    ).toMatchObject({ outcome: 'cancelled', message: 'Ended by the operator.' });
    const runId = started.investigation!.runId;
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, runId)?.status === 'cancelled',
      'investigation cancelled',
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
});
