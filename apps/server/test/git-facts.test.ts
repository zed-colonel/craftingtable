import type { GitOperations } from '@craftingtable/git';
import {
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asSourceRepositoryId,
  asWorkItemId,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { GitFacts } from '../src/services/git-facts.js';
import { createTestContext, type TestContext } from './test-support.js';

/**
 * Git facts pinned by resolved commits are asked of Git once (R-D5, PERF-09): whether one
 * commit is an ancestor of another cannot change once it holds, so the answer is kept by the
 * repository and the two object names. Refs are still resolved on every read.
 */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function counting(answer: (ancestor: string, descendant: string) => boolean | 'fail') {
  const calls: string[] = [];
  const git = {
    isAncestor: async (repo: string, ancestor: string, descendant: string) => {
      calls.push(`${repo} ${ancestor.slice(0, 1)}..${descendant.slice(0, 1)}`);
      const value = answer(ancestor, descendant);
      return value === 'fail'
        ? { ok: false, failure: { kind: 'git-failed', message: 'Could not verify' } }
        : { ok: true, value };
    },
    resolveBranch: async () => ({ ok: true, value: B }),
  } as unknown as GitOperations;
  return { git, calls };
}

describe('Git facts by resolved commit (R-D5, PERF-09)', () => {
  it('asks Git once for an ancestry that holds, per repository and pair of commits', async () => {
    const { git, calls } = counting(() => true);
    const facts = new GitFacts().wrap(git);
    expect(await facts.isAncestor('/repo', A, B)).toEqual({ ok: true, value: true });
    expect(await facts.isAncestor('/repo', A, B)).toEqual({ ok: true, value: true });
    expect(await facts.isAncestor('/other', A, B)).toEqual({ ok: true, value: true });
    expect(await facts.isAncestor('/repo', A, C)).toEqual({ ok: true, value: true });
    expect(calls).toEqual(['/repo a..b', '/other a..b', '/repo a..c']);
    // Everything else goes to Git each time.
    await facts.resolveBranch('/repo', 'main');
    expect(await facts.resolveBranch('/repo', 'main')).toEqual({ ok: true, value: B });
  });

  it('asks again for an ancestry that does not hold, a failure, or an abbreviated name', async () => {
    let holds = false;
    const { git, calls } = counting((ancestor) => (ancestor === C ? 'fail' : holds));
    const facts = new GitFacts().wrap(git);
    // A merge absent from integration may arrive there (or a shallow history deepen).
    expect(await facts.isAncestor('/repo', A, B)).toEqual({ ok: true, value: false });
    holds = true;
    expect(await facts.isAncestor('/repo', A, B)).toEqual({ ok: true, value: true });
    expect((await facts.isAncestor('/repo', C, B)).ok).toBe(false);
    expect((await facts.isAncestor('/repo', C, B)).ok).toBe(false);
    // An abbreviated name could become ambiguous.
    await facts.isAncestor('/repo', 'a'.repeat(12), B);
    await facts.isAncestor('/repo', 'a'.repeat(12), B);
    expect(calls).toHaveLength(6);
  });

  it('keeps a bounded number of facts, the newest', async () => {
    const { git, calls } = counting(() => true);
    const facts = new GitFacts(2).wrap(git);
    const sha = (n: number) => n.toString(16).padStart(40, '0');
    for (const n of [1, 2, 3]) await facts.isAncestor('/repo', sha(n), B);
    await facts.isAncestor('/repo', sha(3), B);
    await facts.isAncestor('/repo', sha(1), B);
    expect(calls).toHaveLength(4);
  });
});

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

it("reads a plan's branches with one ref resolution and no repeated ancestry (PERF-09)", async () => {
  const { git, calls } = counting(() => true);
  let resolved = 0;
  const context = await createTestContext({
    gitOperations: {
      ...git,
      resolveBranch: async () => {
        resolved++;
        return { ok: true, value: C };
      },
    } as unknown as GitOperations,
  });
  contexts.push(context);
  await context.bootstrap();
  const session = await context.login();
  const user = context.storage.users.findByNormalizedUsername('test-user')!;
  const workspaceId = context.storage.workspaces.listAuthorized(user.id)[0]!.workspace.id;
  const projectId = asProjectId('project-1');
  const planVersionId = asPlanVersionId('plan-1');
  const repositoryId = asSourceRepositoryId('repo-1');
  const at = '2026-10-05T10:00:00.000Z';
  context.storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: projectId,
      workspaceId,
      name: 'ActionQueue',
      slug: 'aq',
      createdAt: at,
      createdByUserId: user.id,
    });
    tx.planning.bundles.insert({
      id: asPlanBundleId('bundle-1'),
      workspaceId,
      projectId,
      logicalName: 'aq',
      createdAt: at,
    });
    tx.planning.versions.insert({
      id: planVersionId,
      workspaceId,
      projectId,
      bundleId: asPlanBundleId('bundle-1'),
      versionNumber: 1,
      contentDigest: 'e'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'plan.md',
      normalizedSource: {},
      itemCount: 2,
      requiredDependencyCount: 0,
      createdAt: at,
      createdByUserId: user.id,
    });
    tx.planning.workItems.insertMany(
      [0, 1].map((ordinal) => ({
        id: asWorkItemId(`item-${ordinal}`),
        workspaceId,
        projectId,
        planVersionId,
        sourceId: `AQ-0${ordinal + 1}`,
        ordinal,
        title: `Item ${ordinal + 1}`,
        risk: 'low' as const,
        primaryAreas: [],
        exitGate: 'Checks pass',
        sourceFields: {},
      })),
    );
    for (const [ordinal, mergeSha] of [A, B].entries())
      tx.planning.workItems.complete({
        workspaceId,
        workItemId: asWorkItemId(`item-${ordinal}`),
        projectId,
        completedAt: at,
        completedByUserId: user.id,
        mergeSha,
      });
    tx.execution.sourceRepositories.insert({
      id: repositoryId,
      workspaceId,
      displayName: 'AQ',
      rootPath: '/tmp/aq-git-facts-fixture',
      defaultBranch: 'main',
      registeredHeadSha: A,
      registeredAt: at,
      registeredByUserId: user.id,
    });
    tx.execution.branchSettings.save(
      {
        workspaceId,
        planVersionId,
        repositoryId,
        integrationBranch: 'main',
        updatedAt: at,
        updatedByUserId: user.id,
        version: 1,
      },
      0,
    );
  });
  const read = () =>
    context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/plan-versions/${planVersionId}/branch-settings`,
      headers: { cookie: session.cookie },
    });
  for (let round = 0; round < 3; round++) {
    const response = await read();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ headSha: C, issues: [], missingEvidence: [] });
  }
  expect(resolved).toBe(3);
  expect(calls.toSorted()).toEqual([
    '/tmp/aq-git-facts-fixture a..c',
    '/tmp/aq-git-facts-fixture b..c',
  ]);
});
