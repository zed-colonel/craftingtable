import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mergeWorktreeResponseSchema,
  repositoryBranchesResponseSchema,
  startAgentRunResponseSchema,
} from '@craftingtable/contracts';
import {
  asAgentRunId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
} from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeGateFor } from '../src/services/execution-service.js';

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
    // updated through a scratch worktree and the checkout stays where it was.
    git(['checkout', '-b', 'elsewhere'], repositoryPath);
    const elsewhere = await merge(state, worktree.id);
    expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    const landed = mergeWorktreeResponseSchema.parse(elsewhere.json());
    expect(git(['rev-parse', 'main'], repositoryPath).trim()).toBe(landed.mergeSha);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repositoryPath).trim()).toBe('elsewhere');
    expect(existsSync(join(state.context.config.execution.worktreeRoot, '.merge'))).toBe(true);
    expect(readdirSync(join(state.context.config.execution.worktreeRoot, '.merge'))).toEqual([]);
    git(['checkout', 'main'], repositoryPath);
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
    expect(launch?.prompt).toContain('VERDICT: changes-requested');
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
    profileSelection: { purpose: 'investigation' as const, investigationId: randomUUID() },
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
    const updated = await branchCommand(state, `worktrees/${worktree.id}/update`, {
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
      (await branchCommand(state, `worktrees/${worktree.id}/update`, { expectedVersion: 1 }))
        .statusCode,
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
    const retarget = await branchCommand(state, `worktrees/${worktree.id}/retarget`, {
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
    const response = await branchCommand(state, `worktrees/${worktree.id}/update`, {
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
      (await branchCommand(state, `worktrees/${worktree.id}/update`, { expectedVersion: 1 }))
        .statusCode,
    ).toBe(409);
    const paused = await controlCycle(state, currentCycle(state, cycle), 'pause');
    const update = await branchCommand(state, `worktrees/${worktree.id}/update`, {
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
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/execution`,
    headers: { cookie: state.cookie },
  });
  expect(view.statusCode, view.body).toBe(200);
  expect(view.json().worktrees[0].mergeCleanupError).toContain('cleanup interruption');
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
