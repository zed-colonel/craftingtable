import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { openDaemonStorage } from './persisted-records.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  itNeedsCargo,
  mutationHeaders,
  roadmapControl,
  roadmapId,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

const amendmentCommand = (
  f: Awaited<ReturnType<typeof supervisedMapFixture>>,
  action: string,
  payload: unknown,
  headers = mutationHeaders(f.state),
) =>
  f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/roadmaps/${roadmapId}/amendments${action ? `/${action}` : ''}`,
    headers,
    payload: payload as Record<string, unknown>,
  });
it('holds a roadmap for reviewed amendments, checks stale previews and preserves immutable decisions across recovery', async () => {
  const f = await supervisedMapFixture(true),
    ws = f.state.workspaceId,
    service = f.state.context.services.mapAmendmentService;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input);
  const candidate = { ...f.input.configuration, selection: 'prioritize-full' as const };
  const selection = {
    definitionId: candidate.definitionId,
    bindingRevision: 1,
    targetId: candidate.targetId,
    selection: candidate.selection,
  };
  expect(
    (await amendmentCommand(f, 'preview', selection, { cookie: f.state.cookie })).statusCode,
  ).toBe(403);
  expect((await amendmentCommand(f, 'preview', selection)).statusCode).toBe(200);
  const proposed = await amendmentCommand(f, '', {
    expectedVersion: saved.roadmap.version,
    candidate: selection,
    summary: 'Include retained work after the initial proof.',
  });
  expect(proposed.statusCode, proposed.body).toBe(200);
  const view = proposed.json(),
    pending = view.history[0];
  expect(f.state.context.storage.roadmaps.find(ws, roadmapId)?.status).toBe('paused');
  // The pending decision is the operator's: it is an attention item until decided (R-A4).
  const amendmentItems = () =>
    f.state.context.storage.attention
      .recent(ws, 100)
      .filter((item) => item.code === 'amendment-decision');
  expect(amendmentItems()).toMatchObject([
    { state: 'open', subjectKey: `roadmap:${roadmapId}:amendment` },
  ]);
  await expect(
    f.state.context.services.roadmapService.control(
      f.auth,
      ws,
      roadmapId,
      'resume',
      saved.roadmap.version + 1,
    ),
  ).rejects.toThrow(/amendment/);
  const decision = {
    amendmentId: pending.id,
    outcome: 'apply',
    impactDigest: '0'.repeat(64),
    rationale: 'Reviewed complete retained obligations.',
    reuseIntegrationIds: [],
  };
  expect((await amendmentCommand(f, 'decision', decision)).statusCode).toBe(409);
  const applied = await amendmentCommand(f, 'decision', {
    ...decision,
    impactDigest: view.pendingImpact.digest,
  });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(amendmentItems()).toMatchObject([{ state: 'resolved', resolvedBy: 'operator' }]);
  expect(applied.json().history[0].decision.previous.definition.crossProject.selection).toBe(
    'target-only',
  );
  expect(
    f.state.context.storage.roadmaps.find(ws, roadmapId)?.definition.crossProject?.selection,
  ).toBe('prioritize-full');
  expect(f.state.context.storage.roadmaps.find(ws, roadmapId)?.status).toBe('paused');
  f.state.context.services.roadmapService.recoverInterrupted();
  await f.state.context.services.roadmapService.tick();
  expect(f.state.context.storage.execution.worktrees.listActive(ws)).toHaveLength(0);
  expect(
    (
      await amendmentCommand(f, 'decision', {
        ...decision,
        impactDigest: view.pendingImpact.digest,
      })
    ).statusCode,
  ).toBe(409);
  const ready = service.finalization(f.auth, ws, roadmapId).projects[0]!;
  expect(ready.status).toBe('blocked');
  expect(ready.blockers.join(' ')).toContain('partial target');
});
it('rebinds a reviewed replacement without carrying adoption or evidence and retains old roadmap revisions', async () => {
  const f = await supervisedMapFixture(),
    ws = f.state.workspaceId,
    storage = f.state.context.storage,
    service = f.state.context.services.mapAmendmentService;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input);
  const old = storage.imports.definition(ws, f.parentScope.definitionId)!,
    binding = storage.imports.bindings(ws, old.id)[0]!;
  const id = randomUUID();
  storage.transaction((tx) => {
    tx.imports.addDefinition({
      ...old,
      id,
      revision: 'amended',
      source: { ...old.source, revision: 'amended' },
    });
    tx.imports.addBindings({ ...binding, definitionId: id });
  });
  const candidate = {
    definitionId: id,
    bindingRevision: 1,
    targetId: 'LOCAL',
    selection: 'target-only' as const,
  };
  const v = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: saved.roadmap.version,
    candidate,
    summary: 'Adopt revised scope.',
  });
  const impact = v.pendingImpact!;
  expect(impact.blockers).toEqual([]);
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: v.history[0]!.id,
    outcome: 'apply',
    impactDigest: impact.digest,
    rationale: 'Reviewed replacement; require new approvals.',
    reuseIntegrationIds: [],
  });
  expect(storage.amendments.superseded(ws, old.id, 1)).toBe(true);
  expect(
    storage.roadmaps.history(ws, roadmapId).some((d) => d.crossProject?.definitionId === old.id),
  ).toBe(true);
  expect(f.service.view(f.auth, ws, candidate).blockers.join(' ')).toMatch(/adopt/i);
  expect(storage.imports.adoptions(ws, id)).toHaveLength(0);
  expect(storage.runtimeEvidence.generations(ws, id, 1)).toHaveLength(0);
});

itNeedsCargo(
  'keeps live runs in their original context and retires idle attempts only after explicit amendment approval',
  {
    timeout: 15000,
  },
  async () => {
    const f = await supervisedMapFixture(true),
      { state } = f,
      ws = state.workspaceId,
      storage = state.context.storage,
      service = state.context.services.mapAmendmentService;
    f.service.save(f.auth, ws, {
      ...f.input,
      configuration: {
        ...f.input.configuration,
        defaults: { ...f.input.configuration.defaults, instructions: 'DEFER-TURNS' },
      },
    });
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    await waitFor(
      () =>
        storage.execution.cycles
          .listForWorkspace(ws)
          .some((c) => storage.execution.runs.find(ws, c.currentRunId)?.status === 'running'),
      'live cycle',
    );
    const cycle = storage.execution.cycles.listForWorkspace(ws)[0]!,
      run = storage.execution.runs.find(ws, cycle.currentRunId)!;
    const original = storage.imports.definition(ws, f.parentScope.definitionId)!,
      binding = storage.imports.bindings(ws, original.id)[0]!,
      id = randomUUID();
    storage.imports.addDefinition({
      ...original,
      id,
      revision: 'replacement-live',
      source: { ...original.source, revision: 'replacement-live' },
    });
    storage.imports.addBindings({ ...binding, definitionId: id });
    const proposed = await service.propose(f.auth, ws, roadmapId, {
      expectedVersion: storedRoadmap(state).version,
      candidate: {
        definitionId: id,
        bindingRevision: 1,
        targetId: 'LOCAL',
        selection: 'target-only',
      },
      summary: 'Explicit scope replacement after the current session.',
    });
    expect(proposed.pendingImpact!.blockers.join(' ')).toContain(run.id);
    expect(storage.execution.runs.find(ws, run.id)?.brief).toBe(run.brief);
    expect(storage.execution.cycles.find(ws, cycle.id)?.status).toBe('paused');
    const request = {
      amendmentId: proposed.history[0]!.id,
      outcome: 'apply' as const,
      impactDigest: proposed.pendingImpact!.digest,
      rationale: 'Retain original context as history.',
      reuseIntegrationIds: [],
    };
    await expect(service.decide(f.auth, ws, roadmapId, request)).rejects.toThrow(/Wait for/);
    const cancel = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/runs/${run.id}/cancel`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    await waitFor(
      () => storage.execution.runs.find(ws, run.id)?.status === 'cancelled',
      'cancel complete',
    );
    const current = service.view(f.auth, ws, roadmapId);
    expect(current.pendingImpact!.blockers).toEqual([]);
    await service.decide(f.auth, ws, roadmapId, {
      ...request,
      impactDigest: current.pendingImpact!.digest,
    });
    expect(storage.execution.worktrees.find(ws, cycle.worktreeId)?.status).toBe('active');
    expect(storage.amendments.retired(ws, cycle.worktreeId)).toBe(true);
    expect(storage.execution.cycles.find(ws, cycle.id)?.status).toBe('stopped');
    expect(storedRoadmap(state).attempts).toHaveLength(0);
    expect(
      service.view(f.auth, ws, roadmapId).history[0]?.decision?.previous.attempts[0]?.cycleId,
    ).toBe(cycle.id);
    await expect(
      state.context.services.workCycleService.control(
        f.auth,
        ws,
        cycle.id,
        'resume',
        storage.execution.cycles.find(ws, cycle.id)!.version,
      ),
    ).rejects.toThrow();
    const reopened = openDaemonStorage(state.context.config.databasePath);
    try {
      expect(reopened.amendments.retired(ws, cycle.worktreeId)).toBe(true);
      expect(reopened.amendments.list(ws)[0]?.decision?.outcome).toBe('applied');
    } finally {
      reopened.close();
    }
  },
);
itNeedsCargo(
  'reconciles stale reviews on the same binding while retaining integrated code and requiring independent acceptance again',
  {
    timeout: 25000,
  },
  async () => {
    const f = await supervisedMapFixture(),
      { state } = f,
      ws = state.workspaceId,
      storage = state.context.storage;
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    await waitFor(
      () => storage.planning.workItems.find(ws, state.workItemId)?.status === 'completed',
      'original acceptance',
      15000,
    );
    await roadmapControl(state, 'pause');
    const old = storedRoadmap(state),
      runtime = f.runtime.current!;
    await state.context.services.runtimeEvidenceService.configure(
      f.auth,
      ws,
      f.parentScope.definitionId,
      {
        bindingRevision: 1,
        expectedGeneration: runtime.generation,
        pins: [],
        consumers: runtime.consumers.map((c) => ({ ...c, upstreams: [...c.upstreams] })),
        environments: runtime.environments.map((e) => ({ ...e, fixtureDigest: 'f'.repeat(64) })),
      },
    );
    expect(f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted).toBe(false);
    const service = state.context.services.mapAmendmentService,
      proposed = await service.propose(f.auth, ws, roadmapId, {
        expectedVersion: storedRoadmap(state).version,
        candidate: {
          definitionId: f.parentScope.definitionId,
          bindingRevision: 1,
          targetId: 'LOCAL',
          selection: 'target-only',
        },
        summary: 'Fresh acceptance under revised dependency environment.',
      });
    expect(proposed.pendingImpact!.attempts.filter((a) => a.disposition === 'retain')).toHaveLength(
      2,
    );
    expect(proposed.pendingImpact!.attempts.filter((a) => a.disposition === 'retire')).toHaveLength(
      3,
    );
    await service.decide(f.auth, ws, roadmapId, {
      amendmentId: proposed.history[0]!.id,
      outcome: 'apply',
      impactDigest: proposed.pendingImpact!.digest,
      rationale: 'Require fresh independent verification; retain integration.',
      reuseIntegrationIds: [],
    });
    await roadmapControl(state, 'resume');
    await waitFor(
      () => f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted,
      'fresh parent acceptance',
      15000,
    );
    expect(
      storage.scopeReceipts
        .list(ws, state.workItemId)
        .filter((r) => r.scope.kind === 'parent-acceptance'),
    ).toHaveLength(2);
    expect(
      storedRoadmap(state).attempts.filter((a) => old.attempts.some((prior) => prior.id === a.id)),
    ).toHaveLength(2);
  },
);

itNeedsCargo(
  'queues affected completed scope reviews across restart and resumes them without repeating implementation',
  {
    timeout: 30000,
  },
  async () => {
    const f = await supervisedMapFixture();
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    const svc = state.context.services.runtimeEvidenceService,
      id = f.parentScope.definitionId;
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    await waitFor(
      () => f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted,
      'original parent acceptance',
      15000,
    );
    await roadmapControl(state, 'pause');
    const before = storedRoadmap(state),
      generation = f.runtime.current!;
    const sourceRuns = state.context.storage.execution.runs
      .listRecent(ws, 500)
      .filter((r) => r.role === 'implement')
      .map((r) => r.id);
    const receipts = tx.scopeReceipts.list(ws, state.workItemId);
    const identical = {
      bindingRevision: 1,
      expectedGeneration: 1,
      pins: [],
      consumers: [{ alias: 'local', upstreams: [] }],
      environments: [...generation.environments],
    };
    await svc.configure(f.auth, ws, id, identical);
    expect(f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted).toBe(true);
    expect(tx.scopeReceipts.list(ws, state.workItemId)).toEqual(receipts);
    expect(storedRoadmap(state).attempts.some((a) => a.dependencyRefresh)).toBe(false);
    await svc.configure(f.auth, ws, id, {
      ...identical,
      expectedGeneration: 2,
      environments: generation.environments.map((e) => ({ ...e, fixtureDigest: 'f'.repeat(64) })),
    });
    expect(f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted).toBe(false);
    expect(storedRoadmap(state).status).toBe('paused');
    expect(storedRoadmap(state).attempts.filter((a) => a.dependencyRefresh)).toHaveLength(3);
    // Resuming runs the queued reviews; until then that is the operator's step (R-A4).
    const refreshItems = () =>
      tx.attention.recent(ws, 100).filter((item) => item.code === 'dependency-refresh-resume');
    expect(refreshItems()).toMatchObject([{ state: 'open' }]);
    state.context.services.workCycleService.recoverInterrupted();
    state.context.services.roadmapService.recoverInterrupted();
    const reopened = openDaemonStorage(tx.databasePath);
    try {
      expect(
        reopened.roadmaps.find(ws, roadmapId)?.attempts.filter((a) => a.dependencyRefresh),
      ).toHaveLength(3);
    } finally {
      reopened.close();
    }
    await roadmapControl(state, 'resume');
    expect(refreshItems()).toMatchObject([{ state: 'resolved', resolvedBy: 'operator' }]);
    await waitFor(
      () => f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted,
      'refreshed parent acceptance',
      15000,
    );
    expect(storedRoadmap(state).attempts.map((a) => a.id)).toEqual(
      before.attempts.map((a) => a.id),
    );
    expect(storedRoadmap(state).attempts.some((a) => a.dependencyRefresh)).toBe(false);
    expect(
      tx.execution.runs
        .listRecent(ws, 500)
        .filter((r) => r.role === 'implement')
        .map((r) => r.id),
    ).toEqual(sourceRuns);
    expect(
      tx.scopeReceipts
        .list(ws, state.workItemId)
        .filter((r) => r.scope.kind === 'parent-acceptance'),
    ).toHaveLength(2);
  },
);

itNeedsCargo.each(['manual', 'roadmap'] as const)(
  'recovers an unstarted parent review through %s without losing its assignment',
  { timeout: 30000 },
  async (mode) => {
    const f = await supervisedMapFixture(false, 'automatic', false, false, true);
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    const runtime = state.context.services.runtimeEvidenceService;
    const original = runtime.prepare.bind(runtime);
    const fault = vi.spyOn(runtime, 'prepare').mockImplementation(async (...args) => {
      if (args[0].executionScope?.kind === 'parent-acceptance')
        throw new Error('Provider integration changed before launch.');
      return original(...args);
    });
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    const policy = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/scope-recovery`,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: storedRoadmap(state).version,
        enabled: true,
        maxRoundsPerParent: 3,
      },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    await roadmapControl(state, 'start');
    const parent = () =>
      tx.execution.cycles
        .listForWorkspace(ws)
        .find((c) => c.executionScope?.kind === 'parent-acceptance');
    await waitFor(
      () => parent()?.status === 'needs-attention',
      'unstarted parent preflight',
      15000,
    );
    await roadmapControl(state, 'pause');
    fault.mockRestore();
    const before = parent()!;
    expect(tx.execution.runs.find(ws, before.currentRunId)).toBeUndefined();
    expect(tx.runtimeEvidence.run(ws, before.currentRunId)).toBeUndefined();
    const implementations = tx.execution.runs
      .listRecent(ws, 500)
      .filter((r) => r.role === 'implement')
      .map((r) => r.id);
    if (mode === 'roadmap') {
      await runtime.configure(f.auth, ws, f.parentScope.definitionId, {
        bindingRevision: 1,
        expectedGeneration: 1,
        pins: [],
        consumers: [{ alias: 'local', upstreams: [] }],
        environments: [...f.runtime.current!.environments],
      });
      expect(
        storedRoadmap(state).attempts.find((a) => a.cycleId === before.id)?.dependencyRefresh,
      ).toBeTruthy();
      state.context.services.workCycleService.recoverInterrupted();
      state.context.services.roadmapService.recoverInterrupted();
      await roadmapControl(state, 'resume');
      await waitFor(
        () => f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted,
        'unstarted parent after refresh',
        15000,
      );
    } else {
      const response = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/cycles/${before.id}/control`,
        headers: mutationHeaders(state),
        payload: {
          action: 'resume',
          expectedVersion: before.version,
          instructions: 'Use refreshed controller evidence and retain all parent gates.',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      await waitFor(() => parent()?.status === 'awaiting-merge', 'first parent review');
    }
    expect(parent()?.worktreeId).toBe(before.worktreeId);
    expect(parent()?.profiles).toEqual(before.profiles);
    expect(parent()?.remediationRounds).toBe(0);
    expect(
      tx.execution.runs
        .listRecent(ws, 500)
        .filter((r) => r.role === 'implement')
        .map((r) => r.id),
    ).toEqual(implementations);
  },
);
