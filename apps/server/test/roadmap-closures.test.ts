import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ConcurrencySource,
  type ExecutionScope,
  heldStop,
  roadmapAttention,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { SupersededRoadmapOperation } from '../src/services/roadmap/shared.js';
import {
  adoptSupervisedMap,
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  commitFile,
  cycleProfiles,
  designDone,
  git,
  implementationDone,
  itNeedsCargo,
  mergeRoadmapAttempt,
  mutationHeaders,
  parallelFixture,
  present,
  recordScope,
  reviewText,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  runRecord,
  runScopedFixtureCheck,
  saveRoadmapRequest,
  scopeReport,
  storedRoadmap,
  structuredFinding,
  supervisedMapFixture,
  useIntegration,
  waitFor,
  withoutDaemonChecks,
} from './execution-test-support.js';

/**
 * The scheduler's roadmap closures at their sites (R-B7 scheduler half, increment 1; "The
 * roadmap's closures"): how often the callee calls the `check` and `attach` a `RoadmapService`
 * site passes, and whether `attach` runs inside a write transaction (the callee's reservation's),
 * and whether a delegated merge or scope receipt is audited as `system`. One `RoadmapActor`
 * replaces the closures; every count here must read the same after.
 *
 * A site is watched by wrapping the callee's method on the service the scheduler holds: each call
 * that passes closures has them wrapped with counters and calls through. The site's own calls of
 * `check` before it hands it on are not counted; only the callee's are.
 */

afterEach(cleanupExecutionFixtures);

/** What one site's callee did with the closures it was passed, over every call that passed them. */
interface Site {
  calls: number;
  check: number;
  attach: number;
  /** For each `attach` call, whether a write transaction was open around it. */
  attachInTransaction: boolean[];
  /** What each call that threw refused with. */
  refusals: string[];
}

interface Wrap {
  check<F extends (() => void) | undefined>(fn: F): F;
  attach<F extends (() => void) | undefined>(fn: F): F;
}

/**
 * Wraps `service[method]`: `closures` returns the call's arguments with its closures wrapped, or
 * `undefined` for a call that passes none (left uncounted).
 */
function watch(
  storage: CraftingTableStorage,
  service: object,
  method: string,
  closures: (args: unknown[], wrap: Wrap) => unknown[] | undefined,
): Site {
  const site: Site = { calls: 0, check: 0, attach: 0, attachInTransaction: [], refusals: [] };
  const target = service as Record<string, (...args: unknown[]) => unknown>;
  const original = target[method];
  if (typeof original !== 'function') throw new Error(`No method ${method}`);
  const wrap: Wrap = {
    check: (fn) =>
      (fn &&
        (() => {
          site.check += 1;
          return fn();
        })) as typeof fn,
    attach: (fn) =>
      (fn &&
        (() => {
          site.attach += 1;
          site.attachInTransaction.push(storage.inTransaction);
          return fn();
        })) as typeof fn,
  };
  target[method] = function (this: unknown, ...args: unknown[]) {
    const wrapped = closures(args, wrap);
    if (!wrapped) return original.apply(this, args);
    site.calls += 1;
    const refused = (error: unknown) => {
      site.refusals.push(error instanceof Error ? error.message : String(error));
      throw error;
    };
    try {
      const result = original.apply(this, wrapped);
      return result instanceof Promise ? result.catch(refused) : result;
    } catch (error) {
      return refused(error);
    }
  };
  return site;
}

type Closure = (() => void) | undefined;
/** The scheduler's `RoadmapActor` (R-B7), its `check` and `attach` wrapped. */
type Actor = { check: Closure; attach?: Closure };
const wrapActor = (actor: Actor, wrap: Wrap): Actor => ({
  check: wrap.check(actor.check),
  ...(actor.attach ? { attach: wrap.attach(actor.attach) } : {}),
});
/** The execution service's sites: the actor inside the call's last object argument. */
const inOptions = (index: number) => (args: unknown[], wrap: Wrap) => {
  const options = args[index] as { actor?: Actor } | undefined;
  if (!options?.actor) return undefined;
  const next = [...args];
  next[index] = { ...options, actor: wrapActor(options.actor, wrap) };
  return next;
};

/** The audit rows of one action, as who acted and as what. */
function audited(storage: CraftingTableStorage, workspaceId: string, action: string) {
  return storage.audit
    .listWorkspace({ workspaceId: workspaceId as never, limit: 2000 })
    .filter((row) => row.action === action)
    .map((row) => ({ actorKind: row.actorKind, targetId: row.targetId }));
}

it('admits each entry with its check, and audits a delegated merge as the system', async () => {
  const fixture = await roadmapFixture();
  const { state, backend } = fixture;
  const storage = state.context.storage;
  await useIntegration(fixture);
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  const execution = state.context.services.executionService;
  const created = watch(storage, execution, 'createWorktree', inOptions(5));
  const merged = watch(storage, execution, 'mergeWorktree', inOptions(5));
  // The check the delegated merge is handed, as the scheduler made it: the count above holds that
  // the merge asks it, this that it is the scheduler's own (the R-B7 scheduler half's mutation
  // round: a no-op check in its place was counted the same).
  const mergeChecks: (() => void)[] = [];
  const watchedMerge = execution.mergeWorktree;
  execution.mergeWorktree = function (this: unknown, ...args: Parameters<typeof watchedMerge>) {
    const check = args[5]?.actor.check;
    if (check) mergeChecks.push(check);
    return watchedMerge.apply(this, args);
  } as typeof watchedMerge;
  const input = roadmapInput(state);
  // The first entry merges automatically; the second waits for the operator's merge.
  const saved = await saveRoadmapRequest(state, {
    ...input,
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
    entries: input.entries.map((e, i) =>
      i ? { ...e, automation: { integrationMerge: 'manual', integrationConflicts: 'manual' } } : e,
    ),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await roadmapControl(state, 'start');
  const second = await awaitRoadmapMerge(state, 1);
  await mergeRoadmapAttempt(state, second.worktreeId);
  await waitFor(() => storedRoadmap(state).status === 'completed', 'roadmap completion');
  const first = present(storedRoadmap(state).attempts[0]);
  expect({ created, merged }).toEqual({
    // Each admission's tree asks it before its branch is named and again under the merge lane.
    created: { calls: 2, check: 4, attach: 0, attachInTransaction: [], refusals: [] },
    // The delegated merge's composite check: once before its review gates, once before its
    // reservation's write.
    merged: { calls: 1, check: 2, attach: 0, attachInTransaction: [], refusals: [] },
  });
  // The roadmap has completed, so the scheduler's own check now refuses as superseded.
  expect(mergeChecks).toHaveLength(1);
  expect(() => mergeChecks[0]?.()).toThrow(SupersededRoadmapOperation);
  expect(audited(storage, state.workspaceId, 'worktree.merged')).toEqual([
    { actorKind: 'user', targetId: second.worktreeId },
    { actorKind: 'system', targetId: first.worktreeId },
  ]);
});

it('starts a delegated conflict resolution with its check, and merges every entry as the system', async () => {
  const fixture = await parallelFixture();
  const { state, backend, input } = fixture;
  const storage = state.context.storage;
  await useIntegration(fixture);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(request.cwd, 'README.md', `behavior ${request.cwd}\n`);
    if (request.model === 'resolution-auto') {
      writeFileSync(join(request.cwd, 'README.md'), 'both sibling behaviors\n');
      git(['add', 'README.md'], request.cwd);
    }
  };
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'resolution-auto'
        ? { resultText: 'Combined checks passed.\n\n## Resolution status\nready' }
        : request.model === 'review-model'
          ? { resultText: reviewText([]) }
          : implementationDone;
  const resolved = watch(
    storage,
    state.context.services.workCycleService,
    'resolveIntegration',
    (args, wrap) => {
      if (!args[4]) return undefined;
      const next = [...args];
      next[4] = wrapActor(args[4] as Actor, wrap);
      return next;
    },
  );
  const merged = watch(
    storage,
    state.context.services.executionService,
    'mergeWorktree',
    inOptions(5),
  );
  await saveRoadmapRequest(state, {
    ...input,
    automation: {
      integrationMerge: 'automatic',
      integrationConflicts: 'automatic',
      resolutionProfile: { ...cycleProfiles.remediate, model: 'resolution-auto' },
    },
  });
  await roadmapControl(state, 'start');
  await waitFor(
    () => storedRoadmap(state).status === 'completed',
    'unattended parallel integration',
  );
  expect({ resolved, merged }).toEqual({
    // The resolution's start asks it on entry and again after its Git reads, before its write.
    resolved: { calls: 1, check: 2, attach: 0, attachInTransaction: [], refusals: [] },
    // Each of the three entries' merges asks it twice, as the sequential roadmap's merge does.
    merged: { calls: 3, check: 6, attach: 0, attachInTransaction: [], refusals: [] },
  });
  expect(
    audited(storage, state.workspaceId, 'worktree.merged').map((row) => row.actorKind),
  ).toEqual(['system', 'system', 'system']);
});

/** The cycle and run services' sites: the actor at `index` among the call's arguments. */
const atArgument = (index: number) => (args: unknown[], wrap: Wrap) => {
  if (!args[index]) return undefined;
  const next = [...args];
  next[index] = wrapActor(args[index] as Actor, wrap);
  return next;
};

it('sends a merge refused for skipped adopted checks back for one review with the merge’s check (LIVE-24)', async () => {
  const f = await supervisedMapFixture();
  // As server-execution-declared-rereview.test.ts: the daemon's own check runs taken away and
  // each slice's first review skipping the adopted check, so its delegated merge is refused.
  withoutDaemonChecks(f.state);
  const { state } = f;
  const storage = state.context.storage;
  const ws = state.workspaceId;
  const reviews = new Map<string, number>();
  f.backend.replyForRequest = async (request) => {
    if (request.model === 'design-model') return designDone;
    const tree = storage.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    if (request.model === 'review-model') {
      const key = `${tree.executionScope!.kind}:${tree.executionScope!.sourceId}`;
      const seen = (reviews.get(key) ?? 0) + 1;
      reviews.set(key, seen);
      if (!(tree.executionScope!.kind === 'slice' && seen <= 1))
        await runScopedFixtureCheck(request);
      return {
        resultText:
          '## Open questions\nnone\n## Review report\n' +
          scopeReport({ ...state, workItemId: tree.workItemId! }, tree.executionScope!),
      };
    }
    commitFile(request.cwd, `slice-${tree.id}.txt`, 'Implemented bounded slice');
    return implementationDone;
  };
  const reviewed = watch(
    storage,
    state.context.services.workCycleService,
    'reviewForDeclaredChecks',
    atArgument(1),
  );
  const merged = watch(
    storage,
    state.context.services.executionService,
    'mergeWorktree',
    inOptions(5),
  );
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  expect((await roadmapControl(state, 'start')).statusCode).toBe(200);
  const slices = () =>
    storage.execution.worktrees
      .listForWorkItem(ws, state.workItemId)
      .filter((t) => t.executionScope?.kind === 'slice');
  await waitFor(() => {
    const hold = Object.values(storedRoadmap(state).entryHolds ?? {}).find(
      (h) => h.status === 'needs-attention',
    );
    if (hold) throw new Error(hold.reason);
    return slices().length === 2 && slices().every((t) => t.mergedAt);
  }, 'both slices merged after a fresh review');
  const skipped =
    'The review needs a successful run of each declared check on its exact clean reviewed commit: ct-check --declared fixture. Checks the agent chooses are supplemental.';
  expect({ reviewed, merged }).toEqual({
    // For each slice: asked before its review is reserved, and by the writer before the
    // reservation; nothing is attached.
    reviewed: { calls: 2, check: 4, attach: 0, attachInTransaction: [], refusals: [] },
    // Each slice's refused merge stops before the check; each merge after its fresh review asks
    // it twice.
    merged: {
      calls: 4,
      check: 4,
      attach: 0,
      attachInTransaction: [],
      refusals: [skipped, skipped],
    },
  });
});

/** As server-execution-decision-preparation.test.ts: every slice waits on one decision. */
function withDecision(source: ConcurrencySource): ConcurrencySource {
  return {
    ...source,
    evidence_profiles: [
      ...source.evidence_profiles,
      {
        id: 'architecture-approval',
        independence_required: true,
        reviewer_roles: ['repository-maintainer'],
        required_evidence: [
          'accepted decision artifact digest and revision',
          'source contract and affected schema or protocol references',
          'decision owner approval and applicability to the active plan generation',
        ],
      },
    ],
    checkpoints: [
      ...source.checkpoints,
      {
        ...source.checkpoints[0]!,
        id: 'LOCAL-ADR-01',
        owner: 'local',
        kind: 'architecture_decision' as const,
        evidence_profile: 'architecture-approval',
        requires: [],
      },
    ],
    slices: source.slices.map((s) => ({
      ...s,
      start_requires: [
        { kind: 'checkpoint' as const, id: 'LOCAL-ADR-01', state: 'passed' as const },
      ],
    })),
  };
}

it('prepares an operator’s decision with its check at the worktree and at the launch (R-C3b)', async () => {
  const f = await supervisedMapFixture(false, 'automatic', false, false, false, withDecision);
  f.backend.replyForRequest = () => ({ resultText: 'Nothing to prepare.' });
  const { state } = f;
  const storage = state.context.storage;
  const ws = state.workspaceId;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input).roadmap;
  const worktree = watch(
    storage,
    state.context.services.executionService,
    'createDecisionWorktree',
    atArgument(2),
  );
  const launched = watch(
    storage,
    state.context.services.agentRunService,
    'startDecisionPreparation',
    atArgument(2),
  );
  await roadmapControl(state, 'start');
  const prepared = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/roadmaps/${saved.id}/prepare-decision`,
    headers: mutationHeaders(state),
    payload: {
      expectedVersion: storedRoadmap(state).version,
      checkpointId: 'LOCAL-ADR-01',
      profile: { backend: 'claude-code', model: 'decision-model' },
      minutes: 5,
      instructions: '',
    },
  });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const p = storedRoadmap(state).decisionPreparations!.findLast(
    (q) => q.checkpointId === 'LOCAL-ADR-01',
  )!;
  await waitFor(
    () => storage.execution.runs.find(ws, p.runId)?.status === 'finished',
    'the preparation finishes',
  );
  expect({ worktree, launched }).toEqual({
    // The plan worktree asks it once, under its lane, before Git creates the tree.
    worktree: { calls: 1, check: 1, attach: 0, attachInTransaction: [], refusals: [] },
    // The run service asks it once, the launcher at its three gates and the spawn once its
    // session started.
    launched: { calls: 1, check: 5, attach: 0, attachInTransaction: [], refusals: [] },
  });
});

/** `repeatScopeReview` and `control`'s actor, with its `check` and `attach`, at `index`. */
const checkThenAttach = atArgument;

itNeedsCargo(
  'records each verification’s receipt with its check, as the system, and the operator’s parent receipt as the user',
  async () => {
    const f = await supervisedMapFixture(false, 'manual');
    const { state } = f,
      ws = state.workspaceId,
      storage = state.context.storage;
    const receipts = watch(
      storage,
      state.context.services.executionService,
      'recordScopeReceipt',
      inOptions(4),
    );
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    const parent = () =>
      storage.execution.cycles
        .listForWorkspace(ws)
        .find((c) => c.executionScope?.kind === 'parent-acceptance');
    await waitFor(() => parent()?.status === 'awaiting-merge', 'manual parent review');
    expect(heldStop(parent())?.code).toBe('record-scope-evidence');
    const tree = storage.execution.worktrees.find(ws, parent()!.worktreeId)!;
    const recorded = await recordScope(f, tree);
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(receipts).toEqual({
      // Each verification's receipt asks it on entry under the guard and again after its Git
      // reads, before its transaction; the operator's receipt passes none. The second
      // verification's first receipt meets the first's phase reservation after its first check,
      // and is recorded on a later pass.
      calls: 3,
      check: 5,
      attach: 0,
      attachInTransaction: [],
      refusals: ['Waiting for local-verification: 1/1 reservations occupied.'],
    });
    const verifications = storedRoadmap(state)
      .attempts.map((a) => storage.execution.worktrees.find(ws, a.worktreeId))
      .filter((t) => t?.executionScope?.kind === 'slice-verification')
      .map((t) => t!.id);
    expect(audited(storage, ws, 'scope.evidence-recorded')).toEqual([
      { actorKind: 'user', targetId: tree.id },
      ...verifications.toReversed().map((targetId) => ({ actorKind: 'system', targetId })),
    ]);
  },
);

itNeedsCargo(
  'starts a re-verification queued at the receipt gate with its check, attaching in the reservation',
  async () => {
    // As server-execution-roadmap-reverify.test.ts's `heldAtGate`: a verification approved and
    // waiting at its record-scope-evidence gate when a newer repository policy is adopted, so the
    // scheduler's receipt is refused and the entry held; Re-verify queues a fresh review in place.
    const f = await supervisedMapFixture(false, 'automatic');
    const { state } = f,
      ws = state.workspaceId,
      storage = state.context.storage;
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    const verifications = storedRoadmap(state).definition.entries.filter(
      (e) => e.executionScope?.kind === 'slice-verification',
    );
    const attempt = (entryId: string) =>
      storedRoadmap(state).attempts.find((a) => a.entryId === entryId && !a.recovery);
    const cycle = (entryId: string) => {
      const found = attempt(entryId);
      return found && storage.execution.cycles.find(ws, found.cycleId);
    };
    const reviewing = () =>
      verifications.find(
        (e) => cycle(e.id)?.status === 'running' && cycle(e.id)?.step === 'review',
      );
    await waitFor(() => reviewing() !== undefined, 'a verification review running');
    const entry = reviewing()!;
    const services = state.context.services;
    await waitFor(() => cycle(entry.id)?.status === 'awaiting-merge', 'verification approved', {
      step: async () => {
        await services.agentRunService.quiesce();
        await services.workCycleService.tick();
        await services.agentRunService.quiesce();
      },
    });
    const plan = `/api/workspaces/${ws}/plan-versions/version-1/repository-policy`;
    const preview = await state.context.app.inject({
      method: 'GET',
      url: plan,
      headers: { cookie: state.cookie },
    });
    const adopted = await state.context.app.inject({
      method: 'POST',
      url: plan,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: 0,
        expectedBranchSettingsVersion: preview.json().settingsVersion,
        controlMode: 'controller-local',
        interpretation: 'Controller gates now.',
        publicationRequirement: 'Verify remote protections before publication.',
      },
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    await waitFor(
      () => storedRoadmap(state).entryHolds?.[entry.id]?.status === 'needs-attention',
      'receipt refused at the gate holds the entry',
    );
    const gated = cycle(entry.id)!;
    const repeated = watch(
      storage,
      services.workCycleService,
      'repeatScopeReview',
      checkThenAttach(5),
    );
    const receipts = watch(storage, services.executionService, 'recordScopeReceipt', inOptions(4));
    const reverified = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'reverify',
        entryId: entry.id,
        expectedVersion: storedRoadmap(state).version,
      },
    });
    expect(reverified.statusCode, reverified.body).toBe(200);
    await waitFor(
      () =>
        cycle(entry.id)?.status === 'completed' &&
        cycle(entry.id)?.currentRunId !== gated.currentRunId &&
        storedRoadmap(state).entryHolds?.[entry.id] === undefined,
      'verification recorded after the fresh review',
    );
    expect({ repeated, receipts }).toEqual({
      // The cycle's wrapper asks it before the branch change, the branch change twice, the
      // wrapper again under the worktree guard, and the writer before its reservation; the
      // attach runs once, in the writer's transaction.
      repeated: {
        calls: 1,
        check: 5,
        attach: 1,
        attachInTransaction: [true],
        refusals: [],
      },
      receipts: { calls: 1, check: 2, attach: 0, attachInTransaction: [], refusals: [] },
    });
  },
);

/** `delegateScopeRepair`'s site: the actor inside its delegation, the fifth argument. */
const inDelegation = (args: unknown[], wrap: Wrap) => {
  const delegation = args[4] as { actor: Actor } | undefined;
  if (!delegation) return undefined;
  const next = [...args];
  next[4] = { ...delegation, actor: wrapActor(delegation.actor, wrap) };
  return next;
};

/**
 * As server-execution-scope-recovery-operator-rounds.test.ts: the parent's first review finds one
 * defect and every later one finds it resolved; a repair commits its correction and its review
 * resolves the findings of its packet.
 */
function answerOneRepair(f: Awaited<ReturnType<typeof supervisedMapFixture>>): void {
  const { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage;
  const normal = f.backend.replyForRequest!;
  let parentReviews = 0;
  const reportWith = (scope: ExecutionScope, findings: readonly unknown[]) =>
    '## Open questions\nnone\n\n## Review report\n' +
    scopeReport(state, scope)
      .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
      .replaceAll(
        'mergeable',
        findings.some((f) => (f as { status: string }).status === 'open')
          ? 'changes-requested'
          : 'mergeable',
      );
  const defect = { ...structuredFinding, id: 'F003', severity: 'major' };
  f.backend.replyForRequest = async (request) => {
    const tree = storage.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    const scope = tree.executionScope!;
    if (scope.kind === 'parent-acceptance') {
      parentReviews++;
      await runScopedFixtureCheck(request);
      return {
        resultText: reportWith(
          scope,
          parentReviews > 1
            ? [{ ...defect, status: 'resolved', disposition: 'Verified the repair.' }]
            : [defect],
        ),
      };
    }
    const packetPath = runRecord(request, 'craftingtable-scope-repair.json');
    if (packetPath) {
      if (request.model !== 'review-model') {
        commitFile(request.cwd, 'repair.txt', 'Corrected the family');
        return implementationDone;
      }
      await runScopedFixtureCheck(request);
      const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
      return {
        resultText: reportWith(
          scope,
          packet.sources
            .flatMap((s: { findings: (typeof structuredFinding)[] }) => s.findings)
            .map((finding: typeof structuredFinding) => ({
              id: finding.id,
              title: finding.title,
              severity: finding.severity,
              explanation: finding.explanation,
              recommendation: finding.recommendation,
              status: 'resolved',
              disposition: 'Verified the committed correction.',
            })),
        ),
      };
    }
    return normal(request);
  };
}

itNeedsCargo(
  'delegates an operator’s repair round with its check and attach, and carries its reviews',
  async () => {
    // As server-execution-scope-recovery-operator-rounds.test.ts ('requested'): the parent's
    // review finds a defect, the operator delegates its repair to the owning slice with automatic
    // recovery off, and the roadmap carries the round through its reviews.
    const f = await supervisedMapFixture(false, 'automatic', false, false, true);
    const { state } = f,
      ws = state.workspaceId,
      storage = state.context.storage;
    const services = state.context.services;
    answerOneRepair(f);
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    const parent = () =>
      storage.execution.cycles
        .listForWorkspace(ws)
        .find((c) => c.executionScope?.kind === 'parent-acceptance');
    await waitFor(() => parent()?.status === 'needs-attention', 'parent finding');
    const sourceEntryId = storedRoadmap(state).attempts.find(
      (a) => a.cycleId === parent()!.id,
    )!.entryId;
    // The live shape: the stopped review holds its entry for the operator.
    // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
    services.roadmapService['writer'].change(storedRoadmap(state), {
      entryHolds: {
        [sourceEntryId]: {
          status: 'needs-attention',
          reason: 'Recovery needs your input.',
          attention: roadmapAttention('entry-preparation-failed', { entryId: sourceEntryId }),
        },
      },
    });
    const delegated = watch(
      storage,
      services.workCycleService,
      'delegateScopeRepair',
      inDelegation,
    );
    const repeated = watch(
      storage,
      services.workCycleService,
      'repeatScopeReview',
      checkThenAttach(5),
    );
    const resumed = watch(storage, services.workCycleService, 'control', checkThenAttach(6));
    const merged = watch(storage, services.executionService, 'mergeWorktree', inOptions(5));
    const preview = services.workCycleService.previewScopeRepair(f.auth, ws, parent()!.id);
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${parent()!.id}/scope-repair`,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: parent()!.version,
        snapshotDigest: preview.snapshotDigest,
        sourceId: preview.candidates[0]!.scope.sourceId,
        instructions: 'Repair the missing family.',
        maxRemediationRounds: 2,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    // The repair answers the stopped review in the transaction that creates it.
    expect(storedRoadmap(state).entryHolds?.[sourceEntryId]?.status).not.toBe('needs-attention');
    const round = storedRoadmap(state).attempts.find(
      (a) => a.cycleId === response.json().cycle.id,
    )!;
    await waitFor(
      () => storage.planning.workItems.find(ws, state.workItemId)?.status === 'completed',
      'roadmap-carried parent acceptance',
    );
    await waitFor(
      () =>
        storedRoadmap(state).attempts.find((a) => a.id === round.id)!.recovery!.phase ===
        'completed',
      'round completed',
    );
    expect({ delegated, repeated, resumed, merged }).toEqual({
      // The repair's wrapper asks it on entry, the new tree twice, the wrapper after Git and
      // again in the transaction that starts the repair, where the attach answers the hold.
      delegated: { calls: 1, check: 5, attach: 1, attachInTransaction: [true], refusals: [] },
      // The round's verification restarts its completed review (`repeatScopeReview`).
      repeated: { calls: 1, check: 5, attach: 1, attachInTransaction: [true], refusals: [] },
      // The round's parent review resumes its stopped review (`control`'s resume): asked first,
      // then by the scope review's resume as `repeatScopeReview` asks it.
      resumed: { calls: 1, check: 5, attach: 1, attachInTransaction: [true], refusals: [] },
      // The repair's delegated merge.
      merged: { calls: 1, check: 2, attach: 0, attachInTransaction: [], refusals: [] },
    });
    expect(audited(storage, ws, 'worktree.merged')[0]).toEqual({
      actorKind: 'system',
      targetId: round.worktreeId,
    });
  },
);

itNeedsCargo(
  'delegates automatic recovery’s repair round with its check and attach (MEDIUM-1, mutant C6)',
  async () => {
    // R-B7's scheduler half: the automatic recovery owner's site (`advanceScopeRecovery`), the
    // one of the four attaches no row reached. As scope-recovery-test-support.ts ('accepted'):
    // the parent's review finds a defect, recovery is enabled while the roadmap is paused, and on
    // Resume the scheduler delegates the repair to the owning slice itself.
    const f = await supervisedMapFixture(false, 'automatic', false, false, true);
    const { state } = f,
      ws = state.workspaceId,
      storage = state.context.storage;
    const services = state.context.services;
    answerOneRepair(f);
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    const parent = () =>
      storage.execution.cycles
        .listForWorkspace(ws)
        .find((c) => c.executionScope?.kind === 'parent-acceptance');
    await waitFor(() => parent()?.status === 'needs-attention', 'parent finding');
    await roadmapControl(state, 'pause');
    const enabled = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/scope-recovery`,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: storedRoadmap(state).version,
        enabled: true,
        maxRoundsPerParent: 3,
      },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const delegated = watch(
      storage,
      services.workCycleService,
      'delegateScopeRepair',
      inDelegation,
    );
    await roadmapControl(state, 'resume');
    await waitFor(() => {
      const held = Object.values(storedRoadmap(state).entryHolds ?? {}).find(
        (h) => h.status === 'needs-attention',
      );
      if (held) throw new Error(held.reason);
      return storage.planning.workItems.find(ws, state.workItemId)?.status === 'completed';
    }, 'automatic recovered parent acceptance');
    const rounds = () => storedRoadmap(state).attempts.filter((a) => a.recovery);
    await waitFor(
      () => rounds().length === 1 && rounds()[0]!.recovery!.phase === 'completed',
      'round completed',
    );
    // As the operator's delegation: the repair's wrapper asks it on entry, the new tree twice,
    // the wrapper after Git and again in the transaction that starts the repair, where the attach
    // marks the round active.
    expect(delegated).toEqual({
      calls: 1,
      check: 5,
      attach: 1,
      attachInTransaction: [true],
      refusals: [],
    });
  },
);
