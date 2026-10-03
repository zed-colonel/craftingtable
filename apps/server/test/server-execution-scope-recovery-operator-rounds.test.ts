import { readFileSync } from 'node:fs';
import { type ExecutionScope, roadmapAttention } from '@craftingtable/domain';
import { afterEach, expect } from 'vitest';
import { openDaemonStorage } from '../src/persisted-records.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  commitFile,
  git,
  implementationDone,
  itNeedsCargo,
  mutationHeaders,
  roadmapControl,
  roadmapId,
  runScopedFixtureCheck,
  scopeReport,
  storedRoadmap,
  structuredFinding,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

itNeedsCargo.each(['requested', 'adopted', 'adopted while running'] as const)(
  'carries an operator repair round through with automatic recovery off: %s',
  async (origin) => {
    const f = await supervisedMapFixture(false, 'automatic', false, false, true);
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    const normal = f.backend.replyForRequest!;
    let parentReviews = 0;
    const reportWith = (scope: ExecutionScope, findings: readonly unknown[]) =>
      '## Open questions\nnone\n\n## Review report\n' +
      scopeReport(state, scope)
        .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
        .replaceAll(
          'mergeable',
          findings.some((f) => (f as { status: string }).status === 'open')
            ? 'changes-requested'
            : 'mergeable',
        );
    const defect = { ...structuredFinding, id: 'F003', severity: 'major' };
    f.backend.replyForRequest = async (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      const scope = tree.executionScope!;
      if (scope.kind === 'parent-acceptance') {
        parentReviews++;
        await runScopedFixtureCheck(request);
        return {
          resultText: reportWith(
            scope,
            parentReviews > 1
              ? [{ ...defect, status: 'resolved', disposition: 'Verified the repair.' }]
              : [defect],
          ),
        };
      }
      const packetPath = /`([^`]+\/craftingtable-scope-repair\.json)`/.exec(request.prompt)?.[1];
      if (packetPath) {
        if (request.model !== 'review-model') {
          expect(request.prompt).toContain('Repair the missing family.');
          commitFile(request.cwd, 'repair.txt', 'Corrected the family');
          return implementationDone;
        }
        await runScopedFixtureCheck(request);
        const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
        return {
          resultText: reportWith(
            scope,
            packet.sources
              .flatMap((s: { findings: (typeof structuredFinding)[] }) => s.findings)
              .map((finding: typeof structuredFinding) => ({
                id: finding.id,
                title: finding.title,
                severity: finding.severity,
                explanation: finding.explanation,
                recommendation: finding.recommendation,
                status: 'resolved',
                disposition: 'Verified the committed correction.',
              })),
          ),
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
    expect(storedRoadmap(state).scopeRecovery?.enabled ?? false).toBe(false);
    const parent = tx.execution.cycles
      .listForWorkspace(ws)
      .find((c) => c.executionScope?.kind === 'parent-acceptance')!;
    const sourceEntryId = storedRoadmap(state).attempts.find(
      (a) => a.cycleId === parent.id,
    )!.entryId;
    // The live shape: the stopped review holds its entry for the operator.
    // biome-ignore lint/complexity/useLiteralKeys: a private member the test drives directly.
    state.context.services.roadmapService['change'](storedRoadmap(state), {
      entryHolds: {
        [sourceEntryId]: {
          status: 'needs-attention',
          reason: 'Recovery needs your input.',
          attention: roadmapAttention('entry-preparation-failed', { entryId: sourceEntryId }),
        },
      },
    });
    const preview = state.context.services.workCycleService.previewScopeRepair(
      f.auth,
      ws,
      parent.id,
    );
    const input = {
      expectedVersion: parent.version,
      snapshotDigest: preview.snapshotDigest,
      sourceId: preview.candidates[0]!.scope.sourceId,
      instructions: 'Repair the missing family.',
      maxRemediationRounds: 2,
    };
    let repairId: string;
    if (origin === 'requested') {
      const response = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
        headers: mutationHeaders(state),
        payload: input,
      });
      expect(response.statusCode, response.body).toBe(200);
      repairId = response.json().cycle.id;
    } else {
      // A repair delegated before rounds kept their roadmap: no owner.
      const paused = origin === 'adopted';
      if (paused) await roadmapControl(state, 'pause');
      const unowned = await state.context.services.workCycleService.delegateScopeRepair(
        f.auth,
        ws,
        parent.id,
        input,
      );
      expect(unowned.owner).toBeNull();
      repairId = unowned.id;
      // Adopted on the next pass, while paused (the pause still holds it) or running.
      await state.context.services.roadmapService.tick();
      expect(tx.execution.cycles.find(ws, repairId)?.owner).toBeTruthy();
      if (paused) await roadmapControl(state, 'resume');
    }
    // The repair answers the stopped review, so its needs-attention hold is released.
    expect(storedRoadmap(state).entryHolds?.[sourceEntryId]?.status).not.toBe('needs-attention');
    const round = storedRoadmap(state).attempts.find((a) => a.cycleId === repairId)!;
    expect(round.recovery).toMatchObject({
      requestedByUserId: state.userId,
      sourceEntryId,
    });
    expect(tx.execution.cycles.find(ws, repairId)?.owner).toMatchObject({
      roadmapId,
      attemptId: round.id,
    });
    await waitFor(
      () => tx.planning.workItems.find(ws, state.workItemId)?.status === 'completed',
      'roadmap-carried parent acceptance',
    );
    await waitFor(
      () =>
        storedRoadmap(state).attempts.find((a) => a.id === round.id)!.recovery!.phase ===
        'completed',
      'round completed',
    );
    expect(tx.execution.merges.latest(ws, round.worktreeId)?.roadmapId).toBe(roadmapId);
    expect(parentReviews).toBe(2);
    // The roadmap merged the round's repair itself, so it never asked the operator to.
    expect(
      tx.attention
        .recent(ws, 500)
        .filter(
          (item) => item.subjectKey === `cycle:${repairId}` && item.code === 'merge-approval',
        ),
    ).toEqual([]);
    const reopened = openDaemonStorage(tx.databasePath);
    try {
      expect(
        reopened.roadmaps.find(ws, roadmapId)?.attempts.find((a) => a.id === round.id)?.recovery
          ?.requestedByUserId,
      ).toBe(state.userId);
      expect(reopened.execution.cycles.find(ws, repairId)?.owner?.attemptId).toBe(round.id);
    } finally {
      reopened.close();
    }
  },
);

itNeedsCargo(
  'refreshes an operator repair round from integration before its review (R-C4 with 18f0bb8)',
  async () => {
    const f = await supervisedMapFixture(false, 'automatic', false, false, true);
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    const normal = f.backend.replyForRequest!;
    const defect = { ...structuredFinding, id: 'F003', severity: 'major' };
    let advancedTo: string | undefined;
    f.backend.replyForRequest = async (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      const scope = tree.executionScope!;
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
      const packetPath = /`([^`]+\/craftingtable-scope-repair\.json)`/.exec(request.prompt)?.[1];
      if (packetPath && request.model !== 'review-model') {
        commitFile(request.cwd, 'repair.txt', 'Corrected the family');
        // Another slice merges into the repair's integration branch meanwhile.
        const repo = tx.execution.sourceRepositories.find(ws, tree.repositoryId)!;
        const branch = tree.integrationBranch!;
        const tip = git(['rev-parse', branch], repo.rootPath).trim();
        const treeSha = git(['rev-parse', `${tip}^{tree}`], repo.rootPath).trim();
        advancedTo = git(
          ['commit-tree', treeSha, '-p', tip, '-m', 'another slice merged'],
          repo.rootPath,
        ).trim();
        git(['update-ref', `refs/heads/${branch}`, advancedTo, tip], repo.rootPath);
        return implementationDone;
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
    // Automatic recovery is off: the round exists only because the operator requested it.
    expect(storedRoadmap(state).scopeRecovery?.enabled ?? false).toBe(false);
    const parent = tx.execution.cycles
      .listForWorkspace(ws)
      .find((c) => c.executionScope?.kind === 'parent-acceptance')!;
    const preview = state.context.services.workCycleService.previewScopeRepair(
      f.auth,
      ws,
      parent.id,
    );
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${parent.id}/scope-repair`,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: parent.version,
        snapshotDigest: preview.snapshotDigest,
        sourceId: preview.candidates[0]!.scope.sourceId,
        instructions: 'Repair the missing family.',
        maxRemediationRounds: 2,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const repairId = response.json().cycle.id;
    await waitFor(() => {
      const c = tx.execution.cycles.find(ws, repairId);
      return !!advancedTo && !!c && c.status !== 'running' && c.step === 'review';
    }, 'repair review settles');
    const repair = tx.execution.cycles.find(ws, repairId)!;
    expect(repair.reason ?? '').not.toContain('Integration branch advanced');
    expect(repair.integrationRefreshes ?? 0).toBe(1);
  },
);
