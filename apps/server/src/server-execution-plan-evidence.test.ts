import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evidenceSubmissionRequestSchema,
  registerSourceRepositoryResponseSchema,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import { asAgentRunId, asPlanVersionId, DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { openDaemonStorage } from './persisted-records.js';
import { resolveScope, scopeEvidenceLedger } from './services/execution-scope.js';
import { operatorDecisions } from './services/operator-decisions.js';
import { acceptedEvidence } from './services/runtime-evidence-policy.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  branchCommand,
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  designDone,
  fixtureRepository,
  git,
  implementationDone,
  itNeedsCargo,
  merge,
  mutationHeaders,
  ready,
  registerAndWorktree,
  reviewScope,
  roadmapInput,
  runToFinish,
  saveRoadmapRequest,
  scopeReport,
  scopeTree,
  slicedFixture,
  startCycle,
  storedRoadmap,
  structuredFinding,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

itNeedsCargo(
  'discovers reviewable local setup without saving, preserves exact pins, and rejects stale or altered captures',
  async () => {
    const f = await slicedFixture((source) => ({
      ...source,
      repositories: [
        { ...source.repositories[0]!, id: 'local' },
        {
          ...source.repositories[0]!,
          id: 'provider',
          role: 'implemented_upstream',
          target_branch: null,
          merge_lock: null,
        },
      ],
      work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
      aq_baseline_binding: { ...source.aq_baseline_binding!, repository: 'provider' },
    }));
    const provider = fixtureRepository();
    writeFileSync(
      join(provider, 'Cargo.toml'),
      '[package]\nname="discovery_provider"\nversion="0.2.0"\nedition="2021"\n',
    );
    git(['add', '.'], provider);
    git(['commit', '-m', 'provider'], provider);
    const registered = await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/repositories`,
      headers: mutationHeaders(f.state),
      payload: { rootPath: provider, displayName: 'Discovery fixture' },
    });
    const repository = registerSourceRepositoryResponseSchema.parse(registered.json()).repository;
    const { workspaceId: ws, context } = f.state,
      storage = context.storage;
    const definitionId = f.parentScope.definitionId;
    const binding = storage.imports.bindings(ws, definitionId)[0]!;
    storage.imports.addBindings({
      ...binding,
      revision: 2,
      bindings: [
        ...binding.bindings,
        {
          alias: 'provider',
          repositoryId: repository.id,
          sourceArtifacts: [],
          workItems: [],
        },
      ],
    });
    const base = `/api/workspaces/${ws}/concurrency-definitions/${definitionId}/runtime`;
    const payload = { bindingRevision: 2, refs: [] };
    const forbidden = await context.app.inject({
      method: 'POST',
      url: `${base}/discover`,
      headers: { cookie: f.state.cookie },
      payload,
    });
    expect(forbidden.statusCode).toBe(403);
    const response = await context.app.inject({
      method: 'POST',
      url: `${base}/discover`,
      headers: mutationHeaders(f.state),
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { discoverRuntimeResponseSchema } = await import('@craftingtable/contracts');
    const { configuration } = discoverRuntimeResponseSchema.parse(response.json());
    expect(configuration.pins[0]).toMatchObject({
      alias: 'provider',
      ref: 'main',
      expectedCommitSha: git(['rev-parse', 'HEAD'], provider).trim(),
      conformanceRevision: '16',
    });
    expect(configuration.consumers).toEqual([{ alias: 'local', upstreams: ['provider'] }]);
    const env = configuration.environments[0]!;
    expect(env.kind).toBe('local-development');
    expect(env.discovery?.toolchains).toContain('rustc');
    expect(storage.runtimeEvidence.generations(ws, definitionId, 2)).toHaveLength(0);
    const svc = context.services.runtimeEvidenceService;
    await expect(
      svc.configure(f.auth, ws, definitionId, {
        ...configuration,
        environments: [{ ...env, identityDigest: 'a'.repeat(64) }],
      }),
    ).rejects.toThrow('must match');
    await expect(
      svc.configure(f.auth, ws, definitionId, {
        ...configuration,
        environments: [{ ...env, kind: 'external-kata' }],
      }),
    ).rejects.toThrow('cannot qualify external');
    const saved = await svc.configure(f.auth, ws, definitionId, configuration);
    expect(saved.current?.environments[0]?.discovery).toEqual(env.discovery);
    await expect(svc.configure(f.auth, ws, definitionId, configuration)).rejects.toThrow(
      'Runtime or plan binding changed',
    );
    const draft = await svc.discover(f.auth, ws, definitionId, payload);
    git(['commit', '--allow-empty', '-m', 'Upstream moved after discovery'], provider);
    await expect(svc.configure(f.auth, ws, definitionId, draft.configuration)).rejects.toThrow(
      'advanced before saving',
    );
    storage.imports.addBindings({ ...storage.imports.bindings(ws, definitionId)[0]!, revision: 3 });
    await expect(svc.discover(f.auth, ws, definitionId, payload)).rejects.toThrow(
      'binding changed',
    );
    expect(storage.imports.adoptions(ws, definitionId)).toHaveLength(0);
  },
);

it('generates saved plan facts without approval, guards HTTP authority and starts only after explicit plan review', async () => {
  const f = await supervisedMapFixture(false, 'automatic', false, true);
  const { context, workspaceId: ws } = f.state;
  const svc = context.services.runtimeEvidenceService;
  const id = f.parentScope.definitionId;
  const base = `/api/workspaces/${ws}/concurrency-definitions/${id}/runtime`;
  await adoptSupervisedMap(f);
  expect((await svc.view(f.auth, ws, id)).planAcceptance?.roadmaps).toHaveLength(0);
  const saved = f.service.save(f.auth, ws, f.input).roadmap;
  const ready = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  expect(ready.state).toBe('ready-to-generate');
  expect(
    f.service
      .view(f.auth, ws, f.input.configuration)
      .setupRequirements.some((r) => r.kind === 'plan-acceptance'),
  ).toBe(true);
  await expect(
    context.services.roadmapService.control(f.auth, ws, saved.id, 'start', saved.version),
  ).rejects.toThrow('Waiting for plan acceptance');
  const payload = {
    roadmapId: saved.id,
    definitionRevision: ready.definitionRevision,
    snapshotDigest: ready.snapshotDigest,
  };
  const post = (headers = mutationHeaders(f.state), body = payload) =>
    context.app.inject({ method: 'POST', url: `${base}/generate-plan`, headers, payload: body });
  expect((await post({ cookie: f.state.cookie })).statusCode).toBe(403);
  expect(
    (await post(mutationHeaders(f.state), { ...payload, snapshotDigest: '0'.repeat(64) }))
      .statusCode,
  ).toBe(409);
  const response = await post();
  expect(response.statusCode, response.body).toBe(200);
  const generated = response.json();
  const evidence = generated.submissions[0].submission;
  expect(evidence.generatedPlan.roadmapId).toBe(saved.id);
  expect(evidence.reviewers).toEqual([]);
  expect(generated.planAcceptance.roadmaps[0].state).toBe('awaiting-review');
  expect(generated.submissions[0].issues).toEqual([]);
  expect(context.storage.runtimeEvidence.decisions(ws)).toHaveLength(0);
  expect(context.storage.roadmaps.find(ws, saved.id)?.attempts).toHaveLength(0);
  expect(evidence.artifacts.map((a: { name: string }) => a.name)).toEqual(
    expect.arrayContaining(['map', 'binding', 'adoption', 'runtime', 'roadmap', 'resources']),
  );
  expect((await post()).statusCode).toBe(200);
  expect(context.storage.runtimeEvidence.submissions(ws, id)).toHaveLength(1);
  const manualPackage = {
    runtimeId: evidence.runtimeId,
    subject: evidence.subject,
    environmentId: evidence.environmentId,
    executedBy: evidence.executedBy,
    executedAt: evidence.executedAt,
    reviewers: [
      {
        identity: 'Independent fixture reviewer',
        roles: ['stack-integration-owner'],
        artifact: 'plan-review-guide',
      },
    ],
    requirements: evidence.requirements,
    cases: evidence.cases,
    artifacts: evidence.artifacts.map((a: { name: string; content: string }) => ({
      name: a.name,
      content: a.content,
    })),
  };
  expect(evidenceSubmissionRequestSchema.safeParse(manualPackage).success).toBe(true);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `${base}/submit`,
        headers: mutationHeaders(f.state),
        payload: { ...manualPackage, generatedPlan: evidence.generatedPlan },
      })
    ).statusCode,
  ).toBe(400);
  const accepted = await svc.decide(f.auth, ws, id, {
    submissionId: evidence.id,
    outcome: 'accepted',
    rationale:
      'I reviewed the exact saved plan and configured independent review responsibilities as stack-integration-owner.',
  });
  expect(accepted.planAcceptance!.roadmaps[0]!.state).toBe('accepted');
  expect(f.service.view(f.auth, ws, f.input.configuration).blockers).toEqual([]);
  expect(context.storage.roadmaps.find(ws, saved.id)?.status).toBe('draft');
  await context.services.roadmapService.control(f.auth, ws, saved.id, 'start', saved.version);
  expect(context.storage.roadmaps.find(ws, saved.id)?.status).toBe('running');
  await context.services.roadmapService.control(
    f.auth,
    ws,
    saved.id,
    'pause',
    context.storage.roadmaps.find(ws, saved.id)!.version,
  );
  const prior = accepted.current!;
  await svc.configure(f.auth, ws, id, {
    bindingRevision: 1,
    expectedGeneration: prior.generation,
    pins: [],
    consumers: prior.consumers.map((c) => ({ ...c, upstreams: [...c.upstreams] })),
    environments: [...prior.environments],
  });
  expect(acceptedEvidence(context.storage, ws, id, 1, evidence.subject)).toBeUndefined();
});

it('invalidates generated plan evidence when saved settings change and rejects stale acceptance after an await', async () => {
  const f = await supervisedMapFixture(false, 'automatic', false, true);
  const { context, workspaceId: ws } = f.state;
  const svc = context.services.runtimeEvidenceService,
    id = f.parentScope.definitionId;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input).roadmap;
  const ready = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  const generated = await svc.generatePlanEvidence(f.auth, ws, id, {
    roadmapId: saved.id,
    definitionRevision: ready.definitionRevision,
    snapshotDigest: ready.snapshotDigest,
  });
  const first = generated.submissions[0]!.submission;
  const changed = f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: saved.version,
    name: 'Revised saved settings',
  }).roadmap;
  await expect(
    svc.decide(f.auth, ws, id, {
      submissionId: first.id,
      outcome: 'accepted',
      rationale: 'Review old facts',
    }),
  ).rejects.toThrow('Saved configuration changed');
  expect(context.storage.runtimeEvidence.decisions(ws)).toHaveLength(0);
  const current = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  const next = await svc.generatePlanEvidence(f.auth, ws, id, {
    roadmapId: saved.id,
    definitionRevision: current.definitionRevision,
    snapshotDigest: current.snapshotDigest,
  });
  const second = next.submissions.find((s) => s.submission.id !== first.id)!.submission;
  await svc.decide(f.auth, ws, id, {
    submissionId: second.id,
    outcome: 'accepted',
    rationale: 'Reviewed revised settings',
  });
  expect(acceptedEvidence(context.storage, ws, id, 1, second.subject)?.id).toBe(second.id);
  // The idle scan only uses a shared snapshot to defer work. A later scan sees new settings.
  const service = context.services.roadmapService;
  const spy = vi.spyOn(context.storage.imports, 'definition');
  // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
  service['deferredEntries'](changed);
  expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
  spy.mockRestore();
  f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: changed.version,
    name: 'Changed again',
  });
  expect(acceptedEvidence(context.storage, ws, id, 1, second.subject)).toBeUndefined();
  expect(
    // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
    service['deferredEntries'](context.storage.roadmaps.find(ws, saved.id)!).size,
  ).toBeGreaterThan(0);
  const pending = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  const thirdView = await svc.generatePlanEvidence(f.auth, ws, id, {
    roadmapId: saved.id,
    definitionRevision: pending.definitionRevision,
    snapshotDigest: pending.snapshotDigest,
  });
  const third = thirdView.submissions.find((s) => !s.decision && !s.issues.length)!.submission;
  const review = svc.decide(f.auth, ws, id, {
    submissionId: third.id,
    outcome: 'accepted',
    rationale: 'Reviewed before a concurrent settings change',
  });
  const latest = context.storage.roadmaps.find(ws, saved.id)!;
  f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: latest.version,
    name: 'Changed during review',
  });
  await expect(review).rejects.toThrow('Saved configuration changed');
  expect(
    context.storage.runtimeEvidence.decisions(ws).some((d) => d.submissionId === third.id),
  ).toBe(false);
});

it('native resource approval is scoped, revocable and never admits Kata or development receipts', async () => {
  const { nativeHostDigest } = await import('@craftingtable/agents');
  const { phaseResources } = await import('./services/phase-resources.js');
  const { resolveScope } = await import('./services/execution-scope.js');
  const { currentScopeReceipt } = await import('./services/runtime-evidence-policy.js');
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s, i) => ({
      ...s,
      resources_by_phase: {
        ...s.resources_by_phase,
        verify: [i === 0 ? 'controlled-native-test-host' : 'kata-instance-test-host'],
      },
    })),
  }));
  const { state } = f,
    tx = state.context.storage,
    ws = state.workspaceId,
    scope = f.scopes[0]!;
  const runtime = {
    id: randomUUID(),
    workspaceId: ws,
    definitionId: scope.definitionId,
    bindingRevision: 1,
    generation: 1,
    digest: 'a'.repeat(64),
    pins: [],
    consumers: [],
    environments: [],
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  };
  tx.runtimeEvidence.addGeneration(runtime);
  const resolved = resolveScope(tx, ws, state.workItemId, scope);
  expect(phaseResources(tx, resolved, 'verify').blockers[0]?.kind).toBe('authorization');
  const approval = {
    id: randomUUID(),
    workspaceId: ws,
    definitionId: scope.definitionId,
    bindingRevision: 1,
    runtimeId: runtime.id,
    approved: true,
    hostDigest: nativeHostDigest(),
    auditDigest: 'a'.repeat(64),
    audit: 'fixture',
    rationale: 'Approve fixtures',
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  };
  tx.runtimeEvidence.addNativeApproval(approval);
  expect(phaseResources(tx, resolved, 'verify')).toMatchObject({
    blockers: [],
    resources: [{ key: 'local-verification' }],
  });
  expect(
    phaseResources(tx, resolveScope(tx, ws, state.workItemId, f.scopes[1]!), 'verify').blockers[0]
      ?.kind,
  ).toBe('authorization');
  // An implementation review without native provenance cannot become a current native receipt.
  expect(
    currentScopeReceipt(tx, ws, {
      scope,
      workspaceId: ws,
      reviewRunId: asAgentRunId('missing'),
    } as import('@craftingtable/domain').ScopeReceipt),
  ).toBe(false);
  tx.runtimeEvidence.addNativeApproval({ ...approval, id: randomUUID(), approved: false });
  expect(phaseResources(tx, resolved, 'verify').blockers[0]?.kind).toBe('authorization');
  // The HTTP boundary requires CSRF before an audit/approval can run.
  const denied = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/concurrency-definitions/${scope.definitionId}/runtime/authorize-native`,
    headers: { cookie: state.cookie },
    payload: {},
  });
  expect(denied.statusCode).toBe(403);
  const agents = await import('@craftingtable/agents');
  const audit = {
    hostDigest: nativeHostDigest(),
    auditDigest: 'b'.repeat(64),
    facts: 'Audited fixtures',
    ready: true,
    issues: [],
    kata: { installed: false, kvmAvailable: true, message: 'Not installed' },
  };
  const spy = vi.spyOn(agents, 'auditNativeEnvironment').mockResolvedValue(audit);
  try {
    const prior = tx.runtimeEvidence.nativeApprovals(ws, scope.definitionId, 1)[0]!;
    const input = {
      bindingRevision: 1,
      runtimeId: runtime.id,
      expectedApprovalId: prior.id,
      approved: true,
      auditDigest: audit.auditDigest,
      rationale: 'Reviewed captured limits',
    };
    await expect(
      state.context.services.runtimeEvidenceService.approveNative(f.auth, ws, scope.definitionId, {
        ...input,
        auditDigest: 'c'.repeat(64),
      }),
    ).rejects.toThrow('audit changed');
    const saved = await state.context.services.runtimeEvidenceService.approveNative(
      f.auth,
      ws,
      scope.definitionId,
      input,
    );
    expect(saved.nativeVerification.current).toBe(true);
    expect(tx.runtimeEvidence.generations(ws, scope.definitionId, 1)).toHaveLength(1);
    const { buildVerificationPolicy } = await import('./services/build-verification-policy.js');
    const verificationScope = { ...scope, kind: 'slice-verification' as const };
    const policy = buildVerificationPolicy(
      tx.imports.definition(ws, scope.definitionId)!,
      verificationScope,
    );
    const runId = asAgentRunId(randomUUID()),
      manifestDigest = 'd'.repeat(64),
      headSha = 'e'.repeat(40);
    const native = saved.nativeVerification.approval!;
    let receipt = {
      kind: 'scoped-check',
      success: true,
      clean: true,
      headSha,
      manifestDigest,
      runId,
      runtimeId: runtime.id,
      verificationMode: policy.mode,
      policyDigest: agents.cargoManifestDigest(JSON.stringify(policy)),
      nativeVerification: {
        approvalId: native.id,
        hostDigest: native.hostDigest,
        auditDigest: native.auditDigest,
      },
    };
    const runSpy = vi.spyOn(tx.runtimeEvidence, 'run').mockReturnValue({
      runId,
      workspaceId: ws,
      runtimeId: runtime.id,
      manifestPath: '/unused',
      manifestDigest,
      nativeApprovalId: native.id,
    });
    const buildSpy = vi.spyOn(tx.runtimeEvidence, 'build').mockImplementation(() => ({
      runId,
      workspaceId: ws,
      runtimeId: runtime.id,
      manifestDigest,
      digest: 'f'.repeat(64),
      receipts: JSON.stringify(receipt),
    }));
    const agentSpy = vi.spyOn(tx.execution.runs, 'find').mockReturnValue({
      id: runId,
      reviewBranchContext: { headSha },
    } as import('@craftingtable/domain').AgentRun);
    try {
      // Parent acceptance must become stale when its native prerequisite authority changes.
      const parentReceipt = {
        scope: f.parentScope,
        workspaceId: ws,
        reviewRunId: runId,
      } as import('@craftingtable/domain').ScopeReceipt;
      expect(currentScopeReceipt(tx, ws, parentReceipt)).toBe(true);
      runSpy.mockReturnValueOnce({
        runId,
        workspaceId: ws,
        runtimeId: runtime.id,
        manifestPath: '/unused',
        manifestDigest,
        nativeApprovalId: randomUUID(),
      });
      expect(currentScopeReceipt(tx, ws, parentReceipt)).toBe(false);
      const tree = {
        workspaceId: ws,
        repositoryId: f.repository.id,
        executionScope: verificationScope,
      } as import('@craftingtable/domain').Worktree;
      expect(() => state.context.services.runtimeEvidenceService.assertRun(tree, runId)).toThrow(
        'successful ct-native',
      );
      receipt = { ...receipt, kind: 'native-check' };
      expect(() =>
        state.context.services.runtimeEvidenceService.assertRun(tree, runId),
      ).not.toThrow();
      receipt = {
        ...receipt,
        nativeVerification: { ...receipt.nativeVerification, approvalId: randomUUID() },
      };
      expect(() => state.context.services.runtimeEvidenceService.assertRun(tree, runId)).toThrow(
        'successful ct-native',
      );
    } finally {
      runSpy.mockRestore();
      buildSpy.mockRestore();
      agentSpy.mockRestore();
    }

    await expect(
      state.context.services.runtimeEvidenceService.approveNative(
        f.auth,
        ws,
        scope.definitionId,
        input,
      ),
    ).rejects.toThrow('approval changed');
  } finally {
    spy.mockRestore();
  }
});

it('alerts for an eligible missing native environment, not future dependency waits, and resolves after approval', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    evidence_profiles: source.evidence_profiles.map((p) => ({
      ...p,
      reviewer_roles: ['repository-maintainer'],
    })),
    slices: source.slices.map((s) => ({
      ...s,
      resources_by_phase: { ...s.resources_by_phase, verify: ['controlled-native-test-host'] },
    })),
  }));
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  await state.context.services.roadmapService.shutdown();
  const input = roadmapInput(state, [state.workItemId]);
  const saved = await saveRoadmapRequest(state, {
    ...input,
    entries: input.entries.map((e) => ({
      ...e,
      executionScope: f.scopes[0],
    })),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const draft = storedRoadmap(state);
  tx.roadmaps.save(
    {
      ...draft,
      // A changed definition is a new revision (R-B3).
      definition: {
        ...draft.definition,
        revision: draft.definition.revision + 1,
        entries: draft.definition.entries.map((e) => ({
          ...e,
          executionScope: { ...f.scopes[0]!, kind: 'slice-verification' as const },
        })),
      },
      version: draft.version + 1,
      status: 'running',
    },
    draft.version,
  );
  const { DEFAULT_NOTIFICATION_PREFERENCES } = await import('@craftingtable/domain');
  const notifications = state.context.services.notificationService;
  notifications.save(f.auth, ws, {
    expectedVersion: 0,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
    applicationToken: 'a'.repeat(30),
    userKey: 'u'.repeat(30),
  });
  // Verification setup is derived by the scheduler's pass and kept as an item (R-A4).
  const schedulerPass = () => state.context.services.roadmapService.syncAttention(true);
  schedulerPass();
  const alerts = () =>
    tx.attention.recent(ws, 100).filter((n) => n.subjectKey.endsWith(':environments'));
  expect(alerts()).toHaveLength(0);
  const tree = await scopeTree(f, f.scopes[0]!);
  commitFile(tree.path, 'a.txt', 'A');
  await reviewScope(f, tree);
  expect((await merge(state, tree.id)).statusCode).toBe(200);
  schedulerPass();
  await notifications.tick();
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]?.state).toBe('open');
  expect(alerts()[0]?.message).toContain('controlled-native-test-host');
  const { nativeHostDigest } = await import('@craftingtable/agents');
  const runtimeId = randomUUID();
  tx.runtimeEvidence.addGeneration({
    id: runtimeId,
    workspaceId: ws,
    definitionId: f.parentScope.definitionId,
    bindingRevision: 1,
    generation: 1,
    digest: 'a'.repeat(64),
    pins: [],
    consumers: [{ alias: 'local', upstreams: [] }],
    environments: [],
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  });
  tx.runtimeEvidence.addNativeApproval({
    id: randomUUID(),
    workspaceId: ws,
    definitionId: f.parentScope.definitionId,
    bindingRevision: 1,
    runtimeId,
    approved: true,
    hostDigest: nativeHostDigest(),
    auditDigest: 'a'.repeat(64),
    audit: 'fixture',
    rationale: 'Approved',
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  });
  schedulerPass();
  expect(alerts().filter((n) => n.state === 'open')).toHaveLength(1);
  expect(alerts().find((n) => n.state === 'open')?.message).toContain('reviewer qualifications');
  const roleSpy = vi
    .spyOn(await import('./services/map-adoption-policy.js'), 'scopeReviewerRoles')
    .mockReturnValue(['repository-maintainer']);
  try {
    schedulerPass();
    expect(alerts().every((n) => n.state === 'resolved')).toBe(true);
  } finally {
    roleSpy.mockRestore();
  }
});

it.each([false, true])(
  'slice remediation recovery preserves exact scope (missing evidence: %s)',
  async (omitEvidence) => {
    const f = await slicedFixture();
    const { state, backend } = f;
    const scope = f.scopes[0]!;
    const tree = await scopeTree(f, scope);
    let resolved = false;
    backend.replyForRequest = (request) => {
      if (request.model === 'design-model') return designDone;
      if (request.model !== 'review-model') return implementationDone;
      const finding = resolved
        ? { ...structuredFinding, status: 'resolved', disposition: 'Verified the slice fix.' }
        : structuredFinding;
      return {
        resultText: scopeReport(state, scope, omitEvidence)
          .replace('"findings":[]', `"findings":${JSON.stringify([finding])}`)
          .replaceAll('mergeable', resolved ? 'mergeable' : 'changes-requested'),
      };
    };
    const cycle = await startCycle(state, tree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
    });
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'slice checkpoint',
    );
    const before = currentCycle(state, cycle);
    resolved = true;
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'authorize-remediation',
        expectedVersion: before.version,
        additionalRounds: 1,
      },
    });
    expect(response.statusCode, response.body).toBe(omitEvidence ? 409 : 200);
    if (omitEvidence) {
      expect(currentCycle(state, cycle)).toEqual(before);
      // Missing scope evidence needs the reviewer's work: it stops at once (R-C2).
      expect(backend.repairs).toBe(0);
      expect(backend.launches).toHaveLength(3 + backend.repairs);
    } else {
      expect(workCycleResponseSchema.parse(response.json()).cycle).toMatchObject({
        executionScope: scope,
        additionalRemediationRounds: 1,
      });
      await waitFor(
        () => currentCycle(state, cycle).status === 'awaiting-merge',
        'recovered slice review',
      );
      expect(currentCycle(state, cycle)).toMatchObject({
        executionScope: scope,
        remediationRounds: 1,
        policy: { maxRemediationRounds: 0 },
      });
      expect(backend.launches).toHaveLength(5);
    }
  },
);

it('adopts immutable repository policy, packages fresh evidence, and expires prior review approval', async () => {
  const state = await ready();
  const root = fixtureRepository();
  git(['branch', 'revision'], root);
  const { worktree } = await registerAndWorktree(state, root, 'revision');
  const path = 'plan-versions/version-1/repository-policy';
  const preview = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/${path}`,
    headers: { cookie: state.cookie },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.json().policy).toBeUndefined();
  const input = {
    expectedVersion: 0,
    expectedBranchSettingsVersion: 1,
    controlMode: 'controller-local',
    experimentalFreeze: preview.json().proposedFreeze,
    interpretation: 'Use controller gates now; preserve the experimental baseline.',
    publicationRequirement: 'Verify remote protections before first publication.',
  };
  await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
  const saved = await branchCommand(state, path, input);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json()).toMatchObject({
    settingsVersion: 1,
    issues: [],
    policy: { version: 1, adoptedByUserId: state.userId },
    observedFreezeSha: git(['rev-parse', 'main'], root).trim(),
  });
  const branches = state.context.services.executionService.branches;
  expect(() =>
    branches.requirePolicyMergeTarget(state.workspaceId, worktree.repositoryId, 'main'),
  ).toThrow('frozen by repository policy');
  expect(() =>
    branches.requirePolicyMergeTarget(state.workspaceId, worktree.repositoryId, 'revision'),
  ).not.toThrow();
  expect(() =>
    branches.requirePolicyMergeTarget(state.workspaceId, worktree.repositoryId, 'main', true),
  ).not.toThrow();
  expect((await branchCommand(state, path, input)).statusCode).toBe(409);
  expect((await merge(state, worktree.id)).statusCode).toBe(409);
  const review = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  const run = state.context.storage.execution.runs.find(state.workspaceId, review)!;
  expect(run.reviewBranchContext?.repositoryPolicyVersion).toBe(1);
  const evidencePath = run.brief.match(/`([^`]+\/craftingtable-repository-policy.json)`/)?.[1];
  expect(evidencePath).toBeTruthy();
  const evidence = JSON.parse(readFileSync(evidencePath!, 'utf8'));
  expect(evidence.policy).toMatchObject({
    version: 1,
    experimentalFreeze: input.experimentalFreeze,
  });
  expect(evidence.limitations.join(' ')).toContain('No remote protection');
  const reopened = openDaemonStorage(state.context.storage.databasePath);
  try {
    expect(
      reopened.execution.branchSettings.policy(state.workspaceId, asPlanVersionId('version-1'))
        ?.version,
    ).toBe(1);
  } finally {
    reopened.close();
  }
  const changed = await branchCommand(state, path, {
    ...input,
    expectedVersion: 1,
    interpretation: 'Revised operator interpretation.',
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect((await merge(state, worktree.id)).statusCode).toBe(409);
  // A direct Git mutation is observable, not prevented by the claimed local workflow control.
  commitFile(root, 'outside-controller.txt', 'changed baseline');
  const drift = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/${path}`,
    headers: { cookie: state.cookie },
  });
  expect(drift.json().issues.join(' ')).toContain('frozen experimental branch moved');
  expect((await branchCommand(state, path, { ...input, expectedVersion: 2 })).statusCode).toBe(409);
  expect(git(['rev-parse', 'revision'], root).trim()).toBe(input.experimentalFreeze.commitSha);
});

it('carries recorded operator guidance into related verification and acceptance scopes only', async () => {
  const f = await slicedFixture();
  const { state, backend } = f;
  const tree = await scopeTree(f, f.scopes[0]!);
  backend.replyForRequest = () => ({ resultText: '## Open questions\nWhich policy applies?' });
  const cycle = await startCycle(state, tree.id, {
    instructions: 'Original operator instruction: local integration controls.',
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design question');
  const stopped = await controlCycle(state, currentCycle(state, cycle), 'stop');
  expect(operatorDecisions(state.context.storage, state.workspaceId, [f.second])).toEqual([]);
  expect(
    operatorDecisions(state.context.storage, state.workspaceId, [state.workItemId], {
      ...f.scopes[0]!,
      bindingRevision: 999,
    }),
  ).toEqual([]);
  for (const scope of [
    f.scopes[0]!,
    { ...f.scopes[0]!, kind: 'slice-verification' as const },
    f.parentScope,
  ]) {
    const ledger = scopeEvidenceLedger(
      state.context.storage,
      resolveScope(state.context.storage, state.workspaceId, state.workItemId, scope),
    );
    expect(ledger.operatorDecisions).toEqual([
      expect.objectContaining({
        sourceCycleId: stopped.id,
        cycleInstructions: 'Original operator instruction: local integration controls.',
      }),
    ]);
  }
});
