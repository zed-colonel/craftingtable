import { readFileSync } from 'node:fs';
import { workCycleResponseSchema } from '@craftingtable/contracts';
import type { ExecutionScope, WorkCycle } from '@craftingtable/domain';
import { openCraftingTableStorage } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { latestReviewReport } from './services/run-handoff.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  commitFile,
  currentCycle,
  git,
  implementationDone,
  merge,
  mutationHeaders,
  recordScope,
  roadmapControl,
  runScopedFixtureCheck,
  scopeReport,
  stepDaemons,
  storedRoadmap,
  structuredFinding,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

it.each([false, true])(
  'delegates independent findings into an editable slice and enforces every source ID (omitted: %s)',
  {
    timeout: 40000,
  },
  async (omitFinding) => {
    const f = await supervisedMapFixture(false, 'manual');
    const { state } = f,
      ws = state.workspaceId,
      tx = state.context.storage;
    const normal = f.backend.replyForRequest!;
    const parentFinding = { ...structuredFinding, id: 'F-003', title: 'Semantic ledger ownership' };
    const verifyFinding = {
      ...structuredFinding,
      id: 'F-003',
      title: 'Contribution branch guidance',
    };
    const reportWith = (scope: ExecutionScope, findings: readonly unknown[], open = true) =>
      '## Open questions\nnone\n\n## Review report\n' +
      scopeReport(state, scope)
        .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
        .replaceAll('mergeable', open ? 'changes-requested' : 'mergeable');
    f.backend.replyForRequest = (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      if (tree.executionScope?.kind === 'parent-acceptance') {
        runScopedFixtureCheck(request);
        return { resultText: reportWith(tree.executionScope, [parentFinding]) };
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
      15000,
    );
    await roadmapControl(state, 'pause');
    const parent = tx.execution.cycles
      .listForWorkspace(ws)
      .find((c) => c.executionScope?.kind === 'parent-acceptance')!;
    const notifications = state.context.services.notificationService;
    const { DEFAULT_NOTIFICATION_PREFERENCES } = await import('@craftingtable/domain');
    notifications.save(f.auth, ws, {
      expectedVersion: 0,
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
      applicationToken: 'a'.repeat(30),
      userKey: 'u'.repeat(30),
    });
    await notifications.tick();
    expect(
      tx.notifications
        .records(ws)
        .some((n) => n.sourceKey.startsWith(`cycle:${parent.id}:`) && n.state === 'active'),
    ).toBe(true);
    const verification = tx.execution.cycles
      .listForWorkspace(ws)
      .find((c) => c.executionScope?.kind === 'slice-verification')!;
    const originalOwner = tx.execution.cycles
      .listForWorkspace(ws)
      .find(
        (c) =>
          c.executionScope?.kind === 'slice' &&
          c.executionScope.sourceId === verification.executionScope?.sourceId,
      )!;
    const reviewTree = tx.execution.worktrees.find(ws, verification.worktreeId)!;
    const originalHead = git(['rev-parse', 'HEAD'], reviewTree.path).trim();
    const command = (cycle: WorkCycle, action: 'resume' | 'review-again') =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload: {
          action,
          expectedVersion: currentCycle(state, cycle).version,
          instructions: 'Keep the adopted policy and the original gate.',
        },
      });
    f.backend.replyForRequest = (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      runScopedFixtureCheck(request);
      return { resultText: reportWith(tree.executionScope!, [verifyFinding]) };
    };
    expect((await command(verification, 'review-again')).statusCode).toBe(200);
    await waitFor(
      () => currentCycle(state, verification).status === 'needs-attention',
      'verification finding',
    );
    const latestVerification = currentCycle(state, verification);
    // Resuming without guidance would review the unchanged snapshot again (R-A7, 10dbc912).
    const repeat = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/cycles/${verification.id}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'resume', expectedVersion: latestVerification.version },
    });
    expect(repeat.statusCode, repeat.body).toBe(409);
    expect(repeat.body).toContain('has not changed since this review');
    expect(currentCycle(state, verification).version).toBe(latestVerification.version);
    const { scopeRecoveryDecision } = await import('./services/scope-recovery-policy.js');
    const roadmap = storedRoadmap(state);
    const verificationEntry = roadmap.definition.entries.find(
      (e) =>
        e.executionScope?.kind === 'slice-verification' &&
        e.executionScope.sourceId === verification.executionScope!.sourceId,
    )!;
    expect(
      scopeRecoveryDecision(
        tx,
        {
          ...roadmap,
          scopeRecovery: {
            enabled: true,
            maxRoundsPerParent: 3,
            grantedAt: new Date().toISOString(),
            grantedByUserId: state.userId,
          },
        },
        verificationEntry,
        latestVerification,
      ).reason,
    ).toContain('ambiguous');
    const path = `/api/workspaces/${ws}/cycles/${verification.id}/scope-repair`;
    const response = await state.context.app.inject({
      method: 'GET',
      url: path,
      headers: { cookie: state.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { scopeRepairPreviewSchema } = await import('@craftingtable/contracts');
    const preview = scopeRepairPreviewSchema.parse(response.json());
    expect(preview.sources).toHaveLength(2);
    expect(preview.sources.flatMap((s) => s.findings.map((f) => f.id)).sort()).toEqual([
      'R1.F-003',
      'R2.F-003',
    ]);
    expect(preview.sources.flatMap((s) => s.findings.map((f) => f.title))).toEqual(
      expect.arrayContaining([parentFinding.title, verifyFinding.title]),
    );
    const input = {
      expectedVersion: latestVerification.version,
      snapshotDigest: preview.snapshotDigest,
      sourceId: verification.executionScope!.sourceId,
      instructions: 'Repair both distinct findings; preserve runtime behavior.',
      maxRemediationRounds: 2,
    };
    const delegate = (payload = input, headers = mutationHeaders(state)) =>
      state.context.app.inject({ method: 'POST', url: path, headers, payload });
    expect((await delegate(input, { cookie: state.cookie })).statusCode).toBe(403);
    expect((await delegate({ ...input, snapshotDigest: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await delegate({ ...input, sourceId: 'foreign-slice' })).statusCode).toBe(409);
    let packet:
      | {
          sources: {
            runId: string;
            findings: (typeof structuredFinding)[];
            finalMessage: string;
          }[];
        }
      | undefined;
    f.backend.replyForRequest = (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      const file = /`([^`]+\/craftingtable-scope-repair\.json)`/.exec(request.prompt)?.[1];
      expect(file, request.prompt).toBeTruthy();
      packet = JSON.parse(readFileSync(file!, 'utf8'));
      expect(packet!.sources).toHaveLength(2);
      expect(packet!.sources.every((s) => s.finalMessage.includes('F-003'))).toBe(true);
      expect(request.prompt).toContain('Repair both distinct findings');
      if (request.model !== 'review-model') {
        expect(request.model).toBe('remediate-model');
        commitFile(request.cwd, 'recovery.txt', 'Fixed both ledger and contribution guidance');
        return implementationDone;
      }
      runScopedFixtureCheck(request);
      const findings = packet!.sources
        .flatMap((s) => s.findings)
        .map((finding) => ({
          id: finding.id,
          title: finding.title,
          severity: finding.severity,
          explanation: finding.explanation,
          recommendation: finding.recommendation,
          status: 'resolved',
          disposition: 'Inspected the committed correction and regression evidence.',
        }));
      return {
        resultText: reportWith(
          tree.executionScope!,
          omitFinding ? findings.slice(1) : findings,
          false,
        ),
      };
    };
    const started = await delegate();
    expect(started.statusCode, started.body).toBe(200);
    const repair = workCycleResponseSchema.parse(started.json()).cycle;
    expect(repair).toMatchObject({
      step: 'remediate',
      remediationRounds: 0,
      profiles: originalOwner.profiles,
      executionScope: originalOwner.executionScope,
      policy: { maxRemediationRounds: 2 },
      scopeRepair: { sourceCycleId: verification.id },
    });
    expect(repair.parentRunId).toBeUndefined();
    expect(repair.scopeRepair?.sources).toEqual(
      preview.sources.map((s) => ({ runId: s.runId, sequence: s.sequence, label: s.label })),
    );
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(ws, repair.id)?.scopeRepair).toEqual(
        repair.scopeRepair,
      );
    } finally {
      reopened.close();
    }
    expect(repair.worktreeId).not.toBe(originalOwner.worktreeId);
    expect(repair.worktreeId).not.toBe(reviewTree.id);
    expect(git(['rev-parse', 'HEAD'], reviewTree.path).trim()).toBe(originalHead);
    const duplicate = await delegate();
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    const blockedReview = await command(verification, 'resume');
    expect(blockedReview.statusCode, blockedReview.body).toBe(409);
    expect(blockedReview.body).toContain('active owning-slice');
    const projected = state.context.services.workCycleService.list(f.auth, ws);
    expect(projected.find((c) => c.id === parent.id)?.scopeReviewWait).toContain(
      'Waiting for prerequisite work',
    );
    expect(projected.find((c) => c.id === verification.id)?.scopeReviewWait).toContain(
      'active owning-slice',
    );
    expect(tx.execution.cycles.find(ws, parent.id)?.reason).toBe(parent.reason);
    await stepDaemons();
    await notifications.tick();
    expect(
      tx.notifications
        .records(ws)
        .filter((n) => n.sourceKey.startsWith(`cycle:${parent.id}:`))
        .every((n) => n.state === 'resolved'),
    ).toBe(true);
    await waitFor(() => currentCycle(state, repair).status !== 'running', 'source repair review');
    expect(packet).toBeDefined();
    if (omitFinding) {
      expect(currentCycle(state, repair).status).toBe('needs-attention');
      const report = latestReviewReport(
        tx.execution,
        tx.execution.runs.find(ws, currentCycle(state, repair).currentRunId)!,
      );
      expect(report).toMatchObject({ status: 'invalid' });
      expect((await merge(state, repair.worktreeId)).statusCode).toBe(409);
      return;
    }
    expect(currentCycle(state, repair).status, currentCycle(state, repair).reason).toBe(
      'awaiting-merge',
    );
    const repairedTree = tx.execution.worktrees.find(ws, repair.worktreeId)!;
    const merged = await merge(state, repair.worktreeId);
    expect(merged.statusCode, merged.body).toBe(200);
    expect(storedRoadmap(state).status).toBe('paused');
    expect(tx.execution.cycles.find(ws, originalOwner.id)).toEqual(originalOwner);
    expect(git(['rev-parse', 'HEAD'], reviewTree.path).trim()).toBe(originalHead);
    const integrationHead = git(['rev-parse', 'revision'], f.root).trim();
    expect(integrationHead).not.toBe(originalHead);
    expect((await command(parent, 'resume')).statusCode).toBe(409);
    f.backend.replyForRequest = (request) => {
      const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
      runScopedFixtureCheck(request);
      const finding =
        tree.executionScope?.kind === 'parent-acceptance' ? parentFinding : verifyFinding;
      return {
        resultText: reportWith(
          tree.executionScope!,
          [
            {
              ...finding,
              status: 'resolved',
              disposition: 'Verified fixes in the refreshed integration snapshot.',
            },
          ],
          false,
        ),
      };
    };
    // Existing snapshot resumption must refresh even while the roadmap is paused.
    const resumed = await command(verification, 'resume');
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(git(['rev-parse', 'HEAD'], reviewTree.path).trim()).toBe(integrationHead);
    await waitFor(
      () => currentCycle(state, verification).status !== 'running',
      'fresh verification',
    );
    expect(currentCycle(state, verification).status, currentCycle(state, verification).reason).toBe(
      'awaiting-merge',
    );
    const recorded = await recordScope(f, reviewTree);
    expect(recorded.statusCode, recorded.body).toBe(200);
    // Refresh sibling verification too: integration moved, and the parent gate must stay exact.
    for (const sibling of tx.execution.cycles
      .listForWorkspace(ws)
      .filter((c) => c.executionScope?.kind === 'slice-verification' && c.id !== verification.id)) {
      const result = await command(
        sibling,
        sibling.status === 'completed' ? 'review-again' : 'resume',
      );
      expect(result.statusCode, result.body).toBe(200);
      await waitFor(
        () => currentCycle(state, sibling).status !== 'running',
        'sibling verification',
      );
      const receipt = await recordScope(f, tx.execution.worktrees.find(ws, sibling.worktreeId)!);
      expect(receipt.statusCode, receipt.body).toBe(200);
    }
    const parentResume = await command(parent, 'resume');
    expect(parentResume.statusCode, parentResume.body).toBe(200);
    const parentTree = tx.execution.worktrees.find(ws, parent.worktreeId)!;
    expect(git(['rev-parse', 'HEAD'], parentTree.path).trim()).toBe(integrationHead);
    await waitFor(() => currentCycle(state, parent).status !== 'running', 'parent re-review');
    const accepted = await recordScope(f, parentTree);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(tx.planning.workItems.find(ws, state.workItemId)?.status).toBe('completed');
    expect(storedRoadmap(state).status).toBe('paused');
    expect(repairedTree.executionScope?.kind).toBe('slice');
  },
);
