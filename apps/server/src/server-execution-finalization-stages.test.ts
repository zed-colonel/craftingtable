import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLaunchRequest } from '@craftingtable/agents';
import { finalizationsResponseSchema } from '@craftingtable/contracts';
import {
  asPlanVersionId,
  DEFAULT_COMPLETION_POLICY,
  evaluateCycleCompletion,
  FINALIZATION_STAGE_KINDS,
} from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it } from 'vitest';
import { openDaemonStorage } from './persisted-records.js';
import { assessStageReport, stagedPromotionIssue } from './services/finalization-stage-policy.js';
import { requiredFindingIds } from './services/run-handoff.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  beginFinalization,
  CycleBackend,
  cleanupExecutionFixtures,
  commitFile,
  cycleProfiles,
  finalizationCommand,
  finalizationCycle,
  finalizationFixture,
  git,
  merge,
  present,
  reviewText,
  runDetail,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

it('an incomplete finalization review retains concerns and cannot close findings or supply a verdict', {
  timeout: 15000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend } = fixture;
  let review = 0;
  backend.replyForRequest = (request) => {
    if (request.model?.includes('polish'))
      return { resultText: 'Polish complete.\n\n## Open questions\nnone' };
    review++;
    const findings =
      review === 1
        ? [structuredFinding]
        : review === 2
          ? [
              {
                ...structuredFinding,
                status: 'resolved',
                disposition: 'Claimed fixed before background checks completed.',
              },
              { ...structuredFinding, id: 'F-002', title: 'A newly discovered concern' },
            ]
          : [];
    return {
      resultText: `## Open questions\nnone\n\n## Review report\n${reviewText(findings)}`,
      ...(review === 2 ? { exitReason: 'background-work-incomplete' as const } : {}),
    };
  };
  const value = await beginFinalization(fixture);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'missing unclosed findings',
  );
  const cycle = finalizationCycle(state, value);
  expect(cycle.reason).toContain('F-001');
  expect(cycle.reason).toContain('F-002');
  const runs = state.context.storage.execution.runs.listForWorktree(
    state.workspaceId,
    cycle.worktreeId,
  );
  const failed = present(runs.find((r) => r.status === 'failed'));
  const detail = await runDetail(state, failed.id);
  expect(detail.run.verdict).toBeUndefined();
  expect(detail.reviewReport?.status).toBe('invalid');
  expect(detail.completionIssue?.reason).toBe('background-work-incomplete');
  const next = present(runs.find((r) => r.id === cycle.currentRunId));
  expect([...requiredFindingIds(state.context.storage.execution, next)].sort()).toEqual([
    'F-001',
    'F-002',
  ]);
  // Dropping open findings is missing content, not format: it stops at once (R-C2).
  expect(backend.repairs).toBe(0);
  expect(backend.launches).toHaveLength(4 + backend.repairs);
  expect(backend.launches[3]?.prompt).toContain('Reuse recorded passing checks only when');
  expect(backend.launches[3]?.prompt).not.toContain(
    'The prior review is incomplete or its candidate/destination snapshot cannot be reused',
  );
});

async function findingCheckpointFixture(severity: 'nit' | 'minor' = 'nit', questions = true) {
  const fixture = await finalizationFixture();
  const nit = { ...structuredFinding, severity };
  fixture.backend.replyForRequest = () => ({
    resultText: `## Open questions\n${questions ? 'Fix or defer this finding?' : 'none'}\n\n## Review report\n${reviewText([nit])}`,
  });
  const value = await beginFinalization(fixture, {
    ...fixture.input,
    rounds: [],
    policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
  });
  await waitFor(
    () => finalizationCycle(fixture.state, value).status === 'needs-attention',
    'finding decision',
  );
  return { ...fixture, value, nit };
}

describe('finalization finding decisions', () => {
  it('defers an open nit with provenance, requires fresh independent review, and retains explicit promotion', async () => {
    const { state, backend, value, nit, root } = await findingCheckpointFixture();
    const main = git(['rev-parse', 'main'], root).trim();
    backend.replyForRequest = (request) => {
      expect(request.prompt).toContain('Operator-deferred nits');
      expect(request.prompt).toContain('These findings remain OPEN');
      return { resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([nit])}` };
    };
    const response = await finalizationCommand(state, value, 'defer-nits', {
      findingIds: [nit.id],
      rationale: 'Optional cleanup deferred to follow-up.',
      instructions: 'Defer this nit; no source changes are authorized.',
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'independent review',
    );
    expect(backend.launches).toHaveLength(2);
    expect(backend.launches[1]?.model).toBe('final-review-model');
    const cycle = finalizationCycle(state, value);
    expect(cycle.remediationRounds).toBe(0);
    expect(cycle.reason).toContain('Final independent review meets the completion policy');
    expect(cycle.deferredNits?.[0]).toMatchObject({
      finding: { id: nit.id, status: 'open' },
      createdByUserId: state.userId,
    });
    const reopened = openDaemonStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(state.workspaceId, cycle.id)?.deferredNits).toEqual(
        cycle.deferredNits,
      );
    } finally {
      reopened.close();
    }
    expect(git(['rev-parse', 'main'], root).trim()).toBe(main);
    expect((await merge(state, value.worktreeId)).statusCode).toBe(409);
    const tree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
    );
    const approval = await finalizationCommand(state, value, 'merge', {
      expectedHeadSha: git(['rev-parse', 'HEAD'], tree.path).trim(),
      expectedTargetSha: main,
    });
    expect(approval.statusCode, approval.body).toBe(200);
  });

  it.each(['higher severity', 'changed details', 'technical gate', 'question'])(
    'does not let deferral bypass a subsequent %s',
    async (change) => {
      const { state, backend, value, nit } = await findingCheckpointFixture();
      backend.replyForRequest = () => ({
        resultText: `## Open questions\n${change === 'question' ? 'May I change the API?' : 'none'}\n\n## Review report\n${reviewText(
          [
            change === 'higher severity'
              ? { ...nit, severity: 'minor' }
              : change === 'changed details'
                ? { ...nit, explanation: 'Different concern' }
                : nit,
          ],
        ).replaceAll(
          change === 'technical gate' ? 'mergeable' : '__unchanged__',
          'changes-requested',
        )}`,
      });
      expect(
        (
          await finalizationCommand(state, value, 'defer-nits', {
            findingIds: [nit.id],
            rationale: 'Optional cleanup.',
          })
        ).statusCode,
      ).toBe(200);
      await waitFor(
        () => finalizationCycle(state, value).status === 'needs-attention',
        'new blocker',
      );
      expect(backend.launches).toHaveLength(2);
      expect((await merge(state, value.worktreeId)).statusCode).toBe(409);
    },
  );

  it.each(['head', 'target', 'minor', 'unknown'])(
    'rejects a finding decision after %s changes',
    async (change) => {
      const { state, value, nit, root } = await findingCheckpointFixture(
        change === 'minor' ? 'minor' : 'nit',
      );
      const tree = present(
        state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
      );
      if (change === 'head') commitFile(tree.path, 'changed.txt', 'changed');
      if (change === 'target') commitFile(root, 'changed.txt', 'changed');
      const response = await finalizationCommand(state, value, 'defer-nits', {
        findingIds: [change === 'unknown' ? 'F-missing' : nit.id],
        rationale: 'Optional cleanup.',
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(finalizationCycle(state, value).deferredNits).toBeUndefined();
    },
  );

  it.each([true, false])(
    'grants focused attempts at an exhausted final review, with open questions: %s',
    async (questions) => {
      const { state, backend, value, nit } = await findingCheckpointFixture('minor', questions);
      backend.replyForRequest = (request) => {
        expect(request.prompt).toContain('Focused remediation batch:');
        if (request.model?.includes('polish') || request.model === 'review-model')
          return { resultText: 'Completed selected cleanup.\n\n## Open questions\nnone' };
        return {
          resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([{ ...nit, status: 'resolved', disposition: 'Selected cleanup verified.' }])}`,
        };
      };
      const response = await finalizationCommand(state, value, 'remediate-findings', {
        findingIds: [nit.id],
        rationale: 'Address this exact cleanup.',
        instructions: 'Fix the selected nit; preserve behavior.',
        additionalRounds: 1,
      });
      expect(response.statusCode, response.body).toBe(200);
      await waitFor(
        () => finalizationCycle(state, value).status === 'awaiting-merge',
        'focused verification',
      );
      expect(finalizationCycle(state, value)).toMatchObject({
        remediationRounds: 1,
        additionalRemediationRounds: 1,
        findingFocus: [nit.id],
      });
      expect(backend.launches).toHaveLength(3);
    },
  );
});

describe('finalization recovery agent selection', () => {
  it.each(['remediate-findings', 'authorize-remediation', 'defer-nits', 'resume'])(
    'switches backend for %s and all later reviews, retaining history and permissions',
    async (action) => {
      const codex = new CycleBackend([], 'codex');
      const fixture = await finalizationFixture({ alternateBackend: codex });
      const { state, backend } = fixture;
      const finding = {
        ...structuredFinding,
        severity: action === 'defer-nits' ? ('nit' as const) : ('minor' as const),
      };
      backend.replyForRequest = () =>
        action === 'resume'
          ? {
              resultText:
                'Interrupted review.\n\n## Open questions\nChoose a backend to finish verification.',
              exitReason: 'background-work-incomplete',
            }
          : { resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([finding])}` };
      const value = await beginFinalization(fixture, {
        ...fixture.input,
        rounds: [],
        finalReview: { ...fixture.input.finalReview, permissionMode: 'edit-only' },
        policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
      });
      await waitFor(
        () => finalizationCycle(state, value).status === 'needs-attention',
        'recovery checkpoint',
      );
      const originalCycle = finalizationCycle(state, value);
      const parent = originalCycle.currentRunId;
      const findings =
        action === 'resume'
          ? []
          : action === 'defer-nits'
            ? [finding]
            : [{ ...finding, status: 'resolved' as const, disposition: 'Verified selected fix.' }];
      codex.replyForRequest = (request) => ({
        resultText: /^Role: review$/m.test(request.prompt)
          ? `## Open questions\nnone\n\n## Review report\n${reviewText(findings)}`
          : 'Fix completed.\n\n## Open questions\nnone',
      });
      const agentOverride = { backend: 'codex', model: 'astra-fixture' };
      const response = await finalizationCommand(state, value, action, {
        agentOverride,
        ...(['remediate-findings', 'authorize-remediation'].includes(action)
          ? { additionalRounds: 1 }
          : {}),
        ...(['remediate-findings', 'defer-nits'].includes(action)
          ? { findingIds: [finding.id], rationale: 'Explicit finding decision.' }
          : {}),
      });
      expect(response.statusCode, response.body).toBe(200);
      await waitFor(
        () => finalizationCycle(state, value).status === 'awaiting-merge',
        'Codex final review',
      );
      expect(backend.launches).toHaveLength(1);
      expect(codex.launches.length).toBe(
        ['remediate-findings', 'authorize-remediation'].includes(action) ? 2 : 1,
      );
      expect(codex.launches.every((r) => r.model === 'astra-fixture')).toBe(true);
      expect(codex.launches.at(-1)?.permissionMode).toBe('edit-only');
      expect(
        state.context.storage.execution.runs
          .listForWorktree(state.workspaceId, value.worktreeId)
          .some((r) => r.backend === 'codex' && r.parentRunId === parent),
      ).toBe(true);
      const cycle = finalizationCycle(state, value);
      const reopened = openDaemonStorage(state.context.storage.databasePath);
      try {
        expect(
          reopened.execution.cycles.find(state.workspaceId, cycle.id)?.finalizationAgentOverride,
        ).toEqual(agentOverride);
      } finally {
        reopened.close();
      }
      expect(
        state.context.storage.execution.finalizations.find(state.workspaceId, value.id)
          ?.finalReview,
      ).toEqual(value.finalReview);
      expect(
        state.context.storage.audit
          .listWorkspace({ workspaceId: state.workspaceId, limit: 100 })
          .some(
            (e) =>
              e.metadata?.finalizationAgentOverride &&
              JSON.stringify(e.metadata.finalizationAgentOverride) ===
                JSON.stringify(agentOverride),
          ),
      ).toBe(true);
      expect(
        (
          await finalizationCommand(state, value, 'resume', {
            agentOverride: null,
            expectedCycleVersion: originalCycle.version,
          })
        ).statusCode,
      ).toBe(409);
      expect(finalizationCycle(state, value)).toEqual(cycle);
      if (action === 'remediate-findings') {
        await finalizationCommand(state, value, 'pause');
        backend.replyForRequest = () => ({
          resultText: `## Open questions\nnone\n\n## Review report\n${reviewText(findings)}`,
        });
        expect(
          (await finalizationCommand(state, value, 'resume', { agentOverride: null })).statusCode,
        ).toBe(200);
        await waitFor(
          () => finalizationCycle(state, value).status === 'awaiting-merge',
          'restored review',
        );
        expect(backend.launches.at(-1)?.model).toBe('final-review-model');
        expect(finalizationCycle(state, value).finalizationAgentOverride).toBeNull();
        expect(finalizationCycle(state, value).remediationRounds).toBe(cycle.remediationRounds);
      }
    },
  );
  it('rejects unavailable recovery backends without consuming allowance or replacing the reservation', async () => {
    const { state, value, nit } = await findingCheckpointFixture();
    const before = finalizationCycle(state, value);
    const response = await finalizationCommand(state, value, 'remediate-findings', {
      findingIds: [nit.id],
      rationale: 'Address this finding.',
      additionalRounds: 2,
      agentOverride: { backend: 'codex' },
    });
    expect(response.statusCode).toBe(503);
    expect(finalizationCycle(state, value)).toEqual(before);
  });
});

describe('completed plan and integration branch cleanup', () => {
  async function reviewForPromotion(options: Parameters<typeof finalizationFixture>[0] = {}) {
    const fixture = await finalizationFixture(options);
    const value = await beginFinalization(fixture, { ...fixture.input, rounds: [] });
    await waitFor(
      () => finalizationCycle(fixture.state, value).status === 'awaiting-merge',
      'final review',
    );
    const cycle = finalizationCycle(fixture.state, value);
    const reviewed = present(
      present(
        fixture.state.context.storage.execution.runs.find(
          fixture.state.workspaceId,
          cycle.currentRunId,
        ),
      ).reviewBranchContext,
    );
    return {
      ...fixture,
      value,
      approval: { expectedHeadSha: reviewed.headSha, expectedTargetSha: reviewed.targetSha },
    };
  }

  it('projects historical completion everywhere, scoped to the promoted plan version, and allows later cleanup', async () => {
    const { state, value, root, approval } = await reviewForPromotion();
    expect((await finalizationCommand(state, value, 'remove-integration-branch')).statusCode).toBe(
      409,
    );
    expect((await finalizationCommand(state, value, 'merge', approval)).statusCode).toBe(200);
    const main = git(['rev-parse', 'main'], root).trim();
    expect(git(['rev-parse', 'revision'], root).trim()).toBe(value.integrationSha);
    state.context.storage.planning.projects.setActivePlanVersionIfUnset({
      workspaceId: state.workspaceId,
      projectId: value.projectId,
      planVersionId: value.planVersionId,
    });
    const completion = {
      finalizationId: value.id,
      targetBranch: 'main',
      mergeSha: main,
      completedAt: expect.any(String),
    };
    for (const [url, pick] of [
      [`projects`, (body: { projects: { completion?: unknown }[] }) => present(body.projects[0])],
      [
        `projects/${value.projectId}`,
        (body: { project: { completion?: unknown } }) => body.project,
      ],
      [
        `projects/${value.projectId}/plan-versions/${value.planVersionId}`,
        (body: { version: { completion?: unknown } }) => body.version,
      ],
      ['snapshot', (body: { projects: { completion?: unknown }[] }) => present(body.projects[0])],
    ] as const) {
      const response = await state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${state.workspaceId}/${url}`,
        headers: { cookie: state.cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(pick(response.json()).completion).toEqual(completion);
    }
    // A later import is preserved independently and never inherits completion.
    const plan = present(
      state.context.storage.planning.versions.find(state.workspaceId, value.planVersionId),
    );
    const next = state.context.storage.planning.versions.insert({
      ...plan,
      id: asPlanVersionId('version-2'),
      versionNumber: 2,
      contentDigest: 'a'.repeat(64),
    });
    expect(
      state.context.storage.planning.queries.versionSummaries(state.workspaceId, value.projectId),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: value.planVersionId, completion }),
        expect.objectContaining({ id: next.id }),
      ]),
    );
    expect(
      state.context.storage.planning.queries.versionCompletion(state.workspaceId, next.id),
    ).toBeUndefined();
    const cleaned = await finalizationCommand(state, value, 'remove-integration-branch', {
      expectedCycleVersion: 1,
    });
    expect(cleaned.statusCode, cleaned.body).toBe(200);
    expect(cleaned.json().finalization).toMatchObject({
      status: 'completed',
      integrationCleanup: { status: 'removed', requestedByUserId: state.userId },
    });
    expect(git(['branch', '--list', 'revision'], root).trim()).toBe('');
    expect(git(['rev-parse', 'main'], root).trim()).toBe(main);
    const settings = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/plan-versions/${value.planVersionId}/branch-settings`,
      headers: { cookie: state.cookie },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json()).toMatchObject({ integrationBranchRemoved: true, issues: [] });
    // A retry of an already completed removal must never delete a recreated branch.
    git(['branch', 'revision', 'main'], root);
    expect((await finalizationCommand(state, value, 'remove-integration-branch')).statusCode).toBe(
      200,
    );
    expect(git(['rev-parse', 'revision'], root).trim()).toBe(main);
  });

  it('retains opt-in through merge interruption and reconciles cleanup without merging twice', async () => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let merges = 0;
    const { state, value, root, approval } = await reviewForPromotion({
      gitOperations: {
        ...real,
        mergeBranch: async (input) => {
          merges++;
          await real.mergeBranch(input);
          throw new Error('Simulated interruption after Git commit');
        },
      },
    });
    expect(
      (
        await finalizationCommand(state, value, 'merge', {
          ...approval,
          removeIntegrationBranch: true,
        })
      ).statusCode,
    ).toBe(500);
    const main = git(['rev-parse', 'main'], root);
    const reopened = openDaemonStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.merges.latest(state.workspaceId, value.worktreeId)).toMatchObject({
        status: 'reserved',
        removeIntegrationBranch: true,
      });
    } finally {
      reopened.close();
    }
    const retry = await finalizationCommand(state, value, 'merge', approval);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().finalization.integrationCleanup.status).toBe('removed');
    expect(git(['branch', '--list', 'revision'], root).trim()).toBe('');
    expect(git(['rev-parse', 'main'], root)).toBe(main);
    expect(merges).toBe(1);
  });

  it('retries cleanup after deletion but before its acknowledgement without redoing promotion', async () => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let interrupted = false;
    const { state, value, root, approval } = await reviewForPromotion({
      gitOperations: {
        ...real,
        deleteBranch: async (input) => {
          const result = await real.deleteBranch(input);
          if (input.branchName === 'revision' && !interrupted) {
            interrupted = true;
            throw new Error('Simulated lost cleanup acknowledgement');
          }
          return result;
        },
      },
    });
    const response = await finalizationCommand(state, value, 'merge', {
      ...approval,
      removeIntegrationBranch: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().finalization).toMatchObject({
      status: 'completed',
      integrationCleanup: { status: 'blocked' },
    });
    const main = git(['rev-parse', 'main'], root);
    const reopened = openDaemonStorage(state.context.storage.databasePath);
    try {
      expect(
        reopened.execution.finalizations.find(state.workspaceId, value.id)?.integrationCleanup
          ?.status,
      ).toBe('blocked');
    } finally {
      reopened.close();
    }
    const retry = await finalizationCommand(state, value, 'remove-integration-branch');
    expect(retry.json().finalization.integrationCleanup.status).toBe('removed');
    expect(git(['rev-parse', 'main'], root)).toBe(main);
  });

  it.each(['advanced', 'checked-out', 'protected', 'shared', 'destination-rewound'] as const)(
    'retains a %s branch while leaving the plan completed',
    async (reason) => {
      const { state, value, root, approval } = await reviewForPromotion();
      expect((await finalizationCommand(state, value, 'merge', approval)).statusCode).toBe(200);
      const settings = present(
        state.context.storage.execution.branchSettings.find(state.workspaceId, value.planVersionId),
      );
      if (reason === 'advanced') git(['branch', '-f', 'revision', 'main'], root);
      if (reason === 'checked-out') git(['checkout', 'revision'], root);
      if (reason === 'protected')
        state.context.storage.execution.branchSettings.save(
          { ...settings, manualMergeBranches: ['revision'], version: settings.version + 1 },
          settings.version,
        );
      if (reason === 'shared') {
        const plan = present(
          state.context.storage.planning.versions.find(state.workspaceId, value.planVersionId),
        );
        const next = state.context.storage.planning.versions.insert({
          ...plan,
          id: asPlanVersionId('version-2'),
          versionNumber: 2,
          contentDigest: 'b'.repeat(64),
        });
        state.context.storage.execution.branchSettings.save(
          { ...settings, planVersionId: next.id, version: 1 },
          0,
        );
      }
      if (reason === 'destination-rewound') git(['reset', '--hard', value.targetSha], root);
      const before = git(['rev-parse', 'revision'], root);
      const response = await finalizationCommand(state, value, 'remove-integration-branch');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().finalization).toMatchObject({
        status: 'completed',
        integrationCleanup: { status: 'blocked', error: expect.any(String) },
      });
      expect(git(['rev-parse', 'revision'], root)).toBe(before);
    },
  );
});

function stagedInput(fixture: Awaited<ReturnType<typeof finalizationFixture>>) {
  return {
    ...fixture.input,
    rounds: [],
    stages: FINALIZATION_STAGE_KINDS.map((kind) => ({
      id: kind,
      kind,
      name: kind,
      instructions: `${kind} focus`,
      workItemSourceIds: [],
      review: { ...cycleProfiles.review, model: `${kind}-review` },
      implement: { ...cycleProfiles.remediate, model: `${kind}-implement` },
      policy: { ...DEFAULT_COMPLETION_POLICY, maxNits: 100, maxRemediationRounds: 1 },
      requiredChecks: ['fixture checks'],
    })),
  };
}
function stagedLedger(request: AgentLaunchRequest) {
  const path = /`([^`]+\/craftingtable-finalization-state\.json)`/.exec(request.prompt)?.[1];
  if (!path) throw new Error('Expected staged evidence handoff');
  return JSON.parse(readFileSync(path, 'utf8')) as {
    stages: import('@craftingtable/domain').FinalizationStage[];
    progress: import('@craftingtable/domain').FinalizationProgress;
    reviewBaseline: import('@craftingtable/domain').ReviewBranchContext;
  };
}
function stagedText(
  request: AgentLaunchRequest,
  findings: readonly unknown[] = [],
  overrides: {
    questions?: string;
    evidence?: Record<string, unknown>;
    met?: boolean;
  } = {},
) {
  const ledger = stagedLedger(request);
  const stage = present(ledger.stages[ledger.progress.stageIndex]);
  const verdict = overrides.met === false ? 'changes-requested' : 'mergeable';
  return `## Open questions\n${overrides.questions ?? 'none'}\n\n## Review report\n\`\`\`craftingtable-review\n${JSON.stringify(
    {
      version: 1,
      complete: true,
      verdict,
      exitGate: {
        met: overrides.met ?? true,
        evidence: 'Fixture checks and obligations assessed.',
      },
      findings,
      finalization: {
        stageId: stage.id,
        fullChecks: stage.kind === 'final-review',
        checks: [
          {
            name: 'fixture checks',
            status: 'passed',
            evidence: 'Fixture suite passed at this candidate.',
          },
        ],
        obligations: ledger.progress.obligations.map((o) => ({
          id: o.id,
          status: 'met',
          evidence: 'feature.txt implementation and fixture checks.',
        })),
        ...overrides.evidence,
      },
    },
  )}\n\`\`\`\nVERDICT: ${verdict}`;
}
const stageIdea = {
  ...structuredFinding,
  id: 'S-1',
  category: 'simplification',
  severity: 'minor',
};

describe('staged finalization', () => {
  it('selects one optional batch, retains follow-ups and independently verifies before explicit promotion', {
    timeout: 20000,
  }, async () => {
    const fixture = await finalizationFixture();
    const { state, backend, root } = fixture;
    const input = stagedInput(fixture);
    input.stages = input.stages.map((s) =>
      s.kind === 'simplification' ? { ...s, policy: { ...s.policy, maxRemediationRounds: 0 } } : s,
    );
    const main = git(['rev-parse', 'main'], root);
    let implemented = false;
    backend.onLaunch = (request) => {
      if (request.model === 'simplification-implement') {
        implemented = true;
        commitFile(request.cwd, 'simplified.txt', 'selected S-1 only\n');
      }
    };
    backend.replyForRequest = (request) => {
      if (request.model?.endsWith('-implement'))
        return { resultText: 'Selected batch committed.\n\n## Open questions\nnone' };
      const ledger = stagedLedger(request);
      const current = ledger.stages[ledger.progress.stageIndex];
      const findings =
        current?.kind === 'simplification'
          ? implemented
            ? [
                { ...stageIdea, status: 'resolved', disposition: 'Verified simplified.txt.' },
                { ...stageIdea, id: 'S-3', title: 'A new optional idea' },
              ]
            : [stageIdea, { ...stageIdea, id: 'S-2', title: 'Another optional idea' }]
          : [];
      return { resultText: stagedText(request, findings) };
    };
    const value = await beginFinalization(fixture, input);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'optional selection',
      8000,
    );
    expect(finalizationCycle(state, value).finalizationProgress?.stageIndex).toBe(2);
    expect(finalizationCycle(state, value).finalizationProgress?.stages[2]?.status).toBe(
      'selecting',
    );
    expect(
      (await finalizationCommand(state, value, 'authorize-remediation', { additionalRounds: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await finalizationCommand(state, value, 'remediate-findings', {
          findingIds: ['S-1'],
          rationale: 'select',
          additionalRounds: 1,
        })
      ).statusCode,
    ).toBe(409);
    const resumed = await finalizationCommand(state, value, 'resume');
    expect(resumed.statusCode, resumed.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'review after resume',
    );
    expect(implemented).toBe(false);
    const selected = await finalizationCommand(state, value, 'select-stage-findings', {
      selectedFindingIds: ['S-1'],
      rationale: 'Keep this change focused.',
      additionalRounds: 2,
    });
    expect(selected.statusCode, selected.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'all stages verified',
      10000,
    );
    const cycle = finalizationCycle(state, value);
    const progress = present(cycle.finalizationProgress);
    expect(progress.stages.every((s) => s.status === 'completed')).toBe(true);
    expect(progress.followUps.map((f) => f.id).sort()).toEqual(['S-2', 'S-3']);
    expect(progress.followUps.every((f) => f.status === 'open')).toBe(true);
    expect(progress.stages[2]).toMatchObject({
      selectedFindingIds: ['S-1'],
      remediationRounds: 1,
      additionalRemediationRounds: 2,
    });
    expect(progress.stages[4]?.additionalRemediationRounds).toBe(0);
    expect(cycle.remediationRounds).toBe(1);
    expect(backend.launches.filter((r) => r.model?.endsWith('-implement'))).toHaveLength(1);
    expect(progress.obligations.every((o) => o.status === 'met' && o.source && o.requirement)).toBe(
      true,
    );
    const response = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/plans/version-1/finalizations`,
      headers: { cookie: state.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      finalizationsResponseSchema.parse(response.json()).finalizations[0]?.cycle
        ?.finalizationProgress,
    ).toEqual(progress);
    const reopened = openDaemonStorage(state.context.storage.databasePath);
    expect(
      reopened.execution.cycles.find(state.workspaceId, cycle.id)?.finalizationProgress,
    ).toEqual(progress);
    reopened.close();
    const baseline = present(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)
        ?.reviewBranchContext,
    );
    expect(git(['rev-parse', 'main'], root)).toBe(main);
    const promoted = await finalizationCommand(state, value, 'merge', {
      expectedHeadSha: baseline.headSha,
      expectedTargetSha: baseline.targetSha,
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(readFileSync(join(root, 'simplified.txt'), 'utf8')).toContain('selected S-1');
  });

  it('reopens correctness for a later nit regression and retains that stage’s spent budget', {
    timeout: 25000,
  }, async () => {
    const alternate = new CycleBackend([], 'codex');
    const fixture = await finalizationFixture({ alternateBackend: alternate });
    const { state, backend } = fixture;
    let fixes = 0;
    let regression = false;
    const defect = { ...structuredFinding, category: 'correctness', severity: 'nit' };
    const reply = (request: AgentLaunchRequest) => {
      if (/^Role: implement$/m.test(request.prompt))
        return { resultText: 'Committed and checked.\n\n## Open questions\nnone' };
      const ledger = stagedLedger(request);
      const kind = ledger.stages[ledger.progress.stageIndex]?.kind;
      if (kind === 'final-review' && fixes === 1) regression = true;
      return {
        resultText: stagedText(
          request,
          !fixes
            ? [defect]
            : regression
              ? [
                  {
                    ...defect,
                    id: 'C-2',
                    status: fixes > 1 ? 'resolved' : 'open',
                    ...(fixes > 1 ? { disposition: 'Regression checked.' } : {}),
                  },
                ]
              : [{ ...defect, status: 'resolved', disposition: 'Checked initial fix.' }],
        ),
      };
    };
    const launch = (request: AgentLaunchRequest) => {
      if (/^Role: implement$/m.test(request.prompt)) {
        fixes++;
        commitFile(request.cwd, `fix-${fixes}.txt`, 'fixed\n');
      }
    };
    backend.onLaunch = launch;
    alternate.onLaunch = launch;
    backend.replyForRequest = reply;
    alternate.replyForRequest = reply;
    const value = await beginFinalization(fixture, stagedInput(fixture));
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'reopened exhausted stage',
      12000,
    );
    let cycle = finalizationCycle(state, value);
    expect(cycle.reason).toContain('limit');
    expect(cycle.finalizationProgress?.stageIndex).toBe(0);
    expect(cycle.finalizationProgress?.stages[0]?.remediationRounds).toBe(1);
    expect(cycle.finalizationProgress?.stages[4]?.status).toBe('pending');
    expect(
      (
        await finalizationCommand(state, value, 'defer-nits', {
          findingIds: ['C-2'],
          rationale: 'This must not waive correctness.',
        })
      ).statusCode,
    ).toBe(409);
    const recovered = await finalizationCommand(state, value, 'remediate-findings', {
      findingIds: ['C-2'],
      rationale: 'Fix this regression.',
      additionalRounds: 1,
      agentOverride: { backend: 'codex', model: 'recovery-model' },
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'regression and final review',
      10000,
    );
    cycle = finalizationCycle(state, value);
    expect(fixes).toBe(2);
    expect(cycle.finalizationProgress?.stageIndex).toBe(4);
    expect(cycle.finalizationProgress?.stages[0]).toMatchObject({
      remediationRounds: 2,
      additionalRemediationRounds: 1,
    });
    expect(cycle.finalizationProgress?.stages[4]?.additionalRemediationRounds).toBe(0);
    expect(alternate.launches.every((r) => r.model === 'recovery-model')).toBe(true);
    expect(alternate.launches.at(-1)?.prompt).toContain('final-review');
  });

  it('requires an explicit plan adjustment and revalidation without waiving questions or failed checks', {
    timeout: 20000,
  }, async () => {
    const fixture = await finalizationFixture();
    const { state, backend } = fixture;
    let question = true;
    let failed = false;
    backend.replyForRequest = (request) => {
      const ledger = stagedLedger(request);
      const kind = ledger.stages[ledger.progress.stageIndex]?.kind;
      const obligation = present(ledger.progress.obligations[0]);
      if (kind === 'conformance' && !obligation.approvedChange)
        return {
          resultText: stagedText(request, [], {
            met: false,
            questions: 'Approve the narrower obligation?',
            evidence: {
              obligations: ledger.progress.obligations.map((o, i) => ({
                id: o.id,
                status: i ? 'met' : 'change-requested',
                evidence: 'Explicit adjustment needed.',
                ...(!i ? { proposedRequirement: 'Preserve the supported API.' } : {}),
              })),
            },
          }),
        };
      return {
        resultText: stagedText(request, [], {
          questions:
            kind === 'conformance' && question ? 'Which extra behavior is intended?' : 'none',
          met: !failed,
          ...(failed
            ? {
                evidence: {
                  checks: [
                    {
                      name: 'fixture checks',
                      status: 'failed',
                      evidence: 'A required test failed.',
                    },
                  ],
                },
              }
            : {}),
        }),
      };
    };
    const input = stagedInput(fixture);
    input.stages = input.stages.map((s) => ({
      ...s,
      policy: { ...s.policy, maxRemediationRounds: 0 },
    }));
    const value = await beginFinalization(fixture, input);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'plan adjustment',
      6000,
    );
    const obligation = present(
      finalizationCycle(state, value).finalizationProgress?.obligations[0],
    );
    expect(obligation.status).toBe('change-requested');
    const approved = await finalizationCommand(state, value, 'approve-plan-change', {
      obligationId: obligation.id,
      rationale: 'Scope decision for this plan.',
      instructions: 'Keep every required check.',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'remaining question',
    );
    const current = finalizationCycle(state, value);
    expect(current.reason).toContain('open questions');
    expect(current.finalizationProgress?.obligations[0]).toMatchObject({
      requirement: 'Preserve the supported API.',
      approvedChange: {
        previousRequirement: obligation.requirement,
        rationale: 'Scope decision for this plan.',
      },
    });
    question = false;
    failed = true;
    expect(
      (
        await finalizationCommand(state, value, 'resume', {
          instructions: 'Keep supported behavior.',
        })
      ).statusCode,
    ).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'required check failed',
      6000,
    );
    expect(finalizationCycle(state, value).reason).toContain('limit');
    expect(finalizationCycle(state, value).finalizationProgress?.stageIndex).toBe(1);
    expect(backend.launches.every((r) => /^Role: review$/m.test(r.prompt))).toBe(true);
  });

  it('rejects incomplete final evidence and forbids stale or unapproved obligation substitutions', {
    timeout: 15000,
  }, async () => {
    const fixture = await finalizationFixture();
    const { state, backend } = fixture;
    let fullChecks = false;
    backend.replyForRequest = (request) => ({
      resultText: stagedText(request, [], { evidence: { fullChecks } }),
    });
    const value = await beginFinalization(fixture, stagedInput(fixture));
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'missing final checks',
      9000,
    );
    let cycle = finalizationCycle(state, value);
    expect(cycle.finalizationProgress?.stageIndex).toBe(4);
    const run = present(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    );
    expect(run.verdict).toBeUndefined();
    expect(
      (
        await finalizationCommand(state, value, 'merge', {
          expectedHeadSha: run.reviewBranchContext?.headSha,
          expectedTargetSha: run.reviewBranchContext?.targetSha,
        })
      ).statusCode,
    ).toBe(409);
    fullChecks = true;
    expect(
      (await finalizationCommand(state, value, 'resume', { instructions: 'Run the full checks.' }))
        .statusCode,
    ).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'complete final checks',
    );
    cycle = finalizationCycle(state, value);
    const detail = await runDetail(state, cycle.currentRunId);
    const assessment = detail.reviewReport;
    if (assessment?.status !== 'complete' || !assessment.report.finalization)
      throw new Error('Expected complete stage evidence');
    const baseline = present(detail.run.reviewBranchContext);
    expect(stagedPromotionIssue(value, cycle, assessment, baseline)).toBeUndefined();
    expect(
      assessStageReport(
        {
          ...value,
          stages: value.stages?.map((s) =>
            s.kind === 'correctness'
              ? { ...s, requiredChecks: [...s.requiredChecks, 'Additional performance gate'] }
              : s,
          ),
        },
        cycle,
        assessment,
        baseline,
      ).status,
    ).toBe('invalid');

    const parked = {
      ...stageIdea,
      status: 'open' as const,
      severity: 'nit' as const,
      category: 'polish' as const,
    };
    const parkedCycle = {
      ...cycle,
      finalizationProgress: { ...present(cycle.finalizationProgress), followUps: [parked] },
    };
    expect(
      evaluateCycleCompletion(
        parkedCycle,
        { ...assessment, report: { ...assessment.report, findings: [parked] } },
        baseline,
      ).action,
    ).toBe('awaiting-merge');
    expect(
      evaluateCycleCompletion(
        parkedCycle,
        {
          ...assessment,
          report: { ...assessment.report, findings: [{ ...parked, category: 'correctness' }] },
        },
        baseline,
      ).action,
    ).toBe('remediate');

    expect(
      stagedPromotionIssue(
        value,
        {
          ...cycle,
          finalizationProgress: {
            ...present(cycle.finalizationProgress),
            obligations: present(cycle.finalizationProgress).obligations.map((o) => ({
              ...o,
              headSha: 'a'.repeat(40),
            })),
          },
        },
        assessment,
        baseline,
      ),
    ).toContain('current');
    const substitute = {
      ...assessment,
      report: {
        ...assessment.report,
        finalization: {
          ...assessment.report.finalization,
          obligations: assessment.report.finalization.obligations.map((o) => ({
            ...o,
            requirement: 'Silently weakened',
          })),
        },
      },
    };
    expect(assessStageReport(value, cycle, substitute, baseline).status).toBe('invalid');
    const missing = {
      ...assessment,
      report: {
        ...assessment.report,
        finalization: { ...assessment.report.finalization, obligations: [] },
      },
    };
    expect(assessStageReport(value, cycle, missing, baseline).status).toBe('invalid');
    const reused = {
      ...assessment,
      report: {
        ...assessment.report,
        finalization: {
          ...assessment.report.finalization,
          obligations: assessment.report.finalization.obligations.map((o) => ({
            ...o,
            reusedFromRunId: cycle.currentRunId,
          })),
        },
      },
    };
    expect(assessStageReport(value, cycle, reused, baseline).status).toBe('invalid');
    const conformanceCycle = {
      ...cycle,
      finalizationProgress: { ...present(cycle.finalizationProgress), stageIndex: 1 },
    };
    const outsideFinal = {
      ...reused,
      report: {
        ...reused.report,
        finalization: { ...reused.report.finalization, stageId: 'conformance' },
      },
    };
    expect(assessStageReport(value, conformanceCycle, outsideFinal, baseline).status).toBe(
      'complete',
    );
    expect(
      assessStageReport(value, conformanceCycle, outsideFinal, {
        ...baseline,
        headSha: 'b'.repeat(40),
      }).status,
    ).toBe('invalid');
  });
});

it('keeps all selected stage findings required when recovery temporarily focuses on a subset', {
  timeout: 20000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend } = fixture;
  const fixed = new Set<string>();
  let implementations = 0;
  backend.onLaunch = (request) => {
    if (/^Role: implement$/m.test(request.prompt)) {
      implementations++;
      if (implementations > 1) {
        const cycle = present(
          state.context.storage.execution.cycles
            .listForWorkspace(state.workspaceId)
            .find((c) => c.finalizationId),
        );
        for (const id of cycle.findingFocus ?? []) fixed.add(id);
      }
      commitFile(request.cwd, `partial-${implementations}.txt`, 'bounded progress\n');
    }
  };
  backend.replyForRequest = (request) => {
    if (/^Role: implement$/m.test(request.prompt))
      return { resultText: 'Committed the partial work.\n\n## Open questions\nnone' };
    const ledger = stagedLedger(request);
    const kind = ledger.stages[ledger.progress.stageIndex]?.kind;
    return {
      resultText: stagedText(
        request,
        kind === 'simplification'
          ? ['S-1', 'S-2'].map((id) => ({
              ...stageIdea,
              id,
              ...(fixed.has(id)
                ? { status: 'resolved', disposition: 'Verified the selected change.' }
                : {}),
            }))
          : [],
      ),
    };
  };
  const value = await beginFinalization(fixture, stagedInput(fixture));
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'stage selection',
    6000,
  );
  expect(
    (
      await finalizationCommand(state, value, 'select-stage-findings', {
        selectedFindingIds: ['S-1', 'S-2'],
        rationale: 'Both changes are worth doing.',
      })
    ).statusCode,
  ).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'selected batch allowance',
  );
  expect(
    (
      await finalizationCommand(state, value, 'remediate-findings', {
        findingIds: ['S-1'],
        rationale: 'Fix the first concern in this attempt.',
        additionalRounds: 1,
      })
    ).statusCode,
  ).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'remaining selected finding',
  );
  const cycle = finalizationCycle(state, value);
  expect(cycle.finalizationProgress?.stageIndex).toBe(2);
  expect(cycle.finalizationProgress?.stages[2]?.selectedFindingIds).toEqual(['S-1', 'S-2']);
  expect(cycle.finalizationProgress?.followUps).toEqual([]);
  const view = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/plans/version-1/finalizations`,
    headers: { cookie: state.cookie },
  });
  expect(view.json().finalizations[0].checkpointFindings.map((f: { id: string }) => f.id)).toEqual([
    'S-2',
  ]);
  expect(
    (
      await finalizationCommand(state, value, 'remediate-findings', {
        findingIds: ['S-2'],
        rationale: 'Finish the original selected batch.',
        additionalRounds: 1,
      })
    ).statusCode,
  ).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'selected batch complete',
    6000,
  );
  expect(implementations).toBe(3);
});
