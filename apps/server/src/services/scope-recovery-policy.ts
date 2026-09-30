import { createHash } from 'node:crypto';
import type { Roadmap, RoadmapAttempt, RoadmapEntry, WorkCycle } from '@craftingtable/domain';
import { isTerminalAgentRunStatus, sameExecutionScope } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { finalizationHasNoQuestions } from './finalization-policy.js';
import { classifyRecoveryProgress, type RecoveryRoundReport } from './recovery-progress.js';
import { collectScopeRepair } from './scope-repair.js';
import { resolveScope, scopedReviewIssue } from './execution-scope.js';

/**
 * Whether the roadmap carries this recovery round through its merge, verification and parent
 * review: automatic recovery carries every round, and a round the operator requested is always
 * carried (R-C5 increment 2). Every place that asks whether a round is the roadmap's asks this.
 */
export function roadmapCarriesRound(roadmap: Roadmap, attempt: RoadmapAttempt): boolean {
  return !!roadmap.scopeRecovery?.enabled || !!attempt.recovery?.requestedByUserId;
}

/** What automatic recovery does with a stopped review: wait, refuse, escalate, or start a round. */
export interface ScopeRecoveryDecision {
  readonly waiting?: true;
  /** Why no round starts; display text, never parsed. */
  readonly reason?: string;
  /** Automatic recovery ends here, as a `recovery-not-converging` stop (R-C5 increment 4). */
  readonly escalation?: true;
  readonly preview?: ReturnType<typeof collectScopeRepair>;
  readonly owner?: RoadmapEntry;
  readonly fingerprint?: string;
  readonly sourceSequence?: number;
}

/** Conservative routing: review assertions never choose between multiple owning slices. */
export function scopeRecoveryDecision(
  tx: StorageRepositories,
  roadmap: Roadmap,
  entry: RoadmapEntry,
  cycle: WorkCycle,
): ScopeRecoveryDecision {
  const ws = roadmap.workspaceId;
  const run = tx.execution.runs.find(ws, cycle.currentRunId);
  const turn = run && tx.execution.runEvents.latestOfKind(ws, run.id, 'turn-completed');
  if (run && !isTerminalAgentRunStatus(run.status)) return { waiting: true };
  if (
    run?.status !== 'finished' ||
    turn?.kind !== 'turn-completed' ||
    turn.payload.outcome !== 'success' ||
    turn.payload.truncated ||
    !finalizationHasNoQuestions(turn.payload.resultText) ||
    turn.payload.reviewReport?.status !== 'complete'
  )
    return {
      reason:
        'Recovery needs your input: resolve questions, failed runs or incomplete review reports from the work item.',
    };
  if (!turn.payload.reviewReport.report.findings.some((f) => f.status === 'open'))
    return { reason: 'This review needs manual recovery; it has no actionable open findings.' };
  const tree = tx.execution.worktrees.find(ws, cycle.worktreeId);
  if (!tree || tx.execution.runs.listForWorktree(ws, tree.id)[0]?.id !== run.id)
    return { reason: 'Reconcile the newer manual work before automatic scope recovery.' };
  const issue = scopedReviewIssue(tx, tree, turn.payload.reviewReport);
  if (issue) return { reason: `The independent review needs a complete scope report: ${issue}` };
  if (
    tx.execution.worktrees
      .listForWorkItem(ws, entry.workItemId)
      .some(
        (t) =>
          t.executionScope &&
          t.executionScope.kind !== 'slice' &&
          t.executionScope.definitionId === entry.executionScope?.definitionId &&
          t.executionScope.bindingRevision === entry.executionScope?.bindingRevision &&
          tx.execution.runs
            .listForWorktree(ws, t.id)
            .some((r) => !isTerminalAgentRunStatus(r.status)),
      )
  )
    return { waiting: true };
  const preview = collectScopeRepair(tx, cycle);
  const parent = resolveScope(tx, ws, entry.workItemId, cycle.executionScope!).parent;
  // A parent review names the required slice that owns each open finding (LIVE-27): when they
  // all name one, the round goes there; findings that name none or several stay the operator's.
  const named = [
    ...new Set(
      turn.payload.reviewReport.report.findings
        .filter((f) => f.status === 'open')
        .map((f) => f.owningSlice),
    ),
  ];
  const namedCandidate =
    named.length === 1 && named[0] !== undefined && parent.required_slices.includes(named[0])
      ? preview.candidates.find((c) => c.scope.sourceId === named[0])
      : undefined;
  if (
    !namedCandidate &&
    (preview.candidates.length !== 1 ||
      (preview.sources.some((s) => s.scope.kind === 'parent-acceptance') &&
        parent.required_slices.length !== 1))
  )
    return {
      reason: 'Finding ownership is ambiguous: more than one slice could own it.',
    };
  const candidate = namedCandidate ?? preview.candidates[0]!;
  const owner = roadmap.definition.entries.find(
    (e) =>
      e.workItemId === entry.workItemId && sameExecutionScope(e.executionScope, candidate.scope),
  );
  if (!owner)
    return {
      reason: 'The owning slice is outside this roadmap. Delegate its repair from the work item.',
    };
  if (candidate.cycleId || candidate.worktreeId)
    return {
      reason:
        'An existing slice worktree needs manual recovery before another automatic repair can start.',
    };
  if (candidate.blockers.length) return { reason: candidate.blockers.join(' ') };
  // All pinned source reports must be complete, idle and free of operator questions.
  for (const source of preview.sources) {
    const sourceRun = tx.execution.runs.find(ws, source.runId);
    const sourceTurn = tx.execution.runEvents.latestOfKind(ws, source.runId, 'turn-completed');
    if (
      !sourceRun ||
      !isTerminalAgentRunStatus(sourceRun.status) ||
      sourceTurn?.kind !== 'turn-completed' ||
      sourceTurn.payload.truncated ||
      !finalizationHasNoQuestions(sourceTurn.payload.resultText)
    )
      return {
        reason:
          'A related independent review has unresolved questions. Provide guidance before automatic recovery.',
      };
  }
  const fingerprint = findingFingerprint(turn.payload.reviewReport.report.findings);
  const rounds = roadmap.attempts.filter(
    (a) =>
      a.recovery &&
      roadmap.definition.entries.some(
        (e) => e.id === a.entryId && e.workItemId === entry.workItemId,
      ),
  );
  // How this review's rounds went, judged from each round's pinned source report and the review
  // that just finished; never from the review's finding history (R-C5 increment 3).
  const progress = classifyRecoveryProgress([
    ...rounds
      .filter((a) => a.recovery!.sourceEntryId === entry.id && a.recovery!.sourceRunId !== run.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((a): RecoveryRoundReport[] => {
        const source = tx.execution.runs.find(ws, a.recovery!.sourceRunId);
        const report = tx.execution.runEvents.latestOfKind(
          ws,
          a.recovery!.sourceRunId,
          'turn-completed',
        );
        return source &&
          report?.kind === 'turn-completed' &&
          report.payload.reviewReport?.status === 'complete'
          ? [
              {
                reviewWorktreeId: source.worktreeId,
                fingerprint: a.recovery!.findingFingerprint,
                findings: report.payload.reviewReport.report.findings,
              },
            ]
          : [];
      }),
    { reviewWorktreeId: tree.id, fingerprint, findings: turn.payload.reviewReport.report.findings },
  ]);
  // One typed stop for every way automatic recovery ends here (R-C5 increment 4, ADR-057).
  const escalate = (why: string) => ({
    escalation: true as const,
    reason: `${why} Delegate source fixes with guidance to run a round yourself, or propose a split of the remaining work into a follow-up slice through a planning amendment. ${progress.summary || 'No round has run for this review yet.'}`,
  });
  // Rounds the operator requested do not use the automatic allowance, and it counts only since
  // the work item's last parent review that passed its exit gate with a mergeable verdict: a
  // passing review ends one stretch of repair, and a finding after it starts another (LIVE-28,
  // operator decision 2026-09-30).
  const passed = (report: { verdict: string; exitGate: { met: boolean } } | undefined) =>
    report?.verdict === 'mergeable' && report.exitGate.met;
  const sourceReport = (runId: import('@craftingtable/domain').AgentRunId) => {
    const event = tx.execution.runEvents.latestOfKind(ws, runId, 'turn-completed');
    return event?.kind === 'turn-completed' && event.payload.reviewReport?.status === 'complete'
      ? event.payload.reviewReport.report
      : undefined;
  };
  // Only a parent review ends a stretch, not a passing slice verification (LIVE-28 review).
  const parentReview = (entryId: string) =>
    roadmap.definition.entries.find((e) => e.id === entryId)?.executionScope?.kind ===
    'parent-acceptance';
  const ordered = [...rounds].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const stretch =
    parentReview(entry.id) && passed(turn.payload.reviewReport.report)
      ? []
      : ordered.slice(
          Math.max(
            0,
            ordered.findLastIndex(
              (a) =>
                parentReview(a.recovery!.sourceEntryId) &&
                passed(sourceReport(a.recovery!.sourceRunId)),
            ),
          ),
        );
  const automatic = stretch.filter((a) => !a.recovery!.requestedByUserId).length;
  if (automatic >= (roadmap.scopeRecovery?.maxRoundsPerParent ?? 0))
    return escalate(
      `Automatic recovery allowance exhausted (${automatic} automatic round${automatic === 1 ? '' : 's'} for this parent). Pause the roadmap and raise the total allowance, or continue manually.`,
    );
  // A lifetime ceiling, three stretches' worth: a review that keeps passing with a fresh finding
  // would otherwise start rounds without end (LIVE-28 review, operator decision 2026-09-30).
  const lifetime = rounds.filter((a) => !a.recovery!.requestedByUserId).length;
  const ceiling = 3 * (roadmap.scopeRecovery?.maxRoundsPerParent ?? 0);
  if (lifetime >= ceiling)
    return escalate(
      `Automatic recovery reached its lifetime ceiling (${lifetime} automatic rounds for this parent, three times the allowance). Pause the roadmap and raise the allowance, or continue manually.`,
    );
  if (rounds.some((a) => a.recovery!.findingFingerprint === fingerprint))
    return escalate('Independent review repeated the same substantive findings after repair.');
  if (!progress.converging)
    return escalate(
      `Automatic recovery stopped: ${progress.rounds.length === 1 ? 'the last round' : 'the last rounds'} ended without progress.`,
    );
  return { preview, owner, fingerprint, sourceSequence: turn.sequence };
}

/** Identifies a review's open findings apart from their per-review IDs. */
export function findingFingerprint(
  findings: readonly { readonly id: string; readonly status: string }[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        findings
          .filter((f) => f.status === 'open')
          .map(({ id: _id, ...finding }) => finding)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    )
    .digest('hex');
}

/** Suppress stale parent attention only while an actual delegated recovery owns the next action. */
export function automatedScopeRecoveryWait(
  tx: StorageRepositories,
  cycle: WorkCycle,
): string | undefined {
  if (
    !cycle.executionScope ||
    cycle.executionScope.kind === 'slice' ||
    !['needs-attention', 'paused', 'awaiting-merge'].includes(cycle.status)
  )
    return;
  for (const roadmap of tx.roadmaps.list(cycle.workspaceId)) {
    if (roadmap.status !== 'running') continue;
    const entry = roadmap.definition.entries.find(
      (e) =>
        e.workItemId === cycle.workItemId &&
        sameExecutionScope(e.executionScope, cycle.executionScope),
    );
    if (!entry || roadmap.entryHolds?.[entry.id]) continue;
    const active = roadmap.attempts.find(
      (a) =>
        a.recovery &&
        a.recovery.phase !== 'completed' &&
        roadmap.definition.entries.some(
          (e) => e.id === a.entryId && e.workItemId === cycle.workItemId,
        ),
    );
    if (!roadmap.scopeRecovery?.enabled && !(active && roadmapCarriesRound(roadmap, active)))
      continue;
    if (
      active &&
      !roadmap.entryHolds?.[active.entryId] &&
      (active.recovery!.phase === 'repair' ||
        active.recovery!.reviewRunIds[entry.id] === cycle.currentRunId)
    )
      return 'Waiting for roadmap recovery: owning-slice repair, fresh verification and parent acceptance.';
    if (!active && ['needs-attention', 'paused'].includes(cycle.status)) {
      try {
        const decision = scopeRecoveryDecision(tx, roadmap, entry, cycle);
        if (decision.owner || decision.waiting)
          return 'Waiting for the roadmap to delegate a bounded owning-slice repair.';
      } catch {
        /* Binding failures remain visible through ordinary recovery. */
      }
    }
  }
}
