import { roadmapsResponseSchema, roadmapViewSchema } from '@craftingtable/contracts';
import { afterEach, expect } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  itNeedsCargo,
  mutationHeaders,
  roadmapControl,
  roadmapId,
  scopeTree,
  stepDaemons,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * Re-verify: a verification whose evidence went stale (here, a newer repository policy) gets a
 * fresh independent review with its assigned reviewer, without stopping the roadmap.
 */
itNeedsCargo(
  're-verifies stale verification evidence in place, or with a fresh attempt once its worktree is gone',
  async () => {
    const f = await supervisedMapFixture(false, 'manual');
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    f.service.save(f.auth, ws, f.input);
    await adoptSupervisedMap(f);
    await roadmapControl(state, 'start');
    const verification = (sourceId: string) =>
      storedRoadmap(state).definition.entries.find(
        (e) => e.executionScope?.kind === 'slice-verification' && e.sourceId === sourceId,
      )!;
    const A = verification('local/AQ-01/a'),
      B = verification('local/AQ-01/b');
    const attempt = (entryId: string) =>
      storedRoadmap(state).attempts.find((a) => a.entryId === entryId && !a.recovery);
    const cycle = (entryId: string) => tx.execution.cycles.find(ws, attempt(entryId)!.cycleId);
    const progress = async (entryId: string) => {
      const listed = await state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${ws}/roadmaps`,
        headers: { cookie: state.cookie },
      });
      return roadmapsResponseSchema
        .parse(listed.json())
        .roadmaps.find((r) => r.roadmap.id === roadmapId)!
        .progress.find((p) => p.entryId === entryId)!;
    };
    const parent = () =>
      tx.execution.cycles
        .listForWorkspace(ws)
        .find((c) => c.executionScope?.kind === 'parent-acceptance');
    await waitFor(() => parent()?.status === 'awaiting-merge', 'manual parent review');
    await roadmapControl(state, 'pause');
    const reverify = (entryId: string) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/control`,
        headers: mutationHeaders(state),
        payload: { action: 'reverify', entryId, expectedVersion: storedRoadmap(state).version },
      });

    // Current evidence, and a review that is still open, are not re-verified.
    for (const entry of [A, B]) {
      expect((await progress(entry.id)).status).toBe('completed');
      expect((await progress(entry.id)).reverifiable).toBeUndefined();
    }
    const current = await reverify(A.id);
    expect(current.statusCode).toBe(409);
    expect(current.body).toContain('This evidence is current');
    const parentEntry = storedRoadmap(state).definition.entries.find(
      (e) => e.executionScope?.kind === 'parent-acceptance',
    )!;
    expect((await reverify(parentEntry.id)).body).toContain('still open');

    // A newer repository policy makes the recorded verifications stale.
    const plan = `/api/workspaces/${ws}/plan-versions/version-1/repository-policy`;
    const preview = await state.context.app.inject({
      method: 'GET',
      url: plan,
      headers: { cookie: state.cookie },
    });
    const adopted = await state.context.app.inject({
      method: 'POST',
      url: plan,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: 0,
        expectedBranchSettingsVersion: preview.json().settingsVersion,
        controlMode: 'controller-local',
        interpretation: 'Controller gates now.',
        publicationRequirement: 'Verify remote protections before publication.',
      },
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    for (const entry of [A, B]) {
      expect((await progress(entry.id)).status).not.toBe('completed');
      expect((await progress(entry.id)).reverifiable).toBe(true);
    }
    // The scheduler holds each stale entry with its own code, and the inbox offers Re-verify
    // for it (R-A5), without any navigation prose in the hold.
    await roadmapControl(state, 'resume');
    await stepDaemons();
    const inbox = () => {
      state.context.services.roadmapService.syncAttention(true);
      return state.context.services.attentionService.feed(f.auth, ws).items;
    };
    for (const entry of [A, B]) {
      expect(storedRoadmap(state).entryHolds?.[entry.id]).toMatchObject({
        status: 'needs-attention',
        attention: { code: 'evidence-not-current' },
        reason: 'This review evidence is no longer current; prior attempts remain in history.',
      });
      expect(
        inbox().find((item) => item.subjectKey === `roadmap:${roadmapId}:entry:${entry.id}`),
      ).toMatchObject({ code: 'evidence-not-current', actions: ['reverify'] });
    }
    await roadmapControl(state, 'pause');

    // A: its completed cycle and worktree are intact, so it reviews again in place.
    const oldA = cycle(A.id)!;
    const inPlace = await reverify(A.id);
    expect(inPlace.statusCode, inPlace.body).toBe(200);
    expect(attempt(A.id)?.reverification?.sourceRunId).toBe(oldA.currentRunId);
    expect(
      roadmapViewSchema.parse(inPlace.json()).progress.find((p) => p.entryId === A.id)?.reason,
    ).toContain('queued by Re-verify');
    expect((await reverify(A.id)).body).toContain('already queued');

    // An operator's item pause is kept: Re-verify never resumes a paused item.
    const paused = storedRoadmap(state);
    expect(
      tx.roadmaps.save(
        {
          ...paused,
          version: paused.version + 1,
          entryHolds: { [A.id]: { status: 'paused', reason: 'Item paused by operator.' } },
        },
        paused.version,
      ),
    ).toBe(true);
    expect((await reverify(A.id)).body).toContain('Resume the item before re-verifying');
    const unpaused = storedRoadmap(state);
    tx.roadmaps.save(
      { ...unpaused, version: unpaused.version + 1, entryHolds: {} },
      unpaused.version,
    );

    // B: its worktree is gone, so the ended attempt is retired and a fresh one scheduled. A
    // second active worktree for the scope is refused by name.
    const oldB = attempt(B.id)!;
    const removed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/worktrees/${oldB.worktreeId}/remove`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const manual = await scopeTree(f, B.executionScope!);
    const blocked = await reverify(B.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain(`Remove the unused worktree ${manual.branchName} first`);
    expect(
      (
        await state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws}/worktrees/${manual.id}/remove`,
          headers: mutationHeaders(state),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const fresh = await reverify(B.id);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(attempt(B.id)).toBeUndefined();
    expect(storedRoadmap(state).retiredAttempts).toEqual([
      expect.objectContaining({
        id: oldB.id,
        retiredByUserId: state.userId,
        reason: expect.stringContaining('no longer current'),
      }),
    ]);

    // The retired entry has still started: saving new defaults keeps its frozen settings.
    const frozen = storedRoadmap(state).definition.entries.find((e) => e.id === B.id)!;
    f.service.save(f.auth, ws, {
      ...f.input,
      expectedVersion: storedRoadmap(state).version,
      configuration: {
        ...f.input.configuration,
        defaults: { ...f.input.configuration.defaults, instructions: 'Changed defaults.' },
      },
    });
    const kept = storedRoadmap(state).definition.entries.find(
      (e) => e.executionScope?.kind === 'slice-verification' && e.sourceId === B.sourceId,
    )!;
    expect(kept.instructions).toBe(frozen.instructions);
    expect(kept.instructions).not.toBe('Changed defaults.');

    // Resuming runs both fresh reviews with the assigned reviewer; the evidence is current again.
    await roadmapControl(state, 'resume');
    // The test daemons step only when asked (R-B2 seam); step until both are verified again.
    for (let step = 0; ; step++) {
      if (
        (await progress(A.id)).status === 'completed' &&
        (await progress(B.id)).status === 'completed'
      )
        break;
      if (step > 300) throw new Error('Timed out waiting for fresh verification evidence.');
      await stepDaemons();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(cycle(A.id)?.id).toBe(oldA.id);
    expect(cycle(A.id)?.currentRunId).not.toBe(oldA.currentRunId);
    expect(attempt(A.id)?.reverification).toBeUndefined();
    expect(attempt(B.id)?.id).not.toBe(oldB.id);
    expect(attempt(B.id)?.worktreeId).not.toBe(oldB.worktreeId);

    // A queued in-place review that cannot run (its worktree was removed) holds the item, and
    // Re-verify can then replace it: the item is never left stuck.
    await roadmapControl(state, 'pause');
    const again = await state.context.app.inject({
      method: 'POST',
      url: plan,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: 1,
        expectedBranchSettingsVersion: preview.json().settingsVersion,
        controlMode: 'controller-local',
        interpretation: 'Controller gates, revised.',
        publicationRequirement: 'Verify remote protections before publication.',
      },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect((await reverify(A.id)).statusCode).toBe(200);
    const queued = attempt(A.id)!;
    expect(queued.reverification).toBeDefined();
    expect(
      (
        await state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws}/worktrees/${queued.worktreeId}/remove`,
          headers: mutationHeaders(state),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await roadmapControl(state, 'resume');
    await waitFor(
      () => storedRoadmap(state).entryHolds?.[A.id]?.status === 'needs-attention',
      'failed in-place review holds the item',
    );
    expect((await progress(A.id)).reverifiable).toBe(true);
    expect(
      inbox().find((item) => item.subjectKey === `roadmap:${roadmapId}:entry:${A.id}`)?.actions,
    ).toEqual(['reverify']);
    const replaced = await reverify(A.id);
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(attempt(A.id)).toBeUndefined();
    expect(storedRoadmap(state).retiredAttempts?.map((a) => a.id)).toContain(queued.id);
    for (let step = 0; (await progress(A.id)).status !== 'completed'; step++) {
      if (step > 300) throw new Error('Timed out waiting for the replacement verification.');
      await stepDaemons();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(attempt(A.id)?.reverification).toBeUndefined();
  },
);
