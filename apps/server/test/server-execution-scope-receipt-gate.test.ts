import { afterEach, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  commitFile,
  git,
  merge,
  recordScope,
  reviewScope,
  runScopedFixtureCheck,
  runToFinish,
  scopeReport,
  scopeTree,
  slicedFixture,
  structuredFinding,
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
 */
it('records scope evidence only from a review its gate admits (R-C7 D7)', async () => {
  const f = await slicedFixture(),
    { state } = f;
  const receipts = () =>
    state.context.storage.scopeReceipts.list(state.workspaceId, state.workItemId);
  const refused = async (tree: Tree, message: string) => {
    const before = receipts().length;
    const response = await recordScope(f, tree);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.body).toContain(message);
    expect(receipts()).toHaveLength(before);
  };
  const reviewRule = 'no open blocking, major or minor findings';
  const verificationRule = 'independent verification with a met gate';

  // A slice receipt keeps the old rule: a merged slice with a minor open is not recorded.
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewWith(f, a, [minor]);
  expect((await merge(state, a.id)).statusCode).toBe(200);
  await refused(a, reviewRule);

  // A slice verification: majors, blocking findings, an unmet gate and a requested change stop.
  const verification = await scopeTree(f, { ...f.scopes[0]!, kind: 'slice-verification' });
  for (const [findings, report] of [
    [[minor, { ...structuredFinding, id: 'R-3', severity: 'major' }], {}],
    [[{ ...structuredFinding, id: 'R-4', severity: 'blocking' }], {}],
    [[minor], { met: false }],
    [[minor], { verdict: 'changes-requested' }],
  ] as const) {
    await reviewWith(f, verification, findings, report);
    await refused(verification, verificationRule);
  }
  // Gate met, verdict mergeable, only a minor and a nit open: recorded, both kept.
  await reviewWith(f, verification, [minor, nit]);
  const recorded = await recordScope(f, verification);
  expect(recorded.statusCode, recorded.body).toBe(200);
  expect(receipts()).toHaveLength(1);
  expect(receipts()[0]?.evidence.followUps).toEqual([minor, nit]);

  // Parent acceptance keeps the old rule too.
  const b = await scopeTree(f, f.scopes[1]!);
  git(['merge', '--no-edit', 'main'], b.path);
  commitFile(b.path, 'b.txt', 'B');
  await reviewScope(f, b);
  expect((await merge(state, b.id)).statusCode).toBe(200);
  expect((await recordScope(f, b)).statusCode).toBe(200);
  const acceptance = await scopeTree(f, f.parentScope);
  await reviewWith(f, acceptance, [minor]);
  await refused(acceptance, reviewRule);
  await reviewScope(f, acceptance);
  const accepted = await recordScope(f, acceptance);
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(receipts().find((r) => r.scope.kind === 'parent-acceptance')?.evidence.followUps).toBe(
    undefined,
  );
});
