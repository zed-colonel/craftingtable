import { afterEach, expect, it, vi } from 'vitest';
import type { WorkCycle } from '@craftingtable/domain';
import { delegationWaits } from '../src/services/roadmap-delegation-policy.js';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  controlCycle,
  designDone,
  git,
  implementationDone,
  mutationHeaders,
  parallelFixture,
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

/** A cycle with only the fields `delegationWaits` reads. */
const cycle = (fields: Record<string, unknown>) =>
  ({ id: 'cycle-1', ...fields }) as unknown as WorkCycle;

it('a grant waits for its named entries’ controller reviews, integration refreshes and resolutions at work, and nothing else', () => {
  const refreshing = new Set(['refreshing']);
  const liveOn = new Set(['live']);
  const waits = (cycles: readonly (WorkCycle | undefined)[]) =>
    delegationWaits(
      cycles.map((c, i) => ({ sourceId: `AQ-0${i + 1}`, cycles: c ? [c] : [] })),
      { refreshing: (id) => refreshing.has(id), live: (c) => liveOn.has(c.id) },
    );
  // Steps that read no grant: a design, implementation or remediation, live or not; a stop.
  expect(
    waits([
      cycle({ status: 'running', step: 'implement' }),
      cycle({ id: 'live', status: 'paused', step: 'implement' }),
      cycle({ status: 'needs-attention', step: 'review' }),
      undefined,
    ]),
  ).toEqual([]);
  const reviewing = (kind: string, fields: Record<string, unknown> = { status: 'running' }) =>
    cycle({ ...fields, workflow: { reassessments: 0, questions: [], activeReview: { kind } } });
  for (const kind of ['checkpoint', 'security', 'reassessment'] as const)
    expect(waits([reviewing(kind)])).toEqual([`AQ-01's ${kind} review`]);
  // A paused cycle's review session goes on, so it holds the grant while its run is live.
  expect(waits([reviewing('security', { id: 'live', status: 'paused' })])).toEqual([
    "AQ-01's security review",
  ]);
  // One left on a stopped cycle waits for the operator, and reads the grant again on resume:
  // it holds nothing (increment 2 review HIGH-1).
  for (const status of ['needs-attention', 'paused'] as const)
    expect(waits([reviewing('checkpoint', { status })])).toEqual([]);
  expect(waits([cycle({ id: 'refreshing', status: 'awaiting-merge' })])).toEqual([
    "AQ-01's integration refresh",
  ]);
  for (const status of ['preparing', 'resolving', 'committing'] as const) {
    expect(waits([cycle({ status: 'running', integrationResolution: { status } })])).toEqual([
      "AQ-01's conflict resolution",
    ]);
    expect(
      waits([cycle({ id: 'live', status: 'needs-attention', integrationResolution: { status } })]),
    ).toEqual(["AQ-01's conflict resolution"]);
    expect(
      waits([cycle({ status: 'needs-attention', integrationResolution: { status } })]),
    ).toEqual([]);
  }
  // A conflict detected but not yet taken up waits for the grant, not the other way round.
  for (const status of ['detected', 'completed', 'abandoned'] as const)
    expect(waits([cycle({ status: 'running', integrationResolution: { status } })])).toEqual([]);
});

it('a grant names its named entry’s review at work, and an unnamed entry’s does not hold it (review MEDIUM-2)', async () => {
  const fx = await parallelFixture({ independentThird: true });
  let release!: () => void;
  const designs = new Promise<void>((resolve) => {
    release = resolve;
  });
  fx.backend.replyForRequest = (request) =>
    request.model === 'design-model' ? { ...designDone, release: designs } : implementationDone;
  expect((await saveRoadmapRequest(fx.state, fx.input)).statusCode).toBe(200);
  await roadmapControl(fx.state, 'start');
  const tx = fx.state.context.storage,
    ws = fx.state.workspaceId;
  await waitFor(() => storedRoadmap(fx.state).attempts.length === 2, 'both items started');
  const [first, second] = storedRoadmap(fx.state).attempts;
  // The first item's cycle has a checkpoint review at work.
  const cycle = present(tx.execution.cycles.find(ws, first!.cycleId));
  expect(
    tx.execution.cycles.replace(
      {
        ...cycle,
        workflow: {
          reassessments: 0,
          questions: [],
          activeReview: {
            kind: 'checkpoint',
            sourceRunId: cycle.currentRunId!,
            requirements: [],
            caseIds: [],
            roles: [],
            contextDigest: '0'.repeat(64),
          },
        },
        version: cycle.version + 1,
      },
      cycle.version,
    ),
  ).toBeTruthy();
  const grant = (entryId: string) =>
    fx.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/delegation`,
      headers: mutationHeaders(fx.state),
      payload: {
        expectedVersion: storedRoadmap(fx.state).version,
        entryIds: [entryId],
        automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
        reviewerRoles: [],
        rationale: 'Characterize the wait.',
      },
    });
  const refused = await grant(first!.entryId);
  expect(refused.statusCode, refused.body).toBe(409);
  expect(refused.json().error.message).toBe("Wait for AQ-01's checkpoint review to finish.");
  expect(storedRoadmap(fx.state).delegationAssignments ?? []).toEqual([]);
  // Paused, the cycle's design session goes on, so its review still holds the grant
  // (mutation round, I2-live-wiring).
  await controlCycle(fx.state, tx.execution.cycles.find(ws, first!.cycleId)!, 'pause');
  const paused = await grant(first!.entryId);
  expect(paused.statusCode, paused.body).toBe(409);
  expect(paused.json().error.message).toBe("Wait for AQ-01's checkpoint review to finish.");
  // An integration refresh in flight on the other item holds a grant naming it
  // (mutation round, I2-refreshing-wiring).
  const refreshing = vi
    .spyOn(fx.state.context.services.workCycleService, 'isRefreshing')
    .mockImplementation((id) => id === second!.cycleId);
  const refresh = await grant(second!.entryId);
  expect(refresh.statusCode, refresh.body).toBe(409);
  expect(refresh.json().error.message).toBe("Wait for AQ-03's integration refresh to finish.");
  refreshing.mockRestore();
  // The other item's own work does not hold a grant that does not name it.
  const granted = await grant(second!.entryId);
  expect(granted.statusCode, granted.body).toBe(200);
  expect(storedRoadmap(fx.state).delegationAssignments).toHaveLength(1);
  release();
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
