import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { asWorktreeId, type ExecutionScope } from '@craftingtable/domain';
import { afterEach, expect, vi } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  itNeedsCargo,
  mutationHeaders,
  parallelScheduling,
  roadmapControl,
  roadmapId,
  runScopedFixtureCheck,
  scopeReport,
  storedRoadmap,
  structuredFinding,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';
import { ExecutionRequestError } from './services/errors.js';

/**
 * R-C12: a stopped review that automatic recovery does not answer with a round records why.
 * LIVE-06's shape: EXO-02/domain's round needed a repository slot held by EXO-04/domain's
 * repair, whose merge waited for EXO-02/domain to be verified, and nothing said so.
 */

afterEach(cleanupExecutionFixtures);

/** A slice's verification stopped on one open major finding the slice itself must repair. */
async function stoppedVerification(holderWaitsOnOwner = false) {
  const f = await supervisedMapFixture(false, 'automatic', true, false, true, (source) =>
    holderWaitsOnOwner
      ? {
          ...source,
          slices: source.slices.map((s) =>
            s.id === 'local/AQ-02/a'
              ? {
                  ...s,
                  merge_requires: [
                    ...s.merge_requires,
                    { kind: 'slice' as const, id: 'local/AQ-01/a', state: 'verified' as const },
                  ],
                }
              : s,
          ),
        }
      : source,
  );
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  const normal = f.backend.replyForRequest!;
  const defect = { ...structuredFinding, id: 'F003', severity: 'major' };
  f.backend.replyForRequest = (request) => {
    const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    const scope: ExecutionScope = tree.executionScope!;
    if (scope.kind !== 'slice-verification') return normal(request);
    runScopedFixtureCheck(request);
    return {
      resultText:
        '## Open questions\nnone\n\n## Review report\n' +
        scopeReport(state, scope)
          .replace('"findings":[]', `"findings":${JSON.stringify([defect])}`)
          .replaceAll('mergeable', 'changes-requested'),
    };
  };
  f.input.scheduling = { ...parallelScheduling, maxPerRepository: 1 };
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      tx.execution.cycles
        .listForWorkspace(ws)
        .some(
          (c) => c.executionScope?.kind === 'slice-verification' && c.status === 'needs-attention',
        ),
    'verification finding',
    15000,
  );
  const review = tx.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'slice-verification')!;
  const sourceEntryId = storedRoadmap(state).attempts.find((a) => a.cycleId === review.id)!.entryId;
  const ownerEntryId = storedRoadmap(state).definition.entries.find(
    (e) => e.executionScope?.kind === 'slice',
  )!.id;
  return { f, state, ws, tx, review, sourceEntryId, ownerEntryId };
}

itNeedsCargo.each([
  'a slot another item holds',
  'a slot held by work that waits on this slice',
] as const)(
  'automatic recovery that needs %s records why, or borrows it (LIVE-06)',
  {
    timeout: 45000,
  },
  async (shape) => {
    const deadlock = shape === 'a slot held by work that waits on this slice';
    const { state, ws, tx, sourceEntryId, ownerEntryId } = await stoppedVerification(deadlock);
    await roadmapControl(state, 'pause');
    const enabled = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/scope-recovery`,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: storedRoadmap(state).version,
        enabled: true,
        maxRoundsPerParent: 3,
      },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    // The repository's only slot: an unmerged slice of the next work item.
    const merged = tx.execution.worktrees
      .listForWorkItem(ws, state.workItemId)
      .find((t) => t.executionScope?.kind === 'slice')!;
    const next = tx.imports
      .bindings(ws, merged.executionScope!.definitionId)[0]!
      .bindings.flatMap((b) => b.workItems)
      .find((w) => w.sourceId === 'local/AQ-02')!.workItemId;
    tx.execution.worktrees.insert({
      id: asWorktreeId(randomUUID()),
      workspaceId: ws,
      repositoryId: merged.repositoryId,
      projectId: merged.projectId,
      workItemId: next,
      ...(merged.planVersionId ? { planVersionId: merged.planVersionId } : {}),
      executionScope: { ...merged.executionScope!, sourceId: 'local/AQ-02/a' },
      branchName: 'slot-holder',
      baseSha: merged.baseSha,
      baseBranch: merged.baseBranch,
      ...(merged.integrationBranch ? { integrationBranch: merged.integrationBranch } : {}),
      path: join(state.context.directory, 'slot-holder'),
      createdAt: merged.createdAt,
      createdByUserId: merged.createdByUserId,
    });
    await roadmapControl(state, 'resume');
    await state.context.services.roadmapService.tick();
    const roadmap = storedRoadmap(state);
    const round = roadmap.attempts.find((a) => a.recovery?.sourceEntryId === sourceEntryId);
    if (deadlock) {
      // The holder can never merge before this slice is verified: the round takes one slot more.
      expect(round).toBeDefined();
      expect(roadmap.entryWaits?.[sourceEntryId]?.code).not.toBe('capacity-blocked');
      return;
    }
    expect(round).toBeUndefined();
    expect(roadmap.entryWaits?.[sourceEntryId]).toMatchObject({
      code: 'capacity-blocked',
      refs: { entryId: ownerEntryId },
    });
    expect(roadmap.entryWaits?.[sourceEntryId]?.reason).toContain('capacity is 1');
    // An unchanged wait is not written again.
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).version).toBe(roadmap.version);
  },
);

itNeedsCargo.each(['paused', 'running'] as const)(
  'an open repair the roadmap cannot adopt holds the review it came from: %s (R-I11 → R-C12)',
  { timeout: 45000 },
  async (status) => {
    const { f, state, ws, tx, review, sourceEntryId } = await stoppedVerification();
    if (status === 'paused') await roadmapControl(state, 'pause');
    const preview = state.context.services.workCycleService.previewScopeRepair(
      f.auth,
      ws,
      review.id,
    );
    // A repair delegated before rounds kept their roadmap: no owner.
    const repair = await state.context.services.workCycleService.delegateScopeRepair(
      f.auth,
      ws,
      review.id,
      {
        expectedVersion: review.version,
        snapshotDigest: preview.snapshotDigest,
        sourceId: preview.candidates[0]!.scope.sourceId,
        instructions: 'Repair the missing family.',
        maxRemediationRounds: 2,
      },
    );
    expect(repair.owner).toBeNull();
    const refused = vi
      .spyOn(state.context.services.workCycleService, 'adoptRoadmapRound')
      .mockImplementation(() => {
        throw new ExecutionRequestError('conflict', 'Simulated adoption refusal.');
      });
    await state.context.services.roadmapService.tick();
    const held = storedRoadmap(state);
    expect(held.status).toBe(status);
    expect(held.entryHolds?.[sourceEntryId]).toMatchObject({
      status: 'needs-attention',
      attention: { code: 'entry-preparation-failed', refs: { cycleId: repair.id } },
    });
    expect(held.entryHolds?.[sourceEntryId]?.reason).toContain('Simulated adoption refusal.');
    // The same refusal is not written again on the next pass.
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).version).toBe(held.version);
    refused.mockRestore();
    await state.context.services.roadmapService.tick();
    expect(tx.execution.cycles.find(ws, repair.id)?.owner).toBeTruthy();
    expect(storedRoadmap(state).entryHolds?.[sourceEntryId]).toBeUndefined();
  },
);
