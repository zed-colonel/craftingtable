import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDaemonStorage } from './persisted-records.js';
import {
  beginFinalization,
  CycleBackend,
  cleanupExecutionFixtures,
  commitFile,
  finalizationCommand,
  finalizationCycle,
  finalizationFixture,
  git,
  merge,
  present,
  reviewText,
  type ScriptedReply,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

/*
 * Legacy improvement-round finalization (rounds without stages). New finalizations use the
 * staged controller; these tests cover what only the legacy controller does (improvement
 * rounds and `polishPhase`, and deferring nits) and are deleted together with the legacy
 * branches (R-B10). The same behaviour on staged finalizations is covered in
 * server-execution-finalization.test.ts and server-execution-finalization-stages.test.ts.
 */

afterEach(cleanupExecutionFixtures);

const incomplete: ScriptedReply = {
  resultText: 'Waiting for verification.',
  exitReason: 'background-work-incomplete',
};

it('runs improvement rounds as assess, polish, verify and final review, then requires explicit promotion', {
  timeout: 15000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend, root, integration } = fixture;
  const main = git(['rev-parse', 'main'], root);
  backend.onLaunch = (request) => {
    if (request.model === 'polish-model') commitFile(request.cwd, 'polish.txt', 'simplified\n');
  };
  const value = await beginFinalization(fixture, fixture.legacyInput);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'final independent review',
    8000,
  );
  const cycle = finalizationCycle(state, value);
  expect(backend.launches.map((r) => r.model)).toEqual([
    'assessment-model',
    'polish-model',
    'assessment-model',
    'final-review-model',
  ]);
  expect(cycle.polishPhase).toBe('final-review');
  expect(backend.launches[0]?.prompt).toContain('# Plan finalization');
  expect(backend.launches[0]?.prompt).toContain('craftingtable-work-items.json');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
  expect(git(['rev-parse', 'revision'], root).trim()).toBe(integration);
  const tree = present(
    state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
  );
  expect(tree.workItemId).toBeUndefined();
  expect(tree.planVersionId).toBe('version-1');
  expect(
    state.context.storage.execution.runs.listForWorkItem(state.workspaceId, state.workItemId),
  ).toHaveLength(0);
  expect((await merge(state, tree.id)).statusCode).toBe(409);
  const review = present(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  ).reviewBranchContext;
  if (!review) throw new Error('Expected final review context');
  expect(
    (
      await finalizationCommand(state, value, 'merge', {
        expectedHeadSha: '0'.repeat(40),
        expectedTargetSha: review.targetSha,
      })
    ).statusCode,
  ).toBe(409);
  const promoted = await finalizationCommand(state, value, 'merge', {
    expectedHeadSha: review.headSha,
    expectedTargetSha: review.targetSha,
  });
  expect(promoted.statusCode, promoted.body).toBe(200);
  expect(promoted.json().finalization.status).toBe('completed');
  expect(readFileSync(join(root, 'polish.txt'), 'utf8')).toBe('simplified\n');
  expect(git(['rev-parse', 'revision'], root).trim()).toBe(integration);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.mergeSha,
  ).toBeUndefined();
});

async function findingCheckpointFixture(severity: 'nit' | 'minor' = 'nit', questions = true) {
  const fixture = await finalizationFixture();
  const nit = { ...structuredFinding, severity };
  fixture.backend.replyForRequest = () => ({
    resultText: `## Open questions\n${questions ? 'Fix or defer this finding?' : 'none'}\n\n## Review report\n${reviewText([nit])}`,
  });
  const value = await beginFinalization(fixture, {
    ...fixture.legacyInput,
    rounds: [],
    policy: { ...fixture.legacyInput.policy, maxRemediationRounds: 0 },
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
    'rejects a nit deferral after %s changes',
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
});

describe('finalization recovery agent selection', () => {
  it.each(['defer-nits'])(
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
        ...fixture.legacyInput,
        rounds: [],
        finalReview: { ...fixture.legacyInput.finalReview, permissionMode: 'edit-only' },
        policy: { ...fixture.legacyInput.policy, maxRemediationRounds: 0 },
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
});

it('continues an interrupted polish step with its deadline and still requires the final review', {
  timeout: 15000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend, root } = fixture;
  const normalReply = backend.replyForRequest;
  let interrupted = false;
  backend.replyForRequest = (request) => {
    if (request.model === 'polish-model' && !interrupted) {
      interrupted = true;
      return incomplete;
    }
    return present(normalReply)(request);
  };
  const main = git(['rev-parse', 'main'], root);
  const value = await beginFinalization(fixture, fixture.legacyInput);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'final independent review',
  );
  expect(backend.launches.map((r) => r.model)).toEqual([
    'assessment-model',
    'polish-model',
    'polish-model',
    'assessment-model',
    'final-review-model',
  ]);
  expect(backend.launches[2]?.deadlineAt).toBe(backend.launches[1]?.deadlineAt);
  expect(backend.launches[2]?.prompt).toContain('Phase: polish; improvement round 1 of 1');
  expect(finalizationCycle(state, value)).toMatchObject({
    remediationRounds: 0,
    polishPhase: 'final-review',
  });
  expect(git(['rev-parse', 'main'], root)).toBe(main);
});
