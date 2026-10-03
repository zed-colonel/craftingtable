import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { asAgentRunId, type ExecutionScope } from '@craftingtable/domain';
import { afterEach, expect } from 'vitest';
import { openDaemonStorage } from './persisted-records.js';

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

/**
 * The outcomes of one bounded roadmap scope recovery (R-C5). The test files
 * `server-execution-scope-recovery-*.test.ts` each run a group of them; they shared one
 * `it.each` until TS-M13 split that file, the suite's critical path.
 */
export type ScopeRecoveryOutcome =
  | 'accepted'
  | 'accepted-after-pause'
  | 'questions'
  | 'unchanged'
  | 'stalled'
  | 'exhausted'
  | 'ambiguous'
  | 'passing-after-exhausted'
  | 'passing-forever'
  | 'accepted-named-owner'
  | 'split-owners'
  | 'partly-named';

/**
 * Registers a group of outcomes as the tests `bounded roadmap scope recovery: <outcome>`, with
 * the execution fixtures' cleanup after each. Each `server-execution-scope-recovery-*` file
 * that runs outcomes is one call, so the hook, the name and the Cargo condition stay alike.
 */
export function boundedScopeRecoveryTests(outcomes: readonly ScopeRecoveryOutcome[]): void {
  afterEach(cleanupExecutionFixtures);
  itNeedsCargo.each(outcomes)('bounded roadmap scope recovery: %s', async (outcome) => {
    await boundedScopeRecovery(outcome);
  });
}

/** Drives a supervised map to its first parent finding, enables recovery and runs it to `outcome`. */
export async function boundedScopeRecovery(outcome: ScopeRecoveryOutcome): Promise<void> {
  const f = await supervisedMapFixture(
    false,
    'automatic',
    false,
    false,
    !['ambiguous', 'accepted-named-owner', 'split-owners', 'partly-named'].includes(outcome),
  );
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  const normal = f.backend.replyForRequest!;
  let parentPrompt = '';
  let parentReviews = 0;
  let repairs = 0;
  const reportWith = (
    scope: ExecutionScope,
    findings: readonly unknown[],
    questions = 'none',
    passing = false,
  ) =>
    '## Open questions\n' +
    questions +
    '\n\n## Review report\n' +
    scopeReport(state, scope)
      .replace('"findings":[]', `"findings":${JSON.stringify(findings)}`)
      .replaceAll(
        'mergeable',
        !passing && findings.some((f) => (f as { status: string }).status === 'open')
          ? 'changes-requested'
          : 'mergeable',
      );
  f.backend.replyForRequest = async (request) => {
    const tree = tx.execution.worktrees.listActive(ws).find((t) => t.path === request.cwd)!;
    const scope = tree.executionScope!;
    if (scope.kind === 'parent-acceptance') {
      parentReviews++;
      parentPrompt = request.prompt;
      await runScopedFixtureCheck(request);
      const defect = {
        ...structuredFinding,
        ...(outcome === 'accepted-named-owner' ? { owningSlice: f.scopes[1]!.sourceId } : {}),
        id: 'F003',
        severity: 'major',
        title: 'Complete semantic coverage',
        explanation:
          outcome === 'unchanged'
            ? 'The same missing behavior remains.'
            : `Prior corrections verified; missing family ${parentReviews}.`,
      };
      const finished =
        (outcome.startsWith('accepted') || outcome === 'passing-after-exhausted') &&
        parentReviews >= 3;
      // The second parent review passes its exit gate with one minor finding left.
      const passing =
        (outcome === 'passing-after-exhausted' && parentReviews === 2) ||
        (outcome === 'passing-forever' && parentReviews >= 2);
      return {
        resultText: reportWith(
          scope,
          finished
            ? [{ ...defect, status: 'resolved', disposition: 'Verified all families.' }]
            : outcome === 'split-owners' || outcome === 'partly-named'
              ? [
                  { ...defect, owningSlice: f.scopes[0]!.sourceId },
                  {
                    ...defect,
                    id: 'F004',
                    title: 'Other family',
                    owningSlice: outcome === 'split-owners' ? f.scopes[1]!.sourceId : null,
                  },
                ]
              : [passing ? { ...defect, severity: 'minor' } : defect],
          outcome === 'questions' && parentReviews > 1
            ? 'Which authority should own this behavior?'
            : 'none',
          passing,
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
      await runScopedFixtureCheck(request);
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
  );
  await roadmapControl(state, 'pause');
  const prior = storedRoadmap(state);
  const policyPath = `/api/workspaces/${ws}/roadmaps/${roadmapId}/scope-recovery`;
  const input = {
    expectedVersion: prior.version,
    enabled: true,
    maxRoundsPerParent: ['exhausted', 'passing-after-exhausted', 'passing-forever'].includes(
      outcome,
    )
      ? 1
      : 3,
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
  if (outcome.startsWith('accepted') || outcome === 'passing-after-exhausted') {
    await waitFor(
      () => tx.planning.workItems.find(ws, state.workItemId)?.status === 'completed',
      'automatic recovered parent acceptance',
    );
    await waitFor(
      () =>
        storedRoadmap(state)
          .attempts.filter((a) => a.recovery)
          .every((a) => a.recovery!.phase === 'completed'),
      'rounds completed',
    );
    // One round that leaves F003 open with new evidence is not yet a stall (R-C5 increment 4).
    expect(repairs).toBe(2);
    expect(parentReviews).toBe(3);
    if (outcome === 'accepted-named-owner') {
      // Every round went to the slice the parent review named.
      const owned = storedRoadmap(state)
        .attempts.filter((a) => a.recovery)
        .map(
          (a) =>
            storedRoadmap(state).definition.entries.find((e) => e.id === a.entryId)?.executionScope
              ?.sourceId,
        );
      expect(owned).toEqual([f.scopes[1]!.sourceId, f.scopes[1]!.sourceId]);
      // And the parent reviewer was asked to name it, among the parent's required slices.
      expect(parentPrompt).toContain('set "owningSlice" in the craftingtable-review report');
      expect(parentPrompt).toContain(f.scopes[1]!.sourceId);
    }
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
                  : outcome === 'passing-forever'
                    ? 'lifetime ceiling'
                    : outcome === 'stalled'
                      ? 'without progress'
                      : 'ambiguous',
          ),
        ),
      'bounded recovery stopping reason',
    );
    expect(repairs).toBe(
      ['ambiguous', 'split-owners', 'partly-named'].includes(outcome)
        ? 0
        : outcome === 'stalled'
          ? 2
          : outcome === 'passing-forever'
            ? 3
            : 1,
    );
    // Automatic recovery that stops converging is one typed escalation with its progress
    // (R-C5 increment 4); other refusals keep their own stop.
    const [heldEntryId, hold] = Object.entries(storedRoadmap(state).entryHolds ?? {})[0]!;
    if (outcome === 'passing-forever') expect(hold.attention?.code).toBe('recovery-not-converging');
    else if (['unchanged', 'stalled', 'exhausted'].includes(outcome)) {
      expect(hold.attention?.code).toBe('recovery-not-converging');
      expect(hold.reason).toContain('F003 (major)');
      // One inbox item: the stopped review's own, saying why recovery stopped (increment 5).
      state.context.services.roadmapService.syncAttention(true);
      const review = storedRoadmap(state).attempts.find((a) => a.entryId === heldEntryId)!;
      expect(
        tx.attention
          .open(ws)
          .filter((i) => i.refs.entryId === heldEntryId || i.subjectKey.includes(heldEntryId))
          .map((i) => [i.subjectKey, i.code]),
      ).toEqual([[`cycle:${review.cycleId}`, 'recovery-not-converging']]);
      // Resuming would only stop again: the rounds have not changed.
      const resumed = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/control`,
        headers: mutationHeaders(state),
        payload: {
          action: 'resume',
          entryId: heldEntryId,
          expectedVersion: storedRoadmap(state).version,
        },
      });
      expect(resumed.statusCode, resumed.body).toBe(409);
      expect(storedRoadmap(state).entryHolds?.[heldEntryId]).toEqual(hold);
      // The ways forward come before the rounds, so a long summary cannot cut them off.
      expect(hold.reason.indexOf('Delegate source fixes')).toBeLessThan(
        hold.reason.indexOf('Round 1'),
      );
      // Pausing the item first does not open a way around the refusal (R-C5 review).
      const entryControl = async (action: 'pause' | 'resume') =>
        state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/control`,
          headers: mutationHeaders(state),
          payload: { action, entryId: heldEntryId, expectedVersion: storedRoadmap(state).version },
        });
      expect((await entryControl('pause')).statusCode).toBe(200);
      const afterPause = await entryControl('resume');
      expect(afterPause.statusCode, afterPause.body).toBe(409);
    } else {
      expect(hold.attention?.code).not.toBe('recovery-not-converging');
      // The stopped review's own item replaces the hold's in the inbox, so it carries the
      // hold's reason, and the status list names it too (LIVE-20).
      state.context.services.roadmapService.syncAttention(true);
      const review = storedRoadmap(state).attempts.find((a) => a.entryId === heldEntryId)!;
      const item = tx.attention.open(ws).find((i) => i.subjectKey === `cycle:${review.cycleId}`);
      expect(item?.message).toContain(hold.reason);
      const status = state.context.services.roadmapService
        .statusOf(storedRoadmap(state))
        .entries.find((e) => e.entryId === heldEntryId);
      expect(status?.waitsOn?.reason).toContain(hold.reason);
      // While a recovery round started from this review is open, its repair's item carries
      // the round's stops, so this item does not repeat a hold (LIVE-20 review).
      const current = storedRoadmap(state);
      const round = {
        ...review,
        id: randomUUID(),
        cycleId: randomUUID(),
        recovery: {
          sourceEntryId: heldEntryId,
          sourceRunId: asAgentRunId('run'),
          sourceSequence: 1,
          findingFingerprint: 'f'.repeat(64),
          phase: 'repair' as const,
          reviewRunIds: {},
        },
      };
      expect(
        tx.roadmaps.save(
          { ...current, version: current.version + 1, attempts: [...current.attempts, round] },
          current.version,
        ),
      ).toBe(true);
      state.context.services.roadmapService.syncAttention(true);
      expect(
        tx.attention.open(ws).find((i) => i.subjectKey === `cycle:${review.cycleId}`)?.message,
      ).not.toContain('The roadmap holds this item');
      // The later checks read the roadmap as the scheduler left it.
      expect(
        tx.roadmaps.save({ ...current, version: current.version + 2 }, current.version + 1),
      ).toBe(true);
    }
    expect(tx.planning.workItems.find(ws, state.workItemId)?.status).not.toBe('completed');
  }
  const rounds = storedRoadmap(state).attempts.filter((a) => a.recovery);
  for (const round of rounds) {
    expect(tx.execution.worktrees.find(ws, round.worktreeId)?.mergedAt).toBeTruthy();
    expect(tx.execution.merges.latest(ws, round.worktreeId)?.roadmapId).toBe(roadmapId);
    expect(round.definitionRevision).toBe(prior.definition.revision);
  }
  const reopened = openDaemonStorage(tx.databasePath);
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
}
