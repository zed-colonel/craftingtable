import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { latestReviewReport } from '../src/services/run-handoff.js';

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
  itNeedsCargo,
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
  f.backend.replyForRequest = async (request) => {
    await runScopedFixtureCheck(request);
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
  f.backend.replyForRequest = async (request) => {
    await runScopedFixtureCheck(request);
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

itNeedsCargo(
  'repeats completed verification in its existing worktree with the assigned roadmap reviewer',
  async () => {
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
        .find((v) => v.cycle.id === cycle.id)?.projection.scopeReviewWait,
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
  },
);

itNeedsCargo(
  'recovers a verification defect, survives pause/restart, and preserves manual integration and parent approval',
  async () => {
    const f = await supervisedMapFixture(false, 'manual', false, false, true);
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    const normal = f.backend.replyForRequest!;
    let verifications = 0;
    f.backend.replyForRequest = async (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      const scope = tree.executionScope!;
      let findings: unknown[] | undefined;
      if (scope.kind === 'slice-verification') {
        await runScopedFixtureCheck(request);
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
        await runScopedFixtureCheck(request);
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
    );
    const repair = storedRoadmap(state).attempts.find((a) => a.recovery)!;
    expect(tx.execution.worktrees.find(ws, repair.worktreeId)?.mergedAt).toBeUndefined();
    const source = tx.execution.cycles
      .listForWorkspace(ws)
      .find((c) => c.executionScope?.kind === 'slice-verification')!;
    expect(
      state.context.services.workCycleService.list(f.auth, ws).find((v) => v.cycle.id === source.id)
        ?.projection.scopeReviewWait,
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
  },
);

it('reports the shared workstation limits and admits four scoped runs when configured', async () => {
  const ids = ['local/AQ-01/a', 'local/AQ-01/b', 'local/AQ-01/c', 'local/AQ-01/d', 'local/AQ-01/e'];
  const f = await slicedFixture((source) => ({
    ...source,
    work_items: source.work_items.map((p) => ({
      ...p,
      required_slices: ids,
      acceptance_requires: ids.map((id) => ({
        kind: 'slice' as const,
        id,
        state: 'verified' as const,
      })),
    })),
    slices: ids.map((id) => ({ ...source.slices[0]!, id, title: id })),
  }));
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
