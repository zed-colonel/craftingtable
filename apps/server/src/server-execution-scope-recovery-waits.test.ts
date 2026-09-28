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
  f.backend.replyForRequest = async (request) => {
    const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    const scope: ExecutionScope = tree.executionScope!;
    if (scope.kind !== 'slice-verification') return normal(request);
    await runScopedFixtureCheck(request);
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
  'two slots held by work that waits on this slice',
] as const)(
  'automatic recovery that needs %s records why, or borrows it (LIVE-06)',
  {
    timeout: 45000,
  },
  async (shape) => {
    const deadlock = shape !== 'a slot another item holds';
    const overLimit = shape === 'two slots held by work that waits on this slice';
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
    const holder = (name: string) =>
      tx.execution.worktrees.insert({
        id: asWorktreeId(randomUUID()),
        workspaceId: ws,
        repositoryId: merged.repositoryId,
        projectId: merged.projectId,
        workItemId: next,
        ...(merged.planVersionId ? { planVersionId: merged.planVersionId } : {}),
        executionScope: { ...merged.executionScope!, sourceId: 'local/AQ-02/a' },
        branchName: name,
        baseSha: merged.baseSha,
        baseBranch: merged.baseBranch,
        ...(merged.integrationBranch ? { integrationBranch: merged.integrationBranch } : {}),
        path: join(state.context.directory, name),
        createdAt: merged.createdAt,
        createdByUserId: merged.createdByUserId,
      });
    holder('slot-holder');
    if (overLimit) holder('second-slot-holder');
    if (deadlock && !overLimit) {
      // Only a recovery round borrows the slot; an ordinary start of the slice does not.
      const roadmap = storedRoadmap(state);
      const owner = roadmap.definition.entries.find((e) => e.id === ownerEntryId)!;
      const blocker = (recovery: boolean) =>
        state.context.services.roadmapService['blocker'](roadmap, owner, undefined, tx, recovery);
      expect(blocker(false)?.kind).toBe('capacity-blocked');
      expect(blocker(true)).toBeUndefined();
    }
    await roadmapControl(state, 'resume');
    await state.context.services.roadmapService.tick();
    const roadmap = storedRoadmap(state);
    const round = roadmap.attempts.find((a) => a.recovery?.sourceEntryId === sourceEntryId);
    if (overLimit) {
      // One slot more would not be enough: the circular wait is the operator's to resolve.
      expect(round).toBeUndefined();
      expect(roadmap.entryHolds?.[sourceEntryId]).toMatchObject({
        status: 'needs-attention',
        attention: { code: 'entry-blocked' },
      });
      expect(roadmap.entryHolds?.[sourceEntryId]?.reason).toContain('cannot free by themselves');
      return;
    }
    if (deadlock) {
      // The holder can never merge before this slice is verified: the round takes one slot more.
      expect(round).toBeDefined();
      await state.context.services.roadmapService.tick();
      expect(tx.execution.cycles.find(ws, round!.cycleId)).toBeDefined();
      expect(storedRoadmap(state).entryWaits?.[sourceEntryId]).toMatchObject({
        code: 'recovery-round',
        refs: { entryId: ownerEntryId, cycleId: round!.cycleId },
      });
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

itNeedsCargo.each(['paused', 'running', 'running, review paused'] as const)(
  'an open repair the roadmap cannot adopt holds the review it came from: %s (R-I11 → R-C12)',
  { timeout: 45000 },
  async (shape) => {
    const status = shape === 'paused' ? 'paused' : 'running';
    const { f, state, ws, tx, review, sourceEntryId } = await stoppedVerification();
    if (status === 'paused') await roadmapControl(state, 'pause');
    if (shape === 'running, review paused') {
      const paused = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/control`,
        headers: mutationHeaders(state),
        payload: {
          action: 'pause',
          entryId: sourceEntryId,
          expectedVersion: storedRoadmap(state).version,
        },
      });
      expect(paused.statusCode, paused.body).toBe(200);
    }
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
        expectedVersion: tx.execution.cycles.find(ws, review.id)!.version,
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
    if (shape === 'running, review paused') {
      // The operator's pause of that review stands through the failure and the adoption.
      expect(held.entryHolds?.[sourceEntryId]?.status).toBe('paused');
      refused.mockRestore();
      await state.context.services.roadmapService.tick();
      expect(tx.execution.cycles.find(ws, repair.id)?.owner).toBeTruthy();
      expect(storedRoadmap(state).entryHolds?.[sourceEntryId]?.status).toBe('paused');
      return;
    }
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

itNeedsCargo(
  'an owning-slice question during a recovery round is one inbox item (R-C14, LIVE-13)',
  { timeout: 45000 },
  async () => {
    const { f, state, ws, tx, sourceEntryId } = await stoppedVerification();
    const normal = f.backend.replyForRequest!;
    // The round's repair asks the operator a question instead of finishing. Its second run (the
    // bounded reassessment after the first stop) waits for the test, so the test sees it at work.
    let repairRuns = 0;
    let releaseReassessment: () => void = () => {};
    const reassessment = new Promise<void>((resolve) => {
      releaseReassessment = resolve;
    });
    f.backend.replyForRequest = (request) => {
      if (
        !/craftingtable-scope-repair\.json/.test(request.prompt) ||
        request.model === 'review-model'
      )
        return normal(request);
      repairRuns += 1;
      return {
        resultText: 'Stopped.\n\n## Open questions\nWhich queue should own retries?',
        ...(repairRuns === 2 ? { release: reassessment } : {}),
      };
    };
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
    await roadmapControl(state, 'resume');
    const round = () =>
      storedRoadmap(state).attempts.find((a) => a.recovery?.sourceEntryId === sourceEntryId);
    const repair = () => {
      const attempt = round();
      return attempt && tx.execution.cycles.find(ws, attempt.cycleId);
    };
    const openSubjects = () => {
      state.context.services.roadmapService.syncAttention(true);
      return tx.attention.open(ws).map((item) => item.subjectKey);
    };
    await waitFor(
      () => !!storedRoadmap(state).entryHolds?.[sourceEntryId],
      'the stopped round holds its review',
      30000,
    );
    await waitFor(
      () => repairRuns === 2 && repair()?.status === 'running',
      'the round reassesses its repair',
      15000,
    );
    // While the round's repair is at work again, nobody is asked anything.
    expect(openSubjects()).toEqual([]);
    releaseReassessment();
    await waitFor(
      () => repair()?.status === 'needs-attention',
      'the repair stops on its question',
      30000,
    );
    // The repair's own item carries the question; the review's hold does not repeat it.
    expect(openSubjects()).toEqual([`cycle:${round()!.cycleId}`]);
  },
);
