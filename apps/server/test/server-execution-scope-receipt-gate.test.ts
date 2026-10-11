import { afterEach, expect, it } from 'vitest';
import { workItemViewSchema } from '@craftingtable/contracts';
import { type ExecutionScope, sameExecutionScope } from '@craftingtable/domain';
import {
  cleanupExecutionFixtures,
  commitFile,
  controlRoadmapEntry,
  delegateLocalReviewers,
  entryCycle,
  git,
  merge,
  recordScope,
  replyByScope,
  reviewScope,
  roadmapEntry,
  runScopedFixtureCheck,
  runToFinish,
  scopeReport,
  scopeTree,
  slicedFixture,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

type Fixture = Awaited<ReturnType<typeof slicedFixture>>;
type Tree = Awaited<ReturnType<typeof scopeTree>>;

/** A finished scope review whose report has these findings, gate and verdict. */
async function reviewWith(
  f: Fixture,
  tree: Tree,
  findings: readonly unknown[],
  report: { readonly met?: boolean; readonly verdict?: 'mergeable' | 'changes-requested' } = {},
) {
  const met = report.met ?? true;
  const verdict = report.verdict ?? 'mergeable';
  f.backend.replyForRequest = async (request) => {
    await runScopedFixtureCheck(request);
    const text = scopeReport(f.state, tree.executionScope!)
      .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
      .replace('"met":true', `"met":${met}`)
      .replaceAll('mergeable', verdict);
    expect(text).toContain(`"met":${met}`);
    return { resultText: text };
  };
  return runToFinish(f.state, tree.id, { role: 'review' });
}

const minor = { ...structuredFinding, id: 'R-1', severity: 'minor' };
const nit = { ...structuredFinding, id: 'R-2', severity: 'nit' };

/**
 * The record-scope-evidence command (operator or roadmap delegation) is the gate the receipt
 * passes. R-C7 D7 lets a slice verification through with minor and nit findings open, kept on
 * its evidence; everything else keeps the old rule (R-C7 review M1).
 *
 * The reviewer role is assigned only by a delegating roadmap (R-F2 decision 4), here with every
 * entry item-paused. Hand-made trees reach the D7 gate, which comes before the check that the
 * run is the assigned reviewer's; the recorded cases are the roadmap's own reviews.
 */
it('records scope evidence only from a review its gate admits (R-C7 D7)', async () => {
  const f = await slicedFixture(),
    { state } = f,
    ws = state.workspaceId;
  await delegateLocalReviewers(f, { hold: () => true });
  const receipts = () => state.context.storage.scopeReceipts.list(ws, state.workItemId);
  const refused = async (tree: Tree, message: string) => {
    const before = receipts().length;
    const response = await recordScope(f, tree);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.body).toContain(message);
    expect(receipts()).toHaveLength(before);
  };
  const reviewRule = 'no open blocking, major or minor findings';
  const verificationRule = 'independent verification with a met gate';
  /** Every review the roadmap launches reports its own tree's scope with these findings. */
  const roadmapReviews = (findings: readonly unknown[]) => {
    f.backend.replyForRequest = async (request) => {
      await runScopedFixtureCheck(request);
      const tree = state.context.storage.execution.worktrees
        .listActive(ws)
        .find((t) => t.path === request.cwd)!;
      return {
        resultText:
          '## Open questions\nnone\n## Review report\n' +
          scopeReport(state, tree.executionScope!).replace(
            '"findings":[]',
            `"findings":${JSON.stringify(findings)}`,
          ),
      };
    };
  };
  const remove = (tree: Tree) =>
    state.context.services.executionService.removeWorktree(f.auth, ws, tree.id, undefined, {
      discardChanges: true,
    });
  const verifies = (sourceId: string): ExecutionScope => ({
    ...f.scopes[0]!,
    kind: 'slice-verification',
    sourceId,
  });

  // A slice receipt keeps the old rule: a merged slice with a minor open is not recorded.
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewWith(f, a, [minor]);
  expect((await merge(state, a.id)).statusCode).toBe(200);
  await refused(a, reviewRule);

  // A slice verification: majors, blocking findings, an unmet gate and a requested change stop.
  const verification = await scopeTree(f, verifies(f.scopes[0]!.sourceId));
  for (const [findings, report] of [
    [[minor, { ...structuredFinding, id: 'R-3', severity: 'major' }], {}],
    [[{ ...structuredFinding, id: 'R-4', severity: 'blocking' }], {}],
    [[minor], { met: false }],
    [[minor], { verdict: 'changes-requested' }],
  ] as const) {
    await reviewWith(f, verification, findings, report);
    await refused(verification, verificationRule);
  }
  // Gate met, verdict mergeable, only a minor and a nit open: the roadmap's verification of
  // slice a is recorded, both kept.
  await remove(verification);
  roadmapReviews([minor, nit]);
  await controlRoadmapEntry(f, roadmapEntry(state, verifies(f.scopes[0]!.sourceId)).id, 'resume');
  await waitFor(() => receipts().length === 1, 'minor-only verification recorded');
  expect(receipts()[0]?.scope).toEqual(f.scopes[0]);
  expect(receipts()[0]?.evidence.followUps).toEqual([minor, nit]);
  // The work item's slice shows the follow-ups its verification kept (R-E5b, R-C7 D7).
  const page = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${ws}/work-items/${state.workItemId}/view`,
    headers: { cookie: state.cookie },
  });
  const slice = workItemViewSchema
    .parse(page.json())
    .scopes.choices.find((c) => sameExecutionScope(c.scope, f.scopes[0]));
  expect(slice?.status).toBe('verified');
  expect(slice?.followUps).toEqual([minor, nit]);

  // Parent acceptance keeps the old rule too.
  const b = await scopeTree(f, f.scopes[1]!);
  git(['merge', '--no-edit', 'main'], b.path);
  commitFile(b.path, 'b.txt', 'B');
  await reviewScope(f, b);
  expect((await merge(state, b.id)).statusCode).toBe(200);
  replyByScope(f);
  await controlRoadmapEntry(f, roadmapEntry(state, verifies(f.scopes[1]!.sourceId)).id, 'resume');
  await waitFor(() => receipts().length === 2, 'slice b verified');
  const acceptance = await scopeTree(f, f.parentScope);
  await reviewWith(f, acceptance, [minor]);
  await refused(acceptance, reviewRule);
  // The roadmap's own parent review, with nothing open, is recorded without follow-ups.
  await remove(acceptance);
  replyByScope(f);
  const parentEntry = roadmapEntry(state, f.parentScope);
  await controlRoadmapEntry(f, parentEntry.id, 'resume');
  await waitFor(() => {
    const c = entryCycle(state, parentEntry.id);
    if (c?.status === 'needs-attention') throw new Error(c.reason);
    return c?.status === 'awaiting-merge';
  }, 'parent reviewed');
  const accepted = await recordScope(
    f,
    state.context.storage.execution.worktrees.find(
      ws,
      entryCycle(state, parentEntry.id)!.worktreeId,
    )!,
  );
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(receipts().find((r) => r.scope.kind === 'parent-acceptance')?.evidence.followUps).toBe(
    undefined,
  );
});
