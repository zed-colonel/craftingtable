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

/** The records the writer writes by `action`, from now on. */
function writes(state: Ready) {
  const writer = writerOf(state);
  const change = writer.change.bind(writer);
  const written: { action: string; cycle: WorkCycle }[] = [];
  vi.spyOn(writer, 'change').mockImplementation((cycle, input, action = 'advance', context) => {
    const result = change(cycle, input, action, context);
    written.push({ action, cycle: result });
    return result;
  });
  return (action: string) => written.find((w) => w.action === action)?.cycle;
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
      {},
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
      'a same-step service retry keeps the guidance and takes its retry',
      'design' as const,
      { providerRecovery: 'retry' },
      {
        stepGuidance: 'kept',
        housekeepingInstructions: '',
        resultContinuations: 0,
        outputRepair: null,
        providerRecovery: 'retry',
        designWait: null,
        phaseWait: 'kept',
      },
    ],
    [
      'a completion continuation keeps the guidance and takes its count',
      'design' as const,
      { resultContinuations: 2 },
      {
        stepGuidance: 'kept',
        housekeepingInstructions: '',
        resultContinuations: 2,
        outputRepair: null,
        providerRecovery: null,
        designWait: null,
        phaseWait: 'kept',
      },
    ],
    [
      'an output repair keeps the guidance and takes its repair',
      'design' as const,
      { outputRepair: 'repair' },
      {
        stepGuidance: 'kept',
        housekeepingInstructions: '',
        resultContinuations: 0,
        outputRepair: 'repair',
        providerRecovery: null,
        designWait: null,
        phaseWait: 'kept',
      },
    ],
    [
      'the same step again after its run finished drops the guidance',
      'design' as const,
      {},
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
  ] as const)('%s', async (_name, step, given, expected) => {
    const { state, cycle } = await designStop();
    const parent = run(state, currentCycle(state, cycle));
    const seeded = seed(state, cycle);
    const retry = { ...seeded.providerRecovery!, attempts: 2 };
    const repair = { ...seeded.outputRepair!, attempts: 2 };
    const changes = {
      ...('providerRecovery' in given ? { providerRecovery: retry } : {}),
      ...('outputRepair' in given ? { outputRepair: repair } : {}),
      ...('resultContinuations' in given ? { resultContinuations: given.resultContinuations } : {}),
    };
    const written = await writerOf(state).next(seeded, step, parent, undefined, changes);
    expect(written.version).toBe(seeded.version + 1);
    const named = { retry, repair } as Record<string, unknown>;
    expect(perStep(seeded, written)).toEqual(
      Object.fromEntries(
        Object.entries(expected).map(([field, value]) => [
          field,
          typeof value === 'string' && value in named ? named[value] : value,
        ]),
      ),
    );
  });

  it('keeps the guidance of a step reserved again before its run launched', async () => {
    const { state, cycle } = await designStop();
    const parent = run(state, currentCycle(state, cycle));
    const seeded = seed(state, cycle, { currentRunId: asAgentRunId(randomUUID()) });
    const written = await writerOf(state).next(seeded, 'design', parent);
    expect(perStep(seeded, written)).toMatchObject({ stepGuidance: 'kept', designWait: null });
  });
});

describe('change(): leaving automation keeps the waits', () => {
  it.each([
    ['a stop', { status: 'needs-attention', attention: cycleAttention('step-incomplete') }],
    ['a pause', { status: 'paused' }],
    ['an end', { status: 'stopped' }],
  ] as const)('%s keeps both waits and ends the output repair', async (_name, changes) => {
    const { state, cycle } = await designStop();
    const seeded = seed(state, cycle, { status: 'running', attention: undefined });
    const written = writerOf(state).change(seeded, changes as never, 'pause');
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
    // Seeded at the stop: the investigation's recovery keeps the guidance and the housekeeping
    // (the row above), so the continue meets both.
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
        mode: 'investigate',
        profile: { backend: 'claude-code', model: 'investigation-model' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => written('design-continue') !== undefined, 'the design continue');
    expect(perStep(seeded, written('design-continue')!)).toEqual({
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

  it('adopting a newer manual run keeps every per-step field and the phase wait', async () => {
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
