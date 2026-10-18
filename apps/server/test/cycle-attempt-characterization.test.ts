import { randomUUID } from 'node:crypto';
import { type AgentRun, asAgentRunId, cycleAttention, type WorkCycle } from '@craftingtable/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CycleWriter } from '../src/services/cycle/writer.js';
import {
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  git,
  implementationDone,
  mutationHeaders,
  type Ready,
  reviewText,
  runToFinish,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * R-B4b's characterization (increment 1; program rule 3): what each step change keeps of the
 * five per-step fields (`stepGuidance`, `housekeepingInstructions`, `resultContinuations`,
 * `outputRepair`, `providerRecovery`) and of the waits, before R-B4b groups the five into one
 * attempt record that every step change writes afresh (decision 6). Each row seeds every field on
 * the cycle, takes the step change, and reads the record it wrote: `kept` is the seeded value,
 * anything else is what the change wrote in its place.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

const T = '2026-09-20T12:00:00.000Z';
const seededFields = (source: string) => ({
  stepGuidance: 'Seeded guidance.',
  housekeepingInstructions: 'Seeded housekeeping.',
  resultContinuations: 1,
  outputRepair: {
    attempts: 1,
    sourceRunId: asAgentRunId(source),
    code: 'step-incomplete' as const,
    issues: ['Seeded.'],
  },
  providerRecovery: {
    attempts: 1,
    sourceRunId: asAgentRunId(source),
    failure: { kind: 'capacity' as const, message: 'Seeded.', safeToRetry: true },
    profile: { backend: 'claude-code' as const, permissionMode: 'auto' as const, model: 'm' },
  },
  designWait: {
    startedAt: T,
    requirements: [{ kind: 'slice' as const, id: 'wi/WI-01/domain', state: 'merged' as const }],
  },
  phaseWait: {
    startedAt: T,
    blockers: [
      { kind: 'dependency' as const, message: 'Seeded.', code: 'slice-requirement' as const },
    ],
  },
});
const FIELDS = [
  'stepGuidance',
  'housekeepingInstructions',
  'resultContinuations',
  'outputRepair',
  'providerRecovery',
  'designWait',
  'phaseWait',
] as const;
type Field = (typeof FIELDS)[number];

/** Seeds every per-step field and both waits on the stored cycle, as one write. */
function seed(state: Ready, cycle: WorkCycle, extra: Partial<WorkCycle> = {}): WorkCycle {
  const current = currentCycle(state, cycle);
  const seeded = {
    ...current,
    ...seededFields(current.currentRunId),
    ...extra,
    version: current.version + 1,
  } as WorkCycle;
  expect(state.context.storage.execution.cycles.replace(seeded, current.version)).toBeTruthy();
  return seeded;
}

/** What a written record carries of each field, against the seeded one. */
function perStep(seeded: WorkCycle, written: WorkCycle): Record<Field, unknown> {
  return Object.fromEntries(
    FIELDS.map((field) => {
      const value = written[field];
      return [
        field,
        !(field in written) || value === undefined
          ? 'absent'
          : JSON.stringify(value) === JSON.stringify(seeded[field])
            ? 'kept'
            : value,
      ];
    }),
  ) as Record<Field, unknown>;
}

const writerOf = (state: Ready) =>
  (state.context.services.workCycleService as unknown as { writer: CycleWriter }).writer;

/**
 * The records the writer writes by `action`, from now on. With `seedAt`, the write of that action
 * starts from the record with every field seeded, as if seeded just before it (`seeded()`), so
 * the row shows what that write itself keeps and clears.
 */
function writes(state: Ready, seedAt?: string) {
  const writer = writerOf(state);
  const change = writer.change.bind(writer);
  const written: { action: string; cycle: WorkCycle }[] = [];
  let base: WorkCycle | undefined;
  vi.spyOn(writer, 'change').mockImplementation((cycle, input, action = 'advance', context) => {
    if (action === seedAt && !base)
      base = { ...cycle, ...seededFields(cycle.currentRunId) } as WorkCycle;
    const from = action === seedAt && base ? base : cycle;
    const result = change(from, input, action, context);
    written.push({ action, cycle: result });
    return result;
  });
  const of = (action: string) => written.find((w) => w.action === action)?.cycle;
  return Object.assign(of, { seeded: () => base, actions: () => written.map((w) => w.action) });
}

/** A design question stop: the cycle at `design`, its run finished. */
async function designStop(outputs: Parameters<typeof cycleFixture>[0] = []) {
  const fixture = await cycleFixture([
    { resultText: '## Open questions\nWhich storage format?' },
    ...outputs,
  ]);
  const cycle = await startCycle(fixture.state, fixture.worktree.id);
  await waitFor(
    () => currentCycle(fixture.state, cycle).status === 'needs-attention',
    'design questions',
  );
  return { ...fixture, cycle };
}

/** The run's turn has completed or the run has ended: the next pass decides on it. */
const turnOver = (state: Ready, cycle: WorkCycle) => {
  const found = state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId);
  return (
    !!found &&
    (found.status === 'failed' ||
      found.status === 'finished' ||
      !!state.context.storage.execution.runEvents.latestOfKind(
        state.workspaceId,
        found.id,
        'turn-completed',
      ))
  );
};
const launched = (state: Ready, cycle: WorkCycle) =>
  !!state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId);
const run = (state: Ready, cycle: WorkCycle): AgentRun => {
  const found = state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId);
  if (!found) throw new Error('missing run');
  return found;
};

describe("next(): the step's reservation", () => {
  // Each next() reserves a run the paused fixture never launches: the writer is asked directly.
  it.each([
    [
      'a new step drops every per-step field but keeps the phase wait',
      'implement' as const,
      {
        stepGuidance: 'absent',
        housekeepingInstructions: '',
        resultContinuations: 0,
        outputRepair: null,
        providerRecovery: null,
        designWait: null,
        phaseWait: 'kept',
      },
    ],
    [
      'the same step again after its run finished drops the guidance',
      'design' as const,
      {
        stepGuidance: 'absent',
        housekeepingInstructions: '',
        resultContinuations: 0,
        outputRepair: null,
        providerRecovery: null,
        designWait: null,
        phaseWait: 'kept',
      },
    ],
  ] as const)('%s', async (_name, step, expected) => {
    const { state, cycle } = await designStop();
    const parent = run(state, currentCycle(state, cycle));
    const seeded = seed(state, cycle);
    const written = await writerOf(state).next(seeded, step, parent);
    expect(written.version).toBe(seeded.version + 1);
    expect(perStep(seeded, written)).toEqual(expected);
  });

  it('keeps the guidance of a step reserved again before its run launched', async () => {
    const { state, cycle } = await designStop();
    const parent = run(state, currentCycle(state, cycle));
    const seeded = seed(state, cycle, { currentRunId: asAgentRunId(randomUUID()) });
    const written = await writerOf(state).next(seeded, 'design', parent);
    expect(perStep(seeded, written)).toMatchObject({ stepGuidance: 'kept', designWait: null });
  });
});

/** Seeds the per-step fields alone on the stored cycle: a wait would steer the pass elsewhere. */
function seedAttempt(state: Ready, cycle: WorkCycle, keep: readonly Field[] = []): WorkCycle {
  const current = currentCycle(state, cycle);
  const { designWait: _design, phaseWait: _phase, ...fields } = seededFields(current.currentRunId);
  for (const field of keep) delete (fields as Record<string, unknown>)[field];
  const seeded = { ...current, ...fields, version: current.version + 1 } as WorkCycle;
  expect(state.context.storage.execution.cycles.replace(seeded, current.version)).toBeTruthy();
  return seeded;
}

/** Steps only the agents, so a run can end with no controller pass after it. */
const agentsOnly = (state: Ready) => ({
  step: () => state.context.services.agentRunService.quiesce(),
});

describe('the same-step attempts, through the callers that take them (increment 1 review, MEDIUM-2)', () => {
  it('a service retry keeps the guidance, the housekeeping and the continuation count, and takes its retry', async () => {
    let now = new Date('2026-09-25T12:00:00Z');
    const { state, worktree, backend } = await cycleFixture(
      [
        {
          resultText: 'At capacity.',
          providerFailure: { kind: 'capacity', message: 'At capacity.', safeToRetry: true },
        },
        designDone,
      ],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => !!currentCycle(state, cycle).providerRecovery?.nextRetryAt, 'the retry');
    // A seeded repair would make the retry resume the session for it: the retry keeps none.
    const seeded = seedAttempt(state, cycle, ['providerRecovery', 'outputRepair']);
    const written = writes(state);
    now = new Date('2026-09-25T12:30:00Z');
    await waitFor(() => written('retry-provider') !== undefined, 'the service retry', {
      steps: 20,
    }).catch((error: Error) => {
      const at = currentCycle(state, cycle);
      throw new Error(
        `${error.message}: ${at.status} ${at.attention?.code} ${at.reason} ${written.actions()} launches=${backend.launches.length} seeded-at=${seeded.providerRecovery?.attempts}/${seeded.providerRecovery?.nextRetryAt}`,
      );
    });
    const retried = written('retry-provider')!;
    expect(perStep(seeded, retried)).toEqual({
      stepGuidance: 'kept',
      housekeepingInstructions: 'kept',
      resultContinuations: 'kept',
      outputRepair: null,
      providerRecovery: {
        ...seeded.providerRecovery,
        attempts: seeded.providerRecovery!.attempts + 1,
        nextRetryAt: undefined,
      },
      designWait: null,
      phaseWait: 'absent',
    });
  });

  it('a completion continuation keeps the guidance, the housekeeping and the retry, and counts on', async () => {
    const { state, worktree } = await cycleFixture([
      designDone,
      { resultText: 'Waiting.', exitReason: 'background-work-incomplete' },
      implementationDone,
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () =>
        currentCycle(state, cycle).step === 'implement' &&
        launched(state, currentCycle(state, cycle)),
      'the implementation',
    );
    await waitFor(
      () => turnOver(state, currentCycle(state, cycle)),
      'the implementation ending with background work',
      agentsOnly(state),
    );
    const seeded = seedAttempt(state, cycle);
    const written = writes(state);
    await waitFor(() => written('continue-incomplete-result') !== undefined, 'the continuation');
    expect(perStep(seeded, written('continue-incomplete-result')!)).toEqual({
      stepGuidance: 'kept',
      housekeepingInstructions: 'kept',
      resultContinuations: 2,
      outputRepair: null,
      providerRecovery: 'kept',
      // The stored design wait was already `null`, as `next()` leaves it.
      designWait: 'kept',
      phaseWait: 'absent',
    });
  });

  it('an output repair keeps the guidance, the housekeeping and the continuation count, and takes its repair', async () => {
    const { state, worktree } = await cycleFixture([
      { resultText: 'Design complete.' },
      designDone,
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => launched(state, currentCycle(state, cycle)), 'the design');
    await waitFor(
      () => turnOver(state, currentCycle(state, cycle)),
      'the design ending without its checkpoint',
      agentsOnly(state),
    );
    const seeded = seedAttempt(state, cycle, ['outputRepair']);
    const written = writes(state);
    await waitFor(() => written('repair-output') !== undefined, 'the repair');
    const repaired = written('repair-output')!;
    expect(perStep(seeded, repaired)).toMatchObject({
      stepGuidance: 'kept',
      housekeepingInstructions: 'kept',
      resultContinuations: 'kept',
      providerRecovery: null,
      designWait: null,
      phaseWait: 'absent',
    });
    expect(repaired.outputRepair).toMatchObject({ attempts: 1, code: 'design-open-questions' });
  });

  it("a restart's resume keeps every per-step field", async () => {
    const { state, cycle } = await designStop();
    const seeded = seed(state, cycle);
    const restart = (
      state.context.services.workCycleService as unknown as {
        restart: { resumeAfterRestart: (cycle: WorkCycle, run: AgentRun) => Promise<void> };
      }
    ).restart;
    const written = writes(state);
    await restart.resumeAfterRestart(seeded, run(state, seeded));
    expect(perStep(seeded, written('resume-after-restart')!)).toEqual({
      stepGuidance: 'kept',
      housekeepingInstructions: 'kept',
      resultContinuations: 'kept',
      outputRepair: 'kept',
      providerRecovery: 'kept',
      designWait: null,
      phaseWait: 'kept',
    });
  });
});

describe('change(): leaving automation keeps the waits', () => {
  it.each([
    [
      'a stop',
      { status: 'needs-attention', attention: cycleAttention('step-incomplete') },
      'advance',
    ],
    ['a pause', { status: 'paused' }, 'pause'],
    ['an end', { status: 'stopped' }, 'stop'],
  ] as const)('%s keeps both waits and ends the output repair', async (_name, changes, action) => {
    const { state, cycle } = await designStop();
    const seeded = seed(state, cycle, { status: 'running', attention: undefined });
    const written = writerOf(state).change(seeded, changes as never, action);
    expect(perStep(seeded, written)).toEqual({
      stepGuidance: 'kept',
      housekeepingInstructions: 'kept',
      resultContinuations: 'kept',
      outputRepair: null,
      providerRecovery: 'kept',
      designWait: 'kept',
      phaseWait: 'kept',
    });
  });
});

describe("the step changes that bypass next() (R-B7's note for R-B4b)", () => {
  it('a design recovery keeps the guidance and the housekeeping, and clears the rest', async () => {
    const { state, cycle } = await designStop([designDone]);
    const seeded = seed(state, cycle);
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const written = writes(state);
    const response = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'continue',
        profile: { backend: 'claude-code', model: 'recovery-model' },
        instructions: 'Use SQLite.',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(perStep(seeded, written('design-recovery')!)).toEqual({
      stepGuidance: 'kept',
      housekeepingInstructions: 'kept',
      resultContinuations: 0,
      outputRepair: null,
      providerRecovery: null,
      designWait: null,
      phaseWait: null,
    });
  });

  it('the automatic design continue keeps the housekeeping and clears the rest (R-C3a)', async () => {
    const answered = `Investigated.\n\n\`\`\`craftingtable-design\n${JSON.stringify({
      version: 1,
      items: [
        {
          kind: 'resolved',
          question: 'Which storage format?',
          answer: 'SQLite.',
          sources: ['docs/storage.md'],
        },
      ],
    })}\n\`\`\`\n\n## Open questions\nnone`;
    const { state, cycle } = await designStop([{ resultText: answered }, designDone]);
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    // Seeded as the continue's own write starts, after the investigation's recovery cleared its
    // share (increment 1 review, LOW-4).
    const written = writes(state, 'design-continue');
    const response = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'investigate',
        profile: { backend: 'claude-code', model: 'investigation-model' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => written('design-continue') !== undefined, 'the design continue');
    expect(perStep(written.seeded()!, written('design-continue')!)).toEqual({
      stepGuidance: 'absent',
      housekeepingInstructions: 'kept',
      resultContinuations: 0,
      outputRepair: null,
      providerRecovery: null,
      designWait: null,
      phaseWait: null,
    });
  });

  it("an integration resolution's start keeps every per-step field but the repair, and both waits", async () => {
    const { state, backend, worktree, root } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    backend.onLaunch = (request) => {
      if (request.model === 'implement-model')
        commitFile(worktree.path, 'README.md', 'item behavior\n');
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'the approval');
    await controlCycle(state, currentCycle(state, cycle), 'pause');
    commitFile(root, 'README.md', 'integration behavior\n');
    const resolution = (input: Record<string, unknown>) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/integration-resolution`,
        headers: mutationHeaders(state),
        payload: { expectedVersion: currentCycle(state, cycle).version, ...input },
      });
    expect((await resolution({ action: 'inspect' })).statusCode).toBe(200);
    const seeded = seed(state, cycle);
    const written = writes(state);
    backend.replyForRequest = () => ({
      resultText: 'Combined checks passed.\n\n## Resolution status\nready',
    });
    backend.onLaunch = (request) => {
      if (request.model !== 'resolution-model') return;
      commitFile(worktree.path, 'README.md', 'both behaviors\n');
      git(['add', 'README.md'], worktree.path);
    };
    const started = await resolution({
      action: 'start',
      profile: { ...cycleProfiles.remediate, model: 'resolution-model' },
      instructions: 'Preserve both behaviors',
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(perStep(seeded, written('resolution-started')!)).toEqual({
      stepGuidance: 'kept',
      housekeepingInstructions: 'kept',
      resultContinuations: 'kept',
      // An operator's command ends an output repair (`change()`, R-C2).
      outputRepair: null,
      providerRecovery: 'kept',
      designWait: 'kept',
      phaseWait: 'kept',
    });
  });

  it('adopting a newer manual run keeps every per-step field but the repair, and the phase wait', async () => {
    const { state, worktree, cycle } = await designStop([designDone]);
    await runToFinish(state, worktree.id, {
      role: 'design',
      parentRunId: currentCycle(state, cycle).currentRunId,
    });
    const seeded = seed(state, cycle);
    const written = writes(state);
    await controlCycle(state, currentCycle(state, cycle), 'resume');
    const adopted = written('resume')!;
    expect(adopted.reason).toBe('Resumed with the latest manual run.');
    expect(perStep(seeded, adopted)).toEqual({
      stepGuidance: 'kept',
      housekeepingInstructions: 'kept',
      resultContinuations: 'kept',
      outputRepair: null,
      providerRecovery: 'kept',
      designWait: null,
      phaseWait: 'kept',
    });
  });
});
