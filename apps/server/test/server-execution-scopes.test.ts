import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAgentRunResponseSchema } from '@craftingtable/contracts';
import {
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
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
  commitFile,
  currentCycle,
  designDone,
  expectedScopeEvidence,
  git,
  implementationDone,
  launchScoped,
  merge,
  mergeRoadmapAttempt,
  mutationHeaders,
  recordScope,
  reviewScope,
  roadmapControl,
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
      { state, root } = f;
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
      state.context.services.executionService.createWorktree(
        f.auth,
        state.workspaceId,
        state.workItemId,
        { repositoryId: f.repository.id },
      ),
    ).rejects.toThrow('uses execution slices');
    commitFile(a.path, 'a.txt', 'A');
    await reviewScope(f, a, true);
    expect((await merge(state, a.id)).statusCode).toBe(409);
    await reviewScope(f, a);
    const landedA = await merge(state, a.id);
    expect(landedA.statusCode, landedA.body).toBe(200);
    expect(landedA.json().workItemCompleted).toBe(false);
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    const bypass = await branchCommand(state, `work-items/${state.workItemId}/complete`, {});
    expect(bypass.statusCode, bypass.body).toBe(409);
    const evidenceA = await recordScope(f, a);
    expect(evidenceA.statusCode, evidenceA.body).toBe(200);
    expect(evidenceA.json()).toEqual({ recorded: true, workItemCompleted: false });
    // Sibling branch must refresh and receive its own fresh review after integration advances.
    git(['merge', '--no-edit', 'main'], b.path);
    commitFile(b.path, 'b.txt', 'B');
    await reviewScope(f, b);
    const landedB = await merge(state, b.id);
    expect(landedB.statusCode, landedB.body).toBe(200);
    await expect(scopeTree(f, f.parentScope)).rejects.toThrow('has not been verified');
    expect((await recordScope(f, b)).statusCode).toBe(200);
    const acceptance = await scopeTree(f, f.parentScope);
    const disallowed = await branchCommand(state, `work-items/${state.workItemId}/runs`, {
      worktreeId: acceptance.id,
      role: 'implement',
    });
    expect(disallowed.statusCode, disallowed.body).toBe(409);
    await reviewScope(f, acceptance, false, true);
    const missingCase = await recordScope(f, acceptance);
    expect(missingCase.statusCode, missingCase.body).toBe(409);
    expect(missingCase.body).toContain('CASE-PARENT');
    await reviewScope(f, acceptance);
    expect((await merge(state, acceptance.id)).statusCode).toBe(409);
    commitFile(root, 'post-review.txt', 'Integration advanced after review');
    const staleParent = await recordScope(f, acceptance);
    expect(staleParent.statusCode, staleParent.body).toBe(409);
    git(['merge', '--no-edit', 'main'], acceptance.path);
    await reviewScope(f, acceptance);
    const accepted = await recordScope(f, acceptance);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ recorded: true, workItemCompleted: true });
    expect((await recordScope(f, acceptance)).json()).toEqual({
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
    const a = await scopeTree(f, f.scopes[0]!);
    commitFile(a.path, 'a.txt', 'A');
    await reviewScope(f, a);
    expect((await merge(state, a.id)).statusCode).toBe(200);
    commitFile(root, 'later.txt', 'Later integration change');
    const stale = await recordScope(f, a);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.body).toContain('fresh slice verification');
    const verification = await scopeTree(f, { ...f.scopes[0]!, kind: 'slice-verification' });
    await reviewScope(f, verification);
    const badCsrf = await recordScope(f, verification, {
      ...mutationHeaders(state),
      'x-craftingtable-csrf': 'bad',
    });
    expect(badCsrf.statusCode).toBe(403);
    const accepted = await recordScope(f, verification);
    expect(accepted.statusCode, accepted.body).toBe(200);
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
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/cancel`,
    headers: mutationHeaders(state),
    payload: {},
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
  state.context.services.agentRunService.recoverInterrupted();
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
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/end`,
    headers: mutationHeaders(state),
    payload: {},
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
  state.context.services.agentRunService.recoverInterrupted();
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
  const input = roadmapInput(state, [state.workItemId]);
  const saved = await saveRoadmapRequest(state, {
    ...input,
    scheduling: {
      mode: 'parallel',
      maxInFlight: 1,
      maxPerRepository: 1,
      maxIntegrationRefreshes: 3,
    },
    entries: input.entries.map((e) => ({ ...e, executionScope: f.scopes[1] })),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .listForWorkspace(state.workspaceId)
        .some((c) => c.status === 'awaiting-merge'),
    'development beside pending verification',
  );
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
