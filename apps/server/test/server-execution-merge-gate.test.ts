import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  mergeWorktreeResponseSchema,
  repositoryBranchesResponseSchema,
  startAgentRunResponseSchema,
} from '@craftingtable/contracts';
import {
  asAgentRunId,
  asCycleInvestigationId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
} from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeGateFor } from '../src/services/merge/gate.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  admit,
  branchCommand,
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  currentCycle,
  cycleFixture,
  designDone,
  fixtureRepository,
  git,
  implementationDone,
  merge,
  mergeGate,
  mutationHeaders,
  ready,
  registerAndWorktree,
  reviewText,
  runToFinish,
  startCycle,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

describe('review-gated merge', () => {
  it('opens the gate only after the latest run is a mergeable review, then merges and completes', async () => {
    const realGit = createGitOperations({ gitExecutable: 'git' });
    const deletions: Parameters<GitOperations['deleteBranch']>[0][] = [];
    const state = await ready({
      gitOperations: {
        ...realGit,
        deleteBranch: (input) => {
          deletions.push(input);
          return realGit.deleteBranch(input);
        },
      },
    });
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);

    // No review yet: refused.
    expect(await mergeGate(state, worktree.id)).toMatchObject({
      mergeable: false,
      reason: 'no-review',
    });
    expect((await merge(state, worktree.id)).statusCode).toBe(409);

    // The implementation commits on the branch.
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'implement' });
    expect((await mergeGate(state, worktree.id))?.reason).toBe('no-review');

    // A review that requests changes keeps the gate closed.
    const changes = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-CHANGES',
    });
    expect(state.context.storage.execution.runs.find(state.workspaceId, changes)?.verdict).toBe(
      'changes-requested',
    );
    expect(await mergeGate(state, worktree.id)).toMatchObject({
      mergeable: false,
      reason: 'changes-requested',
      reviewRunId: changes,
    });

    // A mergeable review opens it; a later implement run closes it again.
    const approved = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    expect(await mergeGate(state, worktree.id)).toMatchObject({
      mergeable: true,
      reason: 'ready',
      reviewRunId: approved,
    });
    await runToFinish(state, worktree.id, { role: 'implement' });
    expect((await mergeGate(state, worktree.id))?.reason).toBe('superseded-by-later-run');
    const final = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    expect((await mergeGate(state, worktree.id))?.reviewRunId).toBe(final);

    const tip = git(['rev-parse', worktree.branchName], repositoryPath).trim();
    const merged = await merge(state, worktree.id);
    expect(merged.statusCode, merged.body).toBe(200);
    const result = mergeWorktreeResponseSchema.parse(merged.json());
    expect(result.targetBranch).toBe('main');
    expect(result.workItemCompleted).toBe(true);
    // The merged branch is deleted only if it still points at the merged commit (GIT-09).
    expect(deletions).toEqual([
      expect.objectContaining({ branchName: worktree.branchName, expectedHeadSha: tip }),
    ]);
    expect(result.worktree).toMatchObject({ status: 'removed', mergeSha: result.mergeSha });
    expect(git(['rev-parse', 'HEAD'], repositoryPath).trim()).toBe(result.mergeSha);
    expect(git(['log', '--oneline', '-3'], repositoryPath)).toContain('add feature');
    expect(git(['branch', '--list', worktree.branchName], repositoryPath).trim()).toBe('');
    expect(git(['worktree', 'list'], repositoryPath)).not.toContain(worktree.path);

    const item = state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId);
    expect(item?.status).toBe('completed');
    expect(item?.mergeSha).toBe(result.mergeSha);
    expect(item?.completionWorktreeId).toBe(worktree.id);

    const actions = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 100 })
      .map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['worktree.merged', 'work-item.completed']));
    const kinds = state.context.storage.workspaceEvents
      .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 100 })
      .map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['worktree-merged', 'work-item-completed']));

    // An acknowledged merge retry reconciles the same durable result without another commit.
    const previousHead = git(['rev-parse', 'HEAD'], repositoryPath);
    expect((await merge(state, worktree.id)).statusCode).toBe(200);
    expect(git(['rev-parse', 'HEAD'], repositoryPath)).toBe(previousHead);
  });

  it('refuses a merge when the worktree is dirty or the primary checkout is not on the default branch', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });

    writeFileSync(join(worktree.path, 'uncommitted.txt'), 'oops\n');
    const dirty = await merge(state, worktree.id);
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toMatchObject({
      error: { message: expect.stringMatching(/uncommitted/) },
    });
    rmSync(join(worktree.path, 'uncommitted.txt'));

    // A primary checkout on another branch does not block the merge: main is
    // updated without any worktree (R-G10) and the checkout stays where it was.
    git(['checkout', '-b', 'elsewhere'], repositoryPath);
    const elsewhere = await merge(state, worktree.id);
    expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    const landed = mergeWorktreeResponseSchema.parse(elsewhere.json());
    expect(git(['rev-parse', 'main'], repositoryPath).trim()).toBe(landed.mergeSha);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repositoryPath).trim()).toBe('elsewhere');
    expect(existsSync(join(state.context.config.execution.worktreeRoot, '.merge'))).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'], repositoryPath)).not.toContain('.merge');
    git(['checkout', 'main'], repositoryPath);
  });

  it("never lets the daemon's Git follow a Git directory an agent could have redirected (R-G14 review MEDIUM-1)", async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    const common = join(repositoryPath, '.git');
    // An agent-made copy of the repository's Git directory, with a branch of its own.
    const copy = mkdtempSync(join(dirname(repositoryPath), 'planted-'));
    cpSync(common, copy, { recursive: true });
    git(['--git-dir', copy, 'branch', 'planted', 'main'], repositoryPath);
    const branches = () =>
      state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${state.workspaceId}/repositories/${worktree.repositoryId}/branches`,
        headers: { cookie: state.cookie },
      });
    const diff = () =>
      state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/diff`,
        headers: { cookie: state.cookie },
      });
    expect((await branches()).body).not.toContain('planted');
    expect((await diff()).statusCode).toBe(200);
    // A `commondir` in the repository's own Git directory: Git alone would read the copy.
    writeFileSync(join(common, 'commondir'), `${copy}\n`);
    expect(git(['branch', '--list', 'planted'], repositoryPath)).toContain('planted');
    const redirected = await branches();
    expect(redirected.statusCode).not.toBe(200);
    expect(redirected.body).not.toContain('planted');
    rmSync(join(common, 'commondir'));
    // The worktree's `.git` pointer naming the copy's entry for it: refused, not followed.
    const pointer = readFileSync(join(worktree.path, '.git'), 'utf8');
    writeFileSync(
      join(worktree.path, '.git'),
      pointer.replace(common, copy).replace(realpathSync(common), copy),
    );
    expect(readFileSync(join(worktree.path, '.git'), 'utf8')).toContain(copy);
    expect((await diff()).statusCode).not.toBe(200);
    writeFileSync(join(worktree.path, '.git'), pointer);
    expect((await diff()).statusCode).toBe(200);
  });

  it('merges into the recorded integration branch without changing main', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    git(['branch', 'aq-cont-1'], repositoryPath);
    const { worktree } = await registerAndWorktree(state, repositoryPath, 'aq-cont-1');
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });

    const branches = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/repositories/${worktree.repositoryId}/branches`,
      headers: { cookie: state.cookie },
    });
    expect(repositoryBranchesResponseSchema.parse(branches.json())).toEqual({
      branches: ['aq-cont-1', worktree.branchName, 'main'],
      checkedOut: 'main',
    });

    const invalid = await merge(state, worktree.id, { targetBranch: worktree.branchName });
    expect(invalid.statusCode).toBe(409);
    const hostile = await merge(state, worktree.id, { targetBranch: '--evil' });
    expect(hostile.statusCode).toBe(409);

    const mainHead = git(['rev-parse', 'main'], repositoryPath).trim();
    const merged = await merge(state, worktree.id, { targetBranch: 'aq-cont-1' });
    expect(merged.statusCode, merged.body).toBe(200);
    const result = mergeWorktreeResponseSchema.parse(merged.json());
    expect(result).toMatchObject({ targetBranch: 'aq-cont-1', createdTarget: false });
    expect(git(['rev-parse', 'aq-cont-1'], repositoryPath).trim()).toBe(result.mergeSha);
    expect(git(['log', '--oneline', 'aq-cont-1'], repositoryPath)).toContain('add feature');
    // main is untouched and the worktree branch is gone.
    expect(git(['rev-parse', 'main'], repositoryPath).trim()).toBe(mainHead);
    expect(git(['branch', '--list', worktree.branchName], repositoryPath).trim()).toBe('');
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('completed');
    const event = state.context.storage.workspaceEvents
      .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 100 })
      .find((entry) => entry.kind === 'worktree-merged');
    expect(event?.kind === 'worktree-merged' && event.payload.targetBranch).toBe('aq-cont-1');
  });

  it('refuses a merge whose destination moved after the checks with the code target-moved, and moves nothing (R-G10)', async () => {
    const realGit = createGitOperations({ gitExecutable: 'git' });
    let mover = '';
    const state = await ready({
      gitOperations: {
        ...realGit,
        mergeBranch: (input) => {
          // Someone else moves main between the daemon's checks and its merge.
          const main = git(['rev-parse', 'main'], input.repositoryPath).trim();
          mover = git(
            ['commit-tree', '-p', main, '-m', 'moved elsewhere', `${main}^{tree}`],
            input.repositoryPath,
          ).trim();
          git(['update-ref', 'refs/heads/main', mover], input.repositoryPath);
          return realGit.mergeBranch(input);
        },
      },
    });
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    git(['checkout', '-q', '-b', 'elsewhere'], repositoryPath);

    const refused = await merge(state, worktree.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'conflict', reason: 'target-moved' } });
    expect(git(['rev-parse', 'main'], repositoryPath).trim()).toBe(mover);
    expect(
      state.context.storage.execution.merges.latest(state.workspaceId, worktree.id)?.status,
    ).toBe('failed');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');
  });

  it('refuses a destination checked out in another worktree with the code target-checked-out, and records a checkout taken as the ref moved (R-G10 review F2, F5)', async () => {
    const realGit = createGitOperations({ gitExecutable: 'git' });
    let reported: string | undefined;
    const state = await ready({
      gitOperations: {
        ...realGit,
        mergeBranch: async (input) => {
          const merged = await realGit.mergeBranch(input);
          return merged.ok && reported
            ? { ok: true, value: { ...merged.value, checkedOutDuringMerge: reported } }
            : merged;
        },
      },
    });
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    git(['checkout', '-q', '-b', 'elsewhere'], repositoryPath);
    const linked = join(mkdtempSync(join(dirname(repositoryPath), 'ct-holding-')), 'main');
    git(['worktree', 'add', '-q', linked, 'main'], repositoryPath);

    const refused = await merge(state, worktree.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: 'conflict', reason: 'target-checked-out' },
    });

    git(['worktree', 'remove', linked], repositoryPath);
    rmSync(dirname(linked), { recursive: true, force: true });
    reported = linked;
    const merged = await merge(state, worktree.id);
    expect(merged.statusCode, merged.body).toBe(200);
    const audit = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 100 })
      .find((row) => row.action === 'worktree.merged');
    expect(audit?.metadata).toMatchObject({ checkedOutDuringMerge: linked });
  });

  it('promotes past untracked files in the primary checkout, and refuses one it would overwrite by code with its path (R-G10)', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    const main = git(['rev-parse', 'main'], repositoryPath).trim();

    writeFileSync(join(repositoryPath, 'feature.txt'), "the operator's own\n");
    writeFileSync(join(repositoryPath, 'notes.txt'), 'not in the way\n');
    const refused = await merge(state, worktree.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      error: {
        code: 'conflict',
        reason: 'checkout-would-overwrite',
        paths: ['feature.txt'],
        pathCount: 1,
      },
    });
    expect(git(['rev-parse', 'main'], repositoryPath).trim()).toBe(main);
    expect(readFileSync(join(repositoryPath, 'feature.txt'), 'utf8')).toBe("the operator's own\n");

    rmSync(join(repositoryPath, 'feature.txt'));
    const merged = await merge(state, worktree.id);
    expect(merged.statusCode, merged.body).toBe(200);
    expect(readFileSync(join(repositoryPath, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(readFileSync(join(repositoryPath, 'notes.txt'), 'utf8')).toBe('not in the way\n');
  });

  it('reports a conflicting merge and leaves the checkout clean', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });

    // A conflicting change on main is reported and aborted, leaving main clean.
    writeFileSync(join(repositoryPath, 'feature.txt'), 'conflict\n');
    git(['add', '--all'], repositoryPath);
    git(['commit', '--no-gpg-sign', '-m', 'conflicting'], repositoryPath);
    const conflict = await merge(state, worktree.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { message: expect.stringMatching(/Integration branch advanced/) },
    });
    expect(git(['status', '--porcelain'], repositoryPath)).toBe('');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');
  });

  it('seeds a remediation run with the review findings from the journal', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    await admit(state);
    const review = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-CHANGES',
    });
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, role: 'implement', parentRunId: review },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { run } = startAgentRunResponseSchema.parse(started.json());
    expect(run.parentRunId).toBe(review);
    const launch = state.backend.launches.at(-1);
    expect(launch?.prompt).toContain('## Remediation');
    expect(launch?.prompt).toContain('## Review findings to address (verdict: changes-requested)');
    // The unstructured review is quoted, so its verdict line is not one of the brief's own
    // (R-G6, AGT-53).
    expect(launch?.prompt).toContain('> VERDICT: changes-requested');
    expect(launch?.prompt).not.toMatch(/^VERDICT: changes-requested$/m);
    expect(launch?.prompt).toContain('disposition for each finding');

    // A parent from another work item is refused.
    const other = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, role: 'implement', parentRunId: 'no-such-run' },
    });
    expect(other.statusCode).toBe(404);
  });
});

it('never opens the merge gate for a failed, cancelled or interrupted review with an earlier verdict', async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const id = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  const run = state.context.storage.execution.runs.find(state.workspaceId, id);
  const storedWorktree = state.context.storage.execution.worktrees.find(
    state.workspaceId,
    worktree.id,
  );
  if (run === undefined || storedWorktree === undefined) throw new Error('Missing fixtures');
  expect(mergeGateFor(storedWorktree, [run]).mergeable).toBe(true);
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    expect(mergeGateFor(storedWorktree, [{ ...run, status }]).mergeable).toBe(false);
  }
});

it('closes the merge gate for a removed worktree, a review of another worktree version, and a review without a mergeable verdict', async () => {
  // R-B7 scheduler half, the round backfilled at a48ea92: each of the pure gate's refusals,
  // from the open gate of one mergeable review.
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const id = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  const run = state.context.storage.execution.runs.find(state.workspaceId, id);
  const tree = state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id);
  if (run === undefined || tree === undefined) throw new Error('Missing fixtures');
  const reviewRunId = run.id;
  expect(mergeGateFor(tree, [run])).toEqual({ mergeable: true, reason: 'ready', reviewRunId });
  expect(mergeGateFor({ ...tree, status: 'removed' }, [run])).toEqual({
    mergeable: false,
    reason: 'worktree-removed',
  });
  expect(mergeGateFor({ ...tree, version: tree.version + 1 }, [run])).toEqual({
    mergeable: false,
    reason: 'branch-review-required',
    reviewRunId,
  });
  expect(mergeGateFor(tree, [{ ...run, verdict: 'changes-requested' }])).toEqual({
    mergeable: false,
    reason: 'changes-requested',
    reviewRunId,
  });
  const { verdict: _verdict, ...unjudged } = run;
  expect(mergeGateFor(tree, [unjudged])).toEqual({
    mergeable: false,
    reason: 'review-pending',
    reviewRunId,
  });
});

it("holds the merge while a stop's investigation is live, and is not superseded by it after (R-C16)", async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const id = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  const review = state.context.storage.execution.runs.find(state.workspaceId, id);
  const storedWorktree = state.context.storage.execution.worktrees.find(
    state.workspaceId,
    worktree.id,
  );
  if (review === undefined || storedWorktree === undefined) throw new Error('Missing fixtures');
  const investigation = {
    ...review,
    id: asAgentRunId('investigation-run'),
    role: 'design' as const,
    verdict: undefined,
    createdAt: new Date(Date.parse(review.createdAt) + 1000).toISOString(),
    profileSelection: {
      purpose: 'investigation' as const,
      investigationId: asCycleInvestigationId(randomUUID()),
    },
  };
  expect(mergeGateFor(storedWorktree, [{ ...investigation, status: 'running' }, review])).toEqual({
    mergeable: false,
    reason: 'run-live',
  });
  expect(
    mergeGateFor(storedWorktree, [{ ...investigation, status: 'finished' }, review]).mergeable,
  ).toBe(true);
  // Any other later run still supersedes the review.
  const { profileSelection: _selection, ...manual } = investigation;
  expect(mergeGateFor(storedWorktree, [{ ...manual, status: 'finished' }, review])).toMatchObject({
    mergeable: false,
    reason: 'superseded-by-later-run',
  });
});

describe('plan integration branches', () => {
  it('uses the integration head with main checked out, and preserves existing worktree targets across configuration changes', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const main = git(['rev-parse', 'main'], root).trim();
    git(['checkout', '-b', 'revision'], root);
    const revision = commitFile(root, 'integration.txt', 'previously merged item');
    git(['checkout', 'main'], root);
    const { repository, worktree } = await registerAndWorktree(state, root, 'revision');
    expect(worktree).toMatchObject({
      baseSha: revision,
      baseBranch: 'revision',
      integrationBranch: 'revision',
    });
    expect(readFileSync(join(worktree.path, 'integration.txt'), 'utf8')).toBe(
      'previously merged item',
    );
    expect(git(['rev-parse', 'main'], root).trim()).toBe(main);
    const changed = await branchCommand(state, 'plan-versions/version-1/branch-settings', {
      repositoryId: repository.id,
      integrationBranch: 'next-revision',
      createFromBranch: 'revision',
      expectedVersion: 1,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(git(['branch', '--show-current'], root).trim()).toBe('main');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)
        ?.integrationBranch,
    ).toBe('revision');
    const next = await branchCommand(state, `work-items/${state.workItemId}/worktrees`, {
      repositoryId: repository.id,
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().worktree).toMatchObject({
      integrationBranch: 'next-revision',
      baseSha: revision,
    });
    const stale = await branchCommand(state, 'plan-versions/version-1/branch-settings', {
      repositoryId: repository.id,
      integrationBranch: 'should-not-exist',
      createFromBranch: 'main',
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(git(['branch', '--list', 'should-not-exist'], root).trim()).toBe('');
  });

  it('rejects missing targets, unauthorized settings, and changing the target at merge time', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { repository, worktree } = await registerAndWorktree(state, root);
    const path = 'plan-versions/version-1/branch-settings';
    const payload = {
      repositoryId: repository.id,
      integrationBranch: 'missing',
      expectedVersion: 1,
    };
    const missing = await branchCommand(state, path, payload);
    expect(missing.statusCode).toBe(409);
    expect(git(['branch', '--list', 'missing'], root)).toBe('');
    const csrf = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/${path}`,
      headers: { cookie: state.cookie },
      payload,
    });
    expect(csrf.statusCode).toBe(403);
    const foreign = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/foreign/${path}`,
      headers: mutationHeaders(state),
      payload,
    });
    expect(foreign.statusCode).toBe(404);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    const wrongTarget = await merge(state, worktree.id, { targetBranch: 'missing' });
    expect(wrongTarget.statusCode).toBe(409);
    expect(wrongTarget.body).toContain('Retarget');
    expect(git(['branch', '--list', 'missing'], root)).toBe('');
  });

  it('refuses stale manual reviews, updates integration without completing the item, and requires review again', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, root);
    await admit(state);
    commitFile(worktree.path, 'item.txt', 'item');
    const oldReview = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    const target = commitFile(root, 'other-item.txt', 'integration advanced');
    const before = git(['rev-parse', 'HEAD'], worktree.path).trim();
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    const updated = await branchCommand(state, `worktrees/${worktree.id}/control`, {
      action: 'update',
      expectedVersion: worktree.version,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(git(['rev-parse', 'main'], root).trim()).toBe(target);
    expect(git(['rev-parse', 'HEAD'], worktree.path).trim()).not.toBe(before);
    expect(readFileSync(join(worktree.path, 'other-item.txt'), 'utf8')).toBe(
      'integration advanced',
    );
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    expect(
      (
        await branchCommand(state, `worktrees/${worktree.id}/control`, {
          action: 'update',
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    const diffResponse = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/diff`,
      headers: { cookie: state.cookie },
    });
    expect(diffResponse.statusCode).toBe(200);
    expect(diffResponse.json().baseSha).toBe(target);
    expect(diffResponse.json().files.map((file: { path: string }) => file.path)).toEqual([
      'item.txt',
    ]);
    const review = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
      parentRunId: oldReview,
    });
    const run = state.context.storage.execution.runs.find(state.workspaceId, review);
    expect(run?.reviewBranchContext).toMatchObject({
      targetBranch: 'main',
      targetSha: target,
      worktreeVersion: 2,
    });
    expect(run?.brief).toContain(target);
    const merged = await merge(state, worktree.id);
    expect(merged.statusCode, merged.body).toBe(200);
    expect(readFileSync(join(root, 'item.txt'), 'utf8')).toBe('item');
  });

  it('refuses a changed source commit and invalidates review on an explicit retarget', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, root);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    commitFile(worktree.path, 'unreviewed.txt', 'unreviewed');
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    git(['branch', 'revision'], root);
    const retarget = await branchCommand(state, `worktrees/${worktree.id}/control`, {
      action: 'retarget',
      expectedVersion: 1,
      integrationBranch: 'revision',
    });
    expect(retarget.statusCode).toBe(200);
    expect(retarget.json().worktree).toMatchObject({
      integrationBranch: 'revision',
      baseBranch: 'main',
      version: 2,
    });
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    expect((await merge(state, worktree.id)).statusCode).toBe(200);
    expect(existsSync(join(root, 'unreviewed.txt'))).toBe(false);
  });

  it('aborts conflicting integration updates, preserves both branches, and closes the review gate', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, root);
    const source = commitFile(worktree.path, 'conflict.txt', 'item');
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    const target = commitFile(root, 'conflict.txt', 'integration');
    const response = await branchCommand(state, `worktrees/${worktree.id}/control`, {
      action: 'update',
      expectedVersion: 1,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('conflict');
    expect(git(['rev-parse', 'HEAD'], worktree.path).trim()).toBe(source);
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(target);
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.version,
    ).toBe(2);
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
  });

  it('checks prerequisite commit ancestry and accepts explicit evidence for a historical manual completion', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { repository } = await registerAndWorktree(state, root);
    const prerequisite = asWorkItemId('prior');
    state.context.storage.transaction((tx) => {
      tx.planning.workItems.insertMany([
        {
          id: prerequisite,
          workspaceId: state.workspaceId,
          projectId: asProjectId('project-1'),
          planVersionId: asPlanVersionId('version-1'),
          sourceId: 'AQ-00',
          ordinal: 2,
          title: 'Prerequisite',
          risk: 'low',
          primaryAreas: [],
          exitGate: 'done',
          sourceFields: {},
        },
      ]);
      tx.planning.workItems.complete({
        workspaceId: state.workspaceId,
        workItemId: prerequisite,
        projectId: asProjectId('project-1'),
        completedAt: new Date().toISOString(),
        completedByUserId: state.userId,
      });
      tx.planning.dependencies.insertMany([
        {
          id: asWorkItemDependencyId('prior-edge'),
          workspaceId: state.workspaceId,
          planVersionId: asPlanVersionId('version-1'),
          predecessorWorkItemId: prerequisite,
          successorWorkItemId: state.workItemId,
          kind: 'required',
          ordinal: 0,
        },
      ]);
    });
    const blocked = await branchCommand(state, `work-items/${state.workItemId}/worktrees`, {
      repositoryId: repository.id,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain('no recorded merge commit');
    git(['checkout', '-b', 'unmerged-prior'], root);
    const evidence = commitFile(root, 'prerequisite.txt', 'prior work');
    git(['checkout', 'main'], root);
    expect(
      (await branchCommand(state, 'work-items/prior/integration-evidence', { commitSha: evidence }))
        .statusCode,
    ).toBe(409);
    git(['merge', '--no-ff', '--no-edit', 'unmerged-prior'], root);
    const recorded = await branchCommand(state, 'work-items/prior/integration-evidence', {
      commitSha: evidence.slice(0, 12),
    });
    expect(
      state.context.storage.execution.branchSettings.evidence(
        state.workspaceId,
        prerequisite,
        repository.id,
      ),
    ).toBe(evidence);
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json().missingEvidence).toEqual([]);
    // Historical completion is still immutable and untouched.
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, prerequisite)?.mergeSha,
    ).toBeUndefined();
    expect(
      (
        await branchCommand(state, `work-items/${state.workItemId}/worktrees`, {
          repositoryId: repository.id,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('resumes an awaiting-merge cycle through a fresh review after updating integration', async () => {
    const { state, backend, root, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'initial approval');
    const oldReview = currentCycle(state, cycle).currentRunId;
    const target = commitFile(root, 'parallel-item.txt', 'approved elsewhere');
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    expect(
      (
        await branchCommand(state, `worktrees/${worktree.id}/control`, {
          action: 'update',
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    const paused = await controlCycle(state, currentCycle(state, cycle), 'pause');
    const update = await branchCommand(state, `worktrees/${worktree.id}/control`, {
      action: 'update',
      expectedVersion: 1,
    });
    expect(update.statusCode, update.body).toBe(200);
    await controlCycle(state, paused, 'resume');
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'renewed approval');
    const renewed = currentCycle(state, cycle).currentRunId;
    expect(renewed).not.toBe(oldReview);
    expect(backend.launches).toHaveLength(4);
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, renewed)?.reviewBranchContext
        ?.targetSha,
    ).toBe(target);
    expect((await merge(state, worktree.id)).statusCode).toBe(200);
  });
});

it('serializes operator merges for different items in the same repository', async () => {
  const state = await ready();
  const root = fixtureRepository();
  const { worktree: first } = await registerAndWorktree(state, root);
  const secondId = asWorkItemId('parallel-item');
  state.context.storage.planning.workItems.insertMany([
    {
      id: secondId,
      workspaceId: state.workspaceId,
      projectId: first.projectId,
      planVersionId: asPlanVersionId('version-1'),
      sourceId: 'AQ-02',
      ordinal: 1,
      title: 'Independent item',
      risk: 'low',
      primaryAreas: [],
      exitGate: 'done',
      sourceFields: {},
    },
  ]);
  const secondState = { ...state, workItemId: secondId };
  const { worktree: second } = await registerAndWorktree(secondState, root);
  commitFile(first.path, 'first.txt', 'first');
  commitFile(second.path, 'second.txt', 'second');
  await runToFinish(state, first.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
  await runToFinish(secondState, second.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
  const results = await Promise.all([merge(state, first.id), merge(secondState, second.id)]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  expect(results.find((result) => result.statusCode === 409)?.body).toContain('Another merge');
  expect(
    Number(existsSync(join(root, 'first.txt'))) + Number(existsSync(join(root, 'second.txt'))),
  ).toBe(1);
});

it('records completion before cleanup, exposes retry, and preserves edits added after integration', async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let preserve = false;
  let calls = 0;
  const { state, backend, worktree, root } = await cycleFixture(
    [designDone, implementationDone, { resultText: reviewText([]) }],
    undefined,
    {
      ...realGit,
      mergeBranch: async (input) => {
        calls++;
        return realGit.mergeBranch(input);
      },
      removeWorktree: async (input) =>
        preserve && !input.worktreePath.includes('/.merge/')
          ? {
              ok: false,
              failure: { kind: 'git-failed', message: 'Simulated cleanup interruption' },
            }
          : realGit.removeWorktree(input),
    },
  );
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(request.cwd, 'feature.txt', 'reviewed implementation');
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'reviewed branch');
  preserve = true;
  const response = await merge(state, worktree.id);
  expect(response.statusCode, response.body).toBe(200);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('completed');
  expect(existsSync(worktree.path)).toBe(true);
  const committed = git(['rev-parse', 'main'], root);
  const view = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/view`,
    headers: { cookie: state.cookie },
  });
  expect(view.statusCode, view.body).toBe(200);
  expect(view.json().execution.worktrees[0].mergeCleanupError).toContain('cleanup interruption');
  const source = git(['rev-parse', 'HEAD'], worktree.path).trim();
  preserve = false;
  commitFile(worktree.path, 'operator.txt', 'later operator commit');
  const retained = await merge(state, worktree.id);
  expect(retained.statusCode, retained.body).toBe(200);
  expect(existsSync(worktree.path)).toBe(true);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, worktree.id)?.cleanupError,
  ).toContain('different branch or commit');
  // Remove only this test's extra commit, then retry the browser command.
  git(['reset', '--hard', source], worktree.path);
  const cleaned = await merge(state, worktree.id);
  expect(cleaned.statusCode, cleaned.body).toBe(200);
  expect(calls).toBe(1);
  expect(existsSync(worktree.path)).toBe(false);
  expect(git(['rev-parse', 'main'], root)).toBe(committed);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, worktree.id),
  ).toMatchObject({ status: 'cleaned' });
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, worktree.id)?.cleanupError,
  ).toBeUndefined();
});

it("names the branch the primary checkout holds, so the merge approval can say when it moves the operator's checkout (R-G10 D3; operator 2026-10-09)", async () => {
  const state = await ready();
  const repositoryPath = fixtureRepository();
  const { worktree } = await registerAndWorktree(state, repositoryPath);
  await admit(state);
  // A closed gate states no fact: there is nothing to approve yet.
  expect(await mergeGate(state, worktree.id)).not.toHaveProperty('checkedOutBranch');
  writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
  git(['add', '--all'], worktree.path);
  git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
  await runToFinish(state, worktree.id, { role: 'implement' });
  await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
  // The fixture's checkout is on main, the worktree's target.
  expect(await mergeGate(state, worktree.id)).toMatchObject({
    mergeable: true,
    reason: 'ready',
    checkedOutBranch: 'main',
  });
  git(['switch', '--quiet', '-c', 'elsewhere'], repositoryPath);
  expect(await mergeGate(state, worktree.id)).toMatchObject({
    mergeable: true,
    checkedOutBranch: 'elsewhere',
  });
  // A gate closed after its review, by a target that moved, states no fact (review L4, C53).
  git(['switch', '--quiet', 'main'], repositoryPath);
  commitFile(repositoryPath, 'moved.txt', 'moved\n');
  const closed = await mergeGate(state, worktree.id);
  expect(closed).toMatchObject({ mergeable: false, reason: 'branch-review-required' });
  expect(closed).not.toHaveProperty('checkedOutBranch');
});
