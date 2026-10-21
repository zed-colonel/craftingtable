import { afterEach, expect, it, vi } from 'vitest';
import type { WorkCycle } from '@craftingtable/domain';
import { delegationWaits } from '../src/services/roadmap-delegation-policy.js';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  designDone,
  git,
  implementationDone,
  mutationHeaders,
  present,
  reviewText,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  storedRoadmap,
  useIntegration,
  waitFor,
} from './execution-test-support.js';

/**
 * R-B6 increment 2 (decision 2): a delegation grant lands beside a running roadmap. The
 * scheduler's merge and conflict resolution re-check their grant and stand down when it changed,
 * as a pause made them do; the grant waits only for its named entries' delegated actions in
 * flight: a controller review, an integration refresh, a conflict resolution at work.
 */

afterEach(cleanupExecutionFixtures);

const cycle = (fields: Partial<WorkCycle>) => ({ id: 'cycle-1', ...fields }) as WorkCycle;

it('a grant waits for its named entries’ controller reviews, integration refreshes and resolutions at work, and nothing else', () => {
  const refreshing = new Set(['refreshing']);
  const waits = (cycles: readonly (WorkCycle | undefined)[]) =>
    delegationWaits(
      cycles.map((c, i) => ({ sourceId: `AQ-0${i + 1}`, cycles: c ? [c] : [] })),
      (id) => refreshing.has(id),
    );
  // Steps that read no grant: a design, implementation or remediation, live or not; a stop.
  expect(
    waits([
      cycle({ status: 'running', step: 'implement' }),
      cycle({ status: 'needs-attention', step: 'review' }),
      undefined,
    ]),
  ).toEqual([]);
  for (const kind of ['checkpoint', 'security', 'reassessment'] as const)
    expect(
      waits([
        cycle({
          status: 'running',
          workflow: { reassessments: 0, questions: [], activeReview: { kind } },
        } as Partial<WorkCycle>),
      ]),
    ).toEqual([`AQ-01's ${kind} review`]);
  expect(waits([cycle({ id: 'refreshing', status: 'awaiting-merge' })])).toEqual([
    "AQ-01's integration refresh",
  ]);
  for (const status of ['preparing', 'resolving', 'committing'] as const)
    expect(
      waits([
        cycle({
          status: 'needs-attention',
          integrationResolution: { status },
        } as Partial<WorkCycle>),
      ]),
    ).toEqual(["AQ-01's conflict resolution"]);
  // A conflict detected but not yet taken up waits for the grant, not the other way round.
  for (const status of ['detected', 'completed', 'abandoned'] as const)
    expect(
      waits([
        cycle({
          status: 'needs-attention',
          integrationResolution: { status },
        } as Partial<WorkCycle>),
      ]),
    ).toEqual([]);
});

it('revoking automatic merge while the scheduler’s merge is under way stands the merge down', async () => {
  const fixture = await roadmapFixture();
  const { state, root, backend } = fixture;
  await useIntegration(fixture);
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  const saved = await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const entryId = storedRoadmap(state).definition.entries[0]!.id;
  const before = git(['rev-parse', 'revision'], root);
  // The merge's await before its reservation: the operator revokes automatic merge there.
  const branches = state.context.services.executionService.branches;
  const missing = branches.missingPredecessorMerge.bind(branches);
  let revoked = 0;
  const awaitingMerge = () => {
    const attempt = storedRoadmap(state).attempts[0];
    return (
      !!attempt &&
      state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)?.status ===
        'awaiting-merge'
    );
  };
  vi.spyOn(branches, 'missingPredecessorMerge').mockImplementation(async (...args) => {
    // Asked before an admission too; the merge's is asked of a cycle awaiting merge.
    if (awaitingMerge() && !revoked++) {
      const grant = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/delegation`,
        headers: mutationHeaders(state),
        payload: {
          expectedVersion: storedRoadmap(state).version,
          entryIds: [entryId],
          automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
          reviewerRoles: [],
          rationale: 'Merge this one by hand.',
        },
      });
      expect(grant.statusCode, grant.body).toBe(200);
      expect(storedRoadmap(state).status).toBe('running');
    }
    return missing(...args);
  });
  await roadmapControl(state, 'start');
  const attempt = await awaitRoadmapMerge(state, 0);
  await waitFor(() => revoked > 0, 'the merge reached its await');
  for (let pass = 0; pass < 3; pass++) {
    await state.context.services.workCycleService.tick();
    await state.context.services.roadmapService.tick();
  }
  // Nothing merged: the merge is the operator's now.
  expect(git(['rev-parse', 'revision'], root)).toBe(before);
  expect(
    state.context.storage.execution.worktrees.find(state.workspaceId, attempt.worktreeId)?.mergedAt,
  ).toBeUndefined();
  expect(present(storedRoadmap(state).delegationAssignments).at(-1)?.automation).toEqual({
    integrationMerge: 'manual',
    integrationConflicts: 'manual',
  });
  expect(storedRoadmap(state).status).toBe('running');
});
