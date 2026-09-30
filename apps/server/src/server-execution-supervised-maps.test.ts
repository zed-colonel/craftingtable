import { randomUUID } from 'node:crypto';
import { asPlanVersionId, asWorkItemId, DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { openDaemonStorage } from './persisted-records.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  cycleProfiles,
  finalizationCommand,
  finalizationCycle,
  finalizationReply,
  git,
  implementsFinalization,
  itNeedsCargo,
  mapCommand,
  merge,
  mutationHeaders,
  recordScope,
  roadmapControl,
  roadmapId,
  roadmapInput,
  runLauncher,
  scopeReport,
  scopeTree,
  stagedInput,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

it('adopts exact map decisions separately, previews exclusions, guards HTTP authority and records inherited settings', async () => {
  const f = await supervisedMapFixture(true),
    ws = f.state.workspaceId;
  const preview = f.service.view(f.auth, ws, f.input.configuration);
  expect(preview.nodes.some((n) => n.sourceId === 'local/AQ-01/b' && !n.included)).toBe(true);
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
          key: 'development:local/AQ-01/a',
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
  const reopened = openDaemonStorage(f.state.context.config.databasePath);
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
itNeedsCargo(
  'supervises slices, fresh verification and independent parent acceptance without completing an unproven target',
  {
    timeout: 20000,
  },
  async () => {
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
    // Checkpoints ready for evidence are derived by the scheduler's pass (R-A4).
    const checkpointItems = () =>
      state.context.storage.attention
        .recent(ws, 100)
        .filter((n) => n.subjectKey.includes(':checkpoint:'));
    state.context.services.roadmapService.syncAttention(true);
    await notifications.tick();
    expect(checkpointItems()).toHaveLength(0);
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
          state.context.storage.planning.workItems.find(ws, state.workItemId)?.status ===
          'completed'
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
    state.context.services.roadmapService.syncAttention(true);
    await notifications.tick();
    // One item per checkpoint ready for acceptance, counting the milestones it blocks (R-A5).
    const alert = checkpointItems().find(
      (n) => n.state === 'open' && n.subjectKey.endsWith(':checkpoint:LOCAL-TARGET'),
    )!;
    expect(alert.title).toContain('LOCAL-TARGET');
    const delivered = alert.delivery.deliveredCount;
    state.context.services.roadmapService.syncAttention(true);
    await notifications.tick();
    expect(state.context.storage.attention.find(ws, alert.id)?.delivery.deliveredCount).toBe(
      delivered,
    );
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
        {
          name: 'review',
          content: 'Independently inspected the target and all required receipts.',
        },
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
  },
);
itNeedsCargo(
  'keeps parent approval manual and preserves attempts across restart without relaunch',
  {
    timeout: 20000,
  },
  async () => {
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
  },
);
itNeedsCargo(
  'pauses a verification question without authorizing implementation in the review snapshot',
  {
    timeout: 15000,
  },
  async () => {
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
            (c) =>
              c.executionScope?.kind === 'slice-verification' && c.status === 'needs-attention',
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
  },
);

itNeedsCargo(
  'refreshes a positive review awaiting manual parent acceptance without granting acceptance',
  {
    timeout: 30000,
  },
  async () => {
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
      tx.scopeReceipts
        .list(ws, state.workItemId)
        .filter((r) => r.scope.kind === 'parent-acceptance'),
    ).toHaveLength(0);
  },
);

itNeedsCargo(
  'coordinates full-plan finalization with frozen map and runtime context and retains exact operator promotion',
  {
    timeout: 40000,
  },
  async () => {
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
    const finalInput = stagedInput({
      expectedBranchVersion: settings.version,
      targetBranch: 'main',
      rounds: [],
      finalReview: cycleProfiles.review,
      policy: DEFAULT_COMPLETION_POLICY,
      instructions: 'Final independent plan conformance.',
    });
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
      // Eight cycles since the valid map gave local/AQ-02 its own slice (R-F3), up from five.
      24000,
    );
    await roadmapControl(state, 'pause');
    expect(service.finalization(f.auth, ws, roadmapId).projects[0]?.status).toBe('ready');
    f.backend.onLaunch = undefined;
    f.backend.replyForRequest = async (request) => {
      if (request.buildEnvironment && !implementsFinalization(request))
        await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
      return finalizationReply(request);
    };
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
    // Finalization is held to the repository's adopted checks too (operator decision 2026-09-30).
    expect(storage.runtimeEvidence.run(ws, run.id)?.checkDeclarationId).toBeDefined();
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
  },
);
itNeedsCargo(
  'explicitly reuses unchanged integration code across definitions without transferring verification',
  {
    timeout: 20000,
  },
  async () => {
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
        storage.scopeReceipts
          .list(ws, state.workItemId)
          .some((r) => r.scope.sourceId === 'local/AQ-01/a'),
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
      reuseIntegrationIds: ['local/AQ-01/a'],
    });
    const view = f.service.view(f.auth, ws, candidate);
    expect(
      view.nodes.find((n) => n.sourceId === 'local/AQ-01/a' && n.state === 'merged')?.satisfied,
    ).toBe(true);
    expect(
      view.nodes.find((n) => n.sourceId === 'local/AQ-01/a' && n.state === 'verified')?.satisfied,
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
  },
);

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
