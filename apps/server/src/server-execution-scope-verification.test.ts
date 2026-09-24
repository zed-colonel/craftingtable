import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workCycleResponseSchema } from '@craftingtable/contracts';
import type { ExecutionScope } from '@craftingtable/domain';
import { DEFAULT_COMPLETION_POLICY, type WorkCycle } from '@craftingtable/domain';
import { openCraftingTableStorage } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { latestReviewReport } from './services/run-handoff.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  awaitRoadmapMerge,
  branchCommand,
  cleanupExecutionFixtures,
  commitFile,
  currentCycle,
  cycleProfiles,
  git,
  implementationDone,
  launchScoped,
  merge,
  mergeRoadmapAttempt,
  mutationHeaders,
  recordScope,
  reviewScope,
  roadmapControl,
  roadmapId,
  roadmapInput,
  runScopedFixtureCheck,
  scopeReport,
  scopeTree,
  slicedFixture,
  storedRoadmap,
  structuredFinding,
  supervisedMapFixture,
  waitFor,
  withLocalPhaseResources,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

it('recovers parent review with durable guidance only after current verification gates clear', async () => {
  const f = await slicedFixture(),
    { state } = f;
  for (const scope of f.scopes) {
    const tree = await scopeTree(f, scope);
    commitFile(tree.path, `${scope.sourceId.replaceAll('/', '-')}.txt`, 'slice implementation');
    await reviewScope(f, tree);
    expect((await merge(state, tree.id)).statusCode).toBe(200);
    expect((await recordScope(f, tree)).statusCode).toBe(200);
  }
  const tree = await scopeTree(f, f.parentScope);
  f.backend.replyForRequest = (request) => {
    runScopedFixtureCheck(request);
    return {
      resultText: `## Open questions\nWhich policy applies?\n\n## Review report\n${scopeReport(state, f.parentScope)}`,
    };
  };
  const cycle = state.context.services.workCycleService.start(
    f.auth,
    state.workspaceId,
    state.workItemId,
    {
      worktreeId: tree.id,
      profiles: cycleProfiles,
      policy: DEFAULT_COMPLETION_POLICY,
      instructions: 'Keep the original parent gate.',
    },
    undefined,
    true,
  );
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'parent question');
  const saved = await branchCommand(state, 'plan-versions/version-1/repository-policy', {
    expectedVersion: 0,
    expectedBranchSettingsVersion: 1,
    controlMode: 'controller-local',
    interpretation: 'Use the local controller gates.',
    publicationRequirement: 'Before remote publication.',
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const resume = (
    expectedVersion = currentCycle(state, cycle).version,
    headers = mutationHeaders(state),
  ) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers,
      payload: {
        action: 'resume',
        expectedVersion,
        instructions: 'Apply the adopted policy without waiving the source gate.',
      },
    });
  const prior = currentCycle(state, cycle);
  const blocked = await resume();
  expect(blocked.statusCode, blocked.body).toBe(409);
  expect(blocked.body).toContain('has not been verified');
  expect(currentCycle(state, cycle)).toEqual(prior);
  expect((await resume(prior.version, { cookie: state.cookie })).statusCode).toBe(403);
  for (const scope of f.scopes) {
    const verification = await scopeTree(f, { ...scope, kind: 'slice-verification' });
    await reviewScope(f, verification);
    expect((await recordScope(f, verification)).statusCode).toBe(200);
  }
  f.backend.replyForRequest = (request) => {
    runScopedFixtureCheck(request);
    return {
      resultText: `## Open questions\nnone\n\n## Review report\n${scopeReport(state, f.parentScope)}`,
    };
  };
  expect((await resume(prior.version + 1)).statusCode).toBe(409);
  const result = await resume();
  expect(result.statusCode, result.body).toBe(200);
  const continued = currentCycle(state, cycle);
  expect(continued.instructions).toBe('Keep the original parent gate.');
  expect(continued.stepGuidance).toBe('Apply the adopted policy without waiving the source gate.');
  expect(continued.remediationRounds).toBe(0);
  await waitFor(() => currentCycle(state, cycle).status !== 'running', 'fresh parent review');
  const run = state.context.storage.execution.runs.find(
    state.workspaceId,
    currentCycle(state, cycle).currentRunId,
  )!;
  const assessment = latestReviewReport(state.context.storage.execution, run);
  expect(assessment, JSON.stringify(assessment)).toMatchObject({ status: 'complete' });
  expect(currentCycle(state, cycle).status, currentCycle(state, cycle).reason).toBe(
    'awaiting-merge',
  );
  expect(run.role).toBe('review');
  expect(run.brief).toContain('Apply the adopted policy');
  expect(run.reviewBranchContext?.repositoryPolicyVersion).toBe(1);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('admitted');
});

it('repeats completed verification in its existing worktree with the assigned roadmap reviewer', {
  timeout: 20000,
}, async () => {
  const f = await supervisedMapFixture(false, 'manual'),
    { state } = f,
    ws = state.workspaceId;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .listForWorkspace(ws)
        .some(
          (c) => c.executionScope?.kind === 'parent-acceptance' && c.status === 'awaiting-merge',
        ),
    'parent review ready',
    15000,
  );
  await roadmapControl(state, 'pause');
  const cycle = state.context.storage.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'slice-verification' && c.status === 'completed')!;
  expect(cycle).toBeDefined();
  const tree = state.context.storage.execution.worktrees.find(ws, cycle.worktreeId)!;
  const receipts = state.context.storage.scopeReceipts.list(ws, state.workItemId);
  const count = state.context.storage.execution.worktrees.listForWorkItem(
    ws,
    state.workItemId,
  ).length;
  const command = (id = cycle.id, version = cycle.version, headers = mutationHeaders(state)) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${id}/control`,
      headers,
      payload: {
        action: 'review-again',
        expectedVersion: version,
        instructions: 'Use the adopted repository policy.',
      },
    });
  expect((await command(cycle.id, cycle.version, { cookie: state.cookie })).statusCode).toBe(403);
  expect((await command(cycle.id, cycle.version + 1)).statusCode).toBe(409);
  const implementation = state.context.storage.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'slice')!;
  expect((await command(implementation.id, implementation.version)).statusCode).toBe(409);
  const policy = await branchCommand(state, 'plan-versions/version-1/repository-policy', {
    expectedVersion: 0,
    expectedBranchSettingsVersion: state.context.storage.execution.branchSettings.find(
      ws,
      state.context.storage.planning.workItems.find(ws, state.workItemId)!.planVersionId,
    )!.version,
    controlMode: 'controller-local',
    interpretation: 'Local controller gates.',
    publicationRequirement: 'Before remote publication.',
  });
  expect(policy.statusCode, policy.body).toBe(200);
  git(['checkout', 'revision'], f.root);
  commitFile(f.root, 'fresh-integration.txt', 'new integration evidence');
  const head = git(['rev-parse', 'HEAD'], f.root).trim();
  git(['checkout', 'main'], f.root);
  writeFileSync(join(tree.path, 'operator-note.txt'), 'preserve this');
  const dirty = await command();
  expect(dirty.statusCode, dirty.body).toBe(409);
  expect(readFileSync(join(tree.path, 'operator-note.txt'), 'utf8')).toBe('preserve this');
  expect(currentCycle(state, cycle)).toEqual(cycle);
  expect(state.context.services.workCycleService.isTransitioning(cycle.id)).toBe(false);
  rmSync(join(tree.path, 'operator-note.txt'));
  const branches = state.context.services.executionService.branches;
  const changeWorktree = branches.changeWorktree.bind(branches);
  let release!: () => void;
  const preparation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = vi.spyOn(branches, 'changeWorktree').mockImplementationOnce(async (...args) => {
    await preparation;
    return changeWorktree(...args);
  });
  const pending = command().then((response) => response);
  await waitFor(
    () => state.context.services.workCycleService.isTransitioning(cycle.id),
    'review preparation guard',
  );
  expect(
    state.context.services.workCycleService
      .list(f.auth, ws, cycle.workItemId ? { workItemId: cycle.workItemId } : {})
      .find((c) => c.id === cycle.id)?.scopeReviewWait,
  ).toContain('Preparing the requested recovery');
  const duplicate = await command();
  expect(duplicate.statusCode, duplicate.body).toBe(409);
  release();
  const result = await pending;
  delayed.mockRestore();
  expect(state.context.services.workCycleService.isTransitioning(cycle.id)).toBe(false);
  expect(result.statusCode, result.body).toBe(200);
  expect(git(['rev-parse', 'HEAD'], tree.path).trim()).toBe(head);
  const repeated = currentCycle(state, cycle);
  expect(repeated.currentRunId).not.toBe(cycle.currentRunId);
  expect(repeated.parentRunId).toBe(cycle.currentRunId);
  expect(repeated.profiles).toEqual(cycle.profiles);
  expect(repeated.remediationRounds).toBe(0);
  expect((await command()).statusCode).toBe(409);
  await waitFor(() => currentCycle(state, cycle).status !== 'running', 'repeated verification');
  expect(currentCycle(state, cycle).status, currentCycle(state, cycle).reason).toBe(
    'awaiting-merge',
  );
  const run = state.context.storage.execution.runs.find(ws, repeated.currentRunId)!;
  expect(run.role).toBe('review');
  expect(run.reviewBranchContext?.repositoryPolicyVersion).toBe(1);
  expect(run.brief).toContain('Use the adopted repository policy.');
  const refreshedTree = state.context.storage.execution.worktrees.find(ws, tree.id)!;
  const recorded = await recordScope(f, refreshedTree);
  expect(recorded.statusCode, recorded.body).toBe(200);
  expect(state.context.storage.scopeReceipts.list(ws, state.workItemId)).toHaveLength(
    receipts.length + 1,
  );
  expect(
    state.context.storage.execution.worktrees.listForWorkItem(ws, state.workItemId),
  ).toHaveLength(count);
  expect(storedRoadmap(state).status).toBe('paused');
});

it.each([false, true])(
  'delegates independent findings into an editable slice and enforces every source ID (omitted: %s)',
  {
    timeout: 40000,
  },
  async (omitFinding) => {
    const f = await supervisedMapFixture(false, 'manual');
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    const normal = f.backend.replyForRequest!;
    const parentFinding = { ...structuredFinding, id: 'F-003', title: 'Semantic ledger ownership' };
    const verifyFinding = {
      ...structuredFinding,
      id: 'F-003',
      title: 'Contribution branch guidance',
    };
    const reportWith = (scope: ExecutionScope, findings: readonly unknown[], open = true) =>
      '## Open questions\nnone\n\n## Review report\n' +
      scopeReport(state, scope)
        .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
        .replaceAll('mergeable', open ? 'changes-requested' : 'mergeable');
    f.backend.replyForRequest = (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      if (tree.executionScope?.kind === 'parent-acceptance') {
        runScopedFixtureCheck(request);
        return { resultText: reportWith(tree.executionScope, [parentFinding]) };
      }
      return normal(request);
    };
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    await waitFor(
      () =>
        tx.execution.cycles
          .listForWorkspace(ws)
          .some(
            (c) => c.executionScope?.kind === 'parent-acceptance' && c.status === 'needs-attention',
          ),
      'parent finding',
      15000,
    );
    await roadmapControl(state, 'pause');
    const parent = tx.execution.cycles
      .listForWorkspace(ws)
      .find((c) => c.executionScope?.kind === 'parent-acceptance')!;
    const notifications = state.context.services.notificationService;
    const { DEFAULT_NOTIFICATION_PREFERENCES } = await import('@craftingtable/domain');
    notifications.save(f.auth, ws, {
      expectedVersion: 0,
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
      applicationToken: 'a'.repeat(30),
      userKey: 'u'.repeat(30),
    });
    await notifications.tick();
    expect(
      tx.notifications
        .records(ws)
        .some((n) => n.sourceKey.startsWith(`cycle:${parent.id}:`) && n.state === 'active'),
    ).toBe(true);
    const verification = tx.execution.cycles
      .listForWorkspace(ws)
      .find((c) => c.executionScope?.kind === 'slice-verification')!;
    const originalOwner = tx.execution.cycles
      .listForWorkspace(ws)
      .find(
        (c) =>
          c.executionScope?.kind === 'slice' &&
          c.executionScope.sourceId === verification.executionScope?.sourceId,
      )!;
    const reviewTree = tx.execution.worktrees.find(ws, verification.worktreeId)!;
    const originalHead = git(['rev-parse', 'HEAD'], reviewTree.path).trim();
    const command = (cycle: WorkCycle, action: 'resume' | 'review-again') =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload: {
          action,
          expectedVersion: currentCycle(state, cycle).version,
          instructions: 'Keep the adopted policy and the original gate.',
        },
      });
    f.backend.replyForRequest = (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      runScopedFixtureCheck(request);
      return { resultText: reportWith(tree.executionScope!, [verifyFinding]) };
    };
    expect((await command(verification, 'review-again')).statusCode).toBe(200);
    await waitFor(
      () => currentCycle(state, verification).status === 'needs-attention',
      'verification finding',
    );
    const latestVerification = currentCycle(state, verification);
    // Resuming without guidance would review the unchanged snapshot again (R-A7, 10dbc912).
    const repeat = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${verification.id}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'resume', expectedVersion: latestVerification.version },
    });
    expect(repeat.statusCode, repeat.body).toBe(409);
    expect(repeat.body).toContain('has not changed since this review');
    expect(currentCycle(state, verification).version).toBe(latestVerification.version);
    const { scopeRecoveryDecision } = await import('./services/scope-recovery-policy.js');
    const roadmap = storedRoadmap(state);
    const verificationEntry = roadmap.definition.entries.find(
      (e) =>
        e.executionScope?.kind === 'slice-verification' &&
        e.executionScope.sourceId === verification.executionScope!.sourceId,
    )!;
    expect(
      scopeRecoveryDecision(
        tx,
        {
          ...roadmap,
          scopeRecovery: {
            enabled: true,
            maxRoundsPerParent: 3,
            grantedAt: new Date().toISOString(),
            grantedByUserId: state.userId,
          },
        },
        verificationEntry,
        latestVerification,
      ).reason,
    ).toContain('ambiguous');
    const path = `/api/workspaces/${ws}/cycles/${verification.id}/scope-repair`;
    const response = await state.context.app.inject({
      method: 'GET',
      url: path,
      headers: { cookie: state.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { scopeRepairPreviewSchema } = await import('@craftingtable/contracts');
    const preview = scopeRepairPreviewSchema.parse(response.json());
    expect(preview.sources).toHaveLength(2);
    expect(preview.sources.flatMap((s) => s.findings.map((f) => f.id)).sort()).toEqual([
      'R1.F-003',
      'R2.F-003',
    ]);
    expect(preview.sources.flatMap((s) => s.findings.map((f) => f.title))).toEqual(
      expect.arrayContaining([parentFinding.title, verifyFinding.title]),
    );
    const input = {
      expectedVersion: latestVerification.version,
      snapshotDigest: preview.snapshotDigest,
      sourceId: verification.executionScope!.sourceId,
      instructions: 'Repair both distinct findings; preserve runtime behavior.',
      maxRemediationRounds: 2,
    };
    const delegate = (payload = input, headers = mutationHeaders(state)) =>
      state.context.app.inject({ method: 'POST', url: path, headers, payload });
    expect((await delegate(input, { cookie: state.cookie })).statusCode).toBe(403);
    expect((await delegate({ ...input, snapshotDigest: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await delegate({ ...input, sourceId: 'foreign-slice' })).statusCode).toBe(409);
    let packet:
      | {
          sources: {
            runId: string;
            findings: (typeof structuredFinding)[];
            finalMessage: string;
          }[];
        }
      | undefined;
    f.backend.replyForRequest = (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      const file = /`([^`]+\/craftingtable-scope-repair\.json)`/.exec(request.prompt)?.[1];
      expect(file, request.prompt).toBeTruthy();
      packet = JSON.parse(readFileSync(file!, 'utf8'));
      expect(packet!.sources).toHaveLength(2);
      expect(packet!.sources.every((s) => s.finalMessage.includes('F-003'))).toBe(true);
      expect(request.prompt).toContain('Repair both distinct findings');
      if (request.model !== 'review-model') {
        expect(request.model).toBe('remediate-model');
        commitFile(request.cwd, 'recovery.txt', 'Fixed both ledger and contribution guidance');
        return implementationDone;
      }
      runScopedFixtureCheck(request);
      const findings = packet!.sources
        .flatMap((s) => s.findings)
        .map((finding) => ({
          id: finding.id,
          title: finding.title,
          severity: finding.severity,
          explanation: finding.explanation,
          recommendation: finding.recommendation,
          status: 'resolved',
          disposition: 'Inspected the committed correction and regression evidence.',
        }));
      return {
        resultText: reportWith(
          tree.executionScope!,
          omitFinding ? findings.slice(1) : findings,
          false,
        ),
      };
    };
    const started = await delegate();
    expect(started.statusCode, started.body).toBe(200);
    const repair = workCycleResponseSchema.parse(started.json()).cycle;
    expect(repair).toMatchObject({
      step: 'remediate',
      remediationRounds: 0,
      profiles: originalOwner.profiles,
      executionScope: originalOwner.executionScope,
      policy: { maxRemediationRounds: 2 },
      scopeRepair: { sourceCycleId: verification.id },
    });
    expect(repair.parentRunId).toBeUndefined();
    expect(repair.scopeRepair?.sources).toEqual(
      preview.sources.map((s) => ({ runId: s.runId, sequence: s.sequence, label: s.label })),
    );
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(ws, repair.id)?.scopeRepair).toEqual(
        repair.scopeRepair,
      );
    } finally {
      reopened.close();
    }
    expect(repair.worktreeId).not.toBe(originalOwner.worktreeId);
    expect(repair.worktreeId).not.toBe(reviewTree.id);
    expect(git(['rev-parse', 'HEAD'], reviewTree.path).trim()).toBe(originalHead);
    const duplicate = await delegate();
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    const blockedReview = await command(verification, 'resume');
    expect(blockedReview.statusCode, blockedReview.body).toBe(409);
    expect(blockedReview.body).toContain('active owning-slice');
    const projected = state.context.services.workCycleService.list(f.auth, ws);
    expect(projected.find((c) => c.id === parent.id)?.scopeReviewWait).toContain(
      'Waiting for prerequisite work',
    );
    expect(projected.find((c) => c.id === verification.id)?.scopeReviewWait).toContain(
      'active owning-slice',
    );
    expect(tx.execution.cycles.find(ws, parent.id)?.reason).toBe(parent.reason);
    await notifications.tick();
    expect(
      tx.notifications
        .records(ws)
        .filter((n) => n.sourceKey.startsWith(`cycle:${parent.id}:`))
        .every((n) => n.state === 'resolved'),
    ).toBe(true);
    await waitFor(() => currentCycle(state, repair).status !== 'running', 'source repair review');
    expect(packet).toBeDefined();
    if (omitFinding) {
      expect(currentCycle(state, repair).status).toBe('needs-attention');
      const report = latestReviewReport(
        tx.execution,
        tx.execution.runs.find(ws, currentCycle(state, repair).currentRunId)!,
      );
      expect(report).toMatchObject({ status: 'invalid' });
      expect((await merge(state, repair.worktreeId)).statusCode).toBe(409);
      return;
    }
    expect(currentCycle(state, repair).status, currentCycle(state, repair).reason).toBe(
      'awaiting-merge',
    );
    const repairedTree = tx.execution.worktrees.find(ws, repair.worktreeId)!;
    const merged = await merge(state, repair.worktreeId);
    expect(merged.statusCode, merged.body).toBe(200);
    expect(storedRoadmap(state).status).toBe('paused');
    expect(tx.execution.cycles.find(ws, originalOwner.id)).toEqual(originalOwner);
    expect(git(['rev-parse', 'HEAD'], reviewTree.path).trim()).toBe(originalHead);
    const integrationHead = git(['rev-parse', 'revision'], f.root).trim();
    expect(integrationHead).not.toBe(originalHead);
    expect((await command(parent, 'resume')).statusCode).toBe(409);
    f.backend.replyForRequest = (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      runScopedFixtureCheck(request);
      const finding =
        tree.executionScope?.kind === 'parent-acceptance' ? parentFinding : verifyFinding;
      return {
        resultText: reportWith(
          tree.executionScope!,
          [
            {
              ...finding,
              status: 'resolved',
              disposition: 'Verified fixes in the refreshed integration snapshot.',
            },
          ],
          false,
        ),
      };
    };
    // Existing snapshot resumption must refresh even while the roadmap is paused.
    const resumed = await command(verification, 'resume');
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(git(['rev-parse', 'HEAD'], reviewTree.path).trim()).toBe(integrationHead);
    await waitFor(
      () => currentCycle(state, verification).status !== 'running',
      'fresh verification',
    );
    expect(currentCycle(state, verification).status, currentCycle(state, verification).reason).toBe(
      'awaiting-merge',
    );
    const recorded = await recordScope(f, reviewTree);
    expect(recorded.statusCode, recorded.body).toBe(200);
    // Refresh sibling verification too: integration moved, and the parent gate must stay exact.
    for (const sibling of tx.execution.cycles
      .listForWorkspace(ws)
      .filter((c) => c.executionScope?.kind === 'slice-verification' && c.id !== verification.id)) {
      const result = await command(
        sibling,
        sibling.status === 'completed' ? 'review-again' : 'resume',
      );
      expect(result.statusCode, result.body).toBe(200);
      await waitFor(
        () => currentCycle(state, sibling).status !== 'running',
        'sibling verification',
      );
      const receipt = await recordScope(f, tx.execution.worktrees.find(ws, sibling.worktreeId)!);
      expect(receipt.statusCode, receipt.body).toBe(200);
    }
    const parentResume = await command(parent, 'resume');
    expect(parentResume.statusCode, parentResume.body).toBe(200);
    const parentTree = tx.execution.worktrees.find(ws, parent.worktreeId)!;
    expect(git(['rev-parse', 'HEAD'], parentTree.path).trim()).toBe(integrationHead);
    await waitFor(() => currentCycle(state, parent).status !== 'running', 'parent re-review');
    const accepted = await recordScope(f, parentTree);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(tx.planning.workItems.find(ws, state.workItemId)?.status).toBe('completed');
    expect(storedRoadmap(state).status).toBe('paused');
    expect(repairedTree.executionScope?.kind).toBe('slice');
  },
);

it.each([
  'accepted',
  'accepted-after-pause',
  'questions',
  'unchanged',
  'exhausted',
  'ambiguous',
] as const)('bounded roadmap scope recovery: %s', { timeout: 45000 }, async (outcome) => {
  const f = await supervisedMapFixture(false, 'automatic', false, false, outcome !== 'ambiguous');
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  const normal = f.backend.replyForRequest!;
  let parentReviews = 0;
  let repairs = 0;
  const reportWith = (scope: ExecutionScope, findings: readonly unknown[], questions = 'none') =>
    '## Open questions\n' +
    questions +
    '\n\n## Review report\n' +
    scopeReport(state, scope)
      .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
      .replaceAll(
        'mergeable',
        findings.some((f) => (f as { status: string }).status === 'open')
          ? 'changes-requested'
          : 'mergeable',
      );
  f.backend.replyForRequest = (request) => {
    const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    const scope = tree.executionScope!;
    if (scope.kind === 'parent-acceptance') {
      parentReviews++;
      runScopedFixtureCheck(request);
      const defect = {
        ...structuredFinding,
        id: 'F003',
        severity: 'major',
        title: 'Complete semantic coverage',
        explanation:
          outcome === 'unchanged'
            ? 'The same missing behavior remains.'
            : `Prior corrections verified; missing family ${parentReviews}.`,
      };
      const finished = outcome.startsWith('accepted') && parentReviews >= 3;
      return {
        resultText: reportWith(
          scope,
          finished
            ? [{ ...defect, status: 'resolved', disposition: 'Verified all families.' }]
            : [defect],
          outcome === 'questions' && parentReviews > 1
            ? 'Which authority should own this behavior?'
            : 'none',
        ),
      };
    }
    const packetPath = /`([^`]+\/craftingtable-scope-repair\.json)`/.exec(request.prompt)?.[1];
    if (packetPath) {
      expect(scope.kind).toBe('slice');
      expect(request.prompt).toContain('audit that family systematically');
      if (request.model !== 'review-model') {
        repairs++;
        commitFile(request.cwd, `repair-${repairs}.txt`, `Corrected family ${repairs}`);
        return {
          ...implementationDone,
          backgroundWorkPending: outcome === 'accepted-after-pause' && repairs === 1,
        };
      }
      runScopedFixtureCheck(request);
      const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
      const findings = packet.sources
        .flatMap((s: { findings: (typeof structuredFinding)[] }) => s.findings)
        .map((finding: typeof structuredFinding) => ({
          id: finding.id,
          title: finding.title,
          severity: finding.severity,
          explanation: finding.explanation,
          recommendation: finding.recommendation,
          status: 'resolved',
          disposition: 'Verified the committed correction.',
        }));
      return { resultText: reportWith(scope, findings) };
    }
    return normal(request);
  };
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      tx.execution.cycles
        .listForWorkspace(ws)
        .some(
          (c) => c.executionScope?.kind === 'parent-acceptance' && c.status === 'needs-attention',
        ),
    'initial parent finding',
    15000,
  );
  await roadmapControl(state, 'pause');
  const prior = storedRoadmap(state);
  const policyPath = `/api/workspaces/${ws}/roadmaps/${roadmapId}/scope-recovery`;
  const input = {
    expectedVersion: prior.version,
    enabled: true,
    maxRoundsPerParent: outcome === 'exhausted' ? 1 : 3,
  };
  expect(
    (
      await state.context.app.inject({
        method: 'POST',
        url: policyPath,
        headers: { cookie: state.cookie },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await state.context.app.inject({
        method: 'POST',
        url: policyPath,
        headers: mutationHeaders(state),
        payload: { ...input, expectedVersion: input.expectedVersion - 1 },
      })
    ).statusCode,
  ).toBe(409);
  const saved = await state.context.app.inject({
    method: 'POST',
    url: policyPath,
    headers: mutationHeaders(state),
    payload: input,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(storedRoadmap(state).definition).toEqual(prior.definition);
  expect(parentReviews).toBe(1);
  const stoppedParent = tx.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'parent-acceptance')!;
  const assessment = tx.execution.runEvents.latestOfKind(
    ws,
    stoppedParent.currentRunId,
    'turn-completed',
  );
  expect(
    assessment?.kind === 'turn-completed' && assessment.payload.reviewReport?.status,
    JSON.stringify(assessment?.payload),
  ).toBe('complete');
  await roadmapControl(state, 'resume');
  if (outcome === 'accepted-after-pause') {
    await waitFor(
      () =>
        storedRoadmap(state).attempts.some((a) => {
          const cycle = tx.execution.cycles.find(ws, a.cycleId);
          return (
            a.recovery &&
            cycle &&
            tx.execution.runs.find(ws, cycle.currentRunId)?.status === 'waiting'
          );
        }),
      'repair completed turn awaiting session close',
      10000,
    );
    await roadmapControl(state, 'pause');
    const round = storedRoadmap(state).attempts.find((a) => a.recovery)!;
    const cycle = tx.execution.cycles.find(ws, round.cycleId)!;
    f.backend.sessions.at(-1)!.backgroundWorkPending = false;
    expect((await branchCommand(state, `runs/${cycle.currentRunId}/end`, {})).statusCode).toBe(200);
    await waitFor(
      () => tx.execution.runs.find(ws, cycle.currentRunId)?.status === 'finished',
      'repair session finished',
    );
    expect(state.context.services.agentRunService.recoverInterrupted()).toBe(0);
    state.context.services.workCycleService.recoverInterrupted();
    state.context.services.roadmapService.recoverInterrupted();
    expect(storedRoadmap(state).status).toBe('paused');
    expect(storedRoadmap(state).attempts.filter((a) => a.recovery)).toEqual([round]);
    await roadmapControl(state, 'resume');
  }
  if (outcome.startsWith('accepted')) {
    await waitFor(
      () => tx.planning.workItems.find(ws, state.workItemId)?.status === 'completed',
      'automatic recovered parent acceptance',
      22000,
    );
    await waitFor(
      () =>
        storedRoadmap(state)
          .attempts.filter((a) => a.recovery)
          .every((a) => a.recovery!.phase === 'completed'),
      'rounds completed',
    );
    expect(repairs).toBe(2); // Repeated F003 with new evidence is real progress, not ID-based stagnation.
    expect(parentReviews).toBe(3);
  } else {
    await waitFor(
      () =>
        Object.values(storedRoadmap(state).entryHolds ?? {}).some((h) =>
          h.reason.includes(
            outcome === 'questions'
              ? 'resolve questions'
              : outcome === 'unchanged'
                ? 'same substantive findings'
                : outcome === 'exhausted'
                  ? 'allowance exhausted'
                  : 'ambiguous',
          ),
        ),
      'bounded recovery stopping reason',
      22000,
    );
    expect(repairs).toBe(outcome === 'ambiguous' ? 0 : 1);
    expect(tx.planning.workItems.find(ws, state.workItemId)?.status).not.toBe('completed');
  }
  const rounds = storedRoadmap(state).attempts.filter((a) => a.recovery);
  for (const round of rounds) {
    expect(tx.execution.worktrees.find(ws, round.worktreeId)?.mergedAt).toBeTruthy();
    expect(tx.execution.merges.latest(ws, round.worktreeId)?.roadmapId).toBe(roadmapId);
    expect(round.definitionRevision).toBe(prior.definition.revision);
  }
  const reopened = openCraftingTableStorage(tx.databasePath);
  try {
    expect(reopened.roadmaps.find(ws, roadmapId)?.attempts).toEqual(storedRoadmap(state).attempts);
  } finally {
    reopened.close();
  }
  expect(
    rounds.every(
      (a) => tx.execution.worktrees.find(ws, a.worktreeId)?.integrationBranch !== 'main',
    ),
  ).toBe(true);
});

it('recovers a verification defect, survives pause/restart, and preserves manual integration and parent approval', {
  timeout: 30000,
}, async () => {
  const f = await supervisedMapFixture(false, 'manual', false, false, true);
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  const normal = f.backend.replyForRequest!;
  let verifications = 0;
  f.backend.replyForRequest = (request) => {
    const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    const scope = tree.executionScope!;
    let findings: unknown[] | undefined;
    if (scope.kind === 'slice-verification') {
      runScopedFixtureCheck(request);
      findings = [
        {
          ...structuredFinding,
          ...(++verifications > 1
            ? { status: 'resolved', disposition: 'Verified committed repair.' }
            : {}),
        },
      ];
    }
    const packetPath = /`([^`]+\/craftingtable-scope-repair\.json)`/.exec(request.prompt)?.[1];
    if (packetPath) {
      if (request.model !== 'review-model') {
        commitFile(request.cwd, 'repair.txt', 'Corrected verification finding');
        return implementationDone;
      }
      runScopedFixtureCheck(request);
      const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
      findings = packet.sources
        .flatMap((s: { findings: (typeof structuredFinding)[] }) => s.findings)
        .map((f: typeof structuredFinding) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
          explanation: f.explanation,
          recommendation: f.recommendation,
          status: 'resolved',
          disposition: 'Verified the regression.',
        }));
    }
    return findings
      ? {
          resultText:
            '## Open questions\nnone\n\n## Review report\n' +
            scopeReport(state, scope)
              .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
              .replaceAll(
                'mergeable',
                scope.kind === 'slice-verification' && verifications === 1
                  ? 'changes-requested'
                  : 'mergeable',
              ),
        }
      : normal(request);
  };
  f.service.save(f.auth, ws, {
    ...f.input,
    configuration: {
      ...f.input.configuration,
      defaults: {
        ...f.input.configuration.defaults,
        automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
      },
    },
  });
  await adoptSupervisedMap(f);
  state.context.services.roadmapService.configureScopeRecovery(f.auth, ws, roadmapId, {
    expectedVersion: storedRoadmap(state).version,
    enabled: true,
    maxRoundsPerParent: 2,
  });
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  await mergeRoadmapAttempt(state, first.worktreeId);
  await waitFor(
    () =>
      storedRoadmap(state).attempts.some(
        (a) => a.recovery && tx.execution.cycles.find(ws, a.cycleId)?.status === 'awaiting-merge',
      ),
    'manual repair integration',
    10000,
  );
  const repair = storedRoadmap(state).attempts.find((a) => a.recovery)!;
  expect(tx.execution.worktrees.find(ws, repair.worktreeId)?.mergedAt).toBeUndefined();
  const source = tx.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'slice-verification')!;
  expect(
    state.context.services.workCycleService.list(f.auth, ws).find((c) => c.id === source.id)
      ?.scopeReviewWait,
  ).toContain('roadmap recovery');
  await roadmapControl(state, 'pause');
  expect(storedRoadmap(state).attempts.filter((a) => a.recovery)).toHaveLength(1);
  state.context.services.roadmapService.recoverInterrupted();
  await roadmapControl(state, 'resume');
  state.context.services.roadmapService.recoverInterrupted();
  expect(storedRoadmap(state).status).toBe('needs-attention');
  await state.context.services.roadmapService.tick();
  expect(tx.execution.worktrees.find(ws, repair.worktreeId)?.mergedAt).toBeUndefined();
  await roadmapControl(state, 'resume');
  expect(storedRoadmap(state).attempts.filter((a) => a.recovery)).toHaveLength(1);
  await mergeRoadmapAttempt(state, repair.worktreeId);
  await waitFor(
    () =>
      tx.execution.cycles
        .listForWorkspace(ws)
        .some(
          (c) => c.executionScope?.kind === 'parent-acceptance' && c.status === 'awaiting-merge',
        ),
    'manual parent approval',
    10000,
  );
  expect(verifications).toBe(2);
  expect(tx.planning.workItems.find(ws, state.workItemId)?.status).not.toBe('completed');
  const parent = tx.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'parent-acceptance')!;
  await recordScope(f, tx.execution.worktrees.find(ws, parent.worktreeId)!);
  await waitFor(
    () => tx.planning.workItems.find(ws, state.workItemId)?.status === 'completed',
    'explicit parent approval',
  );
});

it('reports the shared workstation limits and admits four scoped runs when configured', {
  timeout: 15000,
}, async () => {
  const ids = ['AQ-01.A', 'AQ-01.B', 'AQ-01.C', 'AQ-01.D', 'AQ-01.E'];
  const f = await slicedFixture((source) =>
    withLocalPhaseResources({
      ...source,
      work_items: source.work_items.map((p) => ({ ...p, required_slices: ids })),
      slices: ids.map((id) => ({ ...source.slices[0]!, id, title: id })),
    }),
  );
  const { state } = f,
    ws = state.workspaceId;
  state.context.storage.phaseScheduling.setCapacity('local-development', 4);
  const trees = [];
  for (const sourceId of ids) trees.push(await scopeTree(f, { ...f.scopes[0]!, sourceId }));
  const results = await Promise.all(trees.map((tree) => launchScoped(f, tree)));
  expect(results.filter((r) => r.statusCode === 200)).toHaveLength(4);
  expect(results.find((r) => r.statusCode !== 200)?.body).toContain('4/4 reservations occupied');
  const view = state.context.services.roadmapService.save(f.auth, ws, roadmapId, {
    ...roadmapInput(state, [state.workItemId]),
    entries: [{ ...roadmapInput(state).entries[0]!, executionScope: f.scopes[0] }],
  });
  expect(view.hostCapacity).toEqual({
    development: { limit: 4, inUse: 4 },
    verification: { limit: 1, inUse: 0 },
  });
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${ws}/roadmaps`,
    headers: { cookie: state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().roadmaps[0].hostCapacity).toEqual(view.hostCapacity);
});
