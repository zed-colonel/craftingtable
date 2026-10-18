import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { afterEach, expect } from 'vitest';
import {
  cleanupExecutionFixtures,
  commitFile,
  configureLocalRuntime,
  currentCycle,
  designDone,
  implementationDone,
  itNeedsCargo,
  mutationHeaders,
  runScopedFixtureCheck,
  scopeReport,
  scopeTree,
  slicedFixture,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * Housekeeping after a separate review passed (R-B4, decision 4 at every step; review of
 * 1a5c6d2, MEDIUM-1): the finished review's role ends with it, as a review's own remediation
 * ends it (LIVE-33), so the remediation that tidies the worktree is the remediation agent's, not
 * the read-only reviewer's. Within the allowance it runs by itself; at the limit the operator's
 * grant relaunches it.
 */

afterEach(cleanupExecutionFixtures);

const SECURITY = 'This is a separate security review.';

const withWorkflowReport = (text: string, options: Record<string, unknown> = {}) =>
  '```craftingtable-workflow\n' +
  JSON.stringify({
    version: 1,
    questions: [],
    resolved: [],
    securityReview: { required: false, sources: [] },
    ...options,
  }) +
  '\n```\n' +
  text;

itNeedsCargo.each([
  ['within the allowance', 1],
  ['at the limit, by the operator’s grant', 0],
] as const)(
  'tidies a passing security review’s leftovers as a remediation, %s',
  async (_name, rounds) => {
    const f = await slicedFixture();
    await configureLocalRuntime(f.auth, f.state, f.scopes[0]!.definitionId);
    const tree = await scopeTree(f, f.scopes[0]!);
    let securityReviews = 0;
    f.backend.replyForRequest = async (request) => {
      if (request.model === 'design-model') return designDone;
      if (request.model !== 'review-model') {
        const left = join(request.cwd, 'scan.out');
        if (existsSync(left)) rmSync(left);
        else commitFile(request.cwd, 'session.txt', 'Security-sensitive session handling');
        return implementationDone;
      }
      await runScopedFixtureCheck(request);
      if (request.prompt.includes(SECURITY) && ++securityReviews === 1)
        writeFileSync(join(request.cwd, 'scan.out'), 'left by the security review');
      return {
        resultText: withWorkflowReport(
          `## Open questions\nnone\n\n## Review report\n${scopeReport(f.state, tree.executionScope!)}`,
          { securityReview: { required: true, sources: ['Approved security review policy'] } },
        ),
      };
    };
    const cycle = await startCycle(f.state, tree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: rounds },
    });
    if (rounds === 0) {
      await waitFor(() => currentCycle(f.state, cycle).status === 'needs-attention', 'limit stop');
      const stopped = currentCycle(f.state, cycle);
      expect(stopped).toMatchObject({
        step: 'review',
        stop: { code: 'remediation-exhausted' },
        reason: expect.stringContaining('Verification changed the worktree.'),
      });
      const grant = await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${f.state.workspaceId}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(f.state),
        payload: {
          action: 'authorize-remediation',
          expectedVersion: stopped.version,
          additionalRounds: 1,
          instructions: 'Remove what the security review left behind.',
        },
      });
      expect(grant.statusCode, grant.body).toBe(200);
    }
    await waitFor(
      () => currentCycle(f.state, cycle).status === 'awaiting-merge',
      'the tidied candidate at its merge',
    ).catch((error) => {
      const at = currentCycle(f.state, cycle);
      throw new Error(`${error.message}: ${at.status} ${at.step} ${at.reason}`);
    });
    const remediation = f.backend.launches.find((r) =>
      r.prompt.includes('Verification changed the worktree.'),
    )!;
    expect(remediation.model).toBe('remediate-model');
    expect(remediation.prompt).not.toContain(SECURITY);
    if (rounds === 0)
      expect(remediation.prompt).toContain('Remove what the security review left behind.');
    // The candidate changed, so the security review runs again on it.
    expect(securityReviews).toBe(2);
    expect(existsSync(join(tree.path, 'scan.out'))).toBe(false);
  },
);
