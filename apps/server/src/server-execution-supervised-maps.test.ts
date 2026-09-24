import { randomUUID } from 'node:crypto';
import { asPlanVersionId, asWorkItemId, DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { openCraftingTableStorage } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  cycleProfiles,
  finalizationCommand,
  finalizationCycle,
  git,
  mapCommand,
  merge,
  mutationHeaders,
  recordScope,
  reviewText,
  roadmapControl,
  roadmapId,
  roadmapInput,
  scopeReport,
  scopeTree,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

it('adopts exact map decisions separately, previews exclusions, guards HTTP authority and records inherited settings', async () => {
  const f = await supervisedMapFixture(true),
    ws = f.state.workspaceId;
  const preview = f.service.view(f.auth, ws, f.input.configuration);
  expect(preview.nodes.some((n) => n.sourceId === 'AQ-01.B' && !n.included)).toBe(true);
  expect(preview.nodes.some((n) => n.kind === 'work_item' && n.included)).toBe(false);
  expect(
    (
      await mapCommand(
        f,
        'adopt',
        { bindingRevision: 1, decisionIds: ['CS-D01'], rationale: 'Review' },
        { cookie: f.state.cookie },
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (await mapCommand(f, 'adopt', { bindingRevision: 1, decisionIds: [], rationale: 'Review' }))
      .statusCode,
  ).toBe(409);
  const { roadmapEntryInputSchema } = await import('@craftingtable/contracts');
  const disallowed = await f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/roadmaps/${roadmapId}`,
    headers: mutationHeaders(f.state),
    payload: {
      expectedVersion: 0,
      name: 'Cannot independently delegate acceptance',
      entries: [
        roadmapEntryInputSchema.parse({
          ...roadmapInput(f.state, [f.state.workItemId]).entries[0],
          executionScope: f.parentScope,
        }),
      ],
    },
  });
  expect(disallowed.statusCode, disallowed.body).toBe(409);
  expect(disallowed.body).toContain('parent acceptance reviews');
  const saved = f.service.save(f.auth, ws, {
    ...f.input,
    configuration: {
      ...f.input.configuration,
      overrides: [
        {
          level: 'project',
          key: 'local',
          settings: { ...f.input.configuration.defaults, instructions: 'Project defaults' },
        },
        {
          level: 'activity',
          key: 'verification',
          settings: { ...f.input.configuration.defaults, instructions: 'Independent verification' },
        },
        {
          level: 'individual',
          key: 'development:AQ-01.A',
          settings: { ...f.input.configuration.defaults, instructions: 'Specific slice' },
        },
      ],
    },
  });
  expect(saved.roadmap.definition.entries.map((e) => e.instructions)).toEqual([
    'Specific slice',
    'Independent verification',
  ]);
  expect(
    (
      await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/control`,
        headers: mutationHeaders(f.state),
        payload: { action: 'start', expectedVersion: storedRoadmap(f.state).version },
      })
    ).statusCode,
  ).toBe(409);
  await adoptSupervisedMap(f);
  const after = f.service.view(f.auth, ws, f.input.configuration);
  expect(after.decisions.every((d) => d.adopted)).toBe(true);
  expect(
    after.nodes.find((n) => n.kind === 'slice' && n.state === 'verified')?.reviewerRoles,
  ).toEqual(['repository-maintainer', 'independent-security-reviewer-if-required-by-source']);
  expect(
    after.nodes.find((n) => n.kind === 'checkpoint' && n.sourceId === 'LOCAL-TARGET')
      ?.reviewerRoles,
  ).toEqual(['repository-maintainer', 'independent-security-reviewer-if-required-by-source']);

  expect(after.targetReached).toBe(false);
  expect(
    (
      await mapCommand(f, 'adopt', {
        bindingRevision: 2,
        decisionIds: ['CS-D01'],
        rationale: 'Old binding',
      })
    ).statusCode,
  ).toBe(409);
  expect(f.backend.launches).toHaveLength(0);
  expect(f.state.context.storage.scopeReceipts.list(ws, f.state.workItemId)).toHaveLength(0);
  const reopened = openCraftingTableStorage(f.state.context.config.databasePath);
  try {
    expect(reopened.imports.adoptions(ws, f.parentScope.definitionId)).toHaveLength(1);
  } finally {
    reopened.close();
  }
  expect(
    (
      await mapCommand(f, 'preview', {
        ...f.input.configuration,
        defaults: undefined,
        overrides: undefined,
        parentAcceptance: undefined,
        targetId: 'invented',
      })
    ).statusCode,
  ).toBe(409);
});
it('supervises slices, fresh verification and independent parent acceptance without completing an unproven target', {
  timeout: 20000,
}, async () => {
  const f = await supervisedMapFixture(),
    { state } = f,
    ws = state.workspaceId;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  const notifications = state.context.services.notificationService;
  const { DEFAULT_NOTIFICATION_PREFERENCES } = await import('@craftingtable/domain');
  notifications.save(f.auth, ws, {
    expectedVersion: 0,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
    applicationToken: 'a'.repeat(30),
    userKey: 'u'.repeat(30),
  });
  await notifications.tick();
  expect(
    state.context.storage.notifications
      .records(ws)
      .some((n) => n.sourceKey.endsWith(':checkpoints')),
  ).toBe(false);
  expect((await roadmapControl(state, 'start')).statusCode).toBe(200);
  await waitFor(
    () => {
      const r = storedRoadmap(state),
        bad = Object.values(r.entryHolds ?? {}).find((h) => h.status === 'needs-attention');
      if (bad) throw new Error(bad.reason);
      const cycle = state.context.storage.execution.cycles
        .listForWorkspace(ws)
        .find((c) => c.status === 'needs-attention');
      if (cycle) throw new Error(cycle.reason);
      return (
        state.context.storage.planning.workItems.find(ws, state.workItemId)?.status === 'completed'
      );
    },
    'parent independently accepted',
    15000,
  );
  const scopes = state.context.storage.scopeReceipts.list(ws, state.workItemId);
  expect(scopes.filter((s) => s.scope.kind === 'slice')).toHaveLength(2);
  expect(scopes.filter((s) => s.scope.kind === 'parent-acceptance')).toHaveLength(1);
  expect(scopes.every((s) => s.reviewerRoles?.includes('repository-maintainer'))).toBe(true);
  expect(storedRoadmap(state).status).toBe('running');
  expect(f.service.view(f.auth, ws, f.input.configuration).targetReached).toBe(false);
  expect(f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted).toBe(true);
  await notifications.tick();
  const alert = state.context.storage.notifications
    .records(ws)
    .find((n) => n.sourceKey.endsWith(':checkpoints'))!;
  expect(alert.message).toContain('LOCAL-TARGET');
  const delivered = alert.deliveredCount;
  await notifications.tick();
  expect(
    state.context.storage.notifications.records(ws).find((n) => n.id === alert.id)?.deliveredCount,
  ).toBe(delivered);
  await roadmapControl(state, 'pause');
  const before = storedRoadmap(state);
  const changed = f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: before.version,
    configuration: {
      ...f.input.configuration,
      defaults: { ...f.input.configuration.defaults, instructions: 'Future queued guidance' },
    },
  });
  expect(
    changed.roadmap.definition.entries.every((e) => e.instructions === 'Preserve exact scope.'),
  ).toBe(true);
  await roadmapControl(state, 'resume');
  const evidence = state.context.services.runtimeEvidenceService;
  const spec = (await evidence.view(f.auth, ws, f.parentScope.definitionId)).subjects.find(
    (s) => s.subject.sourceId === 'LOCAL-TARGET',
  )!;
  const submitted = await evidence.submit(f.auth, ws, f.parentScope.definitionId, {
    runtimeId: f.runtime.current!.id,
    subject: spec.subject,
    subjectCommit: git(['rev-parse', 'revision'], f.root).trim(),
    environmentId: 'local-tests',
    executedBy: 'author',
    executedAt: new Date().toISOString(),
    reviewers: [
      { identity: 'independent-reviewer', roles: spec.reviewerRoles, artifact: 'review' },
    ],
    requirements: spec.requirements.map((requirement) => ({ requirement, artifact: 'review' })),
    cases: [],
    artifacts: [
      { name: 'review', content: 'Independently inspected the target and all required receipts.' },
    ],
  });
  await evidence.decide(f.auth, ws, f.parentScope.definitionId, {
    submissionId: submitted.submissions[0]!.submission.id,
    outcome: 'accepted',
    rationale: 'Independent target review accepted.',
  });
  await waitFor(() => storedRoadmap(state).status === 'completed', 'selected scope completion');
  const view = f.service.view(f.auth, ws, f.input.configuration);
  expect(view.selectedScopeComplete).toBe(true);
  expect(view.finalized).toBe(false);
  const attempts = storedRoadmap(state).attempts;
  expect(attempts).toHaveLength(5);
  for (const a of attempts) {
    const c = state.context.storage.execution.cycles.find(ws, a.cycleId)!;
    if (c.executionScope?.kind !== 'slice') expect(c.step).toBe('review');
  }
});
it('keeps parent approval manual and preserves attempts across restart without relaunch', {
  timeout: 20000,
}, async () => {
  const f = await supervisedMapFixture(false, 'manual'),
    { state } = f,
    ws = state.workspaceId;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .listForWorkspace(ws)
        .some(
          (c) => c.executionScope?.kind === 'parent-acceptance' && c.status === 'awaiting-merge',
        ),
    'parent approval',
    15000,
  );
  expect(state.context.storage.planning.workItems.find(ws, state.workItemId)?.status).toBe(
    'admitted',
  );
  const count = f.backend.launches.length;
  state.context.services.roadmapService.recoverInterrupted();
  await state.context.services.roadmapService.tick();
  expect(f.backend.launches).toHaveLength(count);
  expect(storedRoadmap(state).status).toBe('needs-attention');
  const tree = state.context.storage.execution.worktrees
    .listForWorkItem(ws, state.workItemId)
    .find((t) => t.executionScope?.kind === 'parent-acceptance')!;
  expect((await recordScope(f, tree)).statusCode).toBe(200);
  expect(state.context.storage.planning.workItems.find(ws, state.workItemId)?.status).toBe(
    'completed',
  );
});
it('pauses a verification question without authorizing implementation in the review snapshot', {
  timeout: 15000,
}, async () => {
  const f = await supervisedMapFixture(true),
    { state } = f,
    ws = state.workspaceId,
    normal = f.backend.replyForRequest;
  f.backend.replyForRequest = (request) => {
    const tree = state.context.storage.execution.worktrees
      .listForWorkItem(ws, state.workItemId)
      .find((t) => t.path === request.cwd);
    return tree?.executionScope?.kind === 'slice-verification'
      ? {
          resultText:
            '## Open questions\nWhich compatibility choice should apply?\n## Review report\n' +
            scopeReport(state, tree.executionScope),
        }
      : normal!(request);
  };
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .listForWorkspace(ws)
        .some(
          (c) => c.executionScope?.kind === 'slice-verification' && c.status === 'needs-attention',
        ),
    'verification question',
    10000,
  );
  expect(state.context.storage.scopeReceipts.list(ws, state.workItemId)).toHaveLength(0);
  expect(
    f.backend.launches
      .filter((r) =>
        state.context.storage.execution.worktrees
          .listForWorkItem(ws, state.workItemId)
          .some((t) => t.path === r.cwd && t.executionScope?.kind === 'slice-verification'),
      )
      .every((r) => r.model === 'review-model'),
  ).toBe(true);
});

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

it('keeps live runs in their original context and retires idle attempts only after explicit amendment approval', {
  timeout: 15000,
}, async () => {
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
  const reopened = openCraftingTableStorage(state.context.config.databasePath);
  try {
    expect(reopened.amendments.retired(ws, cycle.worktreeId)).toBe(true);
    expect(reopened.amendments.list(ws)[0]?.decision?.outcome).toBe('applied');
  } finally {
    reopened.close();
  }
});
it('reconciles stale reviews on the same binding while retaining integrated code and requiring independent acceptance again', {
  timeout: 25000,
}, async () => {
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
});

it('queues affected completed scope reviews across restart and resumes them without repeating implementation', {
  timeout: 30000,
}, async () => {
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
  state.context.services.workCycleService.recoverInterrupted();
  state.context.services.roadmapService.recoverInterrupted();
  const reopened = openCraftingTableStorage(tx.databasePath);
  try {
    expect(
      reopened.roadmaps.find(ws, roadmapId)?.attempts.filter((a) => a.dependencyRefresh),
    ).toHaveLength(3);
  } finally {
    reopened.close();
  }
  await roadmapControl(state, 'resume');
  await waitFor(
    () => f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted,
    'refreshed parent acceptance',
    15000,
  );
  expect(storedRoadmap(state).attempts.map((a) => a.id)).toEqual(before.attempts.map((a) => a.id));
  expect(storedRoadmap(state).attempts.some((a) => a.dependencyRefresh)).toBe(false);
  expect(
    tx.execution.runs
      .listRecent(ws, 500)
      .filter((r) => r.role === 'implement')
      .map((r) => r.id),
  ).toEqual(sourceRuns);
  expect(
    tx.scopeReceipts.list(ws, state.workItemId).filter((r) => r.scope.kind === 'parent-acceptance'),
  ).toHaveLength(2);
});

it.each(['manual', 'roadmap'] as const)(
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

it('refreshes a positive review awaiting manual parent acceptance without granting acceptance', {
  timeout: 30000,
}, async () => {
  const f = await supervisedMapFixture(false, 'manual');
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  const parent = () =>
    tx.execution.cycles
      .listForWorkspace(ws)
      .find((c) => c.executionScope?.kind === 'parent-acceptance');
  await waitFor(() => parent()?.status === 'awaiting-merge', 'manual parent review', 15000);
  await roadmapControl(state, 'pause');
  const old = parent()!,
    runtime = f.runtime.current!;
  await state.context.services.runtimeEvidenceService.configure(
    f.auth,
    ws,
    f.parentScope.definitionId,
    {
      bindingRevision: 1,
      expectedGeneration: 1,
      pins: [],
      consumers: [{ alias: 'local', upstreams: [] }],
      environments: runtime.environments.map((e) => ({ ...e, fixtureDigest: 'f'.repeat(64) })),
    },
  );
  expect(
    storedRoadmap(state).attempts.find((a) => a.cycleId === old.id)?.dependencyRefresh,
  ).toBeDefined();
  await roadmapControl(state, 'resume');
  await waitFor(
    () => parent()?.currentRunId !== old.currentRunId && parent()?.status === 'awaiting-merge',
    'fresh manual parent review',
    15000,
  );
  expect(parent()?.id).toBe(old.id);
  expect(tx.runtimeEvidence.run(ws, parent()!.currentRunId)?.runtimeId).toBe(
    tx.runtimeEvidence.generations(ws, f.parentScope.definitionId, 1)[0]?.id,
  );
  expect(f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted).toBe(false);
  expect(
    tx.scopeReceipts.list(ws, state.workItemId).filter((r) => r.scope.kind === 'parent-acceptance'),
  ).toHaveLength(0);
});

it('coordinates full-plan finalization with frozen map and runtime context and retains exact operator promotion', {
  timeout: 25000,
}, async () => {
  const f = await supervisedMapFixture(false, 'automatic', true),
    { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage,
    service = state.context.services.mapAmendmentService;
  const input = {
    ...f.input,
    configuration: { ...f.input.configuration, selection: 'prioritize-full' as const },
  };
  f.service.save(f.auth, ws, input);
  await adoptSupervisedMap(f);
  const settings = storage.execution.branchSettings.find(ws, asPlanVersionId('version-1'))!;
  const finalInput = {
    expectedBranchVersion: settings.version,
    targetBranch: 'main',
    rounds: [],
    finalReview: cycleProfiles.review,
    policy: DEFAULT_COMPLETION_POLICY,
    instructions: 'Final independent plan conformance.',
  };
  await expect(
    state.context.services.finalizationService.start(
      f.auth,
      ws,
      asPlanVersionId('version-1'),
      finalInput,
    ),
  ).rejects.toThrow(/original plan work item/);
  await roadmapControl(state, 'start');
  await waitFor(
    () => storage.planning.workItems.find(ws, f.second)?.status === 'completed',
    'complete original plan',
    15000,
  );
  await roadmapControl(state, 'pause');
  expect(service.finalization(f.auth, ws, roadmapId).projects[0]?.status).toBe('ready');
  f.backend.onLaunch = undefined;
  f.backend.replyForRequest = () => ({
    resultText: `## Open questions
none
## Review report
${reviewText([])}`,
  });
  const before = git(['rev-parse', 'main'], f.root),
    started = await state.context.services.finalizationService.start(
      f.auth,
      ws,
      asPlanVersionId('version-1'),
      finalInput,
    ),
    value = started.finalization;
  expect(value.mapContext?.runtimeId).toBe(f.runtime.current!.id);
  await waitFor(
    () => {
      const c = finalizationCycle(state, value);
      if (c.status === 'needs-attention') throw new Error(c.reason);
      return c.status === 'awaiting-merge';
    },
    'pinned final review',
    8000,
  );
  const cycle = finalizationCycle(state, value),
    run = storage.execution.runs.find(ws, cycle.currentRunId)!;
  expect(storage.runtimeEvidence.run(ws, run.id)?.runtimeId).toBe(f.runtime.current!.id);
  expect(git(['rev-parse', 'main'], f.root)).toBe(before);
  expect((await merge(state, value.worktreeId)).statusCode).toBe(409);
  const proposed = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: storedRoadmap(state).version,
    candidate: {
      definitionId: f.parentScope.definitionId,
      bindingRevision: 1,
      targetId: 'LOCAL',
      selection: 'prioritize-full',
    },
    summary: 'Scope changes must wait for finalization.',
  });
  expect(proposed.pendingImpact?.blockers.join(' ')).toContain('finalization');
  expect(
    (
      await finalizationCommand(state, value, 'merge', {
        expectedHeadSha: run.reviewBranchContext!.headSha,
        expectedTargetSha: run.reviewBranchContext!.targetSha,
      })
    ).statusCode,
  ).toBe(409);
  const current = service.view(f.auth, ws, roadmapId);
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: current.history[0]!.id,
    outcome: 'reject',
    impactDigest: current.pendingImpact!.digest,
    rationale: 'Keep current finalization context.',
    reuseIntegrationIds: [],
  });
  const promoted = await finalizationCommand(state, value, 'merge', {
    expectedHeadSha: run.reviewBranchContext!.headSha,
    expectedTargetSha: run.reviewBranchContext!.targetSha,
  });
  expect(promoted.statusCode, promoted.body).toBe(200);
  expect(service.finalization(f.auth, ws, roadmapId).projects[0]?.status).toBe('promoted');
  const { providerBranch } = await import('./services/map-finalization-policy.js');
  expect(
    providerBranch(storage, ws, {
      planVersionId: value.planVersionId,
      integrationBranch: 'revision',
    }),
  ).toBe('main');
  expect(f.service.view(f.auth, ws, input.configuration).published).toBe(false);
});
it('explicitly reuses unchanged integration code across definitions without transferring verification', {
  timeout: 20000,
}, async () => {
  const f = await supervisedMapFixture(true),
    { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage,
    service = state.context.services.mapAmendmentService;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      storage.scopeReceipts.list(ws, state.workItemId).some((r) => r.scope.sourceId === 'AQ-01.A'),
    'slice independently verified',
    10000,
  );
  await roadmapControl(state, 'pause');
  const old = storage.imports.definition(ws, f.parentScope.definitionId)!,
    binding = storage.imports.bindings(ws, old.id)[0]!,
    id = randomUUID();
  storage.imports.addDefinition({
    ...old,
    id,
    revision: 'reuse',
    source: { ...old.source, revision: 'reuse' },
  });
  storage.imports.addBindings({ ...binding, definitionId: id });
  const candidate = {
    definitionId: id,
    bindingRevision: 1,
    targetId: 'LOCAL',
    selection: 'target-only' as const,
  };
  const proposed = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: storedRoadmap(state).version,
    candidate,
    summary: 'Reuse reviewed unchanged code; review evidence again.',
  });
  const impact = proposed.pendingImpact!;
  expect(impact.integrations).toHaveLength(1);
  expect(impact.integrations[0]?.eligible).toBe(true);
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: proposed.history[0]!.id,
    outcome: 'apply',
    impactDigest: impact.digest,
    rationale: 'Ancestry checked; no approval migration.',
    reuseIntegrationIds: ['AQ-01.A'],
  });
  const view = f.service.view(f.auth, ws, candidate);
  expect(view.nodes.find((n) => n.sourceId === 'AQ-01.A' && n.state === 'merged')?.satisfied).toBe(
    true,
  );
  expect(
    view.nodes.find((n) => n.sourceId === 'AQ-01.A' && n.state === 'verified')?.satisfied,
  ).toBe(false);
  expect(
    storage.scopeReceipts.list(ws, state.workItemId).every((r) => r.scope.definitionId !== id),
  ).toBe(true);
  await state.context.services.runtimeEvidenceService.configure(f.auth, ws, id, {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [],
    consumers: f.runtime.current!.consumers.map((c) => ({ ...c, upstreams: [...c.upstreams] })),
    environments: [...f.runtime.current!.environments],
  });
  state.context.services.crossProjectService.adopt(f.auth, ws, id, {
    bindingRevision: 1,
    decisionIds: ['CS-D01'],
    rationale: 'Explicit replacement adoption.',
  });
  const verification = await scopeTree(f, {
    ...f.scopes[0]!,
    definitionId: id,
    kind: 'slice-verification',
  });
  expect(verification.executionScope?.definitionId).toBe(id);
});

it('activates only the reviewed replacement plan while preserving admitted history in the old version', async () => {
  const f = await supervisedMapFixture(true),
    { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage,
    service = state.context.services.mapAmendmentService;
  const saved = f.service.save(f.auth, ws, f.input),
    old = storage.imports.definition(ws, f.parentScope.definitionId)!,
    binding = storage.imports.bindings(ws, old.id)[0]!,
    original = storage.planning.versions.find(ws, asPlanVersionId('version-1'))!,
    item = storage.planning.workItems.find(ws, state.workItemId)!;
  const revised = storage.planning.versions.insert({
      ...original,
      id: asPlanVersionId('version-2'),
      versionNumber: 2,
      contentDigest: '9'.repeat(64),
    }),
    nextItem = asWorkItemId('revised-item');
  storage.planning.workItems.insertMany([{ ...item, id: nextItem, planVersionId: revised.id }]);
  const settings = storage.execution.branchSettings.find(ws, original.id)!;
  storage.execution.branchSettings.save({ ...settings, planVersionId: revised.id, version: 1 }, 0);
  const id = randomUUID();
  storage.imports.addDefinition({
    ...old,
    id,
    revision: 'revised-plan',
    source: { ...old.source, revision: 'revised-plan' },
  });
  storage.imports.addBindings({
    ...binding,
    definitionId: id,
    bindings: binding.bindings.map((b) => ({
      ...b,
      planVersionId: revised.id,
      branchSettingsVersion: 1,
      workItems: b.workItems.map((w) => ({ ...w, workItemId: nextItem })),
    })),
  });
  const proposed = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: saved.roadmap.version,
    candidate: {
      definitionId: id,
      bindingRevision: 1,
      targetId: 'LOCAL',
      selection: 'target-only',
    },
    summary: 'Review revised plan before activation.',
  });
  expect(proposed.pendingImpact!.bindings[0]?.activate).toBe(true);
  expect(proposed.pendingImpact!.blockers).toEqual([]);
  expect(storage.planning.projects.find(ws, item.projectId)?.activePlanVersionId).toBe(original.id);
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: proposed.history[0]!.id,
    outcome: 'apply',
    impactDigest: proposed.pendingImpact!.digest,
    rationale: 'Activate this exact revised plan and preserve history.',
    reuseIntegrationIds: [],
  });
  expect(storage.planning.projects.find(ws, item.projectId)?.activePlanVersionId).toBe(revised.id);
  expect(storage.planning.workItems.find(ws, item.id)?.status).toBe('admitted');
  expect(storage.planning.workItems.find(ws, nextItem)?.status).toBe('proposed');
  expect(
    storedRoadmap(state).definition.entries.every(
      (e) => e.planVersionId === revised.id && e.workItemId === nextItem,
    ),
  ).toBe(true);
});
