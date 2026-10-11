import { createHash, randomUUID } from 'node:crypto';
import { registerSourceRepositoryResponseSchema } from '@craftingtable/contracts';
import {
  agentSelections,
  type ConcurrencySource,
  type EvidenceSubmission,
  PLAN_ACCEPTANCE_INPUTS,
  asUserId,
  asWorkspaceMembershipId,
  type RuntimeGeneration,
} from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { carryPlanAcceptance } from '../src/services/generated-plan-evidence.js';
import { savedPlanInputs, savedPlanSnapshot } from '../src/services/plan-acceptance-policy.js';
import { acceptedEvidence } from '../src/services/runtime-evidence-policy.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  commitFile,
  fixtureRepository,
  git,
  mapCommand,
  mutationHeaders,
  roadmapControl,
  supervisedMapFixture,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

const PLAN = { kind: 'checkpoint' as const, sourceId: 'STACK-PLAN-ACCEPTED' };

/**
 * Re-saves a map roadmap as an applied amendment does: its stored settings (the amendment path
 * takes them with their profiles, R-E5b), with the defaults' reviewer roles replaced.
 */
function amendReviewers(
  f: Awaited<ReturnType<typeof supervisedMapFixture>>,
  reviewerRoles: string[],
) {
  const stored = f.state.context.storage.roadmaps.find(f.state.workspaceId, f.input.roadmapId)!;
  const saved = stored.definition.crossProject!;
  f.service.saveStored(
    f.auth,
    f.state.workspaceId,
    {
      ...f.input,
      expectedVersion: stored.version,
      configuration: { ...saved, defaults: { ...saved.defaults, reviewerRoles } },
    },
    { retainAttemptIds: [] },
  );
}

/**
 * A saved cross-project roadmap whose generated STACK-PLAN-ACCEPTED evidence the operator
 * accepted, with the commands the tests change it through.
 */
async function acceptedPlan(
  options: {
    amend?: (source: ConcurrencySource) => ConcurrencySource;
    /** Runs before the roadmap is saved; the binding revision it returns is the roadmap's. */
    setup?: (f: Awaited<ReturnType<typeof supervisedMapFixture>>) => Promise<number>;
  } = {},
) {
  const f = await supervisedMapFixture(false, 'automatic', false, true, false, options.amend);
  const { context, workspaceId: ws } = f.state;
  const storage = context.storage,
    svc = context.services.runtimeEvidenceService,
    id = f.parentScope.definitionId;
  const bindingRevision = options.setup ? await options.setup(f) : 1;
  if (!options.setup) await adoptSupervisedMap(f);
  f.input = { ...f.input, configuration: { ...f.input.configuration, bindingRevision } };
  const roadmap = f.service.save(f.auth, ws, f.input).roadmap;
  const generate = async () => {
    const ready = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
    expect(ready.state).toBe('ready-to-generate');
    const view = await svc.generatePlanEvidence(f.auth, ws, id, {
      roadmapId: roadmap.id,
      definitionRevision: ready.definitionRevision,
      snapshotDigest: ready.snapshotDigest,
    });
    const submissionId = view.planAcceptance!.roadmaps[0]!.submissionId!;
    return view.submissions.find((s) => s.submission.id === submissionId)!.submission;
  };
  const accept = (submissionId: string) =>
    svc.decide(f.auth, ws, id, {
      submissionId,
      outcome: 'accepted',
      rationale: 'Reviewed the saved plan as stack-integration-owner.',
    });
  const first = await generate();
  await accept(first.id);
  /** Saves the roadmap again with the configuration `change` returns. */
  const save = (
    change: (c: typeof f.input.configuration) => typeof f.input.configuration = (c) => c,
    name = f.input.name,
    context = f.auth,
  ) =>
    f.service.save(context, ws, {
      ...f.input,
      name,
      expectedVersion: storage.roadmaps.find(ws, roadmap.id)!.version,
      configuration: change(f.input.configuration),
    });
  const accepted = () => acceptedEvidence(storage, ws, id, bindingRevision, PLAN);
  const state = async () => (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!.state;
  const decisionOf = (submissionId: string) =>
    storage.runtimeEvidence.decisions(ws).find((a) => a.submissionId === submissionId);
  /** The plan the operator's command carried, with its decision and audit event. */
  const carried = () => {
    const plan = accepted()!;
    const audit = storage.audit
      .listWorkspace({ workspaceId: ws, limit: 50 })
      .find(
        (e) =>
          e.action === 'evidence.decided' &&
          (e.metadata as { submissionId?: string }).submissionId === plan.id,
      );
    return { plan, decision: decisionOf(plan.id)!, audit };
  };
  /** The plan items open now, and those the roadmap's scheduler pass would raise (R-A5). */
  const planItems = () => [
    ...storage.attention.open(ws).filter((item) => item.code === 'plan-acceptance'),
    ...context.services.roadmapService
      .passAttention(storage.roadmaps.find(ws, roadmap.id)!)
      .filter((item) => item.code === 'plan-acceptance'),
  ];
  return {
    f,
    ws,
    id,
    storage,
    svc,
    roadmap,
    first,
    generate,
    accept,
    save,
    accepted,
    state,
    decisionOf,
    carried,
    planItems,
  };
}

it('records saved-plan-v2 evidence bound to the plan-acceptance inputs, one artifact per input', async () => {
  const { first, storage, ws, id } = await acceptedPlan();
  expect(first.generatedPlan).toEqual({
    kind: 'saved-plan-v2',
    roadmapId: expect.any(String),
    definitionRevision: 1,
    inputsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    changedInputs: [],
  });
  expect(first.artifacts.map((a) => a.name)).toEqual([
    'plan-review-guide',
    ...PLAN_ACCEPTANCE_INPUTS,
  ]);
  const record = storage.runtimeEvidence.submission(ws, id, first.id)!;
  expect(JSON.parse(record.artifacts.find((a) => a.name === 'reviewerRoles')!.content)).toEqual(
    expect.arrayContaining([
      {
        entry: 'slice:local/AQ-01/a',
        roles: ['independent-security-reviewer-if-required-by-source', 'repository-maintainer'],
      },
    ]),
  );
  expect(record.artifacts[0]!.content).toContain('No plan has been accepted for this roadmap yet.');
});

// Done-when (a): saves and setup changes outside the inputs keep the operator's acceptance.
it('keeps STACK-PLAN-ACCEPTED accepted across saves, generations and capacities outside its inputs', async () => {
  const { f, ws, id, storage, first, save, accepted, state } = await acceptedPlan();
  const unchanged = async () => {
    expect(accepted()?.id).toBe(first.id);
    expect(await state()).toBe('accepted');
    expect(storage.runtimeEvidence.submissions(ws, id)).toHaveLength(1);
  };
  save((c) => c, 'Renamed roadmap');
  await unchanged();
  save((c) => ({ ...c, defaults: { ...c.defaults, instructions: 'New instructions.' } }));
  await unchanged();
  // A model change is an ADR-064 assignment, which leaves the definition alone (R-E5b).
  const entries = storage.roadmaps.find(ws, f.input.roadmapId)!.definition.entries;
  f.state.context.services.roadmapService.applyAgentSettings(f.auth, ws, f.input.roadmapId, {
    expectedVersion: storage.roadmaps.find(ws, f.input.roadmapId)!.version,
    entryIds: entries.map((e) => e.id),
    selections: {
      ...agentSelections(entries[0]!.profiles),
      design: { backend: 'claude-code', model: 'review-model' },
    },
  });
  await unchanged();
  save((c) => ({
    ...c,
    defaults: { ...c.defaults, policy: { ...c.defaults.policy, maxRemediationRounds: 1 } },
  }));
  await unchanged();
  save((c) => ({
    ...c,
    parentAcceptance: 'manual',
    defaults: {
      ...c.defaults,
      automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
    },
  }));
  await unchanged();
  // A save that changes nothing.
  save();
  await unchanged();
  // A new generation that moves only a consumer integration pin (ADR-069), to the head the
  // pin status reads, so the view sees a current pin.
  const runtime = storage.runtimeEvidence.generations(ws, id, 1)[0]!;
  const branch = storage.imports.bindings(ws, id)[0]!.bindings[0]!.integrationBranch!;
  const next: RuntimeGeneration = {
    ...runtime,
    id: randomUUID(),
    generation: runtime.generation + 1,
    digest: 'd'.repeat(64),
    pins: [
      {
        alias: 'local',
        ref: branch,
        repositoryId: f.repository.id,
        commitSha: git(['rev-parse', branch], f.repository.rootPath).trim(),
        treeSha: git(['rev-parse', `${branch}^{tree}`], f.repository.rootPath).trim(),
        conformanceRevision: 'plan-version:version-1',
        packages: [],
      },
    ],
    createdAt: new Date().toISOString(),
  };
  storage.runtimeEvidence.addGeneration(next);
  await unchanged();
  // A host capacity change.
  const host = f.state.context.services.hostSchedulingService;
  host.save(f.auth, ws, {
    expectedDevelopmentVersion: storage.phaseScheduling.setting('local-development').version,
    developmentCapacity: storage.phaseScheduling.capacity('local-development') + 1,
    expectedVersion: storage.phaseScheduling.setting('local-verification').version,
    verificationCapacity: storage.phaseScheduling.capacity('local-verification') + 1,
  });
  await unchanged();
});

// Done-when (b) and D2: a save that changes reviewer roles re-generates the plan, and the
// Decided by the operator 2026-10-08 (R-C6 review OD3): runtime environments stay out of the
// inputs. The package attests no environment, and D1 does not list them.
it('keeps a v2 acceptance across a generation with other environments', async () => {
  const { ws, id, storage, first, accepted } = await acceptedPlan();
  const runtime = storage.runtimeEvidence.generations(ws, id, 1)[0]!;
  storage.runtimeEvidence.addGeneration({
    ...runtime,
    id: randomUUID(),
    generation: runtime.generation + 1,
    digest: 'e'.repeat(64),
    environments: [
      {
        ...runtime.environments[0]!,
        id: 'another-environment',
        toolchainDigest: 'f'.repeat(64),
        authorization: 'Another authorization.',
      },
    ],
    createdAt: new Date().toISOString(),
  });
  expect(first.environmentId).not.toBe('another-environment');
  expect(accepted()?.id).toBe(first.id);
});

// operator's own command accepts it in the same transaction.
it('carries the acceptance when the operator saves new reviewer roles', async () => {
  const { f, first, save, carried, decisionOf, state, storage, ws, id } = await acceptedPlan();
  save((c) => ({ ...c, defaults: { ...c.defaults, reviewerRoles: ['repository-maintainer'] } }));
  const { plan, decision, audit } = carried();
  expect(plan.id).not.toBe(first.id);
  expect(plan.generatedPlan).toMatchObject({
    kind: 'saved-plan-v2',
    changedInputs: ['reviewerRoles'],
  });
  expect(decision).toMatchObject({
    outcome: 'accepted',
    decidedByUserId: f.state.userId,
    carriedFrom: decisionOf(first.id)!.id,
  });
  expect(audit).toMatchObject({
    actorKind: 'user',
    actorUserId: f.state.userId,
    metadata: {
      carriedFrom: decisionOf(first.id)!.id,
      priorSubmissionId: first.id,
      changedInputs: ['reviewerRoles'],
      command: 'roadmap save',
    },
  });
  expect(await state()).toBe('accepted');
  expect(storage.runtimeEvidence.submission(ws, id, plan.id)!.artifacts[0]!.content).toContain(
    'Your roadmap save changed only the inputs named above',
  );
  // The view says whose review it carries and what changed since (R-C6 commit 3).
  const view = await f.state.context.services.runtimeEvidenceService.view(f.auth, ws, id);
  expect(view.planAcceptance!.roadmaps[0]!.carried).toEqual({
    reviewedAt: decisionOf(first.id)!.decidedAt,
    changedInputs: ['reviewerRoles'],
  });
});

// Done-when (c): the carried acceptance never reaches the inbox. An amendment never carries
// (D2), so the same kind of change applied as one raises the plan item.
it('opens no inbox item for a carried acceptance, and an amendment never carries', async () => {
  const { f, save, carried, first, accepted, planItems, decisionOf } = await acceptedPlan();
  await roadmapControl(f.state, 'start');
  await roadmapControl(f.state, 'pause');
  expect(planItems()).toEqual([]);
  save((c) => ({ ...c, defaults: { ...c.defaults, reviewerRoles: ['repository-maintainer'] } }));
  expect(carried().decision.carriedFrom).toBe(decisionOf(first.id)!.id);
  expect(planItems()).toEqual([]);
  amendReviewers(f, ['independent-security-reviewer-if-required-by-source']);
  expect(accepted()).toBeUndefined();
  expect(planItems().map((item) => item.title)).toEqual([
    'Cross-project fixture · STACK-PLAN-ACCEPTED · Plan to accept',
  ]);
});

it('carries the acceptance when the operator approves decision clauses', async () => {
  const DECISION = 'LOCAL-ADR-01';
  const { f, svc, ws, id, storage, first, carried, decisionOf, save, generate } =
    await acceptedPlan({
      amend: (source) => ({
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
            id: DECISION,
            owner: 'local',
            kind: 'architecture_decision' as const,
            evidence_profile: 'architecture-approval',
            requires: [],
          },
        ],
        slices: source.slices.map((s) => ({
          ...s,
          start_requires: [
            ...s.start_requires,
            { kind: 'checkpoint' as const, id: DECISION, state: 'passed' as const },
          ],
        })),
      }),
    });
  await svc.proposeArchitectureDecision(f.auth, ws, id, {
    bindingRevision: 1,
    checkpointId: DECISION,
    coverage: 'clauses',
    proposal: 'Use the documented boundary.',
    sourceReferences: `Exact imported plan ${DECISION}`,
    consumers: [{ sliceId: f.scopes[0]!.sourceId, phase: 'start', replacesFullCheckpoint: true }],
    retainedObligations: 'Implementation tests remain mandatory.',
  });
  const staged = storage.runtimeEvidence.submissions(ws, id)[0]!.id;
  await svc.decide(f.auth, ws, id, {
    submissionId: staged,
    outcome: 'accepted',
    rationale: 'Settled for the first slice.',
  });
  const { plan, decision, audit } = carried();
  expect(plan.generatedPlan).toMatchObject({ changedInputs: ['stagedDecisions'] });
  expect(decision.carriedFrom).toBe(decisionOf(first.id)!.id);
  expect(audit?.metadata).toMatchObject({ command: 'decision approval' });
  // A second carry: the view still names the operator's review and every input changed since.
  save((c) => ({ ...c, defaults: { ...c.defaults, reviewerRoles: ['repository-maintainer'] } }));
  expect(carried().decision.carriedFrom).toBe(decision.id);
  expect((await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!.carried).toEqual({
    reviewedAt: decisionOf(first.id)!.decidedAt,
    changedInputs: ['stagedDecisions', 'reviewerRoles'],
  });
  // An amendment re-opens it; the package the operator then reviews names every input changed
  // since their own review, not only since the last carried acceptance.
  amendReviewers(f, ['independent-security-reviewer-if-required-by-source']);
  expect((await generate()).generatedPlan).toMatchObject({
    changedInputs: ['stagedDecisions', 'reviewerRoles'],
  });
});

/**
 * `acceptedPlan` on a map with an implemented upstream, `provider`, pinned in a real repository
 * at binding revision 2 (the local consumer takes it), so dependency commands can move its pin.
 */
async function providerPlan() {
  let provider = '';
  const plan = await acceptedPlan({
    amend: (source) => ({
      ...source,
      repositories: [
        ...source.repositories,
        {
          ...source.repositories[0]!,
          id: 'provider',
          role: 'implemented_upstream',
          target_branch: null,
          merge_lock: null,
        },
      ],
    }),
    setup: async (f) => {
      const { context, workspaceId: ws } = f.state;
      const id = f.parentScope.definitionId;
      provider = fixtureRepository();
      commitFile(
        provider,
        'Cargo.toml',
        '[package]\nname="plan_provider"\nversion="0.2.0"\nedition="2021"\n',
      );
      const registered = await context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/repositories`,
        headers: mutationHeaders(f.state),
        payload: { rootPath: provider, displayName: 'Plan provider' },
      });
      const repository = registerSourceRepositoryResponseSchema.parse(registered.json()).repository;
      const binding = context.storage.imports.bindings(ws, id)[0]!;
      context.storage.imports.addBindings({
        ...binding,
        revision: 2,
        bindings: [
          ...binding.bindings,
          {
            alias: 'provider',
            repositoryId: repository.id,
            integrationBranch: 'main',
            sourceArtifacts: [],
            workItems: [],
          },
        ],
      });
      const svc = context.services.runtimeEvidenceService;
      const pin = await svc.inspect(f.auth, ws, id, {
        bindingRevision: 2,
        alias: 'provider',
        ref: 'main',
      });
      const local = context.storage.runtimeEvidence.generations(ws, id, 1)[0]!;
      await svc.configure(f.auth, ws, id, {
        bindingRevision: 2,
        expectedGeneration: 0,
        pins: [
          {
            alias: 'provider',
            ref: 'main',
            expectedCommitSha: pin.commitSha,
            conformanceRevision: 'fixture',
            packages: pin.packages,
          },
        ],
        consumers: [{ alias: 'local', upstreams: ['provider'] }],
        environments: [...local.environments],
      });
      const adopted = await mapCommand(f, 'adopt', {
        bindingRevision: 2,
        decisionIds: ['CS-D01'],
        rationale: 'Reviewed exact definition and retained obligations.',
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      return 2;
    },
  });
  /** Saves the dependency environment again through advanced setup, as `change` edits it. */
  const configure = (
    change: (c: { upstreams: string[] }) => { upstreams: string[] } = (c) => c,
    context: typeof plan.f.auth = plan.f.auth,
  ) => {
    const current = plan.storage.runtimeEvidence.generations(plan.ws, plan.id, 2)[0]!;
    return plan.svc.configure(context, plan.ws, plan.id, {
      bindingRevision: 2,
      expectedGeneration: current.generation,
      pins: current.pins.map((p) => ({
        alias: p.alias,
        ref: p.ref,
        expectedCommitSha: p.commitSha,
        conformanceRevision: p.conformanceRevision,
        packages: [...p.packages],
      })),
      consumers: current.consumers.map((c) => ({
        alias: c.alias,
        ...change({ upstreams: [...c.upstreams] }),
      })),
      environments: [...current.environments],
    });
  };
  return { ...plan, provider, configure };
}

// The implemented-upstream pin moves only through the operator's reviewed refresh.
it('carries the acceptance when the operator refreshes the implemented-upstream pin', async () => {
  const { f, svc, ws, id, first, carried, decisionOf, state, provider } = await providerPlan();
  commitFile(provider, 'POLICY.md', 'A provider change the operator reviews.');
  const input = { bindingRevision: 2, expectedGeneration: 1 };
  const preview = await svc.previewRefresh(f.auth, ws, id, input);
  await svc.refresh(f.auth, ws, id, {
    ...input,
    snapshotDigest: preview.snapshotDigest,
    rationale: 'Reviewed the provider change.',
  });
  const { plan, decision, audit } = carried();
  expect(plan.generatedPlan).toMatchObject({ changedInputs: ['upstreamPins'] });
  expect(decision.carriedFrom).toBe(decisionOf(first.id)!.id);
  expect(audit?.metadata).toMatchObject({ command: 'dependency refresh' });
  expect(await state()).toBe('accepted');
});

// Decided by the operator 2026-10-08 (R-C6 review OD2): which implemented upstreams each
// consumer takes is part of the pins input, so dropping one re-opens acceptance though the pin
// stays.
it('re-opens acceptance when a consumer stops taking an implemented upstream', async () => {
  const { f, first, accepted, configure, generate } = await providerPlan();
  // Without a session, so no carry hides the re-opening (OD1).
  const system = { user: f.auth.user } as typeof f.auth;
  await configure((c) => c, system);
  expect(accepted()?.id).toBe(first.id);
  await configure(() => ({ upstreams: [] }), system);
  expect(accepted()).toBeUndefined();
  expect((await generate()).generatedPlan).toMatchObject({ changedInputs: ['upstreamPins'] });
});

// Decided by the operator 2026-10-08 (R-C6 review OD1): the advanced dependency setup is the
// operator's own command too, so it carries like the reviewed refresh; without a session it
// never does.
it('carries the acceptance through advanced dependency setup, never without a session', async () => {
  const { f, first, carried, decisionOf, accepted, configure, storage, ws, id } =
    await providerPlan();
  const before = storage.runtimeEvidence.submissions(ws, id).length;
  await configure((c) => c, { user: f.auth.user } as typeof f.auth);
  expect(accepted()?.id).toBe(first.id);
  // The local consumer stops taking the implemented upstream; the pin stays.
  await configure(() => ({ upstreams: [] }), { user: f.auth.user } as typeof f.auth);
  expect(accepted()).toBeUndefined();
  expect(storage.runtimeEvidence.submissions(ws, id)).toHaveLength(before);
  await configure((c) => ({ upstreams: [...c.upstreams, 'provider'] }));
  expect(accepted()?.id).toBe(first.id);
  await configure(() => ({ upstreams: [] }));
  const { plan, decision, audit } = carried();
  expect(plan.generatedPlan).toMatchObject({ changedInputs: ['upstreamPins'] });
  expect(decision.carriedFrom).toBe(decisionOf(first.id)!.id);
  expect(audit?.metadata).toMatchObject({ command: 'dependency environment save' });
});

// Done-when (d) and D2: a new binding never carries, and nothing without an operator's
// session does: the scheduler never accepts.
it('never carries for a new binding or without the operator', async () => {
  const { f, ws, id, storage, first, accepted } = await acceptedPlan();
  const roles = (reviewerRoles: string[]) => {
    const roadmap = storage.roadmaps.find(ws, f.input.roadmapId)!;
    const definition = {
      ...roadmap.definition,
      revision: roadmap.definition.revision + 1,
      entries: roadmap.definition.entries.map((e) => ({ ...e, reviewerRoles })),
    };
    storage.roadmaps.addDefinition(definition);
    expect(
      storage.roadmaps.save(
        { ...roadmap, definition, version: roadmap.version + 1 },
        roadmap.version,
      ),
    ).toBe(true);
  };
  const system = { user: f.auth.user };
  storage.transaction((tx) =>
    carryPlanAcceptance(
      tx,
      system as typeof f.auth,
      { workspaceId: ws, definitionId: id, command: 'roadmap save', at: new Date().toISOString() },
      () => roles(['repository-maintainer']),
    ),
  );
  expect(accepted()).toBeUndefined();
  expect(storage.runtimeEvidence.submissions(ws, id).map((s) => s.id)).toEqual([first.id]);
});

/**
 * Runs `change` under the operator's session as a carrying command would (R-C6 review L3), and
 * returns the saved setup's issues for the accepted roadmap afterwards: each case below has
 * none, so only the carry guard under test can refuse it.
 */
function carryDirectly(
  plan: Awaited<ReturnType<typeof acceptedPlan>>,
  change: (tx: Parameters<Parameters<typeof plan.storage.transaction>[0]>[0]) => void,
) {
  const { f, ws, id, storage } = plan;
  storage.transaction((tx) =>
    carryPlanAcceptance(
      tx,
      f.auth,
      { workspaceId: ws, definitionId: id, command: 'roadmap save', at: new Date().toISOString() },
      () => change(tx),
    ),
  );
  const binding = storage.imports.bindings(ws, id)[0]!;
  return savedPlanInputs(
    storage,
    storage.imports.definition(ws, id)!,
    storage.roadmaps.find(ws, f.input.roadmapId)!,
    storage.runtimeEvidence.generations(ws, id, binding.revision)[0],
  ).issues;
}

// Done-when (d), through the binding guards: the new binding has its runtime, adoption and a
// roadmap saved on it, so nothing but the binding change itself stands in the way.
it('never carries across a new binding revision, even with its setup complete', async () => {
  const plan = await acceptedPlan();
  const { f, ws, id, storage, first } = plan;
  const issues = carryDirectly(plan, (tx) => {
    const binding = tx.imports.bindings(ws, id)[0]!;
    tx.imports.addBindings({ ...binding, revision: 2 });
    const runtime = tx.runtimeEvidence.generations(ws, id, 1)[0]!;
    tx.runtimeEvidence.addGeneration({
      ...runtime,
      id: randomUUID(),
      bindingRevision: 2,
      generation: 1,
    });
    const adoption = tx.imports.adoptions(ws, id)[0]!;
    tx.imports.addAdoption({ ...adoption, id: randomUUID(), bindingRevision: 2 });
    const roadmap = tx.roadmaps.find(ws, f.input.roadmapId)!;
    const definition = {
      ...roadmap.definition,
      revision: roadmap.definition.revision + 1,
      crossProject: { ...roadmap.definition.crossProject!, bindingRevision: 2 },
      entries: roadmap.definition.entries.map((e) => ({
        ...e,
        executionScope: { ...e.executionScope!, bindingRevision: 2 },
      })),
    };
    tx.roadmaps.addDefinition(definition);
    tx.roadmaps.save({ ...roadmap, definition, version: roadmap.version + 1 }, roadmap.version);
  });
  expect(issues).toEqual([]);
  expect(acceptedEvidence(storage, ws, id, 2, PLAN)).toBeUndefined();
  expect(storage.runtimeEvidence.submissions(ws, id).map((s) => s.id)).toEqual([first.id]);
});

it('never carries a change to the plan archives', async () => {
  const plan = await acceptedPlan();
  const { ws, id, storage, first, accepted } = plan;
  const issues = carryDirectly(plan, (tx) => {
    const d = tx.imports.definition(ws, id)!;
    tx.imports.linkPlan({
      workspaceId: ws,
      planVersionId: tx.imports.bindings(ws, id)[0]!.bindings[0]!.planVersionId!,
      archiveId: d.archiveId,
      implementationPlan: 'implementation-plan.md',
      workBreakdown: 'work-breakdown.yaml',
      selectedPaths: [],
    });
  });
  expect(issues).toEqual([]);
  expect(accepted()).toBeUndefined();
  expect(storage.runtimeEvidence.submissions(ws, id).map((s) => s.id)).toEqual([first.id]);
});

// The package is validated before it is recorded: here another roadmap on the map is paused,
// so plan evidence for this one cannot satisfy the checkpoint though its own setup is clean.
it('never carries a package that would not validate', async () => {
  const plan = await acceptedPlan();
  const { f, ws, id, storage, first, accepted } = plan;
  const issues = carryDirectly(plan, (tx) => {
    const roadmap = tx.roadmaps.find(ws, f.input.roadmapId)!;
    const other = randomUUID();
    tx.roadmaps.save(
      {
        ...roadmap,
        id: other,
        version: 1,
        status: 'paused',
        definition: { ...roadmap.definition, roadmapId: other, revision: 1 },
      },
      0,
    );
    tx.roadmaps.addDefinition({ ...roadmap.definition, roadmapId: other, revision: 1 });
  });
  expect(issues).toEqual([]);
  expect(accepted()).toBeUndefined();
  expect(storage.runtimeEvidence.submissions(ws, id).map((s) => s.id)).toEqual([first.id]);
});

it('never carries onto a roadmap the change stopped', async () => {
  const plan = await acceptedPlan();
  const { f, ws, id, storage, first, accepted } = plan;
  carryDirectly(plan, (tx) => {
    const roadmap = tx.roadmaps.find(ws, f.input.roadmapId)!;
    tx.roadmaps.save(
      { ...roadmap, status: 'stopped', version: roadmap.version + 1 },
      roadmap.version,
    );
  });
  expect(accepted()).toBeUndefined();
  expect(storage.runtimeEvidence.submissions(ws, id).map((s) => s.id)).toEqual([first.id]);
});

// The carried decision is the commanding operator's, not the earlier reviewer's.
it('records the operator whose save carried the acceptance', async () => {
  const { f, ws, save, carried, decisionOf, first } = await acceptedPlan();
  const { context } = f.state;
  const editor = asUserId('editor-id');
  const password = 'another correct horse battery';
  const occurredAt = new Date().toISOString();
  context.storage.users.insert({
    id: editor,
    username: 'editor-user',
    usernameNormalized: 'editor-user',
    passwordHash: `$argon2id$test$${Buffer.from(password).toString('base64url')}`,
    occurredAt,
  });
  context.storage.workspaces.insertMembership({
    id: asWorkspaceMembershipId('editor-membership'),
    workspaceId: ws,
    userId: editor,
    role: 'editor',
    occurredAt,
  });
  const login = await context.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: context.config.publicOrigin, 'content-type': 'application/json' },
    payload: { username: 'editor-user', password },
  });
  expect(login.statusCode, login.body).toBe(200);
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
  const auth = context.services.authService.authenticate(cookie.split('=')[1]!);
  expect(auth.user.id).toBe(editor);
  save(
    (c) => ({ ...c, defaults: { ...c.defaults, reviewerRoles: ['repository-maintainer'] } }),
    f.input.name,
    auth,
  );
  const { decision, audit } = carried();
  expect(decisionOf(first.id)!.decidedByUserId).toBe(f.state.userId);
  expect(decision).toMatchObject({
    decidedByUserId: editor,
    carriedFrom: decisionOf(first.id)!.id,
  });
  expect(audit).toMatchObject({ actorUserId: editor, sessionId: auth.session.id });
});

/** A saved roadmap whose plan the operator accepted before R-C6: a saved-plan-v1 record. */
async function acceptedV1() {
  const f = await supervisedMapFixture(false, 'automatic', false, true);
  const { context, workspaceId: ws } = f.state;
  const storage = context.storage,
    id = f.parentScope.definitionId;
  await adoptSupervisedMap(f);
  const roadmap = storage.roadmaps.find(ws, f.service.save(f.auth, ws, f.input).roadmap.id)!;
  const d = storage.imports.definition(ws, id)!;
  const runtime = storage.runtimeEvidence.generations(ws, id, 1)[0]!;
  const snapshot = savedPlanSnapshot(storage, d, roadmap, runtime);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const guide = 'The daemon collected these saved setup facts.';
  const v1: EvidenceSubmission = {
    id: randomUUID(),
    workspaceId: ws,
    definitionId: id,
    bindingRevision: 1,
    runtimeId: runtime.id,
    subject: PLAN,
    environmentId: runtime.environments[0]!.id,
    executedBy: 'CraftingTable setup collector',
    executedAt: new Date().toISOString(),
    reviewers: [],
    requirements: d.source.evidence_profiles
      .find((p) => p.id === 'plan-approval')!
      .required_evidence.concat(
        d.source.checkpoints.find((c) => c.id === PLAN.sourceId)!.pass_criteria,
      )
      .map((requirement) => ({ requirement, artifact: 'plan-review-guide' })),
    cases: [],
    artifacts: [
      { name: 'plan-review-guide', content: guide, digest: hash(guide) },
      ...Object.entries(snapshot.facts).map(([name, facts]) => {
        const content = JSON.stringify(facts, null, 2);
        return { name, content, digest: hash(content) };
      }),
    ],
    createdAt: new Date().toISOString(),
    createdByUserId: f.state.userId,
    generatedPlan: {
      kind: 'saved-plan-v1',
      roadmapId: roadmap.id,
      definitionRevision: roadmap.definition.revision,
      snapshotDigest: snapshot.snapshotDigest,
    },
  };
  storage.runtimeEvidence.addSubmission(v1);
  await context.services.runtimeEvidenceService.decide(f.auth, ws, id, {
    submissionId: v1.id,
    outcome: 'accepted',
    rationale: 'Reviewed before the upgrade.',
  });
  expect(acceptedEvidence(storage, ws, id, 1, PLAN)?.id).toBe(v1.id);
  const v1Decision = storage.runtimeEvidence.decisions(ws).find((a) => a.submissionId === v1.id)!;
  /** The acceptance now held: carried into v2 from the v1 decision, with no input changed. */
  const carriedFromV1 = () => {
    const carried = acceptedEvidence(storage, ws, id, 1, PLAN)!;
    expect(carried.generatedPlan).toMatchObject({ kind: 'saved-plan-v2', changedInputs: [] });
    expect(
      storage.runtimeEvidence.decisions(ws).find((a) => a.submissionId === carried.id),
    ).toMatchObject({ outcome: 'accepted', carriedFrom: v1Decision.id });
    return carried;
  };
  return { f, ws, id, storage, context, roadmap, v1, carriedFromV1 };
}

// R-C6 D3: a v1 record keeps its frozen rule, so nothing re-opens at deploy.
it('validates a saved-plan-v1 acceptance with the frozen v1 rule', async () => {
  const { f, ws, id, storage, roadmap, v1, carriedFromV1 } = await acceptedV1();
  // Adopting the same proposals again changes neither the v1 facts nor the inputs.
  await adoptSupervisedMap(f);
  expect(acceptedEvidence(storage, ws, id, 1, PLAN)?.id).toBe(v1.id);
  // The frozen rule binds a v1 record to the saved revision, so a save that changes nothing
  // re-opens it; the operator's save carries it into v2, with no plan-acceptance input changed.
  f.service.save(f.auth, ws, { ...f.input, expectedVersion: roadmap.version });
  const carried = carriedFromV1();
  // v2 is not bound to the revision: the next save that changes nothing keeps it.
  f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: storage.roadmaps.find(ws, roadmap.id)!.version,
  });
  expect(acceptedEvidence(storage, ws, id, 1, PLAN)?.id).toBe(carried.id);
  expect(storage.runtimeEvidence.submissions(ws, id)).toHaveLength(2);
});

// The capacity saves change no plan-acceptance input, but the v1 rule covers the saved
// revision and host capacities: the operator's save carries a v1 acceptance into v2.
it('carries a v1 acceptance through a roadmap limits save', async () => {
  const { f, ws, roadmap, context, carriedFromV1 } = await acceptedV1();
  const current = context.storage.roadmaps.find(ws, roadmap.id)!;
  context.services.roadmapService.saveCapacity(f.auth, ws, roadmap.id, {
    expectedVersion: current.version,
    maxInFlight: (current.definition.scheduling?.maxInFlight ?? 2) + 1,
    maxPerRepository: current.definition.scheduling?.maxPerRepository ?? 2,
  });
  carriedFromV1();
});

it('carries a v1 acceptance through a host capacity save', async () => {
  const { f, ws, storage, context, carriedFromV1 } = await acceptedV1();
  context.services.hostSchedulingService.save(f.auth, ws, {
    expectedDevelopmentVersion: storage.phaseScheduling.setting('local-development').version,
    developmentCapacity: storage.phaseScheduling.capacity('local-development') + 1,
    expectedVersion: storage.phaseScheduling.setting('local-verification').version,
    verificationCapacity: storage.phaseScheduling.capacity('local-verification'),
  });
  carriedFromV1();
});
