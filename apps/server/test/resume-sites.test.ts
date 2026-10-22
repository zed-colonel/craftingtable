import { randomUUID } from 'node:crypto';
import {
  asAgentRunId,
  asConcurrencyDefinitionId,
  asMergeOperationId,
  asRoadmapEntryId,
  asRuntimeGenerationId,
  asWorkCycleId,
  type CycleStop,
  type ExecutionScope,
  type Roadmap,
  type RoadmapAttempt,
  type WorkCycle,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  controlCycle,
  mutationHeaders,
  parallelFixture,
  present,
  type Ready,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  saveRoadmapRequest,
  storedRoadmap,
} from './execution-test-support.js';

/**
 * R-B7 scheduler half, increment 1 (characterization; tests only): a roadmap's Resume
 * (`RoadmapControl.controlWithin`, through `RoadmapService.control`) and an item's Resume (`controlEntry`) on each condition the
 * two copies of the resume rule read (CTRL-12). Each row pins which cycles the command asks to
 * resume (`WorkCycleService.control` with `resume`), the entry's hold after it, and the
 * command's answer. Rows whose answer changes under R-B7 decision 1 A (one resume rule for both)
 * say "flipped by R-B7 decision 1 A" in their name, and say what they answered before.
 *
 * The rows write their condition into storage by hand on a real parallel roadmap: its first
 * entry's cycle reaches its merge, is paused, and then carries the condition. A review scope's
 * cycle is a copy of that cycle with a hand-made scope; whether automatic recovery escalates
 * is stubbed (`scopeRecoveryDecision`), so a row says which answer Resume reads.
 */

afterEach(() => {
  recovery.decision = undefined;
  vi.restoreAllMocks();
  return cleanupExecutionFixtures();
});

/** The automatic-recovery decision an item's Resume reads; the policy's own tests pin it. */
const recovery = vi.hoisted(() => ({
  decision: undefined as undefined | { readonly escalation: true; readonly reason: string },
}));
vi.mock('../src/services/scope-recovery-policy.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/services/scope-recovery-policy.js')>();
  return {
    ...original,
    scopeRecoveryDecision: (...args: Parameters<typeof original.scopeRecoveryDecision>) =>
      recovery.decision ?? original.scopeRecoveryDecision(...args),
  };
});

/** The stub's escalation reason; the policy's own (`escalate`) also names the rounds run. */
const NOT_CONVERGING =
  'Automatic recovery is not converging. Delegate source fixes with guidance to run a round yourself.';
const ENDED =
  'This cycle has ended. For imported maps, use Planning amendments and reconciliation to review a replacement attempt.';

type Fixture = Awaited<ReturnType<typeof pausedEntry>>;

/**
 * A running parallel roadmap whose first entry's cycle reached its merge and was then paused;
 * with `sibling`, its independent third entry's cycle is at its merge too.
 */
async function pausedEntry(options: { sibling?: boolean } = {}) {
  const f = await parallelFixture({ independentThird: options.sibling ?? false });
  const { state } = f;
  expect((await saveRoadmapRequest(state, f.input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  const attempt = await awaitRoadmapMerge(state, 0);
  const sibling = options.sibling ? await awaitRoadmapMerge(state, 1) : undefined;
  await controlCycle(state, cycleOf(state, attempt.cycleId), 'pause');
  const cycle = cycleOf(state, attempt.cycleId);
  expect(cycle.status).toBe('paused');
  return { ...f, attempt, cycle, sibling };
}

function cycleOf(state: Ready, id: WorkCycle['id']): WorkCycle {
  return present(state.context.storage.execution.cycles.find(state.workspaceId, id));
}

/** Rewrites a stored cycle by hand, as a record the daemon could hold. */
function writeCycle(state: Ready, id: WorkCycle['id'], changes: Partial<WorkCycle>): void {
  const current = cycleOf(state, id);
  const written = state.context.storage.transaction((tx) =>
    tx.execution.cycles.replace(
      { ...current, ...changes, version: current.version + 1 },
      current.version,
    ),
  );
  expect(written).toBeDefined();
}

/** Rewrites the stored roadmap by hand. */
function writeRoadmap(state: Ready, changes: (roadmap: Roadmap) => Partial<Roadmap>): void {
  const current = storedRoadmap(state);
  const saved = state.context.storage.transaction((tx) =>
    tx.roadmaps.save(
      { ...current, ...changes(current), version: current.version + 1 },
      current.version,
    ),
  );
  expect(saved).toBeTruthy();
}

function writeAttempt(state: Ready, id: RoadmapAttempt['id'], changes: Partial<RoadmapAttempt>) {
  writeRoadmap(state, (r) => ({
    attempts: r.attempts.map((a) => (a.id === id ? { ...a, ...changes } : a)),
  }));
}

const stop = (code: CycleStop['code']): CycleStop =>
  ({ kind: 'attention', code, owner: 'operator', since: new Date().toISOString() }) as CycleStop;

/** A review scope other than a slice: recovery may own its stop. */
const parentScope = (): ExecutionScope => ({
  kind: 'parent-acceptance',
  definitionId: asConcurrencyDefinitionId(randomUUID()),
  bindingRevision: 1,
  sourceId: 'AQ-01',
});

/** A slice's scope: recovery never owns a slice's stop. */
const sliceScope = (): ExecutionScope => ({ ...parentScope(), kind: 'slice' });

/**
 * Gives the first entry's attempt a cycle of a review scope other than a slice. A cycle's scope
 * is immutable (`work_cycle_scope_immutable`), so the paused cycle ends and a copy of it with
 * the scope takes its place in the attempt.
 */
function rescope(f: Fixture, changes: Partial<WorkCycle> = {}): void {
  const current = cycleOf(f.state, f.cycle.id);
  writeCycle(f.state, current.id, {
    status: 'stopped',
    stop: { kind: 'ended', code: 'operator-stopped', at: new Date().toISOString() },
  });
  const scoped: WorkCycle = {
    ...current,
    id: asWorkCycleId(randomUUID()),
    version: 1,
    executionScope: parentScope(),
    ...changes,
  };
  f.state.context.storage.transaction((tx) => tx.execution.cycles.insert(scoped));
  writeAttempt(f.state, f.attempt.id, { cycleId: scoped.id });
  f.cycle = scoped;
}

function enableScopeRecovery(f: Fixture): void {
  writeRoadmap(f.state, () => ({
    scopeRecovery: {
      enabled: true,
      maxRoundsPerParent: 3,
      grantedByUserId: f.state.userId,
      grantedAt: new Date().toISOString(),
    },
  }));
}

/**
 * Makes the sibling entry the first entry's repair round, carried by the roadmap: the sibling's
 * entry now names the same work item (as an owning slice's entry does), and its attempt is an
 * operator-requested recovery round of the first entry's review.
 */
function carryRound(f: Fixture): WorkCycle['id'] {
  const sibling = present(f.sibling);
  writeRoadmap(f.state, (r) => ({
    definition: {
      ...r.definition,
      revision: r.definition.revision + 1,
      entries: r.definition.entries.map((e) =>
        e.id === sibling.entryId ? { ...e, workItemId: f.state.workItemId } : e,
      ),
    },
    attempts: r.attempts.map((a) =>
      a.id === sibling.id
        ? {
            ...a,
            recovery: {
              sourceEntryId: f.attempt.entryId,
              sourceRunId: f.cycle.currentRunId,
              sourceSequence: 1,
              findingFingerprint: 'f'.repeat(64),
              phase: 'repair' as const,
              reviewRunIds: {},
              requestedByUserId: f.state.userId,
            },
          }
        : a,
    ),
  }));
  return sibling.cycleId;
}

function reserveMerge(f: Fixture): void {
  f.state.context.storage.transaction((tx) =>
    tx.execution.merges.save({
      id: asMergeOperationId(randomUUID()),
      workspaceId: f.state.workspaceId,
      worktreeId: f.cycle.worktreeId,
      status: 'reserved',
      sourceSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      targetBranch: 'main',
      reviewRunId: f.cycle.currentRunId,
      createdAt: new Date().toISOString(),
      authorizedByUserId: f.state.userId,
    }),
  );
}

/** A stop's investigation still running: `resumable` refuses the cycle (R-C16). */
function investigate(f: Fixture): void {
  writeCycle(f.state, f.cycle.id, {
    investigation: {
      id: randomUUID(),
      runId: asAgentRunId(randomUUID()),
      sourceRunId: f.cycle.currentRunId,
      code: 'review-open-questions',
      questionsDigest: 'd'.repeat(64),
      profile: { backend: f.cycle.profiles.review.backend, model: f.cycle.profiles.review.model },
      instructions: '',
      minutes: 30,
      deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      startedAt: new Date().toISOString(),
      startedByUserId: f.state.userId,
    } as unknown as WorkCycle['investigation'],
  });
}

/** What `queueRuntimeReviews` writes for a reviewed dependency refresh (`runtime-refresh.ts`). */
const dependencyRefresh = (f: Fixture): Partial<RoadmapAttempt> => ({
  dependencyRefresh: {
    runtimeId: asRuntimeGenerationId(randomUUID()),
    generation: 2,
    sourceRunId: f.cycle.currentRunId,
  },
});

/**
 * Records which cycles a command asks to resume; each call still runs, unless `stubbed`. A row
 * whose hand-made review scope names no map stubs the call: the cycle's own resume would answer
 * that its scope is not found, which is the fixture's, not the Resume's.
 */
function watchResumes(f: Fixture, stubbed = false) {
  const control = vi.spyOn(f.state.context.services.workCycleService, 'control');
  if (stubbed) control.mockImplementation(async (_context, _ws, id) => cycleOf(f.state, id));
  return () =>
    control.mock.calls.filter(([, , , action]) => action === 'resume').map(([, , id]) => id);
}

function hold(f: Fixture) {
  return storedRoadmap(f.state).entryHolds?.[f.attempt.entryId];
}

async function itemControl(f: Fixture, action: 'pause' | 'resume') {
  const response = await f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(f.state),
    payload: {
      action,
      entryId: f.attempt.entryId,
      expectedVersion: storedRoadmap(f.state).version,
    },
  });
  return {
    status: response.statusCode,
    message: response.statusCode === 200 ? undefined : response.json().error.message,
  };
}

/** Pauses the roadmap, writes the condition, and resumes the roadmap. */
async function roadmapResume(f: Fixture, condition: () => void = () => {}, stubbed = false) {
  await roadmapControl(f.state, 'pause');
  condition();
  const resumed = watchResumes(f, stubbed);
  await roadmapControl(f.state, 'resume');
  expect(storedRoadmap(f.state).status).toBe('running');
  return { resumed: resumed(), hold: hold(f)?.status };
}

/** Item-pauses the first entry, writes the condition, and resumes the item. */
async function itemResume(f: Fixture, condition: () => void = () => {}, stubbed = false) {
  expect((await itemControl(f, 'pause')).status).toBe(200);
  condition();
  const resumed = watchResumes(f, stubbed);
  const answer = await itemControl(f, 'resume');
  return { ...answer, resumed: resumed(), hold: hold(f)?.status };
}

describe("a roadmap's Resume (controlWithin)", () => {
  it('resumes a paused cycle', async () => {
    const f = await pausedEntry();
    expect(await roadmapResume(f)).toEqual({ resumed: [f.cycle.id], hold: undefined });
  });

  it('resumes the paused slice cycle of an attempt whose entry the definition no longer has (R-B7 increment 12)', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(f, () =>
      writeAttempt(f.state, f.attempt.id, { entryId: asRoadmapEntryId(randomUUID()) }),
    );
    expect(outcome.resumed).toEqual([f.cycle.id]);
  });

  it('resumes a cycle that needs attention at a stop a plain resume continues', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(f, () =>
      writeCycle(f.state, f.cycle.id, {
        status: 'needs-attention',
        stop: stop('review-needs-attention'),
      }),
    );
    expect(outcome).toEqual({ resumed: [f.cycle.id], hold: undefined });
  });

  it('skips an attempt carrying a queued dependency-refresh review', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(f, () =>
      writeAttempt(f.state, f.attempt.id, dependencyRefresh(f)),
    );
    expect(outcome).toEqual({ resumed: [], hold: undefined });
  });

  it('skips an attempt carrying a queued re-verification', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(f, () =>
      writeAttempt(f.state, f.attempt.id, {
        reverification: {
          requestedAt: new Date().toISOString(),
          requestedByUserId: f.state.userId,
          sourceRunId: f.cycle.currentRunId,
        },
      }),
    );
    expect(outcome).toEqual({ resumed: [], hold: undefined });
  });

  it('skips an item the operator paused, and keeps its hold', async () => {
    const f = await pausedEntry();
    expect((await itemControl(f, 'pause')).status).toBe(200);
    expect(await roadmapResume(f)).toEqual({ resumed: [], hold: 'paused' });
  });

  it('resumes a review scope’s stop when scope recovery is off', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(
      f,
      () => rescope(f, { status: 'needs-attention', stop: stop('scope-review-recovery') }),
      true,
    );
    expect(outcome).toEqual({ resumed: [f.cycle.id], hold: undefined });
  });

  it('skips a review scope’s stop that scope recovery owns', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(f, () => {
      enableScopeRecovery(f);
      rescope(f, { status: 'needs-attention', stop: stop('scope-review-recovery') });
    });
    expect(outcome).toEqual({ resumed: [], hold: undefined });
  });

  // R-B7 scheduler half, review of increment 1 (MEDIUM-1): recovery owns no slice's stop, so
  // the roadmap's Resume resumes a slice cycle at the stop it skips for another review scope.
  it('resumes a slice’s stop under scope recovery: recovery owns no slice’s stop', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(
      f,
      () => {
        enableScopeRecovery(f);
        rescope(f, {
          executionScope: sliceScope(),
          status: 'needs-attention',
          stop: stop('review-needs-attention'),
        });
      },
      true,
    );
    expect(outcome).toEqual({ resumed: [f.cycle.id], hold: undefined });
  });

  it('skips a review scope whose round the roadmap carries, and resumes nothing of a round not paused', async () => {
    const f = await pausedEntry({ sibling: true });
    const outcome = await roadmapResume(f, () => {
      carryRound(f);
      rescope(f);
    });
    expect(outcome).toEqual({ resumed: [], hold: undefined });
  });

  it('resumes the round’s paused repair cycle as its own attempt', async () => {
    const f = await pausedEntry({ sibling: true });
    let repair: WorkCycle['id'] | undefined;
    const outcome = await roadmapResume(f, () => {
      repair = carryRound(f);
      rescope(f);
      writeCycle(f.state, repair, { status: 'paused', stop: undefined });
    });
    expect(outcome).toEqual({ resumed: [repair], hold: undefined });
  });

  it('resumes a paused review scope under scope recovery: it never asks whether recovery converges', async () => {
    const f = await pausedEntry();
    recovery.decision = { escalation: true, reason: NOT_CONVERGING };
    const outcome = await roadmapResume(
      f,
      () => {
        enableScopeRecovery(f);
        rescope(f);
      },
      true,
    );
    expect(outcome).toEqual({ resumed: [f.cycle.id], hold: undefined });
  });

  it('skips a stop `resumable` refuses: a running investigation', async () => {
    const f = await pausedEntry();
    expect(await roadmapResume(f, () => investigate(f))).toEqual({ resumed: [], hold: undefined });
  });

  it('skips a stop `resumable` refuses: a stop a plain resume would only reproduce', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(f, () =>
      writeCycle(f.state, f.cycle.id, {
        status: 'needs-attention',
        stop: stop('remediation-exhausted'),
      }),
    );
    expect(outcome).toEqual({ resumed: [], hold: undefined });
  });

  it('skips a cycle whose worktree merged', async () => {
    const f = await pausedEntry();
    const outcome = await roadmapResume(f, () =>
      f.state.context.storage.execution.worktrees.markMerged({
        workspaceId: f.state.workspaceId,
        worktreeId: f.cycle.worktreeId,
        occurredAt: new Date().toISOString(),
        mergeSha: 'c'.repeat(40),
      }),
    );
    expect(outcome).toEqual({ resumed: [], hold: undefined });
  });

  it('skips a cycle whose merge is reserved, leaving it to the scheduler', async () => {
    const f = await pausedEntry();
    expect(await roadmapResume(f, () => reserveMerge(f))).toEqual({ resumed: [], hold: undefined });
    expect(cycleOf(f.state, f.cycle.id).status).toBe('paused');
  });

  it('skips an ended cycle', async () => {
    const f = await pausedEntry();
    await controlCycle(f.state, f.cycle, 'stop');
    expect(await roadmapResume(f)).toEqual({ resumed: [], hold: undefined });
  });

  // R-B7 scheduler half, LOW-2 (mutant R12): a parallel roadmap's Resume resumes in the current
  // definition's entry order, not in the order of its attempts.
  it('resumes paused cycles in the definition’s entry order, not the attempts’ order', async () => {
    const f = await pausedEntry({ sibling: true });
    const sibling = present(f.sibling);
    await controlCycle(f.state, cycleOf(f.state, sibling.cycleId), 'pause');
    const outcome = await roadmapResume(f, () =>
      writeRoadmap(f.state, (r) => ({ attempts: r.attempts.toReversed() })),
    );
    expect(storedRoadmap(f.state).attempts.map((a) => a.entryId)).toEqual([
      sibling.entryId,
      f.attempt.entryId,
    ]);
    expect(outcome).toEqual({ resumed: [f.cycle.id, sibling.cycleId], hold: undefined });
  });

  // R-B7 scheduler half, LOW-2 (mutant R13): a parallel roadmap swallows one cycle's refusal
  // to resume; its independent sibling still resumes and the Resume answers 200.
  it('resumes a sibling past a cycle whose own resume refuses, on a parallel roadmap', async () => {
    const f = await pausedEntry({ sibling: true });
    const sibling = present(f.sibling);
    await controlCycle(f.state, cycleOf(f.state, sibling.cycleId), 'pause');
    // The hand-made review scope names no map, so the first entry's own resume refuses (404).
    const outcome = await roadmapResume(f, () => rescope(f));
    expect(outcome).toEqual({ resumed: [f.cycle.id, sibling.cycleId], hold: undefined });
    expect(cycleOf(f.state, f.cycle.id).status).toBe('paused');
    expect(cycleOf(f.state, sibling.cycleId).status).not.toBe('paused');
  });

  // R-B7 scheduler half, LOW-2: the other side of the parallel guard. A sequential roadmap's
  // Resume answers with its cycle's own refusal and stays paused.
  it('answers a cycle’s own refusal to resume on a sequential roadmap, and stays paused', async () => {
    const sequential = await roadmapFixture();
    const { state } = sequential;
    expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    const attempt = await awaitRoadmapMerge(state, 0);
    await controlCycle(state, cycleOf(state, attempt.cycleId), 'pause');
    await roadmapControl(state, 'pause');
    // `rescope` and `watchResumes` read only the state, the attempt and its cycle.
    const f = { state, attempt, cycle: cycleOf(state, attempt.cycleId) } as unknown as Fixture;
    rescope(f);
    const resumed = watchResumes(f);
    const answer = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'resume', expectedVersion: storedRoadmap(state).version },
    });
    expect(answer.statusCode, answer.body).toBe(404);
    expect(answer.json().error.message).toBe('Resource not found');
    expect(resumed()).toEqual([f.cycle.id]);
    expect(storedRoadmap(state).status).toBe('paused');
    expect(cycleOf(state, f.cycle.id).status).toBe('paused');
  });
});

describe("an item's Resume (controlEntry)", () => {
  it('resumes the cycle of an item the operator paused, and releases its hold', async () => {
    const f = await pausedEntry();
    expect(await itemResume(f)).toEqual({
      status: 200,
      message: undefined,
      resumed: [f.cycle.id],
      hold: undefined,
    });
  });

  it('leaves an attempt carrying a queued dependency-refresh review to the scheduler (flipped by R-B7 decision 1 A)', async () => {
    const f = await pausedEntry();
    // R-B7 decision 1 A: the item's Resume leaves a queued review to the scheduler, as the
    // roadmap's Resume does; before, it resumed the paused cycle.
    const outcome = await itemResume(f, () =>
      writeAttempt(f.state, f.attempt.id, dependencyRefresh(f)),
    );
    expect(outcome).toEqual({
      status: 200,
      message: undefined,
      resumed: [],
      hold: undefined,
    });
  });

  it('leaves an attempt carrying a queued re-verification to the scheduler (flipped by R-B7 decision 1 A)', async () => {
    const f = await pausedEntry();
    // R-B7 decision 1 A: the item's Resume leaves a queued review to the scheduler; before, it
    // resumed the paused cycle.
    const outcome = await itemResume(f, () =>
      writeAttempt(f.state, f.attempt.id, {
        reverification: {
          requestedAt: new Date().toISOString(),
          requestedByUserId: f.state.userId,
          sourceRunId: f.cycle.currentRunId,
        },
      }),
    );
    expect(outcome).toEqual({
      status: 200,
      message: undefined,
      resumed: [],
      hold: undefined,
    });
  });

  it('resumes a review scope’s stop when scope recovery is off', async () => {
    const f = await pausedEntry();
    const outcome = await itemResume(
      f,
      () => rescope(f, { status: 'needs-attention', stop: stop('scope-review-recovery') }),
      true,
    );
    expect(outcome).toEqual({
      status: 200,
      message: undefined,
      resumed: [f.cycle.id],
      hold: undefined,
    });
  });

  it('resumes a paused review scope under scope recovery whose recovery does not escalate', async () => {
    const f = await pausedEntry();
    const outcome = await itemResume(
      f,
      () => {
        enableScopeRecovery(f);
        rescope(f);
      },
      true,
    );
    expect(outcome).toEqual({
      status: 200,
      message: undefined,
      resumed: [f.cycle.id],
      hold: undefined,
    });
  });

  it('leaves a review scope’s stop that scope recovery owns, and releases the hold', async () => {
    const f = await pausedEntry();
    const outcome = await itemResume(f, () => {
      enableScopeRecovery(f);
      rescope(f, { status: 'needs-attention', stop: stop('scope-review-recovery') });
    });
    expect(outcome).toEqual({ status: 200, message: undefined, resumed: [], hold: undefined });
  });

  // R-B7 scheduler half, review of increment 1 (MEDIUM-1): the item's Resume resumes a slice
  // cycle at a stop recovery would own for another review scope, and releases the hold.
  it('resumes a slice’s stop under scope recovery, and releases the hold', async () => {
    const f = await pausedEntry();
    const outcome = await itemResume(
      f,
      () => {
        enableScopeRecovery(f);
        rescope(f, {
          executionScope: sliceScope(),
          status: 'needs-attention',
          stop: stop('review-needs-attention'),
        });
      },
      true,
    );
    expect(outcome).toEqual({
      status: 200,
      message: undefined,
      resumed: [f.cycle.id],
      hold: undefined,
    });
  });

  // R-B7 scheduler half, review of increment 1 (MEDIUM-1): nor does it ask whether recovery
  // converges for a slice; it resumes the slice where another review scope is refused.
  it('resumes a paused slice under scope recovery without asking whether recovery converges', async () => {
    const f = await pausedEntry();
    recovery.decision = { escalation: true, reason: NOT_CONVERGING };
    const outcome = await itemResume(
      f,
      () => {
        enableScopeRecovery(f);
        rescope(f, { executionScope: sliceScope() });
      },
      true,
    );
    expect(outcome).toEqual({
      status: 200,
      message: undefined,
      resumed: [f.cycle.id],
      hold: undefined,
    });
  });

  it('leaves a review scope whose round the roadmap carries, and resumes nothing of a round not paused', async () => {
    const f = await pausedEntry({ sibling: true });
    const outcome = await itemResume(f, () => {
      carryRound(f);
      rescope(f);
    });
    expect(outcome).toEqual({ status: 200, message: undefined, resumed: [], hold: undefined });
  });

  it('resumes the round’s paused repair cycle, not the review it repairs', async () => {
    const f = await pausedEntry({ sibling: true });
    let repair: WorkCycle['id'] | undefined;
    const outcome = await itemResume(f, () => {
      repair = carryRound(f);
      rescope(f);
      writeCycle(f.state, repair, { status: 'paused', stop: undefined });
    });
    expect(outcome).toEqual({
      status: 200,
      message: undefined,
      resumed: [repair],
      hold: undefined,
    });
  });

  it('refuses a stop automatic recovery says does not converge, and keeps the hold', async () => {
    const f = await pausedEntry();
    recovery.decision = { escalation: true, reason: NOT_CONVERGING };
    const outcome = await itemResume(f, () => {
      enableScopeRecovery(f);
      rescope(f);
    });
    expect(outcome).toEqual({ status: 409, message: NOT_CONVERGING, resumed: [], hold: 'paused' });
  });

  it('leaves a stop `resumable` refuses (a running investigation), and releases the hold', async () => {
    const f = await pausedEntry();
    expect(await itemResume(f, () => investigate(f))).toEqual({
      status: 200,
      message: undefined,
      resumed: [],
      hold: undefined,
    });
  });

  it('leaves a stop `resumable` refuses (a stop a plain resume would only reproduce), and releases the hold', async () => {
    const f = await pausedEntry();
    const outcome = await itemResume(f, () =>
      writeCycle(f.state, f.cycle.id, {
        status: 'needs-attention',
        stop: stop('remediation-exhausted'),
      }),
    );
    expect(outcome).toEqual({ status: 200, message: undefined, resumed: [], hold: undefined });
  });

  it("releases the hold and leaves a merged worktree's cycle to the pass (flipped by R-B7 decision 1 A)", async () => {
    const f = await pausedEntry();
    // R-B7 decision 1 A: the item's Resume releases the hold and leaves a merged worktree's
    // cycle to the pass, which completes it; before, it asked the cycle to resume, which refused
    // (409 "The active worktree or Git is unavailable"), and the hold stayed.
    const outcome = await itemResume(f, () =>
      f.state.context.storage.execution.worktrees.markMerged({
        workspaceId: f.state.workspaceId,
        worktreeId: f.cycle.worktreeId,
        occurredAt: new Date().toISOString(),
        mergeSha: 'c'.repeat(40),
      }),
    );
    expect(outcome).toEqual({ status: 200, message: undefined, resumed: [], hold: undefined });
  });

  it('releases the hold and leaves a reserved merge to the scheduler (flipped by R-B7 decision 1 A)', async () => {
    const f = await pausedEntry();
    // R-B7 decision 1 A: the item's Resume releases the hold and leaves the cycle and its reserved
    // merge to the scheduler, as a roadmap's Resume does; before, the cycle's resume refused
    // (409 "Recover the pending merge before resuming or stopping this cycle.") and the hold
    // stayed.
    expect(await itemResume(f, () => reserveMerge(f))).toEqual({
      status: 200,
      message: undefined,
      resumed: [],
      hold: undefined,
    });
    expect(cycleOf(f.state, f.cycle.id).status).toBe('paused');
  });

  // R-B7 scheduler half, review of increment 3 (LOW-3): an item paused before its entry was
  // admitted has no attempt; its Resume releases the hold and asks no cycle to resume.
  it('releases the hold of an item paused before it started, resuming nothing', async () => {
    const f = await pausedEntry();
    const unstarted = present(
      storedRoadmap(f.state).definition.entries.find(
        (e) => !storedRoadmap(f.state).attempts.some((a) => a.entryId === e.id),
      ),
    );
    const control = async (action: 'pause' | 'resume') =>
      f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/roadmaps/${roadmapId}/control`,
        headers: mutationHeaders(f.state),
        payload: { action, entryId: unstarted.id, expectedVersion: storedRoadmap(f.state).version },
      });
    expect((await control('pause')).statusCode).toBe(200);
    expect(storedRoadmap(f.state).entryHolds?.[unstarted.id]?.status).toBe('paused');
    const resumed = watchResumes(f);
    const answer = await control('resume');
    expect(answer.statusCode, answer.body).toBe(200);
    expect(resumed()).toEqual([]);
    expect(storedRoadmap(f.state).entryHolds?.[unstarted.id]).toBeUndefined();
  });

  it('refuses an ended cycle, and keeps the hold', async () => {
    const f = await pausedEntry();
    expect((await itemControl(f, 'pause')).status).toBe(200);
    await controlCycle(f.state, cycleOf(f.state, f.cycle.id), 'stop');
    const resumed = watchResumes(f);
    expect(await itemControl(f, 'resume')).toEqual({ status: 409, message: ENDED });
    expect(resumed()).toEqual([]);
    expect(hold(f)?.status).toBe('paused');
  });

  it('leaves the queued review of a paused item a dependency refresh queued to the scheduler (flipped by R-B7 decision 1 A)', async () => {
    const f = await pausedEntry();
    expect((await itemControl(f, 'pause')).status).toBe(200);
    // What a reviewed dependency refresh writes (`queueRuntimeReviews`): the attempt carries the
    // queued review and the roadmap pauses.
    writeRoadmap(f.state, (r) => ({
      status: 'paused',
      reason:
        'Dependency refresh saved. Check plan acceptance, then Resume to run affected independent reviews.',
      attempts: r.attempts.map((a) =>
        a.id === f.attempt.id ? { ...a, ...dependencyRefresh(f) } : a,
      ),
    }));
    // The roadmap's Resume skips the queued review and keeps the operator's item pause.
    const roadmapResumes = watchResumes(f);
    await roadmapControl(f.state, 'resume');
    expect(roadmapResumes()).toEqual([]);
    expect(hold(f)?.status).toBe('paused');
    vi.restoreAllMocks();
    // R-B7 decision 1 A: the item's Resume leaves the queued review to the scheduler's
    // `repeatScopeReview`, as the roadmap's Resume does; before, it resumed the stale cycle.
    const resumed = watchResumes(f);
    expect(await itemControl(f, 'resume')).toEqual({ status: 200, message: undefined });
    expect(resumed()).toEqual([]);
    expect(hold(f)).toBeUndefined();
  });
});
