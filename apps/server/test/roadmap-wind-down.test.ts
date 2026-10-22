import { randomUUID } from 'node:crypto';
import {
  asMergeOperationId,
  asRoadmapId,
  asRoadmapWindDownId,
  cycleEnd,
  type Roadmap,
  WIND_DOWN_STEPS,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  cycleOf,
  itemAt,
  settleFixture,
  stop,
  windDownAudit,
} from './wind-down-test-support.js';
import {
  cleanupExecutionFixtures,
  designDone,
  implementationDone,
  mutationHeaders,
  parallelFixture,
  parallelScheduling,
  present,
  reviewText,
  roadmapControl,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  stepDaemon,
  storedRoadmap,
  waitFor,
} from './execution-test-support.js';

/**
 * Settling a roadmap (R-B11, ADR-073): Stop is the wind-down's settle path. It is refused by code
 * before any write, holds the roadmap while it settles, converges from every step it can stop
 * at, and never touches another roadmap.
 */

afterEach(cleanupExecutionFixtures);

describe('settling a roadmap (R-B11)', () => {
  it('refuses a Stop before any write while one attempt holds a reserved merge and another runs', async () => {
    const { state, first, third, release } = await settleFixture();
    const before = storedRoadmap(state);
    const firstCycle = cycleOf(state, first.cycleId);
    const thirdCycle = cycleOf(state, third.cycleId);
    expect(thirdCycle.status).toBe('running');
    state.context.storage.transaction((tx) =>
      tx.execution.merges.save({
        id: asMergeOperationId(randomUUID()),
        workspaceId: state.workspaceId,
        worktreeId: first.worktreeId,
        status: 'reserved',
        sourceSha: 'a'.repeat(40),
        targetSha: 'b'.repeat(40),
        targetBranch: 'main',
        reviewRunId: firstCycle.currentRunId,
        createdAt: new Date().toISOString(),
        authorizedByUserId: firstCycle.createdByUserId,
      }),
    );
    const refused = await stop(state);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: 'conflict', reason: 'merge-in-flight' },
    });
    // Nothing was written: the roadmap still runs, both cycles are as they were, no hold.
    expect(storedRoadmap(state)).toEqual(before);
    expect(cycleOf(state, first.cycleId)).toEqual(firstCycle);
    expect(cycleOf(state, third.cycleId)).toEqual(thirdCycle);
    expect(state.context.storage.windDowns.find(state.workspaceId, roadmapId)).toBeUndefined();
    release();
  });

  it('stops every cycle with code roadmap-wound-down, records the settlement, and a repeat changes nothing', async () => {
    const { state, first, third, release } = await settleFixture();
    const response = await stop(state);
    expect(response.statusCode, response.body).toBe(200);
    const roadmap = storedRoadmap(state);
    expect(roadmap.status).toBe('stopped');
    expect(roadmap.reason).toBe(
      'Roadmap stopped. Existing worktrees remain available for manual work.',
    );
    // R-B7 scheduler half, review of increment 4 (LOW-2): the settlement saves the stopped
    // roadmap as the operator who asked, in their session, not as the system.
    expect(
      auditLog(state).filter((e) => e.action === 'roadmap.updated' && e.metadata.action === 'stop'),
    ).toEqual([
      expect.objectContaining({
        actorKind: 'user',
        actorUserId: state.userId,
        sessionId: expect.any(String),
      }),
    ]);
    for (const attempt of [first, third]) {
      expect(cycleOf(state, attempt.cycleId).status).toBe('stopped');
      // The end it records (R-B4b increment 2 review, MEDIUM-2).
      expect(cycleEnd(cycleOf(state, attempt.cycleId))).toBe('roadmap-wound-down');
    }
    // The held design run was ended with its cycle.
    await stepDaemon(state.context.services);
    expect(
      state.context.storage.execution.runs.liveForWorktree(state.workspaceId, third.worktreeId),
    ).toEqual([]);
    const stops = auditLog(state).filter(
      (e) => e.action === 'work-cycle.updated' && e.metadata.status === 'stopped',
    );
    expect(stops.map((e) => e.metadata.action)).toEqual([
      'roadmap-wound-down',
      'roadmap-wound-down',
    ]);
    const record = present(state.context.storage.windDowns.find(state.workspaceId, roadmapId));
    expect(record).toMatchObject({ status: 'settled', retire: [], abandonResolutions: [] });
    expect(windDownAudit(state).map((e) => e.metadata.phase)).toEqual(['requested', 'settled']);
    // A second Stop is refused as before and writes nothing.
    const again = await stop(state);
    expect(again.statusCode).toBe(409);
    expect(state.context.storage.windDowns.find(state.workspaceId, roadmapId)).toEqual(record);
    expect(storedRoadmap(state)).toEqual(roadmap);
    release();
  });

  it.each(WIND_DOWN_STEPS)(
    'converges after a crash once its %s step ended, and asks once in Needs you meanwhile',
    async (crashed) => {
      const { state, first, third, release } = await settleFixture();
      state.context.services.roadmapService.observeSettlement((_id, step) => {
        if (step === crashed) throw new Error(`crashed after ${step}`);
      });
      expect((await stop(state)).statusCode).toBe(200);
      const interrupted = present(
        state.context.storage.windDowns.find(state.workspaceId, roadmapId),
      );
      const item = () =>
        state.context.storage.attention
          .open(state.workspaceId)
          .filter((i) => i.code === 'wind-down-incomplete');
      // The last step commits the roadmap's stop and the settlement together: a crash after it
      // finds nothing left to do.
      if (crashed === 'settle') expect(interrupted.status).toBe('settled');
      else {
        expect(interrupted.status).toBe('settling');
        expect(interrupted.incomplete).toMatchObject({
          step: crashed,
          message: `crashed after ${crashed}`,
        });
        expect(item()).toHaveLength(1);
      }
      // The cause clears; the next pass (as at a start) resumes and finishes.
      state.context.services.roadmapService.observeSettlement(undefined);
      await stepDaemon(state.context.services);
      const settled = present(state.context.storage.windDowns.find(state.workspaceId, roadmapId));
      expect(settled.status).toBe('settled');
      expect(settled.incomplete).toBeUndefined();
      expect(storedRoadmap(state).status).toBe('stopped');
      for (const attempt of [first, third])
        expect(cycleOf(state, attempt.cycleId).status).toBe('stopped');
      expect(item()).toEqual([]);
      // Each cycle was stopped once; the repeat found them stopped.
      const stops = auditLog(state).filter(
        (e) => e.action === 'work-cycle.updated' && e.metadata.action === 'roadmap-wound-down',
      );
      expect(stops).toHaveLength(2);
      // A repeated command is a no-op.
      await stepDaemon(state.context.services);
      expect(state.context.storage.windDowns.find(state.workspaceId, roadmapId)).toEqual(settled);
      release();
    },
  );

  it('holds the roadmap and its cycles while a settling record stands, and resumes it on a pass', async () => {
    const { state, third, release } = await settleFixture();
    const roadmap = storedRoadmap(state);
    const owner = roadmap.delegatedByUserId ?? roadmap.createdByUserId;
    // A crash right after the hold was written, before any step ran.
    state.context.storage.transaction((tx) =>
      tx.windDowns.insert({
        id: asRoadmapWindDownId(randomUUID()),
        workspaceId: state.workspaceId,
        roadmapId: asRoadmapId(roadmapId),
        version: 1,
        status: 'settling',
        retire: [],
        abandonResolutions: [],
        previewDigest: 'd'.repeat(64),
        requestedAt: new Date().toISOString(),
        requestedByUserId: owner,
        startedAt: new Date().toISOString(),
      }),
    );
    // A restart does not turn a settling roadmap into one that waits for a resume.
    expect(state.context.services.roadmapService.recoverInterrupted()).toEqual([]);
    // The held design ends; the cycle worker leaves the held cycle where it is.
    release();
    await state.context.services.agentRunService.quiesce();
    const before = cycleOf(state, third.cycleId);
    for (let i = 0; i < 3; i++) {
      await state.context.services.workCycleService.tick();
      await state.context.services.agentRunService.quiesce();
    }
    expect(cycleOf(state, third.cycleId)).toEqual(before);
    // The scheduler's pass resumes the settle instead of advancing the roadmap.
    await state.context.services.roadmapService.tick();
    expect(state.context.storage.windDowns.find(state.workspaceId, roadmapId)?.status).toBe(
      'settled',
    );
    expect(cycleOf(state, third.cycleId).status).toBe('stopped');
    expect(storedRoadmap(state).status).toBe('stopped');
  });

  it('finishes what an old Stop left running, and never touches another roadmap in the workspace', async () => {
    const fixture = await parallelFixture({ independentThird: true });
    const { state, backend } = fixture;
    let releaseFirst: () => void = () => undefined;
    let releaseOther: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const otherHeld = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? {
            ...designDone,
            release: itemAt(state, request.cwd) === fixture.third ? otherHeld : firstHeld,
          }
        : request.model === 'review-model'
          ? { resultText: reviewText([]) }
          : implementationDone;
    // Roadmap A runs the first item.
    const a = roadmapInput(state, [state.workItemId]);
    expect(
      (await saveRoadmapRequest(state, { ...a, scheduling: parallelScheduling })).statusCode,
    ).toBe(200);
    await roadmapControl(state, 'start');
    await waitFor(
      () =>
        storedRoadmap(state).attempts.some(
          (attempt) =>
            state.context.storage.execution.runs.liveForWorktree(
              state.workspaceId,
              attempt.worktreeId,
            ).length > 0,
        ),
      'roadmap A running',
    );
    const aAttempt = present(storedRoadmap(state).attempts[0]);
    // The old Stop saved the roadmap stopped and then threw before reaching its cycle.
    const running = storedRoadmap(state);
    state.context.storage.transaction((tx) =>
      tx.roadmaps.save(
        { ...running, status: 'stopped', version: running.version + 1, reason: 'Roadmap stopped.' },
        running.version,
      ),
    );
    expect(cycleOf(state, aAttempt.cycleId).status).toBe('running');
    // Roadmap B starts in the same workspace on the independent third item.
    const otherId = asRoadmapId('00000000-0000-4000-8000-000000000099');
    const b = {
      ...roadmapInput(state, [fixture.third]),
      name: 'Other roadmap',
      scheduling: parallelScheduling,
    };
    expect((await saveRoadmapRequest(state, b, otherId)).statusCode).toBe(200);
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${otherId}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'start',
        expectedVersion: present(state.context.storage.roadmaps.find(state.workspaceId, otherId))
          .version,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const other = () => present(state.context.storage.roadmaps.find(state.workspaceId, otherId));
    await waitFor(
      () =>
        other().attempts.some(
          (attempt) =>
            state.context.storage.execution.runs.liveForWorktree(
              state.workspaceId,
              attempt.worktreeId,
            ).length > 0,
        ),
      'roadmap B running',
    );
    const otherBefore: Roadmap = other();
    const otherAttempt = present(otherBefore.attempts[0]);
    const otherCycle = cycleOf(state, otherAttempt.cycleId);
    const otherTree = state.context.storage.execution.worktrees.find(
      state.workspaceId,
      otherAttempt.worktreeId,
    );

    // Stopping A again settles what the old Stop left.
    const response = await stop(state);
    expect(response.statusCode, response.body).toBe(200);
    expect(cycleOf(state, aAttempt.cycleId).status).toBe('stopped');
    expect(state.context.storage.windDowns.find(state.workspaceId, roadmapId)?.status).toBe(
      'settled',
    );
    // B, its cycle, its live run and its worktree are untouched.
    expect(other()).toEqual(otherBefore);
    expect(cycleOf(state, otherAttempt.cycleId)).toEqual(otherCycle);
    expect(
      state.context.storage.execution.runs.liveForWorktree(
        state.workspaceId,
        otherAttempt.worktreeId,
      ),
    ).toHaveLength(1);
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, otherAttempt.worktreeId),
    ).toEqual(otherTree);
    expect(state.context.storage.windDowns.find(state.workspaceId, otherId)).toBeUndefined();
    releaseFirst();
    releaseOther();
  });
});
