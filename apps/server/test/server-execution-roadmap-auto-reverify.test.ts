import { roadmapsResponseSchema, roadmapViewSchema } from '@craftingtable/contracts';
import {
  asUserId,
  asWorkspaceMembershipId,
  type Roadmap,
  type UserId,
} from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { evidenceChangedAt, evidenceStaleness } from '../src/services/cross-project-service.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  itNeedsCargo,
  roadmapFixture,
  saveRoadmapRequest,
  mutationHeaders,
  recordScope,
  roadmapControl,
  roadmapId,
  stepDaemons,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * R-C10's follow-up, increment 5 (decision 4): under the roadmap's revocable grant, the
 * scheduler re-verifies a verification whose evidence went stale for a reason a fresh review
 * answers (here, a newer repository policy), in place, once approvals have settled; the queued
 * review names the grantor and the audit names the system. Without the grant, while approvals
 * settle, and once its in-place route is gone, the hold and its Re-verify stay the operator's.
 */
itNeedsCargo(
  're-verifies stale evidence by itself under the grant, in place and after approvals settle',
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
    // The operator accepts the parent by hand (manual acceptance), and its cycle completes.
    const parentEntry = storedRoadmap(state).definition.entries.find(
      (e) => e.executionScope?.kind === 'parent-acceptance',
    )!;
    const parentTree = tx.execution.worktrees
      .listForWorkItem(ws, state.workItemId)
      .find((t) => t.executionScope?.kind === 'parent-acceptance')!;
    expect((await recordScope(f, parentTree)).statusCode).toBe(200);
    await stepDaemons();
    await state.context.services.roadmapService.tick();
    expect(parent()?.status).toBe('completed');
    const grant = (enabled: boolean) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/reverification`,
        headers: mutationHeaders(state),
        payload: { expectedVersion: storedRoadmap(state).version, enabled },
      });
    const reverifyRows = () =>
      tx.audit
        .listWorkspace({ workspaceId: ws, limit: 500 })
        .filter(
          (row) => row.action === 'roadmap.updated' && row.metadata.action === 'reverify-entry',
        )
        .reverse();
    const scheduler = state.context.services.roadmapService as unknown as { now: () => Date };
    const settled = () => {
      const later = Date.now() + 11 * 60_000;
      scheduler.now = () => new Date(later);
    };
    const tick = () => state.context.services.roadmapService.tick();

    // The grant is off until the operator turns it on (at any status but ended since R-B6,
    // pause-scope-characterization.test.ts); this roadmap is paused for the steps below.
    expect(storedRoadmap(state).reverificationGrant).toBeUndefined();
    await roadmapControl(state, 'pause');

    // A newer repository policy makes the recorded verifications stale, for that reason alone.
    const plan = `/api/workspaces/${ws}/plan-versions/version-1/repository-policy`;
    const preview = await state.context.app.inject({
      method: 'GET',
      url: plan,
      headers: { cookie: state.cookie },
    });
    const adopt = (expectedVersion: number, interpretation: string) =>
      state.context.app.inject({
        method: 'POST',
        url: plan,
        headers: mutationHeaders(state),
        payload: {
          expectedVersion,
          expectedBranchSettingsVersion: preview.json().settingsVersion,
          controlMode: 'controller-local',
          interpretation,
          publicationRequirement: 'Verify remote protections before publication.',
        },
      });
    expect((await adopt(0, 'Controller gates now.')).statusCode).toBe(200);
    // The settle window reads the policy's adoption (the fixture approves no decisions).
    expect(evidenceChangedAt(tx, ws, A.executionScope!, A.workItemId)).toBe(
      tx.execution.branchSettings.policy(ws, 'version-1' as never)?.adoptedAt,
    );
    for (const entry of [A, B])
      expect(evidenceStaleness(tx, ws, entry.executionScope!, entry.workItemId).reasons).toEqual([
        'repository-policy',
      ]);

    // Without the grant the scheduler holds each stale entry and leaves Re-verify to the operator,
    // however long approvals have settled.
    await roadmapControl(state, 'resume');
    await stepDaemons();
    settled();
    await tick();
    for (const entry of [A, B])
      expect(storedRoadmap(state).entryHolds?.[entry.id]?.attention?.code).toBe(
        'evidence-not-current',
      );
    expect(reverifyRows()).toEqual([]);

    // The grant, set while paused, names its grantor and is audited.
    scheduler.now = () => new Date();
    await roadmapControl(state, 'pause');
    const granted = await grant(true);
    expect(granted.statusCode, granted.body).toBe(200);
    expect(roadmapViewSchema.parse(granted.json()).roadmap.reverificationGrant).toMatchObject({
      enabled: true,
      grantedByUserId: state.userId,
    });
    expect(
      tx.audit
        .listWorkspace({ workspaceId: ws, limit: 500 })
        .find(
          (row) =>
            row.action === 'roadmap.updated' && row.metadata.action === 'configure-reverification',
        )?.metadata,
    ).toMatchObject({ reverificationEnabled: true });

    // While approvals settle (the policy was adopted just now), the holds stay. Resume drops the
    // stored holds, so the first pass holds again and the second asks for a release.
    await roadmapControl(state, 'resume');
    await tick();
    for (const entry of [A, B]) expect(storedRoadmap(state).entryHolds?.[entry.id]).toBeDefined();
    await tick();
    for (const entry of [A, B]) expect(storedRoadmap(state).entryHolds?.[entry.id]).toBeDefined();
    // The scheduler's drain looks at the roadmap again once approvals have settled (R-B5 part 2).
    const adoptedAt = Date.parse(
      tx.execution.branchSettings.policy(ws, 'version-1' as never)?.adoptedAt ?? '',
    );
    expect(
      (
        state.context.services.roadmapService as unknown as {
          kernel: { nextDue(): number | undefined };
        }
      ).kernel.nextDue(),
    ).toBe(adoptedAt + 10 * 60_000);
    expect(reverifyRows()).toEqual([]);

    // A grantor who may no longer re-verify (now only a viewer) grants nothing, as a standing
    // preparation's grantor (R-C3b): the review would name them as its requester.
    const viewer = asUserId('former-editor-id');
    tx.users.insert({
      id: viewer,
      username: 'former-editor',
      usernameNormalized: 'former-editor',
      passwordHash: `$argon2id$test$${Buffer.from('unused-password').toString('base64url')}`,
      occurredAt: new Date().toISOString(),
    });
    tx.workspaces.insertMembership({
      id: asWorkspaceMembershipId('former-editor-membership'),
      workspaceId: ws,
      userId: viewer,
      role: 'viewer',
      occurredAt: new Date().toISOString(),
    });
    const regrant = (grantedByUserId: UserId) => {
      const current = storedRoadmap(state);
      tx.roadmaps.save(
        {
          ...current,
          version: current.version + 1,
          reverificationGrant: { ...current.reverificationGrant!, grantedByUserId },
        },
        current.version,
      );
    };
    regrant(viewer);
    settled();
    await tick();
    for (const entry of [A, B]) expect(storedRoadmap(state).entryHolds?.[entry.id]).toBeDefined();
    expect(reverifyRows()).toEqual([]);
    regrant(state.userId);
    scheduler.now = () => new Date();

    // Once they settled, each is re-verified in place, as the system, for the grantor.
    const oldA = cycle(A.id)!;
    const patches: Partial<Roadmap>[] = [];
    const internals = scheduler as unknown as { change: (...args: unknown[]) => unknown };
    const change = internals.change.bind(internals);
    const spy = vi.spyOn(internals, 'change').mockImplementation((...args: unknown[]) => {
      if (args[2] === 'reverify-entry') patches.push(args[1] as Partial<Roadmap>);
      return change(...args);
    });
    settled();
    await tick();
    spy.mockRestore();
    const rows = reverifyRows();
    expect(rows.map((row) => row.metadata.release)).toEqual(
      expect.arrayContaining([
        {
          entryId: A.id,
          code: 'evidence-not-current',
          fact: 'reverify',
          requestedByUserId: state.userId,
        },
        {
          entryId: B.id,
          code: 'evidence-not-current',
          fact: 'reverify',
          requestedByUserId: state.userId,
        },
      ]),
    );
    expect(rows.every((row) => row.actorKind === 'system')).toBe(true);
    expect(
      patches.flatMap((p) => p.attempts ?? []).find((a) => a.entryId === A.id && a.reverification)
        ?.reverification,
    ).toMatchObject({ requestedByUserId: state.userId, sourceRunId: oldA.currentRunId });
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
    expect(evidenceStaleness(tx, ws, A.executionScope!, A.workItemId).reasons).toEqual([]);

    // The parent acceptance, asked once its verifications are current again, is stale too, with
    // its in-place route; the operator accepts it by hand, so it stays theirs to re-verify.
    settled();
    await tick();
    await tick();
    expect(storedRoadmap(state).entryHolds?.[parentEntry.id]?.attention?.code).toBe(
      'evidence-not-current',
    );
    expect((await progress(parentEntry.id)).reverifiable).toBe(true);
    expect(
      reverifyRows().map((row) => (row.metadata.release as { entryId: string }).entryId),
    ).not.toContain(parentEntry.id);

    // A stale entry whose worktree is gone has no in-place route, so it stays the operator's under
    // the grant (Re-verify offers them the fresh route), while B, stale again with its route
    // intact, is re-verified once more (review LOW-2).
    await roadmapControl(state, 'pause');
    expect((await adopt(1, 'Controller gates, revised.')).statusCode).toBe(200);
    expect(
      (
        await state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws}/worktrees/${attempt(A.id)!.worktreeId}/control`,
          headers: mutationHeaders(state),
          payload: { action: 'remove' },
        })
      ).statusCode,
    ).toBe(200);
    const before = reverifyRows().length;
    scheduler.now = () => new Date();
    await roadmapControl(state, 'resume');
    await tick();
    expect(storedRoadmap(state).entryHolds?.[A.id]?.attention?.code).toBe('evidence-not-current');
    settled();
    await tick();
    expect(storedRoadmap(state).entryHolds?.[A.id]?.attention?.code).toBe('evidence-not-current');
    expect((await progress(A.id)).reverifiable).toBe(true);
    expect(
      reverifyRows()
        .slice(before)
        .map((row) => row.metadata.release),
    ).toEqual([
      {
        entryId: B.id,
        code: 'evidence-not-current',
        fact: 'reverify',
        requestedByUserId: state.userId,
      },
    ]);
    for (let step = 0; (await progress(B.id)).status !== 'completed'; step++) {
      if (step > 300) throw new Error('Timed out waiting for B’s fresh verification.');
      await stepDaemons();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Revoked, the grant starts no new re-verification: B's stale evidence, settled, is held for
    // the operator.
    await roadmapControl(state, 'pause');
    const revoked = await grant(false);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(storedRoadmap(state).reverificationGrant?.enabled).toBe(false);
    expect((await adopt(2, 'Controller gates, revised again.')).statusCode).toBe(200);
    const revokedAt = reverifyRows().length;
    await roadmapControl(state, 'resume');
    await stepDaemons();
    settled();
    await tick();
    expect(storedRoadmap(state).entryHolds?.[B.id]?.attention?.code).toBe('evidence-not-current');
    expect(reverifyRows().slice(revokedAt)).toEqual([]);
  },
);

it('refuses the grant on a roadmap that is not cross-project', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  const refused = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/reverification`,
    headers: mutationHeaders(state),
    payload: { expectedVersion: storedRoadmap(state).version, enabled: true },
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.message).toBe(
    'Automatic re-verification is set on a cross-project roadmap.',
  );
  expect(storedRoadmap(state).reverificationGrant).toBeUndefined();
  const extra = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/reverification`,
    headers: mutationHeaders(state),
    payload: { expectedVersion: storedRoadmap(state).version, enabled: true, settleMinutes: 1 },
  });
  expect(extra.statusCode).toBe(400);
});
