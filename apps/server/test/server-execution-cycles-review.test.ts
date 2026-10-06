import type { AgentLaunchRequest } from '@craftingtable/agents';
import { workCycleResponseSchema } from '@craftingtable/contracts';
import { DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { openDaemonStorage } from '../src/persisted-records.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  cleanupExecutionFixtures,
  commitFile,
  currentCycle,
  cycleFixture,
  designDone,
  git,
  implementationDone,
  mutationHeaders,
  present,
  reviewText,
  startCycle,
  stepUp,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

/** Makes every remediation commit a change, as a remediation that fixes something does. */
function commitRemediations(backend: {
  onLaunch: ((request: AgentLaunchRequest) => void) | undefined;
}) {
  let n = 0;
  backend.onLaunch = (request) => {
    if (request.model === 'remediate-model')
      commitFile(request.cwd, `remediation-${++n}.txt`, 'Remediated finding');
  };
}

afterEach(cleanupExecutionFixtures);

describe('single work-item automation', () => {
  it.each([
    [
      'unstructured review',
      { resultText: 'VERDICT: mergeable' },
      DEFAULT_COMPLETION_POLICY,
      'structured',
    ],
    [
      'truncated review',
      { resultText: reviewText([]), truncated: true },
      DEFAULT_COMPLETION_POLICY,
      'complete successful',
    ],
    [
      'remediation budget',
      { resultText: reviewText([structuredFinding]) },
      { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
      'limit reached',
    ],
  ] as const)(
    'pauses for %s and never merges through it',
    async (_name, review, policy, reason) => {
      const { state, backend, worktree } = await cycleFixture([
        designDone,
        implementationDone,
        review,
      ]);
      const cycle = await startCycle(state, worktree.id, { policy });
      await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', reason);
      expect(currentCycle(state, cycle).reason).toContain(reason);
      // Only the unstructured report is a format fault the agent gets two repairs for (R-C2).
      expect(backend.repairs).toBe(reason === 'structured' ? 2 : 0);
      expect(backend.launches).toHaveLength(3 + backend.repairs);
      // A merge into the repository's default branch needs the password again (R-G9).
      await stepUp(state);
      const merge = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/merge`,
        headers: mutationHeaders(state),
        payload: {},
      });
      expect(merge.statusCode).toBe(409);
    },
  );

  it('extends an exhausted work-item cycle explicitly without resetting history or accepting duplicate grants', async () => {
    const review = { resultText: reviewText([structuredFinding]) };
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      review,
      implementationDone,
      review,
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Verified regression fix.' },
        ]),
      },
    ]);
    // Each remediation commits its fix: remediations that change nothing stop on their own (LIVE-27).
    commitRemediations(backend);
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 1 },
      instructions: 'Keep the approved API.',
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'exhausted cycle');
    const paused = currentCycle(state, cycle);
    const payload = {
      action: 'authorize-remediation',
      expectedVersion: paused.version,
      additionalRounds: 1,
      instructions: 'Concentrate on the remaining regression.',
    };
    const authorize = (body: typeof payload) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload: body,
      });
    const results = await Promise.all([authorize(payload), authorize(payload)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const granted = workCycleResponseSchema.parse(
      present(results.find((r) => r.statusCode === 200)).json(),
    ).cycle;
    expect(granted).toMatchObject({
      remediationRounds: 2,
      additionalRemediationRounds: 1,
      policy: { maxRemediationRounds: 1 },
      parentRunId: paused.currentRunId,
      worktreeId: worktree.id,
    });
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'review after recovery',
    );
    expect(backend.launches).toHaveLength(7);
    expect(backend.launches[5]?.prompt).toContain('Keep the approved API.');
    expect(backend.launches[5]?.prompt).toContain('Concentrate on the remaining regression.');
    // The grant's guidance was for that remediation; the following review keeps only the
    // cycle's own instructions.
    expect(backend.launches[6]?.prompt).toContain('Keep the approved API.');
    expect(backend.launches[6]?.prompt).not.toContain('Concentrate on the remaining regression.');
    const reopened = openDaemonStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(state.workspaceId, cycle.id)).toMatchObject({
        remediationRounds: 2,
        additionalRemediationRounds: 1,
        policy: { maxRemediationRounds: 1 },
      });
    } finally {
      reopened.close();
    }
    expect((await authorize(payload)).statusCode).toBe(409);
    const audits = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 1000 })
      .filter((e) => e.metadata?.action === 'authorize-remediation');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: 'user',
      actorUserId: state.userId,
      metadata: {
        initialRemediationAllowance: 1,
        additionalRemediationRounds: 1,
        remediationAllowance: 2,
      },
    });
  });

  it.each(['questions', 'invalid', 'truncated', 'branch'] as const)(
    'does not grant a work-item allowance across a %s checkpoint',
    async (checkpoint) => {
      const review =
        checkpoint === 'invalid'
          ? 'Review missing report.'
          : `${checkpoint === 'questions' ? '## Open questions\nWhich API should be changed?\n\n## Review report\n' : ''}${reviewText([structuredFinding])}`;
      const { state, backend, worktree } = await cycleFixture([
        designDone,
        implementationDone,
        { resultText: review, truncated: checkpoint === 'truncated' },
      ]);
      const cycle = await startCycle(state, worktree.id, {
        policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
      });
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'review checkpoint',
      );
      if (checkpoint === 'branch') git(['checkout', '-b', 'unexpected'], worktree.path);
      const before = currentCycle(state, cycle);
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
      expect(response.statusCode, response.body).toBe(409);
      expect(currentCycle(state, cycle)).toEqual(before);
      // A missing report is repaired twice before the stop (R-C2); questions are not.
      expect(backend.repairs).toBe(checkpoint === 'invalid' ? 2 : 0);
      expect(backend.launches).toHaveLength(3 + backend.repairs);
    },
  );

  it('stops when two remediations in a row change nothing, before a third review of the same commit (LIVE-27)', async () => {
    const review = { resultText: reviewText([structuredFinding]) };
    const outOfScope = { resultText: 'No source change: this finding belongs to another slice.' };
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      review,
      outOfScope,
      review,
      outOfScope,
      review,
    ]);
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 10 },
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'no-change stop');
    expect(currentCycle(state, cycle).attention).toMatchObject({
      code: 'remediation-no-change',
      owner: 'operator',
    });
    // Design, implementation, two reviews and two remediations: no third review.
    expect(backend.launches).toHaveLength(6);
  });

  it('sends Continue with guidance after a no-change stop to a fresh review of the same commit (LIVE-27 review)', async () => {
    const review = { resultText: reviewText([structuredFinding]) };
    const outOfScope = { resultText: 'No source change: this finding belongs to another slice.' };
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      review,
      outOfScope,
      review,
      outOfScope,
      {
        resultText: reviewText([
          {
            ...structuredFinding,
            status: 'resolved',
            disposition: 'Owned by another slice; out of this repair.',
          },
        ]),
      },
    ]);
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 10 },
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'no-change stop');
    const stopped = currentCycle(state, cycle);
    expect(stopped.attention?.code).toBe('remediation-no-change');
    const guidance = 'Judge only the findings this slice may fix.';
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'resume', expectedVersion: stopped.version, instructions: guidance },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'guided review');
    // The guidance went to a review, not another remediation.
    expect(backend.launches).toHaveLength(7);
    expect(backend.launches[6]?.model).toBe('review-model');
    expect(backend.launches[6]?.prompt).toContain(guidance);
  });

  it('reviews again after one remediation that changes nothing, so a rebuttal can be accepted (LIVE-27)', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([structuredFinding]) },
      { resultText: 'No source change: the finding is already handled by the existing guard.' },
      {
        resultText: reviewText([
          {
            ...structuredFinding,
            status: 'resolved',
            disposition: 'The existing guard handles it.',
          },
        ]),
      },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'rebuttal accepted',
    );
    expect(backend.launches).toHaveLength(5);
  });

  it('stops after two unchanged remediation rounds even with remaining budget', async () => {
    const review = { resultText: reviewText([structuredFinding]) };
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      review,
      implementationDone,
      review,
      implementationDone,
      review,
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Verified after guidance.' },
        ]),
      },
    ]);
    // Each remediation commits its fix: remediations that change nothing stop on their own (LIVE-27).
    commitRemediations(backend);
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 10 },
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'stalled reviews');
    expect(currentCycle(state, cycle).reason).toContain('Two remediation rounds');
    expect(backend.launches).toHaveLength(7);
    const before = currentCycle(state, cycle);
    const payload = {
      action: 'resume',
      expectedVersion: before.version,
      instructions: 'Use the supported controller launcher for supplementary checks.',
    };
    const recover = () =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload,
      });
    const response = await recover();
    expect(response.statusCode, response.body).toBe(200);
    expect((await recover()).statusCode).toBe(409);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'guided stalled recovery',
    );
    const after = currentCycle(state, cycle);
    expect(after.remediationRounds).toBe(before.remediationRounds + 1);
    expect(after.additionalRemediationRounds ?? 0).toBe(0);
    expect(after.policy).toEqual(before.policy);
    expect(backend.launches[7]?.prompt).toContain(payload.instructions);
  });

  it.each([0, 3])(
    'stops operator questions until explicit guidance with initial allowance %s',
    async (allowance) => {
      const { state, backend, worktree } = await cycleFixture([
        designDone,
        {
          resultText: 'Prepared the change.\n\n## Open questions\nApprove the verification policy?',
        },
        implementationDone,
        {
          resultText: `## Open questions\nWhich boundary should the fix preserve?\n\n## Review report\n${reviewText([structuredFinding])}`,
        },
        implementationDone,
        {
          resultText: reviewText([
            {
              ...structuredFinding,
              status: 'resolved',
              disposition: 'Verified fix within approved boundary.',
            },
          ]),
        },
      ]);
      const cycle = await startCycle(state, worktree.id, {
        policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: allowance },
      });
      const resume = (instructions?: string) =>
        state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
          headers: mutationHeaders(state),
          payload: {
            action: 'resume',
            expectedVersion: currentCycle(state, cycle).version,
            ...(instructions === undefined ? {} : { instructions }),
          },
        });
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'implementation question',
      );
      expect(currentCycle(state, cycle).step).toBe('implement');
      expect(backend.launches).toHaveLength(2);
      expect((await resume()).statusCode).toBe(409);
      expect(
        (await resume('Use the controller policy and preserve required checks.')).statusCode,
      ).toBe(200);
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'review question',
      );
      expect(currentCycle(state, cycle).step).toBe('review');
      expect(currentCycle(state, cycle).remediationRounds).toBe(0);
      expect(backend.launches).toHaveLength(4);
      expect(backend.launches[2]?.prompt).toContain('Use the controller policy');
      expect(backend.launches[3]?.prompt).not.toContain('Use the controller policy');
      expect((await resume()).statusCode).toBe(409);
      const guidance = 'Preserve the approved API boundary.';
      if (allowance === 0) {
        expect(currentCycle(state, cycle).reason).toContain('Remediation limit reached.');
        const grant = await state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
          headers: mutationHeaders(state),
          payload: {
            action: 'authorize-remediation',
            expectedVersion: currentCycle(state, cycle).version,
            additionalRounds: 1,
            instructions: guidance,
          },
        });
        expect(grant.statusCode, grant.body).toBe(200);
      } else expect((await resume(guidance)).statusCode).toBe(200);
      await waitFor(
        () => currentCycle(state, cycle).status === 'awaiting-merge',
        'answered review',
      );
      expect(currentCycle(state, cycle).remediationRounds).toBe(1);
      expect(backend.launches[4]?.prompt).toContain('Preserve the approved API boundary.');
      expect(backend.launches[5]?.prompt).not.toContain('Preserve the approved API boundary.');
    },
  );
});
