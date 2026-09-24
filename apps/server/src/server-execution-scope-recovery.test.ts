import { readFileSync } from 'node:fs';
import type { ExecutionScope } from '@craftingtable/domain';
import { openCraftingTableStorage } from '@craftingtable/storage';
import { afterEach, expect } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  adoptSupervisedMap,
  branchCommand,
  cleanupExecutionFixtures,
  commitFile,
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

itNeedsCargo.each([
  'accepted',
  'accepted-after-pause',
  'questions',
  'unchanged',
  'exhausted',
  'ambiguous',
] as const)('bounded roadmap scope recovery: %s', { timeout: 45000 }, async (outcome) => {
  const f = await supervisedMapFixture(false, 'automatic', false, false, outcome !== 'ambiguous');
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  const normal = f.backend.replyForRequest!;
  let parentReviews = 0;
  let repairs = 0;
  const reportWith = (scope: ExecutionScope, findings: readonly unknown[], questions = 'none') =>
    '## Open questions\n' +
    questions +
    '\n\n## Review report\n' +
    scopeReport(state, scope)
      .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
      .replaceAll(
        'mergeable',
        findings.some((f) => (f as { status: string }).status === 'open')
          ? 'changes-requested'
          : 'mergeable',
      );
  f.backend.replyForRequest = (request) => {
    const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    const scope = tree.executionScope!;
    if (scope.kind === 'parent-acceptance') {
      parentReviews++;
      runScopedFixtureCheck(request);
      const defect = {
        ...structuredFinding,
        id: 'F003',
        severity: 'major',
        title: 'Complete semantic coverage',
        explanation:
          outcome === 'unchanged'
            ? 'The same missing behavior remains.'
            : `Prior corrections verified; missing family ${parentReviews}.`,
      };
      const finished = outcome.startsWith('accepted') && parentReviews >= 3;
      return {
        resultText: reportWith(
          scope,
          finished
            ? [{ ...defect, status: 'resolved', disposition: 'Verified all families.' }]
            : [defect],
          outcome === 'questions' && parentReviews > 1
            ? 'Which authority should own this behavior?'
            : 'none',
        ),
      };
    }
    const packetPath = /`([^`]+\/craftingtable-scope-repair\.json)`/.exec(request.prompt)?.[1];
    if (packetPath) {
      expect(scope.kind).toBe('slice');
      expect(request.prompt).toContain('audit that family systematically');
      if (request.model !== 'review-model') {
        repairs++;
        commitFile(request.cwd, `repair-${repairs}.txt`, `Corrected family ${repairs}`);
        return {
          ...implementationDone,
          backgroundWorkPending: outcome === 'accepted-after-pause' && repairs === 1,
        };
      }
      runScopedFixtureCheck(request);
      const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
      const findings = packet.sources
        .flatMap((s: { findings: (typeof structuredFinding)[] }) => s.findings)
        .map((finding: typeof structuredFinding) => ({
          id: finding.id,
          title: finding.title,
          severity: finding.severity,
          explanation: finding.explanation,
          recommendation: finding.recommendation,
          status: 'resolved',
          disposition: 'Verified the committed correction.',
        }));
      return { resultText: reportWith(scope, findings) };
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
    'initial parent finding',
    15000,
  );
  await roadmapControl(state, 'pause');
  const prior = storedRoadmap(state);
  const policyPath = `/api/workspaces/${ws}/roadmaps/${roadmapId}/scope-recovery`;
  const input = {
    expectedVersion: prior.version,
    enabled: true,
    maxRoundsPerParent: outcome === 'exhausted' ? 1 : 3,
  };
  expect(
    (
      await state.context.app.inject({
        method: 'POST',
        url: policyPath,
        headers: { cookie: state.cookie },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await state.context.app.inject({
        method: 'POST',
        url: policyPath,
        headers: mutationHeaders(state),
        payload: { ...input, expectedVersion: input.expectedVersion - 1 },
      })
    ).statusCode,
  ).toBe(409);
  const saved = await state.context.app.inject({
    method: 'POST',
    url: policyPath,
    headers: mutationHeaders(state),
    payload: input,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(storedRoadmap(state).definition).toEqual(prior.definition);
  expect(parentReviews).toBe(1);
  const stoppedParent = tx.execution.cycles
    .listForWorkspace(ws)
    .find((c) => c.executionScope?.kind === 'parent-acceptance')!;
  const assessment = tx.execution.runEvents.latestOfKind(
    ws,
    stoppedParent.currentRunId,
    'turn-completed',
  );
  expect(
    assessment?.kind === 'turn-completed' && assessment.payload.reviewReport?.status,
    JSON.stringify(assessment?.payload),
  ).toBe('complete');
  await roadmapControl(state, 'resume');
  if (outcome === 'accepted-after-pause') {
    await waitFor(
      () =>
        storedRoadmap(state).attempts.some((a) => {
          const cycle = tx.execution.cycles.find(ws, a.cycleId);
          return (
            a.recovery &&
            cycle &&
            tx.execution.runs.find(ws, cycle.currentRunId)?.status === 'waiting'
          );
        }),
      'repair completed turn awaiting session close',
      10000,
    );
    await roadmapControl(state, 'pause');
    const round = storedRoadmap(state).attempts.find((a) => a.recovery)!;
    const cycle = tx.execution.cycles.find(ws, round.cycleId)!;
    f.backend.sessions.at(-1)!.backgroundWorkPending = false;
    expect((await branchCommand(state, `runs/${cycle.currentRunId}/end`, {})).statusCode).toBe(200);
    await waitFor(
      () => tx.execution.runs.find(ws, cycle.currentRunId)?.status === 'finished',
      'repair session finished',
    );
    expect(state.context.services.agentRunService.recoverInterrupted()).toBe(0);
    state.context.services.workCycleService.recoverInterrupted();
    state.context.services.roadmapService.recoverInterrupted();
    expect(storedRoadmap(state).status).toBe('paused');
    expect(storedRoadmap(state).attempts.filter((a) => a.recovery)).toEqual([round]);
    await roadmapControl(state, 'resume');
  }
  if (outcome.startsWith('accepted')) {
    await waitFor(
      () => tx.planning.workItems.find(ws, state.workItemId)?.status === 'completed',
      'automatic recovered parent acceptance',
      22000,
    );
    await waitFor(
      () =>
        storedRoadmap(state)
          .attempts.filter((a) => a.recovery)
          .every((a) => a.recovery!.phase === 'completed'),
      'rounds completed',
    );
    expect(repairs).toBe(2); // Repeated F003 with new evidence is real progress, not ID-based stagnation.
    expect(parentReviews).toBe(3);
  } else {
    await waitFor(
      () =>
        Object.values(storedRoadmap(state).entryHolds ?? {}).some((h) =>
          h.reason.includes(
            outcome === 'questions'
              ? 'resolve questions'
              : outcome === 'unchanged'
                ? 'same substantive findings'
                : outcome === 'exhausted'
                  ? 'allowance exhausted'
                  : 'ambiguous',
          ),
        ),
      'bounded recovery stopping reason',
      22000,
    );
    expect(repairs).toBe(outcome === 'ambiguous' ? 0 : 1);
    expect(tx.planning.workItems.find(ws, state.workItemId)?.status).not.toBe('completed');
  }
  const rounds = storedRoadmap(state).attempts.filter((a) => a.recovery);
  for (const round of rounds) {
    expect(tx.execution.worktrees.find(ws, round.worktreeId)?.mergedAt).toBeTruthy();
    expect(tx.execution.merges.latest(ws, round.worktreeId)?.roadmapId).toBe(roadmapId);
    expect(round.definitionRevision).toBe(prior.definition.revision);
  }
  const reopened = openCraftingTableStorage(tx.databasePath);
  try {
    expect(reopened.roadmaps.find(ws, roadmapId)?.attempts).toEqual(storedRoadmap(state).attempts);
  } finally {
    reopened.close();
  }
  expect(
    rounds.every(
      (a) => tx.execution.worktrees.find(ws, a.worktreeId)?.integrationBranch !== 'main',
    ),
  ).toBe(true);
});
