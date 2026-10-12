import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAgentRunResponseSchema } from '@craftingtable/contracts';
import {
  asPlanVersionId,
  asProjectId,
  asQualificationEnvironmentId,
  asWorkItemDependencyId,
  asWorkItemId,
  type ExecutionScope,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { openDaemonStorage } from '../src/persisted-records.js';
import { resolveScope, scopeCases, scopeRequirements } from '../src/services/execution-scope.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  admit,
  branchCommand,
  cleanupExecutionFixtures,
  controlRoadmapEntry,
  delegateLocalReviewers,
  entryCycle,
  commitFile,
  configureLocalRuntime,
  currentCycle,
  declareFixtureChecks,
  designDone,
  expectedScopeEvidence,
  git,
  implementationDone,
  launchScoped,
  merge,
  mergeRoadmapAttempt,
  mutationHeaders,
  recordScope,
  replyByScope,
  roadmapEntry,
  runScopedFixtureCheck,
  reviewScope,
  roadmapControl,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  scopeKey,
  scopeReport,
  scopeTree,
  slicedFixture,
  startCycle,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

describe('execution slices and parent acceptance', () => {
  it('keeps sibling merges separate, verifies exact scopes and accepts the independently reviewed parent', async () => {
    const f = await slicedFixture(),
      { state, root } = f,
      ws = state.workspaceId;
    // The reviewer role is the delegated roadmap's (R-F2 decision 4). The slices are developed
    // and merged by hand; the roadmap verifies them and reviews the parent, whose acceptance the
    // operator records.
    await delegateLocalReviewers(f, { hold: (e) => e.executionScope?.kind === 'slice' });
    const receipts = () => state.context.storage.scopeReceipts.list(ws, state.workItemId);
    const a = await scopeTree(f, f.scopes[0]!),
      b = await scopeTree(f, f.scopes[1]!);
    expect(a.branchName).not.toBe(b.branchName);
    expect(a.path).not.toBe(b.path);
    await expect(scopeTree(f, f.scopes[0]!)).rejects.toThrow('active worktree');
    await expect(scopeTree(f, { ...f.scopes[0]!, sourceId: 'foreign-slice' })).rejects.toThrow();
    await expect(scopeTree(f, f.parentScope)).rejects.toThrow('has not merged');
    await expect(scopeTree(f, { ...f.scopes[0]!, kind: 'slice-verification' })).rejects.toThrow(
      'Merge this slice',
    );
    await expect(
      state.context.services.executionService.createWorktree(f.auth, ws, state.workItemId, {
        repositoryId: f.repository.id,
      }),
    ).rejects.toThrow('uses execution slices');
    commitFile(a.path, 'a.txt', 'A');
    await reviewScope(f, a, true);
    expect((await merge(state, a.id)).statusCode).toBe(409);
    await reviewScope(f, a);
    const landedA = await merge(state, a.id);
    expect(landedA.statusCode, landedA.body).toBe(200);
    expect(landedA.json().workItemCompleted).toBe(false);
    expect(state.context.storage.planning.workItems.find(ws, state.workItemId)?.status).toBe(
      'admitted',
    );
    const bypass = await branchCommand(state, `work-items/${state.workItemId}/control`, {
      action: 'complete',
    });
    expect(bypass.statusCode, bypass.body).toBe(409);
    // Slice a's exact scope is verified by the roadmap's own verification attempt.
    const verification = (sourceId: string) =>
      entryCycle(
        state,
        roadmapEntry(state, { ...f.scopes[0]!, kind: 'slice-verification', sourceId }).id,
      );
    replyByScope(f);
    await waitFor(() => receipts().length === 1, 'slice a verified');
    const verifiedA = verification(f.scopes[0]!.sourceId)!;
    expect(receipts().map((r) => [r.scope, r.worktreeId, r.reviewRunId])).toEqual([
      [f.scopes[0], verifiedA.worktreeId, verifiedA.currentRunId],
    ]);
    // Recording the same review again records nothing.
    const again = await recordScope(
      f,
      state.context.storage.execution.worktrees.find(ws, verifiedA.worktreeId)!,
    );
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ recorded: false, workItemCompleted: false });
    // Sibling branch must refresh and receive its own fresh review after integration advances.
    git(['merge', '--no-edit', 'main'], b.path);
    commitFile(b.path, 'b.txt', 'B');
    await reviewScope(f, b);
    const landedB = await merge(state, b.id);
    expect(landedB.statusCode, landedB.body).toBe(200);
    await expect(scopeTree(f, f.parentScope)).rejects.toThrow('has not been verified');
    replyByScope(f);
    await waitFor(() => receipts().length === 2, 'slice b verified');
    expect(
      receipts()
        .map((r) => r.scope.sourceId)
        .sort(),
    ).toEqual(f.scopes.map((x) => x.sourceId));
    expect(receipts().every((r) => r.scope.kind === 'slice')).toBe(true);
    // The roadmap's parent review omits the parent's case first.
    let omitted = false;
    const full = f.backend.replyForRequest;
    f.backend.replyForRequest = async (request) => {
      const tree = state.context.storage.execution.worktrees
        .listActive(ws)
        .find((t) => t.path === request.cwd);
      if (
        request.model === 'review-model' &&
        tree?.executionScope?.kind === 'parent-acceptance' &&
        !omitted
      ) {
        omitted = true;
        await runScopedFixtureCheck(request);
        return {
          resultText: `## Open questions\nnone\n## Review report\n${scopeReport(state, f.parentScope, false, true)}`,
        };
      }
      return full!(request);
    };
    const parentCycle = () => entryCycle(state, roadmapEntry(state, f.parentScope).id);
    await waitFor(() => {
      const c = parentCycle();
      if (c?.status === 'needs-attention') throw new Error(c.reason);
      return c?.status === 'awaiting-merge';
    }, 'parent reviewed');
    const acceptance = state.context.storage.execution.worktrees.find(
      ws,
      parentCycle()!.worktreeId,
    )!;
    const disallowed = await branchCommand(state, `work-items/${state.workItemId}/runs`, {
      worktreeId: acceptance.id,
      role: 'implement',
    });
    expect(disallowed.statusCode, disallowed.body).toBe(409);
    const missingCase = await recordScope(f, acceptance);
    expect(missingCase.statusCode, missingCase.body).toBe(409);
    expect(missingCase.body).toContain('CASE-PARENT');
    expect((await merge(state, acceptance.id)).statusCode).toBe(409);
    commitFile(root, 'post-review.txt', 'Integration advanced after review');
    const staleParent = await recordScope(f, acceptance);
    expect(staleParent.statusCode, staleParent.body).toBe(409);
    // A fresh review of the current integration, by the roadmap's reviewer, is recorded.
    const stale = parentCycle()!.currentRunId;
    await waitFor(() => {
      const c = parentCycle();
      if (c?.status === 'needs-attention') throw new Error(c.reason);
      return c?.status === 'awaiting-merge' && c.currentRunId !== stale;
    }, 'fresh parent review');
    const current = state.context.storage.execution.worktrees.find(ws, acceptance.id)!;
    const accepted = await recordScope(f, current);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ recorded: true, workItemCompleted: true });
    expect((await recordScope(f, current)).json()).toEqual({
      recorded: false,
      workItemCompleted: true,
    });
    const item = state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId);
    expect(item?.status).toBe('completed');
    expect(item?.mergeSha).toBe(git(['rev-parse', 'main'], root).trim());
    expect(
      state.context.storage.planning.dependencies.listPredecessors(state.workspaceId, f.second)[0]
        ?.status,
    ).toBe('completed');
    const reopened = openDaemonStorage(state.context.config.databasePath);
    try {
      expect(reopened.scopeReceipts.list(state.workspaceId, state.workItemId)).toHaveLength(3);
      expect(reopened.execution.worktrees.find(state.workspaceId, a.id)?.executionScope).toEqual(
        f.scopes[0],
      );
    } finally {
      reopened.close();
    }
    expect(f.backend.launches.at(-1)?.prompt).toContain('Original plan conforms');
    expect(f.backend.launches.at(-1)?.prompt).toContain('CASE-PARENT');
    const lastRun = state.context.storage.execution.runs.listForWorktree(
      state.workspaceId,
      acceptance.id,
    )[0]!;
    const ledger = JSON.parse(
      readFileSync(
        join(
          state.context.config.execution.runsRoot,
          lastRun.id,
          'plan',
          'craftingtable-scope-evidence.json',
        ),
        'utf8',
      ),
    );
    expect(ledger.receipts).toHaveLength(2);
    const db = openDatabase(state.context.config.databasePath);
    try {
      expect(() => db.prepare('UPDATE scope_receipts SET record_json = record_json').run()).toThrow(
        'immutable',
      );
      expect(() =>
        db.prepare('UPDATE worktrees SET execution_scope_json = NULL WHERE id = ?').run(a.id),
      ).toThrow('immutable');
    } finally {
      db.close();
    }
  });
  it('allows sibling cycles and persists their scope through roadmap reservations', async () => {
    const f = await slicedFixture(),
      { state } = f;
    // A roadmap's cycles in a repository without adopted checks stop (R-G13 increment 4).
    declareFixtureChecks(state);
    f.backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? designDone
        : request.model === 'review-model'
          ? {
              resultText: scopeReport(
                state,
                state.context.storage.execution.worktrees
                  .listForWorkItem(state.workspaceId, state.workItemId)
                  .find((t) => t.path === request.cwd)!.executionScope!,
              ),
            }
          : implementationDone;
    const input = {
      ...roadmapInput(state, [state.workItemId, state.workItemId]),
      scheduling: {
        mode: 'parallel',
        maxInFlight: 2,
        maxPerRepository: 2,
        maxIntegrationRefreshes: 3,
      },
      entries: roadmapInput(state, [state.workItemId, state.workItemId]).entries.map((e, i) => ({
        ...e,
        executionScope: f.scopes[i],
      })),
    };
    const saved = await saveRoadmapRequest(state, input);
    expect(saved.statusCode, saved.body).toBe(200);
    await roadmapControl(state, 'start');
    await waitFor(
      () => state.context.storage.execution.cycles.listForWorkspace(state.workspaceId).length === 2,
      'two sibling cycles',
    );
    const cycles = state.context.storage.execution.cycles.listForWorkspace(state.workspaceId);
    expect(new Set(cycles.map((c) => c.executionScope?.sourceId)).size).toBe(2);
    expect(new Set(cycles.map((c) => c.worktreeId)).size).toBe(2);
    for (const cycle of cycles)
      await waitFor(() => {
        const c = currentCycle(state, cycle);
        if (c.status === 'needs-attention') throw new Error(c.reason);
        return c.status === 'awaiting-merge';
      }, `review ${cycle.executionScope?.sourceId}`);
    const first = cycles[0]!,
      second = cycles[1]!;
    await mergeRoadmapAttempt(state, first.worktreeId);
    await waitFor(
      () =>
        currentCycle(state, second).integrationRefreshes === 1 &&
        currentCycle(state, second).status === 'awaiting-merge',
      'fresh slice review',
    );
    await mergeRoadmapAttempt(state, second.worktreeId);
    await waitFor(() => storedRoadmap(state).status === 'completed', 'slice roadmap completed');
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    expect(
      state.context.storage.planning.dependencies.listPredecessors(state.workspaceId, f.second)[0]
        ?.status,
    ).toBe('admitted');
  });
  it('rejects stale integration evidence, supports fresh verification, and keeps older bound attempts visible', async () => {
    const f = await slicedFixture(),
      { state, root } = f;
    // The reviewer role is the delegated roadmap's (R-F2 decision 4): it verifies slice a,
    // while slice a's development and every other entry stay manual.
    const verifyA = (e: { executionScope?: ExecutionScope }) =>
      e.executionScope?.kind === 'slice-verification' &&
      e.executionScope.sourceId === f.scopes[0]!.sourceId;
    await delegateLocalReviewers(f, { hold: (e) => !verifyA(e) });
    const entry = storedRoadmap(state).definition.entries.find(verifyA)!;
    const a = await scopeTree(f, f.scopes[0]!);
    commitFile(a.path, 'a.txt', 'A');
    await reviewScope(f, a);
    expect((await merge(state, a.id)).statusCode).toBe(200);
    commitFile(root, 'later.txt', 'Later integration change');
    // A development review is never the assigned verification reviewer, so recording it as the
    // slice's evidence is refused before its integration is even compared.
    const stale = await recordScope(f, a);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.body).toContain('lacks the explicitly assigned independent reviewer roles');
    // The roadmap verifies a; hold its evidence before the scheduler records it.
    replyByScope(f);
    await waitFor(
      () => entryCycle(state, entry.id)?.status === 'awaiting-merge',
      'verification reviewed',
    );
    await controlRoadmapEntry(f, entry.id, 'pause');
    const verification = state.context.storage.execution.worktrees.find(
      state.workspaceId,
      entryCycle(state, entry.id)!.worktreeId,
    )!;
    const reviewedBefore = entryCycle(state, entry.id)!.currentRunId;
    commitFile(root, 'later-again.txt', 'Integration advanced after the verification review');
    const outdated = await recordScope(f, verification);
    expect(outdated.statusCode, outdated.body).toBe(409);
    expect(outdated.body).toContain('Integration branch advanced');
    const badCsrf = await recordScope(f, verification, {
      ...mutationHeaders(state),
      'x-craftingtable-csrf': 'bad',
    });
    expect(badCsrf.statusCode).toBe(403);
    expect(state.context.storage.scopeReceipts.list(state.workspaceId, state.workItemId)).toEqual(
      [],
    );
    // Resumed, the roadmap reviews the current integration afresh and records that evidence.
    await controlRoadmapEntry(f, entry.id, 'resume');
    await waitFor(
      () =>
        state.context.storage.scopeReceipts.list(state.workspaceId, state.workItemId).length > 0,
      'fresh verification recorded',
    );
    // The evidence is a fresh review of the current integration, by the assigned reviewer.
    expect(
      state.context.storage.scopeReceipts
        .list(state.workspaceId, state.workItemId)
        .map((r) => [r.scope.kind, r.scope.sourceId, r.worktreeId, r.reviewRunId]),
    ).toEqual([
      ['slice', f.scopes[0]!.sourceId, verification.id, entryCycle(state, entry.id)!.currentRunId],
    ]);
    expect(entryCycle(state, entry.id)!.currentRunId).not.toBe(reviewedBefore);
    const old = state.context.storage.imports.bindings(
      state.workspaceId,
      f.scopes[0]!.definitionId,
    )[0]!;
    state.context.storage.imports.addBindings({ ...old, revision: 2 });
    const choices = state.context.services.executionService.executionScopes(
      f.auth,
      state.workspaceId,
      state.workItemId,
    ).choices;
    expect(choices[0]?.scope.bindingRevision).toBe(1);
    expect(choices[0]?.status).toBe('merged'); // Historical receipt remains visible but cannot approve a superseded binding.
    const settings = state.context.storage.execution.branchSettings.find(
      state.workspaceId,
      asPlanVersionId('version-1'),
    )!;
    state.context.storage.execution.branchSettings.save(
      { ...settings, version: settings.version + 1 },
      settings.version,
    );
    await expect(scopeTree(f, f.scopes[1]!)).rejects.toThrow('binding changed');
  });
});

it('enforces slice phase requirements in manual controls without treating checkpoints as passed', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    checkpoints: [
      ...source.checkpoints,
      { ...source.checkpoints[0]!, id: 'EXTERNAL-PROOF', title: 'External proof' },
    ],
    slices: source.slices.map((s, i) =>
      i === 0
        ? s
        : {
            ...s,
            start_requires: [{ kind: 'slice', id: 'local/AQ-01/a', state: 'merged' }],
            verify_requires: [{ kind: 'checkpoint', id: 'EXTERNAL-PROOF', state: 'passed' }],
          },
    ),
  }));
  await expect(scopeTree(f, f.scopes[1]!)).rejects.toThrow('must be merged');
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewScope(f, a);
  expect((await merge(f.state, a.id)).statusCode).toBe(200);
  const b = await scopeTree(f, f.scopes[1]!);
  commitFile(b.path, 'b.txt', 'B');
  await reviewScope(f, b);
  expect((await merge(f.state, b.id)).statusCode).toBe(200);
  const evidence = await recordScope(f, b);
  expect(evidence.statusCode, evidence.body).toBe(409);
  expect(evidence.body).toContain('Checkpoint EXTERNAL-PROOF must pass');
  expect(
    f.state.context.storage.scopeReceipts.list(f.state.workspaceId, f.state.workItemId),
  ).toHaveLength(0);
});

it('phase reservations serialize competing launches and release on terminal failure, cancellation and restart', async () => {
  const f = await slicedFixture(),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  const responses = await Promise.all([launchScoped(f, a), launchScoped(f, b)]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const successful = responses.find((r) => r.statusCode === 200)!;
  const run = startAgentRunResponseSchema.parse(successful.json()).run;
  expect(state.context.storage.phaseScheduling.active()).toMatchObject([
    { ownerId: run.id, phase: 'start', resourceKey: 'local-development' },
  ]);
  const occupied = responses[0]!.statusCode === 200 ? a : b;
  const free = occupied.id === a.id ? b : a;
  const cancelled = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'cancel' },
  });
  expect(cancelled.statusCode).toBe(200);
  await waitFor(
    () => !state.context.storage.phaseScheduling.active().length,
    'reservation released',
  );
  f.backend.failNextLaunch = true;
  const failed = await launchScoped(f, free);
  expect(failed.statusCode, failed.body).toBe(200);
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
  const fresh = await launchScoped(f, free);
  expect(fresh.statusCode, fresh.body).toBe(200);
  const reopened = openDaemonStorage(state.context.storage.databasePath);
  expect(reopened.phaseScheduling.active()).toHaveLength(1);
  reopened.close();
  await state.context.services.agentRunService.recoverInterrupted();
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
});
it('phase resources reserve all or none and release Git reservations after a failed operation', async () => {
  const { reservePhase, withPhaseReservation } = await import('../src/services/phase-resources.js');
  const f = await slicedFixture(),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  const resolved = resolveScope(
    state.context.storage,
    state.workspaceId,
    state.workItemId,
    f.scopes[0]!,
  );
  state.context.storage.transaction((tx) =>
    reservePhase(tx, resolved, b, 'merge', 'operation:held', new Date().toISOString()),
  );
  const before = state.context.storage.phaseScheduling.active();
  await expect(
    withPhaseReservation(state.context.storage, resolved, a, 'merge', async () => {
      throw new Error('must not run');
    }),
  ).rejects.toThrow('repository:');
  expect(state.context.storage.phaseScheduling.active()).toEqual(before);
  state.context.storage.transaction((tx) =>
    tx.phaseScheduling.release('operation:held', new Date().toISOString(), 'test-finished'),
  );
  await expect(
    withPhaseReservation(state.context.storage, resolved, a, 'merge', async () => {
      throw new Error('Git failure');
    }),
  ).rejects.toThrow('Git failure');
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
});
it('phase gates let development merge while qualified verification waits without holding resources', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s) => ({
      ...s,
      resources_by_phase: { ...s.resources_by_phase, verify: ['controlled-native-test-host'] },
    })),
  }));
  // The reviewer role is assigned by a delegating roadmap, paused so the work stays manual.
  await delegateLocalReviewers(f, { pause: true });
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewScope(f, a);
  expect(f.state.context.storage.phaseScheduling.active()).toHaveLength(0);
  const merged = await merge(f.state, a.id);
  expect(merged.statusCode, merged.body).toBe(200);
  const receipt = await recordScope(f, a);
  expect(receipt.statusCode, receipt.body).toBe(409);
  expect(receipt.body).toContain('fresh slice-verification');
  expect(f.state.context.storage.phaseScheduling.active()).toHaveLength(0);
  expect(f.state.context.services.executionService.branches.repositoryBusy(f.root)).toBe(false);
  await expect(scopeTree(f, f.scopes[1]!)).resolves.toHaveProperty('executionScope', f.scopes[1]);
  const view = f.state.context.services.executionService.executionScopes(
    f.auth,
    f.state.workspaceId,
    f.state.workItemId,
  );
  expect(view.choices[0]?.phases.find((p) => p.phase === 'verify')?.blockers).toContainEqual(
    expect.objectContaining({ kind: 'authorization' }),
  );
});
it('phase gates require explicit bound early-development authorization but retain parent barriers', async () => {
  const f = await slicedFixture((source) => ({
      ...source,
      slices: source.slices.map((s) => ({ ...s, early_start_exception: true })),
    })),
    { state } = f;
  // A required external parent is incomplete; avoid a cycle with the fixture's local/AQ-02 successor.
  const predecessor = asWorkItemId('external-parent');
  state.context.storage.planning.workItems.insertMany([
    {
      id: predecessor,
      workspaceId: state.workspaceId,
      projectId: asProjectId('project-1'),
      planVersionId: asPlanVersionId('version-1'),
      sourceId: 'PRE',
      ordinal: 3,
      title: 'Predecessor',
      risk: 'low',
      primaryAreas: [],
      exitGate: 'Done',
      sourceFields: { id: 'PRE' },
    },
  ]);
  state.context.storage.planning.dependencies.insertMany([
    {
      id: asWorkItemDependencyId('early-edge'),
      workspaceId: state.workspaceId,
      planVersionId: asPlanVersionId('version-1'),
      predecessorWorkItemId: predecessor,
      successorWorkItemId: state.workItemId,
      kind: 'required',
      ordinal: 1,
    },
  ]);
  await expect(scopeTree(f, f.scopes[0]!)).rejects.toThrow('Parent predecessor');
  const url = `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/scope-scheduling`;
  const denied = await state.context.app.inject({
    method: 'POST',
    url,
    headers: { cookie: state.cookie },
    payload: { scope: f.scopes[0] },
  });
  expect(denied.statusCode).toBe(403);
  const authorized = await state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(state),
    payload: { scope: f.scopes[0] },
  });
  expect(authorized.statusCode, authorized.body).toBe(200);
  const a = await scopeTree(f, f.scopes[0]!);
  await admit(state);
  const agenda = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/work-items?filter=admitted`,
    headers: { cookie: state.cookie },
  });
  expect(agenda.statusCode, agenda.body).toBe(200);
  expect(agenda.json().items.find((i: { id: string }) => i.id === state.workItemId)).toMatchObject({
    blockerSourceIds: ['PRE'],
    executionScopes: [{ sourceId: 'local/AQ-01/a', kind: 'slice', earlyDevelopment: true }],
  });
  await expect(scopeTree(f, f.scopes[1]!)).rejects.toThrow('Parent predecessor');
  commitFile(a.path, 'early.txt', 'Early');
  await reviewScope(f, a);
  const merged = await merge(state, a.id);
  expect(merged.statusCode, merged.body).toBe(200);
  await expect(scopeTree(f, f.parentScope)).rejects.toThrow('Parent predecessor');
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('admitted');
  expect(
    state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 100 })
      .filter((e) => e.action === 'scope.scheduling-authorized'),
  ).toHaveLength(1);
});
it('phase resource waits resume cycles automatically without consuming the execution deadline', async () => {
  const f = await slicedFixture(),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  const started = await launchScoped(f, a);
  const run = startAgentRunResponseSchema.parse(started.json()).run;
  const cycle = await startCycle(state, b.id);
  await waitFor(() => !!currentCycle(state, cycle).phaseWait, 'queued for resources');
  expect(currentCycle(state, cycle).status).toBe('running');
  expect(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  ).toBeUndefined();
  const deadline = currentCycle(state, cycle).runDeadlineAt;
  await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'end' },
  });
  await waitFor(
    () => !!state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    'queued cycle starts',
  );
  expect(Date.parse(currentCycle(state, cycle).runDeadlineAt)).toBeGreaterThan(
    Date.parse(deadline),
  );
  expect(currentCycle(state, cycle).phaseWait).toBeNull();
});
it('phase merge dependencies let an independent sibling integrate first and then refresh the waiting review', async () => {
  const f = await slicedFixture(
      (source) => ({
        ...source,
        slices: source.slices.map((s, i) =>
          i === 0
            ? { ...s, merge_requires: [{ kind: 'slice', id: 'local/AQ-01/b', state: 'merged' }] }
            : s,
        ),
      }),
      true,
    ),
    { state } = f;
  // A roadmap's cycles in a repository without adopted checks stop (R-G13 increment 4).
  declareFixtureChecks(state);
  f.backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? {
            resultText: scopeReport(
              state,
              state.context.storage.execution.worktrees
                .listForWorkItem(state.workspaceId, state.workItemId)
                .find((t) => t.path === request.cwd)!.executionScope!,
            ),
          }
        : implementationDone;
  const saved = await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId, state.workItemId]),
    scheduling: {
      mode: 'parallel',
      maxInFlight: 2,
      maxPerRepository: 2,
      maxIntegrationRefreshes: 3,
    },
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
    entries: roadmapInput(state, [state.workItemId, state.workItemId]).entries.map((e, i) => ({
      ...e,
      executionScope: f.scopes[i],
    })),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => {
    const r = storedRoadmap(state);
    const stalled = state.context.storage.execution.cycles
      .listForWorkspace(state.workspaceId)
      .find((c) => c.status === 'needs-attention');
    if (stalled) throw new Error(stalled.reason);
    if (
      r.status === 'needs-attention' ||
      Object.values(r.entryHolds ?? {}).some((h) => h.status === 'needs-attention')
    )
      throw new Error(JSON.stringify(r));
    return r.status === 'completed';
  }, 'phase dependency roadmap completes');
  const trees = state.context.storage.execution.worktrees.listForWorkItem(
    state.workspaceId,
    state.workItemId,
  );
  const a = trees.find((t) => t.executionScope?.sourceId === 'local/AQ-01/a')!,
    b = trees.find((t) => t.executionScope?.sourceId === 'local/AQ-01/b')!;
  expect(git(['merge-base', '--is-ancestor', b.mergeSha!, a.mergeSha!], f.root)).toBe('');
  expect(
    state.context.storage.execution.cycles
      .listForWorkspace(state.workspaceId)
      .find((c) => c.worktreeId === a.id)?.integrationRefreshes,
  ).toBeGreaterThanOrEqual(1);
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('admitted');
});
it('phase verification capacity is separate and restart releases operation reservations without erasing history', async () => {
  const { reservePhase } = await import('../src/services/phase-resources.js');
  const f = await slicedFixture(),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  const r = resolveScope(state.context.storage, state.workspaceId, state.workItemId, f.scopes[0]!);
  state.context.storage.transaction((tx) =>
    reservePhase(tx, r, a, 'verify', 'operation:verification', new Date().toISOString()),
  );
  const run = await launchScoped(f, b);
  expect(run.statusCode, run.body).toBe(200);
  expect(
    state.context.storage.phaseScheduling
      .active()
      .map((r) => r.resourceKey)
      .sort(),
  ).toEqual(['local-development', 'local-verification']);
  const db = openDatabase(state.context.storage.databasePath);
  expect(() => db.prepare('DELETE FROM phase_reservations').run()).toThrow('immutable');
  db.close();
  await state.context.services.agentRunService.recoverInterrupted();
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
  const reopened = openDatabase(state.context.storage.databasePath);
  expect(
    reopened
      .prepare('SELECT count(*) AS n FROM phase_reservations WHERE released_at IS NOT NULL')
      .get(),
  ).toMatchObject({ n: 2 });
  reopened.close();
});
it('phase verification worktrees do not consume roadmap development capacity', async () => {
  const f = await slicedFixture(),
    { state } = f;
  // A roadmap's cycles in a repository without adopted checks stop (R-G13 increment 4).
  declareFixtureChecks(state);
  // The one delegated roadmap assigns the reviewer role (R-F2 decision 4). Its development of
  // slice b waits until the hand-made verification tree exists; slice a and every verification
  // and acceptance entry stay manual.
  const develop = (e: { executionScope?: ExecutionScope }) =>
    e.executionScope?.kind === 'slice' && e.executionScope.sourceId === f.scopes[1]!.sourceId;
  await delegateLocalReviewers(f, {
    hold: () => true,
    scheduling: {
      mode: 'parallel',
      maxInFlight: 1,
      maxPerRepository: 1,
      maxIntegrationRefreshes: 3,
    },
  });
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewScope(f, a);
  expect((await merge(state, a.id)).statusCode).toBe(200);
  const verification = await scopeTree(f, { ...f.scopes[0]!, kind: 'slice-verification' });
  f.backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: scopeReport(state, f.scopes[1]!) }
        : implementationDone;
  const entry = storedRoadmap(state).definition.entries.find(develop)!;
  await state.context.services.roadmapService.controlEntry(
    f.auth,
    state.workspaceId,
    roadmapId,
    entry.id,
    'resume',
    storedRoadmap(state).version,
  );
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .listForWorkspace(state.workspaceId)
        .some((c) => c.status === 'awaiting-merge'),
    'development beside pending verification',
  );
  expect(
    state.context.storage.execution.cycles
      .listForWorkspace(state.workspaceId)
      .map((c) => c.executionScope?.sourceId),
  ).toEqual([f.scopes[1]!.sourceId]);
  expect(
    state.context.storage.execution.worktrees.find(state.workspaceId, verification.id)?.status,
  ).toBe('active');
  expect(
    state.context.storage.scopeReceipts.list(state.workspaceId, state.workItemId),
  ).toHaveLength(0);
});
it('phase started milestones require a launched run, not a cycle queued for resources', async () => {
  const { reservePhase } = await import('../src/services/phase-resources.js');
  const f = await slicedFixture((source) => ({
      ...source,
      slices: source.slices.map((s, i) =>
        i
          ? { ...s, start_requires: [{ kind: 'slice', id: 'local/AQ-01/a', state: 'started' }] }
          : s,
      ),
    })),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  state.context.storage.transaction((tx) =>
    reservePhase(
      tx,
      resolveScope(tx, state.workspaceId, state.workItemId, f.scopes[0]!),
      a,
      'start',
      'operation:held',
      new Date().toISOString(),
    ),
  );
  const cycle = await startCycle(state, a.id);
  await waitFor(() => !!currentCycle(state, cycle).phaseWait, 'queued start');
  await expect(scopeTree(f, f.scopes[1]!)).rejects.toThrow('must be started');
  state.context.storage.transaction((tx) =>
    tx.phaseScheduling.release('operation:held', new Date().toISOString(), 'test-finished'),
  );
  await waitFor(
    () =>
      !!state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.startedAt,
    'real start',
  );
  const { scopePhaseBlockers } = await import('../src/services/execution-scope.js');
  expect(
    scopePhaseBlockers(
      state.context.storage,
      state.workspaceId,
      state.workItemId,
      f.scopes[1]!,
      'start',
      { resources: false },
    ),
  ).toEqual([]);
});

// The scenario tests report literal scope evidence; this is the one place the resolver's
// derivation from the fixture maps is compared with those literals (R-I5, QA-06).
it('derives from the fixture maps exactly the scope evidence the scenario tests report', async () => {
  const sliced = await slicedFixture();
  const supervised = await supervisedMapFixture(false, 'automatic', true);
  for (const f of [sliced, supervised]) {
    const { state } = f;
    const scopes = [
      ...f.scopes,
      ...f.scopes.map((scope) => ({ ...scope, kind: 'slice-verification' as const })),
      f.parentScope,
    ];
    for (const scope of scopes) {
      const resolved = resolveScope(
        state.context.storage,
        state.workspaceId,
        state.workItemId,
        scope,
      );
      expect(
        { requirements: scopeRequirements(resolved), caseIds: scopeCases(resolved) },
        scopeKey(scope),
      ).toEqual(expectedScopeEvidence(state, scope));
    }
  }
  const second = { ...supervised.parentScope, sourceId: 'local/AQ-02' };
  const resolved = resolveScope(
    supervised.state.context.storage,
    supervised.state.workspaceId,
    supervised.second,
    second,
  );
  expect({ requirements: scopeRequirements(resolved), caseIds: scopeCases(resolved) }).toEqual(
    expectedScopeEvidence(supervised.state, second),
  );
});

// R-F2 decision 4: a lone `review` or `independent-reviewer` role was treated as assigned, an
// undeclared bypass of reviewer qualification for any map using those names.
it('holds verification and acceptance for every unassigned reviewer role, whatever it is named', async () => {
  const { scopePhaseBlockers } = await import('../src/services/execution-scope.js');
  for (const role of ['independent-reviewer', 'review']) {
    const f = await slicedFixture((source) => ({
      ...source,
      evidence_profiles: source.evidence_profiles.map((p) => ({ ...p, reviewer_roles: [role] })),
    }));
    const { state } = f;
    const verification = { ...f.scopes[0]!, kind: 'slice-verification' as const };
    for (const [scope, phase] of [
      [verification, 'verify'],
      [f.parentScope, 'accept'],
    ] as const)
      expect(
        scopePhaseBlockers(
          state.context.storage,
          state.workspaceId,
          state.workItemId,
          scope,
          phase,
          { resources: false },
        ).filter((b) => b.code === 'reviewer-assignment'),
        `${role} ${scope.kind}`,
      ).toEqual([
        expect.objectContaining({
          kind: 'review',
          message: expect.stringContaining(`unassigned reviewer qualifications: ${role}.`),
        }),
      ]);
    await cleanupExecutionFixtures();
  }
});

// Accepted independent evidence for a slice satisfies its reviewer requirement, so recording its
// development tree reaches the merge guard: a merge integration has moved past is refused.
it('refuses to record a merged slice once integration has moved past it, even with accepted evidence', async () => {
  const f = await slicedFixture(),
    { state, root } = f,
    ws = state.workspaceId,
    definitionId = f.parentScope.definitionId;
  const runtime = await configureLocalRuntime(f.auth, state, definitionId);
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewScope(f, a);
  expect((await merge(state, a.id)).statusCode).toBe(200);
  commitFile(root, 'later.txt', 'Integration advanced outside the daemon');
  const integration = state.context.storage.execution.branchSettings.find(
    ws,
    asPlanVersionId('version-1'),
  )!.integrationBranch!;
  const svc = state.context.services.runtimeEvidenceService;
  const spec = (await svc.view(f.auth, ws, definitionId)).subjects.find(
    (s) => s.subject.kind === 'slice' && s.subject.sourceId === f.scopes[0]!.sourceId,
  )!;
  const submitted = await svc.submit(f.auth, ws, definitionId, {
    runtimeId: runtime.current!.id,
    subject: spec.subject,
    subjectCommit: git(['rev-parse', integration], root).trim(),
    environmentId: asQualificationEnvironmentId('local-tests'),
    executedBy: 'implementation-author',
    executedAt: new Date().toISOString(),
    reviewers: [{ identity: 'reviewer', roles: spec.reviewerRoles, artifact: 'review' }],
    requirements: spec.requirements.map((requirement) => ({ requirement, artifact: 'review' })),
    cases: spec.cases.map((c) => ({
      id: c.id,
      sourceRecordDigest: c.sourceRecordDigest,
      result: 'passed' as const,
      artifact: 'review',
    })),
    artifacts: [{ name: 'review', content: 'Independently reviewed the integrated slice.' }],
  });
  await svc.decide(f.auth, ws, definitionId, {
    submissionId: submitted.submissions.at(-1)!.submission.id,
    outcome: 'accepted',
    rationale: 'Independent slice review accepted.',
  });
  const stale = await recordScope(f, a);
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.body).toContain('Merge this reviewed slice first');
  expect(state.context.storage.scopeReceipts.list(ws, state.workItemId)).toEqual([]);
});
