import { randomUUID } from 'node:crypto';
import {
  asMergeOperationId,
  asPlanVersionId,
  asProjectId,
  asRoadmapId,
  asRoadmapWindDownId,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthContext } from '../src/services/auth-service.js';
import { addMember, cleanupFixture, OTHER, startOther } from './cleanup-test-support.js';
import {
  cleanupExecutionFixtures,
  present,
  type Ready,
  mutationHeaders,
  roadmapId,
  stepDaemon,
  storedRoadmap,
} from './execution-test-support.js';
import { auditLog, settleFixture, stop, windDownAudit } from './wind-down-test-support.js';

/**
 * What a wind-down refuses, and when (R-B11, review F3, F4, F9): a version something else still
 * runs, checked again where the retirement is written; commands while a roadmap settles; another
 * user's retirements finished only by choosing them again; and a requester who can no longer act.
 */

afterEach(cleanupExecutionFixtures);

const V1 = asPlanVersionId('version-1');

function authOf(state: Ready): AuthContext {
  return state.context.services.authService.authenticate(state.cookie.split('=')[1]);
}

const record = (state: Ready) =>
  present(state.context.storage.windDowns.find(state.workspaceId, roadmapId));

/** Crash after the `cycles` step, as a daemon that died mid-settle would leave it. */
function crashAfterCycles(state: Ready) {
  state.context.services.roadmapService.observeSettlement((_id, step) => {
    if (step === 'cycles') throw new Error('crashed after cycles');
  });
}

describe('what a wind-down refuses (R-B11 review F3)', () => {
  it('refuses a version another roadmap runs or an outside merge holds, and clears its active pointer once retired', async () => {
    const f = await cleanupFixture();
    const { state, release } = f;
    const auth = authOf(state);
    const ws = state.workspaceId;
    const roadmaps = state.context.services.roadmapService;
    const version = () =>
      present(
        roadmaps
          .windDownView(auth, ws, roadmapId)
          .preview.versions.find((v) => v.planVersionId === V1),
      );
    const windDown = () =>
      roadmaps.windDown(auth, ws, roadmapId, {
        expectedDigest: roadmaps.windDownView(auth, ws, roadmapId).preview.digest,
        retire: [{ planVersionId: V1, disposition: 'parked' }],
      });
    // The other roadmap delegates work of version 1.
    expect(version().refusal?.code).toBe('version-in-use');
    await expect(windDown()).rejects.toMatchObject({ detail: { reason: 'version-in-use' } });
    // Once it has ended, it holds nothing.
    release();
    const other = present(state.context.storage.roadmaps.find(ws, OTHER));
    await roadmaps.control(auth, ws, OTHER, 'stop', other.version);
    expect(version().refusal).toBeUndefined();
    // A merge reserved on a worktree of the version outside this roadmap refuses it.
    const otherTree = present(f.otherTree);
    const merge = {
      id: asMergeOperationId(randomUUID()),
      workspaceId: ws,
      worktreeId: otherTree.id,
      status: 'reserved' as const,
      sourceSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      targetBranch: 'main',
      reviewRunId: present(
        state.context.storage.execution.runs.listForWorktree(ws, otherTree.id)[0],
      ).id,
      createdAt: new Date().toISOString(),
      authorizedByUserId: state.userId,
    };
    state.context.storage.transaction((tx) => tx.execution.merges.save(merge));
    expect(version().refusal?.code).toBe('merge-in-flight');
    await expect(windDown()).rejects.toMatchObject({ detail: { reason: 'merge-in-flight' } });
    state.context.storage.transaction((tx) =>
      tx.execution.merges.save({ ...merge, status: 'failed' }),
    );
    // The project's active plan is the version: retiring it clears the pointer.
    const project = present(
      state.context.storage.planning.projects.find(ws, asProjectId('project-1')),
    );
    expect(state.context.storage.imports.activatePlan(ws, project.id, V1, project.version)).toBe(
      true,
    );
    await windDown();
    expect(record(state).status).toBe('settled');
    expect(
      state.context.storage.planning.projects.find(ws, asProjectId('project-1'))
        ?.activePlanVersionId,
    ).toBeUndefined();
    expect(
      auditLog(state).find((e) => e.action === 'plan.version-retired')?.metadata,
    ).toMatchObject({ disposition: 'parked', activeCleared: true });
  });

  it('checks a retirement again where it is written, asks once, and finishes when the cause clears (F4, F10)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { state, release } = f;
    const auth = authOf(state);
    const ws = state.workspaceId;
    const roadmaps = state.context.services.roadmapService;
    crashAfterCycles(state);
    await roadmaps.windDown(auth, ws, roadmapId, {
      expectedDigest: roadmaps.windDownView(auth, ws, roadmapId).preview.digest,
      retire: [{ planVersionId: V1, disposition: 'superseded' }],
    });
    roadmaps.observeSettlement(undefined);
    expect(record(state)).toMatchObject({ status: 'settling', incomplete: { step: 'cycles' } });
    // Meanwhile another roadmap starts work of the version.
    await startOther(state);
    await stepDaemon(state.context.services);
    expect(record(state)).toMatchObject({ status: 'settling', incomplete: { step: 'settle' } });
    expect(record(state).incomplete?.message).toMatch(/cannot be retired now/);
    expect(state.context.storage.windDowns.retirement(ws, V1)).toBeUndefined();
    const incomplete = () =>
      windDownAudit(state).filter((e) => e.metadata.phase === 'incomplete').length;
    const asked = incomplete();
    // Another pass on the same cause records nothing new.
    await stepDaemon(state.context.services);
    expect(incomplete()).toBe(asked);
    // The other roadmap ends; the next pass retires the version.
    release();
    const other = present(state.context.storage.roadmaps.find(ws, OTHER));
    await roadmaps.control(auth, ws, OTHER, 'stop', other.version);
    await stepDaemon(state.context.services);
    expect(record(state).status).toBe('settled');
    expect(state.context.storage.windDowns.retirement(ws, V1)).toMatchObject({
      disposition: 'superseded',
    });
  });

  it('refuses a stale command, a stale preview, another retirement and other commands while settling; a repeat once settled changes nothing', async () => {
    const { state, release } = await settleFixture();
    const auth = authOf(state);
    const ws = state.workspaceId;
    const roadmaps = state.context.services.roadmapService;
    const before = roadmaps.windDownView(auth, ws, roadmapId).preview.digest;
    const stale = await stop(state, storedRoadmap(state).version - 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { reason: 'version-conflict' } });
    crashAfterCycles(state);
    expect((await stop(state)).statusCode).toBe(200);
    roadmaps.observeSettlement(undefined);
    expect(record(state).status).toBe('settling');
    // The cycles it stopped changed what winding down would do.
    await expect(
      roadmaps.windDown(auth, ws, roadmapId, {
        expectedDigest: before,
        retire: [{ planVersionId: V1, disposition: 'superseded' }],
      }),
    ).rejects.toMatchObject({ detail: { reason: 'preview-stale' } });
    await expect(
      roadmaps.windDown(auth, ws, roadmapId, {
        expectedDigest: roadmaps.windDownView(auth, ws, roadmapId).preview.digest,
        retire: [{ planVersionId: V1, disposition: 'superseded' }],
      }),
    ).rejects.toMatchObject({ detail: { reason: 'wind-down-in-progress' } });
    const paused = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'pause', expectedVersion: storedRoadmap(state).version },
    });
    expect(paused.statusCode).toBe(409);
    expect(paused.json()).toMatchObject({ error: { reason: 'wind-down-in-progress' } });
    await stepDaemon(state.context.services);
    const settled = record(state);
    expect(settled.status).toBe('settled');
    const audits = windDownAudit(state).length;
    await roadmaps.windDown(auth, ws, roadmapId, {
      expectedDigest: roadmaps.windDownView(auth, ws, roadmapId).preview.digest,
      retire: [],
    });
    expect(record(state)).toEqual(settled);
    expect(windDownAudit(state)).toHaveLength(audits);
    release();
  });

  it('lets another user finish someone’s retirements only by choosing them again, as themself (F9)', async () => {
    const f = await cleanupFixture({ withOther: false });
    const { state } = f;
    const auth = authOf(state);
    const ws = state.workspaceId;
    const roadmaps = state.context.services.roadmapService;
    const editor = addMember(state, 'editor');
    const digest = () => roadmaps.windDownView(auth, ws, roadmapId).preview.digest;
    crashAfterCycles(state);
    await roadmaps.windDown(auth, ws, roadmapId, {
      expectedDigest: digest(),
      retire: [{ planVersionId: V1, disposition: 'parked' }],
    });
    roadmaps.observeSettlement(undefined);
    await expect(
      roadmaps.windDown(editor, ws, roadmapId, { expectedDigest: digest(), retire: [] }),
    ).rejects.toMatchObject({ detail: { reason: 'wind-down-in-progress' } });
    await expect(
      roadmaps.control(editor, ws, roadmapId, 'stop', storedRoadmap(state).version),
    ).rejects.toMatchObject({ detail: { reason: 'wind-down-in-progress' } });
    expect(state.context.storage.windDowns.retirement(ws, V1)).toBeUndefined();
    // Choosing the version again (the route asks for the editor's password) finishes it.
    await roadmaps.windDown(editor, ws, roadmapId, {
      expectedDigest: digest(),
      retire: [{ planVersionId: V1, disposition: 'parked' }],
    });
    expect(record(state).status).toBe('settled');
    expect(state.context.storage.windDowns.retirement(ws, V1)).toMatchObject({
      disposition: 'parked',
      retiredByUserId: state.userId,
    });
    expect(auditLog(state).find((e) => e.action === 'plan.version-retired')).toMatchObject({
      actorUserId: editor.user.id,
      sessionId: editor.session.id,
    });
  });

  it('settles as its requester only while they may act, holding the roadmap meanwhile', async () => {
    const { state, release } = await settleFixture();
    const auth = authOf(state);
    const ws = state.workspaceId;
    const viewer = addMember(state, 'viewer');
    // A record whose requester can no longer act on the roadmap.
    state.context.storage.transaction((tx) =>
      tx.windDowns.insert({
        id: asRoadmapWindDownId(randomUUID()),
        workspaceId: ws,
        roadmapId: asRoadmapId(roadmapId),
        version: 1,
        status: 'settling',
        retire: [],
        abandonResolutions: [],
        previewDigest: 'd'.repeat(64),
        requestedAt: new Date().toISOString(),
        requestedByUserId: viewer.user.id,
        startedAt: new Date().toISOString(),
      }),
    );
    const roadmaps = state.context.services.roadmapService;
    await roadmaps.tick();
    expect(record(state)).toMatchObject({ status: 'settling', incomplete: { step: 'cycles' } });
    expect(record(state).incomplete?.message).toMatch(/can no longer act/);
    expect(storedRoadmap(state).status).toBe('running');
    expect(
      state.context.storage.attention.open(ws).filter((i) => i.code === 'wind-down-incomplete'),
    ).toHaveLength(1);
    // An editor stops it as themself.
    await roadmaps.control(auth, ws, roadmapId, 'stop', storedRoadmap(state).version);
    expect(record(state).status).toBe('settled');
    expect(storedRoadmap(state).status).toBe('stopped');
    release();
  });
});
