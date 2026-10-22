/**
 * Operator-requested recovery rounds (R-C5 increment 2, 18f0bb8) at their edges: the
 * automatic allowance, refused and overlapping requests, and a round whose request never
 * finished. Found by the independent review of the live fixes (R-I11).
 */
import { randomUUID } from 'node:crypto';
import {
  asRoadmapAttemptId,
  asWorkCycleId,
  type ExecutionScope,
  type RoadmapAttempt,
  roadmapAttention,
} from '@craftingtable/domain';
import { afterEach, expect, vi } from 'vitest';
import { mapReadSnapshot } from '../src/services/map-read-snapshot.js';
import {
  automatedScopeRecoveryWait,
  scopeRecoveryDecision,
} from '../src/services/scope-recovery-policy.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  git,
  itNeedsCargo,
  mutationHeaders,
  roadmapControl,
  runScopedFixtureCheck,
  scopeReport,
  storedRoadmap,
  structuredFinding,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/** A roadmap whose parent review stopped with one open finding; automatic recovery off. */
async function stoppedParentReview() {
  const f = await supervisedMapFixture(false, 'automatic', false, false, true);
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  const normal = f.backend.replyForRequest!;
  const defect = { ...structuredFinding, id: 'F003', severity: 'major' };
  f.backend.replyForRequest = async (request) => {
    const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    const scope: ExecutionScope = tree.executionScope!;
    if (scope.kind === 'parent-acceptance') {
      await runScopedFixtureCheck(request);
      return {
        resultText:
          '## Open questions\nnone\n\n## Review report\n' +
          scopeReport(state, scope)
            .replace('"findings":[]', `"findings":${JSON.stringify([defect])}`)
            .replaceAll('mergeable', 'changes-requested'),
      };
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
  );
  const parent = tx.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'parent-acceptance')!;
  const roadmap = storedRoadmap(state);
  const sourceEntry = roadmap.definition.entries.find(
    (e) => e.id === roadmap.attempts.find((a) => a.cycleId === parent.id)!.entryId,
  )!;
  const ownerEntry = roadmap.definition.entries.find(
    (e) => e.workItemId === sourceEntry.workItemId && e.executionScope?.kind === 'slice',
  )!;
  const preview = state.context.services.workCycleService.previewScopeRepair(f.auth, ws, parent.id);
  const input = {
    expectedVersion: parent.version,
    snapshotDigest: preview.snapshotDigest,
    sourceId: preview.candidates[0]!.scope.sourceId,
    instructions: 'Repair the missing family.',
    maxRemediationRounds: 2,
  };
  return { f, state, ws, tx, parent, sourceEntry, ownerEntry, input };
}

itNeedsCargo(
  'operator rounds do not use the automatic allowance but still count as repeats',
  async () => {
    const { state, tx, parent, sourceEntry, ownerEntry } = await stoppedParentReview();
    const roadmap = storedRoadmap(state);
    const round = (requested: boolean, fingerprint: string): RoadmapAttempt => ({
      id: asRoadmapAttemptId(randomUUID()),
      entryId: ownerEntry.id,
      definitionRevision: roadmap.definition.revision,
      worktreeId: randomUUID() as RoadmapAttempt['worktreeId'],
      cycleId: asWorkCycleId(randomUUID()),
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      recovery: {
        sourceEntryId: sourceEntry.id,
        sourceRunId: parent.currentRunId,
        sourceSequence: 1,
        findingFingerprint: fingerprint,
        phase: 'completed',
        reviewRunIds: {},
        ...(requested ? { requestedByUserId: state.userId } : {}),
      },
    });
    const decide = (attempts: readonly RoadmapAttempt[]) =>
      scopeRecoveryDecision(
        mapReadSnapshot(tx),
        {
          ...roadmap,
          scopeRecovery: {
            enabled: true,
            maxRoundsPerParent: 1,
            grantedByUserId: state.userId,
            grantedAt: new Date().toISOString(),
          },
          attempts: [...roadmap.attempts, ...attempts],
        },
        sourceEntry,
        parent,
      );
    const baseline = decide([]);
    expect(baseline.owner?.id, baseline.reason).toBe(ownerEntry.id);
    // Three operator rounds with other findings: allowance 1 is still unused, and the lifetime
    // ceiling of three is not reached (LIVE-28 review).
    const operatorOnly = decide(['a', 'b', 'c'].map((c) => round(true, c.repeat(64))));
    expect(operatorOnly.owner?.id, operatorOnly.reason).toBe(ownerEntry.id);
    // One automatic round exhausts allowance 1 (boundary: >=).
    expect(decide([round(false, 'a'.repeat(64))]).reason).toContain('allowance exhausted');
    // An operator round with the same findings still stops as a repeat.
    expect(decide([round(true, baseline.fingerprint!)]).reason).toContain(
      'same substantive findings',
    );
    // The stop counts only the rounds that used the allowance.
    expect(decide([round(false, 'a'.repeat(64)), round(true, 'b'.repeat(64))]).reason).toContain(
      '(1 automatic round for this parent)',
    );
  },
);

itNeedsCargo('a reservation that created its worktree is retried in place', async () => {
  const { f, state, ws, tx, parent, input } = await stoppedParentReview();
  // delegateScopeRepair's start (R-B7 increment 8: the start command).
  const cycles = (
    state.context.services.workCycleService as unknown as {
      starts: { start: (...args: unknown[]) => unknown };
    }
  ).starts;
  const spy = vi.spyOn(cycles, 'start').mockImplementationOnce(() => {
    throw new Error('simulated cycle creation failure');
  });
  const post = () =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
      headers: mutationHeaders(state),
      payload: input,
    });
  const first = await post();
  expect(first.statusCode).toBe(500);
  const reserved = storedRoadmap(state).attempts.filter((x) => x.recovery);
  expect(reserved).toHaveLength(1);
  expect(reserved[0]!.status).toBe('preparing');
  expect(tx.execution.worktrees.find(ws, reserved[0]!.worktreeId)).toBeTruthy();
  expect(tx.execution.cycles.find(ws, reserved[0]!.cycleId)).toBeUndefined();
  spy.mockRestore();
  // The roadmap waits for the operator's retry and does not start its own.
  await state.context.services.roadmapService.tick();
  expect(storedRoadmap(state).attempts.filter((x) => x.recovery)).toEqual(reserved);
  // The operator refreshes the preview, as the UI does after a failure.
  const refreshed = state.context.services.workCycleService.previewScopeRepair(
    f.auth,
    ws,
    parent.id,
  );
  expect(refreshed.candidates[0]!.worktreeId).toBe(reserved[0]!.worktreeId);
  const second = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
    headers: mutationHeaders(state),
    payload: { ...input, snapshotDigest: refreshed.snapshotDigest },
  });
  expect(second.statusCode, second.body).toBe(200);
  const rounds = storedRoadmap(state).attempts.filter((x) => x.recovery);
  expect(rounds).toHaveLength(1);
  expect(rounds[0]!.id).toBe(reserved[0]!.id);
  expect(second.json().cycle.id).toBe(reserved[0]!.cycleId);
  expect(second.json().cycle.worktreeId).toBe(reserved[0]!.worktreeId);
  expect(
    tx.execution.worktrees
      .listForWorkItem(ws, parent.workItemId!)
      .filter((t) => t.executionScope?.kind === 'slice' && t.status === 'active'),
  ).toHaveLength(1);
});

itNeedsCargo('an explicit pause on the source entry survives the request', async () => {
  const { state, ws, parent, sourceEntry, input } = await stoppedParentReview();
  // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
  state.context.services.roadmapService['writer'].change(storedRoadmap(state), {
    entryHolds: { [sourceEntry.id]: { status: 'paused', reason: 'Operator paused this item.' } },
  });
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
    headers: mutationHeaders(state),
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(storedRoadmap(state).entryHolds?.[sourceEntry.id]?.status).toBe('paused');
});

itNeedsCargo('a request that fails before creating anything keeps the source hold', async () => {
  const { state, ws, parent, sourceEntry, input } = await stoppedParentReview();
  const hold = {
    status: 'needs-attention' as const,
    reason: 'Recovery needs your input.',
    attention: roadmapAttention('entry-preparation-failed', { entryId: sourceEntry.id }),
  };
  // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
  state.context.services.roadmapService['writer'].change(storedRoadmap(state), {
    entryHolds: { [sourceEntry.id]: hold },
  });
  await state.context.services.roadmapService.tick();
  expect(storedRoadmap(state).entryHolds?.[sourceEntry.id]).toMatchObject(hold);
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
    headers: mutationHeaders(state),
    payload: { ...input, snapshotDigest: 'f'.repeat(64) },
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(storedRoadmap(state).attempts.filter((a) => a.recovery)).toEqual([]);
  // Nothing was created, so the stop the operator has not answered should remain.
  expect(storedRoadmap(state).entryHolds?.[sourceEntry.id]).toMatchObject(hold);
});

itNeedsCargo('a round whose request never finished holds its entry for the operator', async () => {
  const { f, state, ws, parent, sourceEntry, input } = await stoppedParentReview();
  // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
  state.context.services.roadmapService['writer'].change(storedRoadmap(state), {
    entryHolds: {
      [sourceEntry.id]: {
        status: 'needs-attention',
        reason: 'Recovery needs your input.',
        attention: roadmapAttention('entry-preparation-failed', { entryId: sourceEntry.id }),
      },
    },
  });
  const spy = vi
    .spyOn(
      (state.context.services.workCycleService as unknown as { starts: { start: () => never } })
        .starts,
      'start',
    )
    .mockImplementationOnce(() => {
      throw new Error('simulated cycle creation failure');
    });
  const failed = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
    headers: mutationHeaders(state),
    payload: input,
  });
  spy.mockRestore();
  expect(failed.statusCode).toBe(500);
  // Several roadmap passes.
  for (let i = 0; i < 3; i++) await state.context.services.roadmapService.tick();
  const view = state.context.services.roadmapService
    .list(f.auth, ws)
    .find((v) => v.roadmap.id === storedRoadmap(state).id)!;
  const progress = view.progress.find((p) => p.entryId === sourceEntry.id);
  const outcome = {
    roadmap: [view.roadmap.status, view.roadmap.reason, view.roadmap.attention],
    holds: view.roadmap.entryHolds,
    progress,
    round: storedRoadmap(state).attempts.find((a) => a.recovery)?.status,
    feed: (
      await state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${ws}/attention`,
        headers: { cookie: state.cookie },
      })
    ).body,
    // The stopped review's own attention is replaced by an automation wait.
    parentWait: automatedScopeRecoveryWait(
      state.context.storage,
      state.context.storage.execution.cycles.find(ws, parent.id)!,
    ),
  };
  // Nothing runs and nothing will until the operator repeats the command; the item must say so.
  expect(progress?.status, JSON.stringify(outcome)).toBe('needs-attention');
});
itNeedsCargo('two overlapping requests create one round', async () => {
  const { state, ws, tx, parent, input } = await stoppedParentReview();
  const post = () =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
      headers: mutationHeaders(state),
      payload: input,
    });
  const [a, b] = await Promise.all([post(), post()]);
  const statuses = [a.statusCode, b.statusCode].sort();
  const rounds = storedRoadmap(state).attempts.filter((x) => x.recovery);
  const repairs = tx.execution.cycles
    .listForWorkspace(ws)
    .filter((c) => c.scopeRepair?.sourceCycleId === parent.id);
  const trees = tx.execution.worktrees
    .listForWorkItem(ws, parent.workItemId!)
    .filter((t) => t.executionScope?.kind === 'slice' && t.status === 'active');
  // Expected: one request succeeds, one conflicts, one round owns one repair cycle.
  expect({ statuses, a: a.body, b: b.body }).toMatchObject({ statuses: [200, 409] });
  expect(repairs).toHaveLength(1);
  expect(rounds.map((r) => r.cycleId)).toEqual([repairs[0]!.id]);
  expect(trees).toHaveLength(1);
});

itNeedsCargo(
  'a second request during the first one’s worktree creation creates no second round',
  async () => {
    const { state, ws, tx, parent, input } = await stoppedParentReview();
    const post = () =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
        headers: mutationHeaders(state),
        payload: input,
      });
    const ops = (
      state.context.services.executionService as unknown as {
        git: { createWorktree: (...args: unknown[]) => Promise<unknown> };
      }
    ).git;
    const original = ops.createWorktree.bind(ops);
    let second: Awaited<ReturnType<typeof post>> | undefined;
    const spy = vi.spyOn(ops, 'createWorktree').mockImplementationOnce(async (...args) => {
      // A double submit arrives while the first request is creating its worktree.
      second = await post();
      return original(...args);
    });
    const first = await post();
    spy.mockRestore();
    const rounds = storedRoadmap(state).attempts.filter((x) => x.recovery);
    const trees = tx.execution.worktrees
      .listForWorkItem(ws, parent.workItemId!)
      .filter((t) => t.executionScope?.kind === 'slice' && t.status === 'active');
    const outcome = {
      first: [first.statusCode, first.body],
      second: [second?.statusCode, second?.body],
      rounds: rounds.length,
      trees: trees.map((t) => [t.id, tx.execution.cycles.activeForWorktree(ws, t.id)?.id]),
    };
    expect(outcome.rounds, JSON.stringify(outcome)).toBe(1);
  },
);

itNeedsCargo(
  'a round a restart left half-prepared holds its entry until the operator repeats the request',
  async () => {
    const { state, ws, tx, parent, sourceEntry, ownerEntry, input } = await stoppedParentReview();
    const roadmap = storedRoadmap(state);
    const ownerAttempt = roadmap.attempts.find((a) => a.entryId === ownerEntry.id && !a.recovery)!;
    // What the request commits before it creates anything; the daemon then stopped.
    const reserved: RoadmapAttempt = {
      id: asRoadmapAttemptId(randomUUID()),
      entryId: ownerEntry.id,
      definitionRevision: ownerAttempt.definitionRevision,
      worktreeId: randomUUID() as RoadmapAttempt['worktreeId'],
      cycleId: asWorkCycleId(randomUUID()),
      status: 'preparing',
      createdAt: new Date().toISOString(),
      recovery: {
        sourceEntryId: sourceEntry.id,
        sourceRunId: parent.currentRunId,
        sourceSequence: 1,
        findingFingerprint: 'a'.repeat(64),
        phase: 'repair',
        reviewRunIds: {},
        requestedByUserId: state.userId,
      },
    };
    // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
    state.context.services.roadmapService['writer'].change(roadmap, {
      attempts: [...roadmap.attempts, reserved],
    });
    for (let i = 0; i < 2; i++) await state.context.services.roadmapService.tick();
    // Nothing runs until the operator repeats the request, so the entry says so.
    expect(storedRoadmap(state).entryHolds?.[sourceEntry.id]).toMatchObject({
      status: 'needs-attention',
      attention: { code: 'entry-preparation-failed' },
    });
    // The inbox shows the stopped review, whose controls repeat the request.
    expect(
      tx.attention
        .recent(ws, 100)
        .filter((item) => !item.resolvedAt)
        .map((item) => [item.subjectKey, item.code]),
    ).toContainEqual([`cycle:${parent.id}`, 'scope-review-recovery']);
    // Repeating it prepares the same round and answers the hold.
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
      headers: mutationHeaders(state),
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().cycle.id).toBe(reserved.cycleId);
    expect(storedRoadmap(state).entryHolds?.[sourceEntry.id]).toBeUndefined();
  },
);

/**
 * A recovery round's reviews restart within the roadmap's allowance (`maxIntegrationRefreshes`,
 * 3 in the fixture's parallel scheduling) and are refused at it (R-B7 scheduler half: the review
 * of 180c36a raised it, and the restart block is characterized after it moved). The round is
 * written by hand, its repair done and merged: the merge moves the integration branch past the
 * stopped parent review's snapshot. A round's `reviewRunIds` are written when it is made, so the
 * stopped review's resume meets a count of 0; a count past it is met by a review whose cycle
 * completed, which the round repeats. Here that is the owning slice's verification: with
 * `verification`, the round's repair worktree is a merge of the owning slice at the new head, so
 * the slice's earlier verification is no longer current. `restarts` is the count the round
 * records for it: the restart block reads only that count, whatever history wrote it (a real
 * count past 1 needs a newer verification that went stale again).
 */
async function roundRestarting(phase: 'parent-review' | 'verification', restarts: number) {
  const { state, ws, tx, parent, sourceEntry, ownerEntry } = await stoppedParentReview();
  const roadmap = storedRoadmap(state);
  const ownerAttempt = roadmap.attempts.find((a) => a.entryId === ownerEntry.id && !a.recovery)!;
  const verificationEntry = roadmap.definition.entries.find(
    (e) =>
      e.workItemId === sourceEntry.workItemId &&
      e.executionScope?.kind === 'slice-verification' &&
      e.executionScope.sourceId === ownerEntry.executionScope?.sourceId,
  )!;
  const target = phase === 'verification' ? verificationEntry : sourceEntry;
  const targetCycle = tx.execution.cycles.find(
    ws,
    roadmap.attempts.find((a) => a.entryId === target.id && !a.recovery)!.cycleId,
  )!;
  // The repair's merge moved the integration branch past the stopped review's snapshot.
  const reviewed = tx.execution.runs.find(ws, parent.currentRunId)!.reviewBranchContext!;
  const checkout = tx.execution.worktrees.find(ws, parent.worktreeId)!.path;
  const head = git(['rev-parse', reviewed.targetBranch], checkout).trim();
  const merged = git(
    ['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'The repair merged.'],
    checkout,
  ).trim();
  git(['update-ref', `refs/heads/${reviewed.targetBranch}`, merged, head], checkout);
  // With `verification`, the round's repair worktree is an owning-slice attempt merged at the
  // new head. Without it the owning slice's verification stays current, which keeps the round
  // at its parent review.
  const owner = tx.execution.worktrees.find(ws, ownerAttempt.worktreeId)!;
  const repairId = randomUUID() as RoadmapAttempt['worktreeId'];
  if (phase === 'verification') {
    tx.execution.worktrees.insert({
      id: repairId,
      workspaceId: ws,
      repositoryId: owner.repositoryId,
      projectId: owner.projectId,
      workItemId: owner.workItemId,
      branchName: `${owner.branchName}-repair`,
      baseSha: head,
      baseBranch: owner.baseBranch,
      integrationBranch: owner.integrationBranch,
      path: `${owner.path}-repair`,
      createdAt: new Date().toISOString(),
      createdByUserId: state.userId,
      executionScope: owner.executionScope!,
    });
    tx.execution.worktrees.markMerged({
      workspaceId: ws,
      worktreeId: repairId,
      occurredAt: new Date().toISOString(),
      mergeSha: merged,
    });
  }
  const round: RoadmapAttempt = {
    id: asRoadmapAttemptId(randomUUID()),
    entryId: ownerEntry.id,
    definitionRevision: ownerAttempt.definitionRevision,
    worktreeId: repairId,
    cycleId: asWorkCycleId(randomUUID()),
    status: 'completed',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    recovery: {
      sourceEntryId: sourceEntry.id,
      sourceRunId: parent.currentRunId,
      sourceSequence: 1,
      findingFingerprint: 'a'.repeat(64),
      phase,
      reviewRunIds: { [target.id]: targetCycle.currentRunId },
      ...(restarts ? { reviewRestarts: { [target.id]: restarts } } : {}),
      requestedByUserId: state.userId,
    },
  };
  // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
  state.context.services.roadmapService['writer'].change(roadmap, {
    attempts: [...roadmap.attempts, round],
  });
  const cycles = state.context.services.workCycleService;
  const resumes = vi.spyOn(cycles, 'control');
  const repeats = vi.spyOn(cycles, 'repeatScopeReview');
  for (let i = 0; i < 2; i++) await state.context.services.roadmapService.tick();
  const stored = storedRoadmap(state);
  return {
    hold: stored.entryHolds?.[sourceEntry.id],
    restarts: stored.attempts.find((a) => a.id === round.id)?.recovery?.reviewRestarts,
    resumed: resumes.mock.calls.filter(
      ([, , id, action]) => id === targetCycle.id && action === 'resume',
    ).length,
    repeated: repeats.mock.calls.filter(([, , id]) => id === targetCycle.id).length,
    target,
  };
}

const REFUSED =
  'Recovery review refresh allowance exhausted. Inspect and refresh this scope manually before resuming.';

itNeedsCargo('resumes a round’s stopped parent review and counts its first restart', async () => {
  const { hold, restarts, resumed, target } = await roundRestarting('parent-review', 0);
  expect(hold).toBeUndefined();
  expect(resumed).toBe(1);
  expect(restarts).toEqual({ [target.id]: 1 });
});

itNeedsCargo('repeats a round’s completed review within the allowance and counts it', async () => {
  const { hold, restarts, repeated, target } = await roundRestarting('verification', 2);
  expect(hold).toBeUndefined();
  expect(repeated).toBe(1);
  expect(restarts).toEqual({ [target.id]: 3 });
});

itNeedsCargo('refuses a round’s review repeat at the allowance and holds its entry', async () => {
  const { hold, restarts, repeated, target } = await roundRestarting('verification', 3);
  expect(repeated).toBe(0);
  expect(restarts).toEqual({ [target.id]: 3 });
  expect(hold).toMatchObject({ status: 'needs-attention', reason: REFUSED });
});
