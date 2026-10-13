import { randomUUID } from 'node:crypto';
import {
  asMergeOperationId,
  asRoadmapEntryId,
  DEFAULT_COMPLETION_POLICY,
  ownsIntegrationResolution,
  asPlanVersionId,
  asProjectId,
  asRoadmapId,
  asRoadmapWindDownId,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthContext } from '../src/services/auth-service.js';
import { addMember, cleanupFixture, FOURTH, OTHER } from './cleanup-test-support.js';
import {
  cleanupExecutionFixtures,
  commitFile,
  cycleProfiles,
  beginFinalization,
  designDone,
  finalizationFixture,
  git,
  implementationDone,
  parallelFixture,
  present,
  reviewText,
  roadmapControl,
  saveRoadmapRequest,
  stepPermissions,
  useIntegration,
  waitFor,
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
  it('abandons an owned integration resolution once its session ends, waiting without asking meanwhile', async () => {
    const fixture = await parallelFixture();
    const { state, backend, input } = fixture;
    await useIntegration(fixture);
    let releaseResolution: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    backend.onLaunch = (request) => {
      if (request.model === 'implement-model')
        commitFile(request.cwd, 'README.md', `behavior ${request.cwd}\n`);
    };
    backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? designDone
        : request.model === 'resolution-auto'
          ? { resultText: 'Combined checks passed.\n\n## Resolution status\nready', release: held }
          : request.model === 'review-model'
            ? { resultText: reviewText([]) }
            : implementationDone;
    await saveRoadmapRequest(state, {
      ...input,
      automation: {
        integrationMerge: 'automatic',
        integrationConflicts: 'automatic',
        resolutionProfile: { ...cycleProfiles.remediate, model: 'resolution-auto' },
      },
    });
    await roadmapControl(state, 'start');
    const ws = state.workspaceId;
    const owning = () =>
      state.context.storage.execution.cycles
        .listForWorkspace(ws)
        .find(
          (c) =>
            ownsIntegrationResolution(c) &&
            state.context.storage.execution.runs.liveForWorktree(ws, c.worktreeId).length > 0,
        );
    await waitFor(() => owning() !== undefined, 'a resolution session live');
    const owner = present(owning());
    // Stop asks the session to end; while it ends, the settle waits and asks nobody.
    expect((await stop(state)).statusCode).toBe(200);
    expect(record(state).abandonResolutions).toEqual([owner.id]);
    if (record(state).status === 'settling') expect(record(state).incomplete).toBeUndefined();
    expect(
      state.context.storage.attention.open(ws).filter((i) => i.code === 'wind-down-incomplete'),
    ).toEqual([]);
    releaseResolution();
    await state.context.services.agentRunService.quiesce();
    await stepDaemon(state.context.services);
    expect(record(state).status).toBe('settled');
    const stopped = present(state.context.storage.execution.cycles.find(ws, owner.id));
    expect(stopped.status).toBe('stopped');
    expect(stopped.integrationResolution?.status).toBe('abandoned');
    const tree = present(state.context.storage.execution.worktrees.find(ws, owner.worktreeId));
    expect(git(['status', '--porcelain'], tree.path)).toBe('');
  });

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

  it('refuses to retire a version with an open finalization', async () => {
    const fixture = await finalizationFixture();
    const { state } = fixture;
    await beginFinalization(fixture);
    expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
    const auth = authOf(state);
    const roadmaps = state.context.services.roadmapService;
    const view = roadmaps.windDownView(auth, state.workspaceId, roadmapId);
    expect(view.preview.versions.find((v) => v.planVersionId === V1)?.refusal?.code).toBe(
      'finalization-active',
    );
    await expect(
      roadmaps.windDown(auth, state.workspaceId, roadmapId, {
        expectedDigest: view.preview.digest,
        retire: [{ planVersionId: V1, disposition: 'parked' }],
      }),
    ).rejects.toMatchObject({ detail: { reason: 'finalization-active' } });
  });

  it('checks a retirement again where it is written, refuses new work of it meanwhile, asks once, and finishes when the cause clears (F4, F10, N1)', async () => {
    const f = await cleanupFixture();
    const { state, release } = f;
    const auth = authOf(state);
    const ws = state.workspaceId;
    const roadmaps = state.context.services.roadmapService;
    // The other roadmap ends; its worktree of the version stays.
    release();
    const other = present(state.context.storage.roadmaps.find(ws, OTHER));
    await roadmaps.control(auth, ws, OTHER, 'stop', other.version);
    crashAfterCycles(state);
    await roadmaps.windDown(auth, ws, roadmapId, {
      expectedDigest: roadmaps.windDownView(auth, ws, roadmapId).preview.digest,
      retire: [{ planVersionId: V1, disposition: 'superseded' }],
    });
    roadmaps.observeSettlement(undefined);
    expect(record(state)).toMatchObject({ status: 'settling', incomplete: { step: 'cycles' } });
    // While it settles, no roadmap may plan the version's work.
    const planned = await saveRoadmapRequest(
      state,
      {
        expectedVersion: 0,
        name: 'Planned meanwhile',
        entries: [
          {
            id: asRoadmapEntryId('00000000-0000-4000-8000-000000000051'),
            workItemId: FOURTH,
            permissions: stepPermissions,
            policy: DEFAULT_COMPLETION_POLICY,
            instructions: '',
          },
        ],
      },
      asRoadmapId('00000000-0000-4000-8000-000000000050'),
    );
    expect(planned.statusCode, planned.body).toBe(409);
    expect(planned.json()).toMatchObject({ error: { reason: 'plan-version-retired' } });
    // A merge is reserved on the other roadmap's worktree of the version.
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
    await stepDaemon(state.context.services);
    expect(record(state)).toMatchObject({ status: 'settling', incomplete: { step: 'settle' } });
    expect(record(state).incomplete?.message).toMatch(/cannot be retired now/);
    expect(state.context.storage.windDowns.retirement(ws, V1)).toBeUndefined();
    const incomplete = () =>
      windDownAudit(state).filter((e) => e.metadata.phase === 'incomplete').length;
    const asked = incomplete();
    const stuck = record(state);
    // Another pass on the same cause records nothing new, and wakes nothing (N7).
    const notifier = state.context.services.workspaceEventNotifier;
    const generation = notifier.workflowGeneration;
    await roadmaps.tick();
    expect(incomplete()).toBe(asked);
    expect(record(state)).toEqual(stuck);
    expect(notifier.workflowGeneration).toBe(generation);
    // Minutes later the same cause refreshes its message and time, still without asking again.
    const aged = new Date(Date.now() - 10 * 60_000).toISOString();
    state.context.storage.transaction((tx) =>
      tx.windDowns.replace(
        {
          ...stuck,
          version: stuck.version + 1,
          incomplete: { ...present(stuck.incomplete), at: aged, message: 'An older message.' },
        },
        stuck.version,
      ),
    );
    await roadmaps.tick();
    expect(record(state).incomplete?.at).not.toBe(aged);
    expect(record(state).incomplete?.message).toMatch(/cannot be retired now/);
    expect(incomplete()).toBe(asked);
    // The merge ends; the next pass retires the version.
    state.context.storage.transaction((tx) =>
      tx.execution.merges.save({ ...merge, status: 'failed' }),
    );
    await stepDaemon(state.context.services);
    expect(record(state).status).toBe('settled');
    expect(state.context.storage.windDowns.retirement(ws, V1)).toMatchObject({
      disposition: 'superseded',
    });
  });

  it('refuses a stale command, a stale preview, another retirement and other commands while settling; a repeat once settled changes nothing', async () => {
    const { state, release, first } = await settleFixture();
    const auth = authOf(state);
    const ws = state.workspaceId;
    const roadmaps = state.context.services.roadmapService;
    // A claim that a finished run of the roadmap still holds is released by the settle.
    const finished = present(
      state.context.storage.execution.runs
        .listForWorktree(ws, first.worktreeId)
        .find((r) => r.status === 'finished'),
    );
    state.context.storage.phaseScheduling.acquire({
      id: 'orphaned-claim',
      workspaceId: ws,
      worktreeId: first.worktreeId,
      ownerId: finished.id,
      phase: 'start',
      resourceKey: 'local-development',
      capacity: 2,
      acquiredAt: new Date().toISOString(),
    });
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
    expect(
      state.context.storage.phaseScheduling.active().some((r) => r.id === 'orphaned-claim'),
    ).toBe(false);
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
