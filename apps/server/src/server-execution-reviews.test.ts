import { randomUUID } from 'node:crypto';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import { agentSelections, asAgentRunId, asWorktreeId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import {
  acceptedEvidence,
  subjectRequirements as requireSubjectRequirements,
} from './services/runtime-evidence-policy.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  commitFile,
  currentCycle,
  cycleFixture,
  implementationDone,
  itNeedsCargo,
  merge,
  mutationHeaders,
  present,
  reviewScope,
  roadmapControl,
  runToFinish,
  scopeTree,
  slicedFixture,
  startCycle,
  stepDaemons,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

itNeedsCargo(
  'records explicit architecture approval, stages named consumers without passing the full ADR, and binds future reviews',
  async () => {
    const f = await slicedFixture((source) => ({
      ...source,
      planning_targets: [
        { id: 'LOCAL', checkpoint: 'LOCAL-ADR-01', scope: 'Local proof', is_release: false },
      ],
      terminal_checkpoint: 'LOCAL-ADR-01',
      checkpoints: [
        ...source.checkpoints,
        {
          ...source.checkpoints[0]!,
          id: 'LOCAL-ADR-01',
          decision_refs: [],
          owner: 'local',
          kind: 'architecture_decision',
          requires: [],
          pass_criteria: ['Approve the complete transport contract.'],
          evidence_profile: 'decision-review',
        },
      ],
      evidence_profiles: [
        ...source.evidence_profiles,
        {
          id: 'decision-review',
          required_evidence: [
            'accepted decision artifact digest and revision',
            'source contract and affected schema or protocol references',
            'decision owner approval and applicability to the active plan generation',
          ],
          reviewer_roles: ['repository-maintainer'],
          independence_required: true,
        },
      ],
      slices: source.slices.map((slice) => ({
        ...slice,
        merge_requires: [{ kind: 'checkpoint', id: 'LOCAL-ADR-01', state: 'passed' }],
      })),
    }));
    const { context, workspaceId: ws } = f.state,
      tx = context.storage,
      id = f.parentScope.definitionId;
    const svc = context.services.runtimeEvidenceService;
    context.services.crossProjectService.adopt(f.auth, ws, id, {
      bindingRevision: 1,
      decisionIds: ['CS-D01'],
      rationale: 'Adopt the exact fixture map.',
    });
    await svc.configure(f.auth, ws, id, {
      bindingRevision: 1,
      expectedGeneration: 0,
      pins: [],
      consumers: [{ alias: 'local', upstreams: [] }],
      environments: [
        {
          id: 'local',
          kind: 'local-development',
          identityDigest: '1'.repeat(64),
          fixtureDigest: '2'.repeat(64),
          toolchainDigest: '3'.repeat(64),
          authorization: 'Local fixtures',
        },
      ],
    });
    const designTree = await scopeTree(f, f.scopes[0]!);
    const decisionBrief = {
      checkpointId: 'LOCAL-ADR-01',
      decisionText: 'Use stable identifiers and the complete transport contract.',
      why: 'Preserves identity across replay.',
      alternatives: [{ option: 'Ephemeral identifiers', tradeoff: 'Loses replay identity' }],
      consequences: 'Implementation and independent verification remain required.',
      coverage: 'full',
      consumers: [],
      retainedObligations:
        'Independent implementation, qualification and release gates remain required.',
    };
    f.backend.replyForRequest = () => ({
      resultText:
        'ADR-01 recommends identifiers first.\n```craftingtable-design\n' +
        JSON.stringify({
          version: 1,
          items: [
            {
              kind: 'operator-decision',
              question: 'Approve LOCAL-ADR-01?',
              answer: 'Recommend stable identifiers.',
              sources: ['source-plan.md §4'],
              decision: decisionBrief,
            },
          ],
        }) +
        '\n```\n## Open questions\nApprove the decision?',
    });
    const sourceRunId = await runToFinish(f.state, designTree.id, { role: 'design' });
    const discovered = await svc.view(f.auth, ws, id);
    expect(
      discovered.architectureDecisions.designRuns.find((r) => r.id === sourceRunId)?.checkpointIds,
    ).toContain('LOCAL-ADR-01');
    const base = `/api/workspaces/${ws}/concurrency-definitions/${id}/runtime`;
    const inbox = discovered.decisionInbox;
    expect(inbox.decisions[0]?.recommendation?.brief).toEqual(decisionBrief);
    expect(inbox.decisions[0]?.sourceReferences).toContain('source-plan.md §4');
    expect(inbox.decisions[0]?.records).toEqual([]);
    const { architectureDecisionInbox } = await import('./services/architecture-decision-inbox.js');
    const input = {
      sourceRunId,
      sourceReportDigest: inbox.decisions[0]!.recommendation!.sourceReportDigest,
      checkpointId: 'LOCAL-ADR-01',
      bindingRevision: 1,
      coverage: 'clauses' as const,
      proposal: 'Approve identifiers for the domain slice only.',
      sourceReferences: 'source-plan.md §4 early definitions',
      retainedObligations:
        'The later slice still requires transport, credential and live-provider decisions.',
      consumers: [
        { sliceId: 'local/AQ-01/a', phase: 'merge' as const, replacesFullCheckpoint: true },
      ],
    };
    await expect(
      svc.proposeArchitectureDecision(f.auth, ws, id, {
        ...input,
        sourceReportDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow('recommendation changed');
    expect(tx.runtimeEvidence.submissions(ws, id)).toHaveLength(0);
    const forbidden = await context.app.inject({
      method: 'POST',
      url: `${base}/propose-decision`,
      headers: { cookie: f.state.cookie },
      payload: input,
    });
    expect(forbidden.statusCode).toBe(403);
    const response = await context.app.inject({
      method: 'POST',
      url: `${base}/propose-decision`,
      headers: mutationHeaders(f.state),
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(200);
    const submission = response.json().submissions[0].submission;
    expect(tx.runtimeEvidence.decisions(ws)).toHaveLength(0);
    expect(
      submission.artifacts.some(
        (a: { name: string }) => a.name === 'source-design-proposal-not-approval',
      ),
    ).toBe(true);
    expect(acceptedEvidence(tx, ws, id, 1, submission.subject)).toBeUndefined();
    const { stagedDecision, architectureDecisionDigest } = await import(
      './services/architecture-decision-policy.js'
    );
    const { mapReadSnapshot } = await import('./services/map-read-snapshot.js');
    const beforeApproval = mapReadSnapshot(tx);
    expect(architectureDecisionDigest(beforeApproval, ws, f.scopes[0]!)).toBeUndefined();
    expect(stagedDecision(tx, ws, f.scopes[0]!, 'LOCAL-ADR-01')).toBeUndefined();
    const before = architectureDecisionDigest(tx, ws, f.scopes[0]!);
    await svc.decide(f.auth, ws, id, {
      submissionId: submission.id,
      outcome: 'accepted',
      rationale: 'I approve these exact early clauses as repository maintainer.',
    });
    expect(stagedDecision(tx, ws, f.scopes[0]!, 'LOCAL-ADR-01')?.id).toBe(submission.id);
    expect(stagedDecision(tx, ws, f.scopes[1]!, 'LOCAL-ADR-01')).toBeUndefined();
    // The cycle workflow agrees with the merge gate: the staged clauses stand in for the full
    // checkpoint for slice a only, so a mergeable review of a is not stopped for LOCAL-ADR-01.
    const { workflowContext } = await import('./services/workflow-policy.js');
    const workflow = (scope: (typeof f.scopes)[number]) =>
      workflowContext(tx, {
        workspaceId: ws,
        workItemId: f.state.workItemId,
        executionScope: scope,
      } as import('@craftingtable/domain').WorkCycle)!.checkpoints.find(
        (c) => c.id === 'LOCAL-ADR-01',
      );
    expect(workflow(f.scopes[0]!)?.accepted).toBe(true);
    expect(workflow(f.scopes[1]!)?.accepted).toBe(false);
    expect(stagedDecision(tx, ws, f.parentScope, 'LOCAL-ADR-01')).toBeUndefined();
    const definition = tx.imports.definition(ws, id)!;
    expect(
      architectureDecisionInbox(tx, definition, f.scopes[0]).decisions[0]?.records[0],
    ).toMatchObject({
      applicable: true,
      issues: [],
      decision: { outcome: 'accepted' },
      proposal: { coverage: 'clauses' },
    });
    expect(
      architectureDecisionInbox(tx, definition, f.scopes[1]).decisions[0]?.records[0]?.applicable,
    ).toBe(false);
    expect(acceptedEvidence(tx, ws, id, 1, submission.subject)).toBeUndefined();
    expect(architectureDecisionDigest(tx, ws, f.scopes[0]!)).not.toBe(before);
    const afterApproval = mapReadSnapshot(tx);
    expect(architectureDecisionDigest(afterApproval, ws, f.scopes[0]!)).not.toBe(before);
    const { crossProjectState } = await import('./services/cross-project-service.js');
    const projected = crossProjectState(tx, ws, {
      definitionId: id,
      bindingRevision: 1,
      targetId: 'LOCAL',
      selection: 'prioritize-full',
    });
    const early = projected.nodes.find(
      (n) => n.sourceId === 'local/AQ-01/a' && n.state === 'merged',
    )!;
    expect(early.decisionCoverage?.[0]?.checkpoint).toBe('LOCAL-ADR-01');
    expect(early.requirements).not.toContain('checkpoint:LOCAL-ADR-01:passed');
    expect(early.originalRequirements).toContain('checkpoint:LOCAL-ADR-01:passed');
    expect(
      projected.nodes
        .find((n) => n.sourceId === 'local/AQ-01/b' && n.state === 'merged')
        ?.blockers.join(' '),
    ).toContain('LOCAL-ADR-01');

    await expect(
      svc.proposeArchitectureDecision(f.auth, ws, id, {
        ...input,
        consumers: [...input.consumers, { ...input.consumers[0]!, sliceId: 'local/AQ-01/b' }],
      }),
    ).rejects.toThrow('Retain at least one later slice');
    await expect(
      svc.proposeArchitectureDecision(f.auth, ws, id, {
        ...input,
        coverage: 'full',
      }),
    ).rejects.toThrow('Full approval cannot also stage');
    const fullView = await svc.proposeArchitectureDecision(f.auth, ws, id, {
      ...input,
      coverage: 'full',
      consumers: [],
      retainedObligations:
        'Independent implementation, qualification and release gates remain required.',
      proposal:
        'Approve the full contract, including transport, credentials and provider representation.',
    });
    const full = fullView.submissions.find(
      (s) => s.submission.architectureDecision?.coverage === 'full',
    )!.submission;
    expect(acceptedEvidence(tx, ws, id, 1, full.subject)).toBeUndefined();
    await svc.decide(f.auth, ws, id, {
      submissionId: full.id,
      outcome: 'accepted',
      rationale: 'Reviewed and approved the full contract.',
    });
    expect(acceptedEvidence(tx, ws, id, 1, full.subject)?.id).toBe(full.id);
    expect(
      architectureDecisionInbox(tx, definition, f.scopes[1]).decisions[0]?.records.find(
        (r) => r.id === full.id,
      ),
    ).toMatchObject({
      applicable: true,
      issues: [],
      decision: { outcome: 'accepted' },
      proposal: { coverage: 'full' },
    });
    const inboxResponse = await context.app.inject({
      method: 'GET',
      url: base,
      headers: { cookie: f.state.cookie },
    });
    expect(inboxResponse.statusCode, inboxResponse.body).toBe(200);
    expect(inboxResponse.json().decisionInbox.decisions[0].records[0].decision.outcome).toBe(
      'accepted',
    );
    await expect(
      svc.decide(f.auth, ws, id, {
        submissionId: full.id,
        outcome: 'accepted',
        rationale: 'Duplicate',
      }),
    ).rejects.toThrow('immutable decision');
    // Malformed agent output stays available through its source run, never a guessed brief.
    f.backend.replyForRequest = () => ({
      resultText:
        'Investigation facts remain readable.\n```craftingtable-design\n{"version":1,"items":[{"kind":"operator-decision","question":"LOCAL-ADR-01?","answer":"Choice","sources":[],"decision":{"checkpointId":"LOCAL-ADR-01"}}]}\n```\n## Open questions\nApprove LOCAL-ADR-01?',
    });
    const malformedRunId = await runToFinish(f.state, designTree.id, { role: 'design' });
    const malformed = architectureDecisionInbox(tx, definition, f.scopes[0]).decisions[0]
      ?.recommendation;
    expect(malformed?.sourceRunId).toBe(malformedRunId);
    expect(malformed?.classificationIssue).toContain('items.0.decision');
    expect(malformed?.brief).toBeUndefined();
    const binding = tx.imports.bindings(ws, id)[0]!;
    tx.imports.addBindings({ ...binding, revision: 2 });
    expect(acceptedEvidence(tx, ws, id, 2, full.subject)).toBeUndefined();
    expect(architectureDecisionDigest(mapReadSnapshot(tx), ws, f.scopes[0]!)).toBeUndefined();
    expect(
      architectureDecisionInbox(tx, definition).decisions[0]?.records[0]?.issues.join(' '),
    ).toContain('binding changed');
  },
);

it('does not implement a classified operator decision hidden behind Open questions none', async () => {
  const text =
    '```craftingtable-design\n' +
    JSON.stringify({
      version: 1,
      items: [
        {
          kind: 'operator-decision',
          question: 'Approve storage split?',
          answer: 'Recommend separate stores.',
          sources: ['plan §4'],
        },
      ],
    }) +
    '\n```\n## Open questions\nnone';
  const { state, backend, worktree } = await cycleFixture([{ resultText: text }]);
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'classified decision',
  );
  expect(currentCycle(state, cycle).reason).toContain('operator decision');
  expect(backend.launches).toHaveLength(1);
});

it('waits for an exact mapped slice merge, survives recovery, then bounds automatic design rechecks', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((slice, index) => ({
      ...slice,
      merge_requires: index === 1 ? [{ kind: 'slice', id: 'local/AQ-01/a', state: 'merged' }] : [],
    })),
  }));
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  const report =
    '```craftingtable-design\n' +
    JSON.stringify({
      version: 1,
      items: [
        {
          kind: 'dependency',
          question: 'Need the mapped predecessor result.',
          answer: '',
          sources: ['exact map merge requirement'],
          dependency: { kind: 'slice', id: 'local/AQ-01/a', state: 'merged' },
        },
      ],
    }) +
    '\n```\n## Open questions\nWaiting for local/AQ-01/a merge.';
  f.backend.replyForRequest = () => ({ resultText: report });
  const cycle = await startCycle(f.state, b.id);
  await waitFor(() => !!currentCycle(f.state, cycle).designWait, 'dependency wait');
  expect(currentCycle(f.state, cycle).status).toBe('running');
  const initial = f.backend.launches.length;
  f.state.context.services.workCycleService.recoverInterrupted();
  expect(currentCycle(f.state, cycle).status).toBe('running');
  await stepDaemons(3);
  expect(f.backend.launches).toHaveLength(initial);
  commitFile(a.path, 'prerequisite.txt', 'Complete the independent predecessor.');
  await reviewScope(f, a);
  f.backend.replyForRequest = () => ({ resultText: report });
  expect((await merge(f.state, a.id)).statusCode).toBe(200);
  await waitFor(
    () => currentCycle(f.state, cycle).status === 'needs-attention',
    'bounded dependency rechecks',
  );
  expect(currentCycle(f.state, cycle).designDependencyContinuations).toBe(2);
  expect(currentCycle(f.state, cycle).reason).toContain('Two automatic dependency continuations');
  expect(
    f.state.context.storage.execution.runs
      .listForWorktree(f.state.workspaceId, b.id)
      .map((r) => r.role),
  ).toEqual(['design', 'design', 'design']);
});

function withWorkflowReport(text: string, options: Record<string, unknown> = {}) {
  return (
    '```craftingtable-workflow\n' +
    JSON.stringify({
      version: 1,
      questions: [],
      resolved: [],
      securityReview: { required: false, sources: [] },
      ...options,
    }) +
    '\n```\n' +
    text
  );
}

itNeedsCargo(
  'schedules a distinct security review after a source-required review and retains exact candidate evidence',
  {
    timeout: 20000,
  },
  async () => {
    const f = await supervisedMapFixture(true);
    const original = f.backend.replyForRequest!;
    const security: AgentLaunchRequest[] = [];
    f.backend.replyForRequest = (request) => {
      const reply = original(request);
      if (request.model !== 'review-model') return reply;
      if (request.prompt.includes('This is a separate security review.')) security.push(request);
      return {
        ...reply,
        resultText: withWorkflowReport(reply.resultText!, {
          securityReview: { required: true, sources: ['Approved plan review policy'] },
        }),
      };
    };
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    await roadmapControl(f.state, 'start');
    await waitFor(
      () =>
        f.state.context.storage.execution.cycles
          .listForWorkspace(f.state.workspaceId)
          .some((c) => c.executionScope?.kind === 'slice' && c.status === 'completed'),
      'specialist-reviewed integration',
      12000,
    );
    expect(security).toHaveLength(1);
    const cycle = f.state.context.storage.execution.cycles
      .listForWorkspace(f.state.workspaceId)
      .find((c) => c.executionScope?.kind === 'slice')!;
    expect(cycle.workflow?.securityReceipt?.runId).toBeTruthy();
    expect(cycle.remediationRounds).toBe(0);
    expect(
      f.backend.launches.filter((r) => r.model === 'review-model').length,
    ).toBeGreaterThanOrEqual(2);
  },
);

itNeedsCargo.each([
  { kind: 'contract', valid: true },
  { kind: 'profile', valid: true },
  { kind: 'semantic_review', valid: true },
  { kind: 'contract', valid: false },
] as const)(
  'delegated $kind checkpoint requires complete attestation: $valid',
  { timeout: 20000 },
  async ({ kind, valid }) => {
    const f = await supervisedMapFixture(true, 'automatic', false, false, false, (source) => ({
      ...source,
      checkpoints: [
        ...source.checkpoints,
        {
          ...source.checkpoints[0]!,
          id: 'LOCAL-REVIEW',
          kind,
          owner: kind === 'semantic_review' ? 'stack' : 'local',
          requires: [],
          pass_criteria: ['Candidate boundary is sound'],
          evidence_profile: 'scope-review',
        },
      ],
      slices: source.slices.map((s, i) =>
        i
          ? s
          : {
              ...s,
              mode: 'domain',
              merge_requires: [{ kind: 'checkpoint', id: 'LOCAL-REVIEW', state: 'passed' }],
            },
      ),
    }));
    const original = f.backend.replyForRequest!;
    let independent = 0;
    f.backend.replyForRequest = (request) => {
      const reply = original(request);
      if (request.model !== 'review-model') return reply;
      const checkpoint = request.prompt.includes('This is a separate checkpoint review.');
      if (checkpoint) independent++;
      const def = f.state.context.storage.imports.definition(
        f.state.workspaceId,
        f.parentScope.definitionId,
      )!;
      const spec = requireSubjectRequirements(
        def,
        { kind: 'checkpoint', sourceId: 'LOCAL-REVIEW' },
        f.scopes[0]!.sourceId,
      );
      return {
        ...reply,
        resultText: withWorkflowReport(
          reply.resultText!,
          checkpoint
            ? {
                checkpoint: {
                  id: 'LOCAL-REVIEW',
                  passed: true,
                  requirements: (valid ? spec.requirements : []).map((requirement) => ({
                    requirement,
                    evidence: 'Independent exact-candidate check and fixture receipts',
                  })),
                  caseIds: spec.cases.map((c) => c.id),
                },
              }
            : {},
        ),
      };
    };
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    await roadmapControl(f.state, 'start');
    await waitFor(
      () =>
        f.state.context.storage.execution.cycles
          .listForWorkspace(f.state.workspaceId)
          .some(
            (c) =>
              c.executionScope?.kind === 'slice' &&
              c.status === (valid ? 'completed' : 'needs-attention'),
          ),
      'checkpoint-reviewed integration',
      12000,
    ).catch((error) => {
      throw new Error(
        `${error.message}: ${JSON.stringify(f.state.context.storage.execution.cycles.listForWorkspace(f.state.workspaceId).map((c) => ({ status: c.status, reason: c.reason, workflow: c.workflow })))}`,
      );
    });
    expect(independent).toBe(1);
    if (!valid) {
      const cycle = f.state.context.storage.execution.cycles
        .listForWorkspace(f.state.workspaceId)
        .find((c) => c.status === 'needs-attention')!;
      expect(cycle.reason).toContain('attestation');
      expect(
        f.state.context.storage.runtimeEvidence
          .submissions(f.state.workspaceId, f.parentScope.definitionId)
          .some((s) => s.subject.sourceId === 'LOCAL-REVIEW'),
      ).toBe(false);
      expect(
        f.state.context.storage.execution.worktrees.find(f.state.workspaceId, cycle.worktreeId)
          ?.mergedAt,
      ).toBeUndefined();
      return;
    }
    const evidence = f.state.context.storage.runtimeEvidence
      .submissions(f.state.workspaceId, f.parentScope.definitionId)
      .find((s) => s.subject.sourceId === 'LOCAL-REVIEW')!;
    expect(evidence.candidateCheckpoint?.delegatedReview?.roles).toContain('repository-maintainer');
    expect(evidence.executedBy).toMatch(/^review-run:/);
    expect(
      f.state.context.storage.runtimeEvidence
        .decisions(f.state.workspaceId)
        .find((d) => d.submissionId === evidence.id)?.outcome,
    ).toBe('accepted');
  },
);

itNeedsCargo(
  'reassesses an older implementation question read-only and leaves a genuine operator question at its named destination',
  {
    timeout: 20000,
  },
  async () => {
    const f = await supervisedMapFixture(true);
    const original = f.backend.replyForRequest!;
    f.backend.replyForRequest = (request) => {
      const reassessment = request.prompt.includes('This is a separate reassessment review.');
      const reply = original(reassessment ? { ...request, model: 'review-model' } : request);
      if (request.model === 'implement-model')
        return {
          ...reply,
          resultText:
            'Implementation complete.\n## Open questions\nShould the controller obtain the remaining checkpoint?',
        };
      if (!reassessment) return reply;
      return {
        ...reply,
        resultText: withWorkflowReport(
          reply.resultText!.replace(
            '## Open questions\nnone',
            '## Open questions\nChoose the new data-retention policy.',
          ),
          {
            questions: [
              { question: 'Choose the new data-retention policy.', destination: 'work-item' },
            ],
          },
        ),
      };
    };
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    await roadmapControl(f.state, 'start');
    await waitFor(
      () =>
        f.state.context.storage.execution.cycles
          .listForWorkspace(f.state.workspaceId)
          .some((c) => c.workflow?.questions.length === 1 && c.status === 'needs-attention'),
      'genuine question',
      12000,
    );
    const cycle = f.state.context.storage.execution.cycles
      .listForWorkspace(f.state.workspaceId)
      .find((c) => c.workflow?.questions.length)!;
    expect(cycle.workflow?.reassessments).toBe(1);
    expect(cycle.workflow?.questions[0]?.destination).toBe('work-item');
    expect(cycle.remediationRounds).toBe(0);
    expect(f.backend.launches.filter((r) => r.model === 'implement-model')).toHaveLength(1);
    const investigation = f.backend.launches.find((r) =>
      r.prompt.includes('This is a separate reassessment review.'),
    )!;
    expect(investigation.model).toBe('design-model');
    expect(investigation.permissionMode).toBe(cycle.profiles.review.permissionMode);
    expect(
      f.state.context.storage.execution.runs.find(f.state.workspaceId, cycle.currentRunId)
        ?.profileSelection?.purpose,
    ).toBe('investigation');
  },
);

itNeedsCargo(
  'shows a reassessment that cannot be prepared once instead of retrying it on every controller pass',
  {
    timeout: 20000,
  },
  async () => {
    const f = await supervisedMapFixture(true);
    const original = present(f.backend.replyForRequest);
    f.backend.replyForRequest = (request) => {
      const reply = original(request);
      return request.model === 'implement-model'
        ? {
            ...reply,
            resultText:
              'Implementation complete.\n## Open questions\nShould the controller obtain the remaining checkpoint?',
          }
        : reply;
    };
    const cycles = f.state.context.services.workCycleService as unknown as {
      startWorkflowReview: (...args: unknown[]) => Promise<void>;
    };
    let attempts = 0;
    vi.spyOn(cycles, 'startWorkflowReview').mockImplementation(async () => {
      attempts++;
      throw new Error('Unexpected preparation failure');
    });
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    await roadmapControl(f.state, 'start');
    const tx = f.state.context.storage,
      ws = f.state.workspaceId;
    await waitFor(() => attempts > 0, 'controller reassessment', 12000);
    await waitFor(
      () => tx.execution.cycles.listForWorkspace(ws).some((c) => c.reason.includes('reassessment')),
      'surfaced reassessment failure',
    );
    const surfaced = present(
      tx.execution.cycles.listForWorkspace(ws).find((c) => c.status !== 'completed'),
    );
    expect(surfaced.status).toBe('needs-attention');
    expect(surfaced.reason).toContain('Controller reassessment could not be prepared');
    await stepDaemons(3);
    expect(attempts).toBe(1);
    expect(present(tx.execution.cycles.find(ws, surfaced.id)).version).toBe(surfaced.version);
  },
);

itNeedsCargo(
  'repairs code findings before the separate security review without spending remediation on the review obligation',
  {
    timeout: 20000,
  },
  async () => {
    const f = await supervisedMapFixture(true);
    const original = f.backend.replyForRequest!;
    let fixed = false,
      securityRuns = 0;
    f.backend.replyForRequest = (request) => {
      if (request.model === 'remediate-model') {
        fixed = true;
        commitFile(request.cwd, 'guard.txt', 'Recovery guard fixed');
        return implementationDone;
      }
      const reply = original(request);
      if (request.model !== 'review-model') return reply;
      const specialist = request.prompt.includes('This is a separate security review.');
      if (specialist) {
        securityRuns++;
        expect(fixed).toBe(true);
      }
      const raw = reply.resultText!;
      const body = JSON.parse(raw.match(/```craftingtable-review\n([\s\S]*?)\n```/)![1]!);
      body.verdict = fixed ? 'mergeable' : 'changes-requested';
      body.exitGate.met = fixed;
      body.findings = [
        {
          id: 'RECOVERY-1',
          severity: 'major',
          status: fixed ? 'resolved' : 'open',
          title: 'Recovery guard bypass',
          explanation: 'A restricted state can reenter through an intermediate state.',
          recommendation: 'Apply the recovery guard to every operational path.',
          ...(fixed
            ? {
                disposition:
                  'Independent negative-path regression passed on the repaired candidate.',
              }
            : {}),
        },
      ];
      return {
        ...reply,
        resultText: withWorkflowReport(
          '## Open questions\nnone\n## Review report\n```craftingtable-review\n' +
            JSON.stringify(body) +
            '\n```\nVERDICT: ' +
            body.verdict,
          {
            securityReview: { required: true, sources: ['Approved security-sensitive PR policy'] },
          },
        ),
      };
    };
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    await roadmapControl(f.state, 'start');
    await waitFor(
      () =>
        f.state.context.storage.execution.cycles
          .listForWorkspace(f.state.workspaceId)
          .some((c) => c.executionScope?.kind === 'slice' && c.status === 'completed'),
      'repair then security review',
      12000,
    );
    const cycle = f.state.context.storage.execution.cycles
      .listForWorkspace(f.state.workspaceId)
      .find((c) => c.executionScope?.kind === 'slice')!;
    expect(cycle.remediationRounds).toBe(1);
    expect(securityRuns).toBe(1);
  },
);

itNeedsCargo(
  'holds a technical checkpoint for its mapped prerequisite without launching repeated reviews',
  {
    timeout: 15000,
  },
  async () => {
    const f = await supervisedMapFixture(true, 'automatic', false, false, false, (source) => ({
      ...source,
      checkpoints: [
        ...source.checkpoints,
        {
          ...source.checkpoints[0]!,
          id: 'LOCAL-ADR-01',
          kind: 'architecture_decision',
          owner: 'local',
          requires: [],
        },
        {
          ...source.checkpoints[0]!,
          id: 'LOCAL-PROFILE',
          kind: 'profile',
          owner: 'local',
          requires: [{ kind: 'checkpoint', id: 'LOCAL-ADR-01', state: 'passed' }],
        },
      ],
      slices: source.slices.map((s, i) =>
        i
          ? s
          : {
              ...s,
              mode: 'domain',
              merge_requires: [{ kind: 'checkpoint', id: 'LOCAL-PROFILE', state: 'passed' }],
            },
      ),
    }));
    const original = f.backend.replyForRequest!;
    f.backend.replyForRequest = (request) => {
      const reply = original(request);
      return request.model === 'review-model'
        ? { ...reply, resultText: withWorkflowReport(reply.resultText!) }
        : reply;
    };
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    await roadmapControl(f.state, 'start');
    await waitFor(
      () =>
        f.state.context.storage.execution.cycles
          .listForWorkspace(f.state.workspaceId)
          .some((c) => !!c.workflow?.waiting),
      'checkpoint dependency wait',
      6000,
    );
    const cycle = f.state.context.storage.execution.cycles
      .listForWorkspace(f.state.workspaceId)
      .find((c) => c.workflow?.waiting)!;
    expect(cycle.status).toBe('awaiting-merge');
    expect(cycle.workflow?.waiting).toContain('LOCAL-ADR-01');
    expect(cycle.remediationRounds).toBe(0);
    expect(f.backend.launches.filter((r) => r.model === 'review-model')).toHaveLength(1);
    expect(cycle.workflow?.activeReview).toBeUndefined();
  },
);

itNeedsCargo(
  'holds specialist review while scheduling is paused and invalidates its receipt when policy or dependency inputs change',
  {
    timeout: 20000,
  },
  async () => {
    const f = await supervisedMapFixture(true);
    const original = f.backend.replyForRequest!;
    let paused = false;
    f.backend.replyForRequest = (request) => {
      const reply = original(request);
      if (request.model !== 'review-model') return reply;
      if (!paused) {
        paused = true;
        const r = storedRoadmap(f.state);
        f.state.context.storage.roadmaps.save(
          { ...r, status: 'paused', version: r.version + 1 },
          r.version,
        );
      }
      return {
        ...reply,
        resultText: withWorkflowReport(reply.resultText!, {
          securityReview: { required: true, sources: ['Approved source review policy'] },
        }),
      };
    };
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    await roadmapControl(f.state, 'start');
    const cycles = () =>
      f.state.context.storage.execution.cycles.listForWorkspace(f.state.workspaceId);
    await waitFor(
      () => cycles().some((c) => c.status === 'awaiting-merge'),
      'paused specialist review',
      8000,
    );
    expect(f.backend.launches.filter((r) => r.model === 'review-model')).toHaveLength(1);
    expect(
      cycles().find((c) => c.status === 'awaiting-merge')?.workflow?.securityReceipt,
    ).toBeUndefined();
    await roadmapControl(f.state, 'resume');
    await waitFor(
      () => cycles().some((c) => c.status === 'completed'),
      'resumed specialist review',
      8000,
    );
    const cycle = cycles().find((c) => c.workflow?.securityReceipt)!;
    const run = f.state.context.storage.execution.runs.find(
      f.state.workspaceId,
      cycle.currentRunId,
    )!;
    const { securityReviewCurrent } = await import('./services/workflow-policy.js');
    expect(securityReviewCurrent(f.state.context.storage, cycle, run)).toBe(true);
    expect(
      securityReviewCurrent(f.state.context.storage, cycle, {
        ...run,
        reviewBranchContext: {
          ...run.reviewBranchContext!,
          repositoryPolicyVersion: 999,
        },
      }),
    ).toBe(false);
    expect(
      securityReviewCurrent(
        {
          ...f.state.context.storage,
          runtimeEvidence: Object.assign(Object.create(f.state.context.storage.runtimeEvidence), {
            run: () => undefined,
          }),
        },
        cycle,
        run,
      ),
    ).toBe(false);
  },
);

itNeedsCargo(
  'routes a classified review question into the shared ADR inbox without approving it',
  {
    timeout: 15000,
  },
  async () => {
    const f = await supervisedMapFixture(true, 'automatic', false, false, false, (source) => ({
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
          evidence_profile: 'architecture-approval',
          kind: 'architecture_decision',
          owner: 'local',
          requires: [],
        },
      ],
    }));
    const original = f.backend.replyForRequest!;
    f.backend.replyForRequest = (request) => {
      const reply = original(request);
      return request.model !== 'review-model'
        ? reply
        : {
            ...reply,
            resultText: withWorkflowReport(
              reply.resultText!.replace(
                '## Open questions\nnone',
                '## Open questions\nApprove LOCAL-ADR-01?',
              ),
              {
                questions: [
                  {
                    question: 'Approve LOCAL-ADR-01?',
                    destination: 'shared-decision',
                    checkpointId: 'LOCAL-ADR-01',
                  },
                ],
              },
            ),
          };
    };
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    await roadmapControl(f.state, 'start');
    const tx = f.state.context.storage;
    await waitFor(
      () =>
        tx.execution.cycles
          .listForWorkspace(f.state.workspaceId)
          .some((c) => c.workflow?.questions.length),
      'shared question',
      8000,
    );
    const cycle = tx.execution.cycles
      .listForWorkspace(f.state.workspaceId)
      .find((c) => c.workflow?.questions.length)!;
    expect(cycle.status).toBe('needs-attention');
    const { architectureDecisionInbox } = await import('./services/architecture-decision-inbox.js');
    const inbox = architectureDecisionInbox(
      tx,
      tx.imports.definition(f.state.workspaceId, f.parentScope.definitionId)!,
    );
    const adr = inbox.decisions.find((d) => d.checkpointId === 'LOCAL-ADR-01')!;
    expect(adr.recommendation?.sourceRunId).toBe(cycle.currentRunId);
    expect(adr.records).toHaveLength(0);
    expect(cycle.reason).toContain('Shared architecture decisions');
    await roadmapControl(f.state, 'pause');
    const view = await f.state.context.services.runtimeEvidenceService.proposeArchitectureDecision(
      f.auth,
      f.state.workspaceId,
      f.parentScope.definitionId,
      {
        bindingRevision: f.scopes[0]!.bindingRevision,
        checkpointId: 'LOCAL-ADR-01',
        sourceRunId: cycle.currentRunId,
        sourceReportDigest: adr.recommendation!.sourceReportDigest,
        coverage: 'full',
        proposal: 'Use the operator-approved boundary.',
        sourceReferences: adr.sourceReferences,
        consumers: [],
        retainedObligations: '',
      },
    );
    const proposal = view.submissions.find(
      (s) => s.submission.subject.sourceId === 'LOCAL-ADR-01',
    )!;
    expect(proposal.submission.sourceRunId).toBe(cycle.currentRunId);
    expect(
      proposal.submission.artifacts.some((a) => a.name === 'source-run-proposal-not-approval'),
    ).toBe(true);
    expect(proposal.decision).toBeUndefined();
  },
);

it('applies model-only roadmap choices without expiring accepted saved-plan evidence or changing delegation', async () => {
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
  const evidence = generated.submissions[0]!.submission;
  await svc.decide(f.auth, ws, id, {
    submissionId: evidence.id,
    outcome: 'accepted',
    rationale: 'Reviewed exact saved plan',
  });
  const selections = agentSelections(saved.definition.entries[0]!.profiles);
  const result = context.services.roadmapService.applyAgentSettings(f.auth, ws, saved.id, {
    expectedVersion: saved.version,
    entryIds: saved.definition.entries.map((e) => e.id),
    selections: {
      ...selections,
      implement: { backend: 'claude-code', model: 'new-implement-model' },
      remediate: { backend: 'claude-code', model: 'new-remediate-model' },
      security: { backend: 'claude-code', model: 'security-model' },
    },
  });
  const current = context.storage.roadmaps.find(ws, saved.id)!;
  expect(current.definition).toEqual(saved.definition);
  expect(current.attempts).toEqual(saved.attempts);
  expect(current.status).toBe('draft');
  expect(result.roadmaps[0]!.entries[0]!.selections.remediate.model).toBe('new-remediate-model');
  expect(acceptedEvidence(context.storage, ws, id, 1, evidence.subject)?.id).toBe(evidence.id);
  expect((await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!.snapshotDigest).toBe(
    ready.snapshotDigest,
  );
  expect(context.storage.runtimeEvidence.submissions(ws, id)).toHaveLength(1);
  expect(context.storage.roadmaps.history(ws, saved.id)).toHaveLength(1);
  const url = `/api/workspaces/${ws}/roadmaps/${saved.id}/agent-profiles`;
  const payload = {
    expectedVersion: current.version,
    entryIds: [saved.definition.entries[0]!.id],
    selections,
  };
  expect((await context.app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url,
        headers: { cookie: f.state.cookie },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url,
        headers: mutationHeaders(f.state),
        payload: {
          ...payload,
          selections: {
            ...selections,
            review: { ...selections.review, permissionMode: 'unrestricted' },
          },
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url,
        headers: mutationHeaders(f.state),
        payload: { ...payload, expectedVersion: saved.version },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url,
        headers: mutationHeaders(f.state),
        payload: { ...payload, entryIds: [randomUUID()] },
      })
    ).statusCode,
  ).toBe(409);
});

it('prepares a decision before gated development, keeps it proposal-only, and binds its report to the exact map', {
  timeout: 20000,
}, async () => {
  const f = await supervisedMapFixture(false, 'automatic', false, false, false, (source) => ({
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
        kind: 'architecture_decision',
        evidence_profile: 'architecture-approval',
        requires: [],
      },
    ],
    slices: source.slices.map((s) => ({
      ...s,
      start_requires: [{ kind: 'checkpoint', id: 'LOCAL-ADR-01', state: 'passed' }],
    })),
  }));
  const ws = f.state.workspaceId,
    tx = f.state.context.storage,
    roadmaps = f.state.context.services.roadmapService;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input).roadmap;
  const beforeEvidence = tx.runtimeEvidence.submissions(ws, f.parentScope.definitionId);
  const beforeItems = tx.planning.workItems.listForVersion(
    ws,
    saved.definition.entries[0]!.planVersionId,
  );
  const decision = {
    checkpointId: 'LOCAL-ADR-01',
    decisionText: 'Use the documented boundary.',
    why: 'The plan requires separation.',
    alternatives: [{ option: 'Shared mutable boundary', tradeoff: 'Weaker isolation' }],
    consequences: 'Test isolation later.',
    coverage: 'full',
    consumers: [],
    retainedObligations: 'Implementation tests remain mandatory.',
  };
  f.backend.replyForRequest = () => ({
    resultText:
      '## Open questions\nApprove LOCAL-ADR-01?\n```craftingtable-design\n' +
      JSON.stringify({
        version: 1,
        items: [
          {
            kind: 'operator-decision',
            question: 'Approve LOCAL-ADR-01?',
            answer: 'Use the documented boundary.',
            sources: ['Exact imported plan LOCAL-ADR-01'],
            decision,
          },
        ],
      }) +
      '\n```',
  });
  const url = `/api/workspaces/${ws}/roadmaps/${saved.id}/prepare-decision`;
  const payload = {
    expectedVersion: saved.version,
    checkpointId: 'LOCAL-ADR-01',
    profile: { backend: 'claude-code', model: 'decision-model' },
    minutes: 5,
    instructions: 'Focus on architectural choice, retain test obligations.',
  };
  expect((await f.state.context.app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
  expect(
    (
      await f.state.context.app.inject({
        method: 'POST',
        url,
        headers: { cookie: f.state.cookie },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  const launchBackend = f.backend.launch.bind(f.backend);
  let releaseLaunch!: () => void;
  const launchReady = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  const launchSpy = vi.spyOn(f.backend, 'launch').mockImplementation(async (request) => {
    await launchReady;
    return launchBackend(request);
  });
  const pending = f.state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(f.state),
    payload,
  });
  await waitFor(() => tx.execution.runs.listLive().length === 1, 'reserved preparation launch');
  const duplicate = await f.state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(f.state),
    payload: { ...payload, expectedVersion: storedRoadmap(f.state).version },
  });
  expect(duplicate.statusCode).toBe(409);
  releaseLaunch();
  const result = await pending;
  expect(launchSpy).toHaveBeenCalledTimes(1);
  expect(result.statusCode, result.body).toBe(200);
  const updated = storedRoadmap(f.state),
    prep = updated.decisionPreparations![0]!;
  await waitFor(
    () => tx.execution.runs.find(ws, prep.runId)?.status === 'finished',
    'standalone decision preparation',
  );
  expect(updated.definition).toEqual(saved.definition);
  expect(updated.attempts).toHaveLength(0);
  expect(updated.status).toBe('draft');
  expect(tx.execution.cycles.listForWorkspace(ws)).toHaveLength(0);
  expect(
    tx.planning.workItems.listForVersion(ws, saved.definition.entries[0]!.planVersionId),
  ).toEqual(beforeItems);
  expect(tx.runtimeEvidence.submissions(ws, prep.definitionId)).toEqual(beforeEvidence);
  const launch = f.backend.launches[0]!;
  expect(launch.readOnly).toBe(true);
  expect(launch.deadlineAt).toBe(prep.deadlineAt);
  expect(launch.prompt).toContain('LOCAL-ADR-01');
  expect(launch.prompt).toContain('decision-preparation/context.json');
  expect(launch.prompt).not.toContain('Plan finalization:');
  const tree = tx.execution.worktrees.find(ws, prep.worktreeId)!;
  expect(tree.workItemId).toBeUndefined();
  expect(tree.executionScope).toBeUndefined();
  expect(tree.baseSha).toBe(prep.integrationSha);
  const { architectureDecisionInbox } = await import('./services/architecture-decision-inbox.js');
  const definition = tx.imports.definition(ws, prep.definitionId)!;
  const card = architectureDecisionInbox(tx, definition).decisions.find(
    (c) => c.checkpointId === prep.checkpointId,
  )!;
  expect(card.recommendation?.brief).toEqual(decision);
  expect(card.recommendation?.investigation).toBe(true);
  expect(card.records).toHaveLength(0);
  const proposal =
    await f.state.context.services.runtimeEvidenceService.proposeArchitectureDecision(
      f.auth,
      ws,
      prep.definitionId,
      {
        bindingRevision: 1,
        checkpointId: prep.checkpointId,
        sourceRunId: prep.runId,
        sourceReportDigest: card.recommendation!.sourceReportDigest,
        coverage: 'full',
        proposal: decision.decisionText,
        sourceReferences: card.sourceReferences,
        consumers: [],
        retainedObligations: decision.retainedObligations,
      },
    );
  expect(
    proposal.submissions.find((s) => s.submission.subject.sourceId === prep.checkpointId)?.decision,
  ).toBeUndefined();
  await expect(
    f.state.context.services.executionService.mergeWorktree(f.auth, ws, prep.worktreeId),
  ).rejects.toThrow('cannot be merged');

  expect(
    (
      await f.state.context.app.inject({
        method: 'POST',
        url,
        headers: mutationHeaders(f.state),
        payload,
      })
    ).statusCode,
  ).toBe(409);
  // Rebinding makes prior preparation unavailable for new proposals without discarding history.
  const reservation = {
    ...prep,
    id: randomUUID(),
    runId: asAgentRunId(randomUUID()),
    worktreeId: asWorktreeId(randomUUID()),
  };
  const beforeRestart = storedRoadmap(f.state);
  tx.roadmaps.save(
    {
      ...beforeRestart,
      version: beforeRestart.version + 1,
      decisionPreparations: [...beforeRestart.decisionPreparations!, reservation],
    },
    beforeRestart.version,
  );
  roadmaps.recoverInterrupted();
  expect(storedRoadmap(f.state).decisionPreparations!.at(-1)?.failure).toContain(
    'restarted before launch',
  );
  expect(launchSpy).toHaveBeenCalledTimes(1);
  const binding = tx.imports.bindings(ws, prep.definitionId)[0]!;
  tx.imports.addBindings({ ...binding, revision: 2 });
  expect(
    architectureDecisionInbox(tx, definition).decisions.find(
      (c) => c.checkpointId === prep.checkpointId,
    )?.recommendation,
  ).toBeUndefined();
});

itNeedsCargo(
  'explicitly updates future delegation of started work without rewriting definitions, reports or accepted-plan evidence',
  {
    timeout: 20000,
  },
  async () => {
    const f = await supervisedMapFixture(true, 'manual', false, false, false, (source) => ({
      ...source,
      evidence_profiles: [
        ...source.evidence_profiles,
        {
          ...source.evidence_profiles[0]!,
          id: 'profile-review',
          reviewer_roles: ['profile-owner'],
        },
      ],
      checkpoints: [
        ...source.checkpoints,
        {
          ...source.checkpoints[0]!,
          id: 'LOCAL-PROFILE',
          owner: 'local',
          kind: 'profile',
          requires: [],
          evidence_profile: 'profile-review',
        },
      ],
      slices: source.slices.map((s, i) =>
        i
          ? s
          : {
              ...s,
              mode: 'domain',
              merge_requires: [{ kind: 'checkpoint', id: 'LOCAL-PROFILE', state: 'passed' }],
            },
      ),
    }));
    const originalReply = f.backend.replyForRequest!;
    f.backend.replyForRequest = (request) => {
      const reply = originalReply(request);
      if (request.model !== 'review-model') return reply;
      const checkpoint = request.prompt.includes('This is a separate checkpoint review.');
      const spec = requireSubjectRequirements(
        f.state.context.storage.imports.definition(
          f.state.workspaceId,
          f.parentScope.definitionId,
        )!,
        { kind: 'checkpoint', sourceId: 'LOCAL-PROFILE' },
        f.scopes[0]!.sourceId,
      );
      return {
        ...reply,
        resultText: withWorkflowReport(
          reply.resultText!,
          checkpoint
            ? {
                checkpoint: {
                  id: 'LOCAL-PROFILE',
                  passed: true,
                  requirements: spec.requirements.map((requirement) => ({
                    requirement,
                    evidence: 'Independent candidate inspection',
                  })),
                  caseIds: spec.cases.map((c) => c.id),
                },
              }
            : {},
        ),
      };
    };
    await adoptSupervisedMap(f);
    f.service.save(f.auth, f.state.workspaceId, f.input);
    const preview = f.service.view(f.auth, f.state.workspaceId, {
      definitionId: f.parentScope.definitionId,
      bindingRevision: 1,
      targetId: 'LOCAL',
      selection: 'target-only',
    });
    expect(preview.nodes.find((n) => n.sourceId === 'LOCAL-PROFILE')?.reviewerRoles).toContain(
      'profile-owner',
    );
    await roadmapControl(f.state, 'start');
    const tx = f.state.context.storage,
      ws = f.state.workspaceId;
    await waitFor(
      () =>
        tx.execution.cycles
          .listForWorkspace(ws)
          .some((c) => ['needs-attention', 'awaiting-merge'].includes(c.status)),
      'missing reviewer delegation',
      10000,
    );
    await roadmapControl(f.state, 'pause');
    const saved = storedRoadmap(f.state),
      attempt = saved.attempts[0]!,
      beforeRuns = tx.execution.runs.listForWorktree(ws, attempt.worktreeId);
    const input = {
      expectedVersion: saved.version,
      entryIds: [attempt.entryId],
      automation: {
        integrationMerge: 'automatic' as const,
        integrationConflicts: 'automatic' as const,
      },
      reviewerRoles: [
        'repository-maintainer',
        'independent-security-reviewer-if-required-by-source',
        'profile-owner',
      ],
      rationale: 'Delegate remaining technical reviews and integration recovery.',
    };
    const url = `/api/workspaces/${ws}/roadmaps/${saved.id}/delegation`;
    expect(
      (await f.state.context.app.inject({ method: 'POST', url, payload: input })).statusCode,
    ).toBe(401);
    const reply = await f.state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(f.state),
      payload: input,
    });
    expect(reply.statusCode, reply.body).toBe(200);
    const current = storedRoadmap(f.state);
    expect(current.status).toBe('paused');
    expect(current.definition).toEqual(saved.definition);
    expect(current.attempts).toEqual(saved.attempts);
    expect(tx.execution.runs.listForWorktree(ws, attempt.worktreeId)).toEqual(beforeRuns);
    expect(tx.roadmaps.history(ws, saved.id)).toHaveLength(1);
    const { workflowDelegation } = await import('./services/workflow-policy.js');
    expect(workflowDelegation(tx, tx.execution.cycles.find(ws, attempt.cycleId)!)?.roles).toContain(
      'profile-owner',
    );
    expect(
      (
        await f.state.context.app.inject({
          method: 'POST',
          url,
          headers: mutationHeaders(f.state),
          payload: input,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.state.context.app.inject({
          method: 'POST',
          url,
          headers: mutationHeaders(f.state),
          payload: {
            ...input,
            expectedVersion: current.version,
            reviewerRoles: ['invented-qualification'],
          },
        })
      ).statusCode,
    ).toBe(409);
    await roadmapControl(f.state, 'resume');
    await waitFor(
      () => !!tx.execution.worktrees.find(ws, attempt.worktreeId)?.mergedAt,
      'integration after explicit reviewer grant',
      10000,
    ).catch((error) => {
      throw new Error(
        `${error.message}: ${JSON.stringify(tx.execution.cycles.listForWorkspace(ws).map((c) => ({ status: c.status, reason: c.reason, workflow: c.workflow })))}; roadmap=${JSON.stringify(storedRoadmap(f.state).entryHolds)}`,
      );
    });
    const checkpoint = tx.runtimeEvidence
      .submissions(ws, f.parentScope.definitionId)
      .find((s) => s.subject.sourceId === 'LOCAL-PROFILE');
    expect(checkpoint?.candidateCheckpoint?.delegatedReview?.roles).toEqual(['profile-owner']);
  },
);
