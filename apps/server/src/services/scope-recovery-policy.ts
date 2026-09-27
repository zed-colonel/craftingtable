import { createHash } from 'node:crypto';
import type { Roadmap, RoadmapAttempt, RoadmapEntry, WorkCycle } from '@craftingtable/domain';
import { isTerminalAgentRunStatus, sameExecutionScope } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { finalizationHasNoQuestions } from './finalization-policy.js';
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

/** Conservative routing: review assertions never choose between multiple owning slices. */
export function scopeRecoveryDecision(
  tx: StorageRepositories,
  roadmap: Roadmap,
  entry: RoadmapEntry,
  cycle: WorkCycle,
) {
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
  if (
    preview.candidates.length !== 1 ||
    (preview.sources.some((s) => s.scope.kind === 'parent-acceptance') &&
      parent.required_slices.length !== 1)
  )
    return {
      reason: 'Finding ownership is ambiguous: more than one slice could own it.',
    };
  const candidate = preview.candidates[0]!;
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
  // Rounds the operator requested do not use the automatic allowance.
  if (
    rounds.filter((a) => !a.recovery!.requestedByUserId).length >=
    (roadmap.scopeRecovery?.maxRoundsPerParent ?? 0)
  )
    return {
      reason: `Automatic recovery allowance exhausted (${rounds.length} rounds for this parent). Pause the roadmap and raise the total allowance, or continue manually.`,
    };
  if (rounds.some((a) => a.recovery!.findingFingerprint === fingerprint))
    return {
      reason:
        'Independent review repeated the same substantive findings after repair. Inspect the work item and provide guidance or delegate a manual repair before continuing.',
    };
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
