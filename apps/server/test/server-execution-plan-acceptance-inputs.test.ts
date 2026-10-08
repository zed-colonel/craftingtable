import { createHash, randomUUID } from 'node:crypto';
import {
  type EvidenceSubmission,
  PLAN_ACCEPTANCE_INPUTS,
  type RuntimeGeneration,
} from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { savedPlanSnapshot } from '../src/services/plan-acceptance-policy.js';
import { acceptedEvidence } from '../src/services/runtime-evidence-policy.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  git,
  supervisedMapFixture,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

const PLAN = { kind: 'checkpoint' as const, sourceId: 'STACK-PLAN-ACCEPTED' };

/**
 * A saved cross-project roadmap whose generated STACK-PLAN-ACCEPTED evidence the operator
 * accepted, with the commands the tests change it through.
 */
async function acceptedPlan() {
  const f = await supervisedMapFixture(false, 'automatic', false, true);
  const { context, workspaceId: ws } = f.state;
  const storage = context.storage,
    svc = context.services.runtimeEvidenceService,
    id = f.parentScope.definitionId;
  await adoptSupervisedMap(f);
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
  ) =>
    f.service.save(f.auth, ws, {
      ...f.input,
      name,
      expectedVersion: storage.roadmaps.find(ws, roadmap.id)!.version,
      configuration: change(f.input.configuration),
    });
  const accepted = () => acceptedEvidence(storage, ws, id, 1, PLAN);
  const state = async () => (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!.state;
  return { f, ws, id, storage, svc, roadmap, first, generate, accept, save, accepted, state };
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
  save((c) => ({
    ...c,
    defaults: {
      ...c.defaults,
      profiles: {
        ...c.defaults.profiles,
        design: { ...c.defaults.profiles.design, model: 'review-model' },
      },
    },
  }));
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

it('re-opens STACK-PLAN-ACCEPTED when a save changes reviewer roles, naming the changed input', async () => {
  const { save, accepted, state, generate } = await acceptedPlan();
  save((c) => ({ ...c, defaults: { ...c.defaults, reviewerRoles: ['repository-maintainer'] } }));
  expect(accepted()).toBeUndefined();
  expect(await state()).toBe('ready-to-generate');
  const next = await generate();
  expect(next.generatedPlan).toMatchObject({
    kind: 'saved-plan-v2',
    changedInputs: ['reviewerRoles'],
  });
});

// R-C6 D3: a v1 record keeps its frozen rule, so nothing re-opens at deploy.
it('validates a saved-plan-v1 acceptance with the frozen v1 rule', async () => {
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
  // The frozen rule still binds a v1 record to the saved revision.
  f.service.save(f.auth, ws, { ...f.input, expectedVersion: roadmap.version });
  expect(acceptedEvidence(storage, ws, id, 1, PLAN)).toBeUndefined();
});
