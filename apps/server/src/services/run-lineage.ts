/**
 * A run's journal and handoff lineage, read-only (R-B7): what the cycle's decision core and the
 * handoff both read, apart from the handoff's writes, so the core reaches no file write.
 */
import type {
  AgentRun,
  AgentRunEvent,
  ReviewFinding,
  ReviewReportAssessment,
  WorkCycle,
} from '@craftingtable/domain';
import { stagedFollowUpIds } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { ExecutionRequestError } from './errors.js';
import { assessReviewReport } from './review-report.js';

type Execution = StorageRepositories['execution'];

/** Read journal pages, never a clipped first page or a bounded run summary. */
export function* runEvents(
  execution: Execution,
  run: AgentRun,
  throughSequence = Number.MAX_SAFE_INTEGER,
): Generator<AgentRunEvent> {
  let after = 0;
  for (;;) {
    const page = execution.runEvents.listAfter({
      workspaceId: run.workspaceId,
      runId: run.id,
      after,
      limit: 100,
    });
    if (page.length === 0) return;
    for (const event of page) {
      if (event.sequence > throughSequence) return;
      yield event;
    }
    after = page.at(-1)?.sequence ?? after;
  }
}

/**
 * Whether a run continues a cycle's handoff lineage from the cycle's own run (its current one,
 * or the parent it was reserved from), so a resume may adopt it. The command and the offer read
 * the same answer (R-B4, decision 14).
 */
export function continuesLineage(
  execution: Execution,
  cycle: Pick<WorkCycle, 'workspaceId' | 'currentRunId' | 'parentRunId'>,
  run: AgentRun,
): boolean {
  const anchor =
    execution.runs.find(cycle.workspaceId, cycle.currentRunId)?.id ?? cycle.parentRunId;
  return anchor === undefined || runLineage(execution, run).some((source) => source.id === anchor);
}

/** The newest run first; lineage must stay inside the worktree and workspace. */
export function runLineage(execution: Execution, run: AgentRun): readonly AgentRun[] {
  const runs: AgentRun[] = [];
  const seen = new Set<string>();
  let current: AgentRun | undefined = run;
  while (current !== undefined) {
    if (
      seen.has(current.id) ||
      runs.length >= 1000 ||
      current.worktreeId !== run.worktreeId ||
      current.workItemId !== run.workItemId
    ) {
      throw new ExecutionRequestError(
        'conflict',
        'Run lineage cannot be handed off: it is cyclic, too long, or crosses worktrees',
      );
    }
    runs.push(current);
    seen.add(current.id);
    if (current.parentRunId === undefined) break;
    current = execution.runs.find(run.workspaceId, current.parentRunId);
    if (current === undefined)
      throw new ExecutionRequestError(
        'conflict',
        'A source run is missing from the handoff lineage',
      );
  }
  return runs;
}

/** Inherited context is pinned to the source messages actually delivered at launch. */
export function sourceRuns(
  execution: Execution,
  run: AgentRun,
): readonly { run: AgentRun; throughSequence?: number }[] {
  const first = execution.runEvents.listAfter({
    workspaceId: run.workspaceId,
    runId: run.id,
    after: 0,
    limit: 1,
  })[0];
  const sources = first?.kind === 'user-message' ? first.payload.handoffSources : undefined;
  if (sources === undefined) return runLineage(execution, run).map((source) => ({ run: source }));
  return [
    { run },
    ...sources.map((source) => {
      const found = execution.runs.find(run.workspaceId, source.runId);
      if (
        found === undefined ||
        found.worktreeId !== run.worktreeId ||
        found.workItemId !== run.workItemId ||
        found.id === run.id
      ) {
        throw new ExecutionRequestError(
          'conflict',
          'A handoff source is missing or outside this worktree',
        );
      }
      return { run: found, throughSequence: source.throughSequence };
    }),
  ];
}

/**
 * How a run was cut off, for its handoff (R-C17 part 2, its L-4 and part 4): it never completed a
 * turn; its latest completed turn ended in error; or it began another turn after its latest
 * completed one (an assistant message or tool call after it) that never completed. A turn the run
 * completed after an earlier error or cut-off supersedes it.
 */
export type RunCutOff = 'no-turn' | 'error-turn' | 'later-turn';

/**
 * Whether a run's final message falls short of where it stopped, read from the journal's event
 * kinds, sequences and the adapter's typed marks, never its text (rule 4). A follow-up the run never answered, a notice or
 * stderr does not begin a turn. The launch reads it once and hands it to the handoff.
 */
export function runCutOff(execution: Execution, run: AgentRun): RunCutOff | undefined {
  const turn = execution.runEvents.latestOfKind(run.workspaceId, run.id, 'turn-completed');
  if (turn?.kind !== 'turn-completed') return 'no-turn';
  // A Claude result held for background work is journaled at the session's end, after the later
  // turn's events: the adapter marks it (decision 0).
  if (turn.payload.afterLaterWork) return 'later-turn';
  for (let after = turn.sequence; ; ) {
    const page = execution.runEvents.listAfter({
      workspaceId: run.workspaceId,
      runId: run.id,
      after,
      limit: 100,
    });
    if (page.length === 0) break;
    if (page.some((event) => event.kind === 'assistant-message' || event.kind === 'tool-call'))
      return 'later-turn';
    after = page.at(-1)?.sequence ?? after;
  }
  return turn.payload.outcome === 'error' ? 'error-turn' : undefined;
}

/** Later lifecycle events cannot rewrite an already-delivered source snapshot. */
export function incompleteRun(
  execution: Execution,
  run: AgentRun,
  throughSequence = Number.MAX_SAFE_INTEGER,
) {
  const ended = execution.runEvents.latestOfKind(run.workspaceId, run.id, 'run-finished');
  return (
    ended?.kind === 'run-finished' && ended.sequence <= throughSequence && ended.payload.reason
  );
}

/** Latest valid reviewer disposition, replayed only from the delivered source snapshots. */
export function recordedFindings(execution: Execution, run: AgentRun) {
  const findings = new Map<
    string,
    { finding: ReviewFinding; runId: AgentRun['id']; sequence: number }
  >();
  for (const { run: source, throughSequence } of sourceRuns(execution, run).toReversed()) {
    if (source.role !== 'review') continue;
    const incomplete = incompleteRun(execution, source, throughSequence);
    for (const event of runEvents(execution, source, throughSequence)) {
      if (event.kind === 'turn-completed' && event.payload.reviewReport?.status === 'complete') {
        for (const finding of event.payload.reviewReport.report.findings) {
          // Preserve concerns, but an incomplete run cannot supply closure evidence.
          if (!incomplete || finding.status === 'open')
            findings.set(finding.id, { finding, runId: source.id, sequence: event.sequence });
        }
      }
    }
  }
  return findings;
}

export function requiredFindingIds(execution: Execution, run: AgentRun): ReadonlySet<string> {
  const cycle = execution.cycles.activeForWorktree(run.workspaceId, run.worktreeId);
  const followUps = cycle ? stagedFollowUpIds(cycle) : new Set<string>();
  return new Set(
    [...recordedFindings(execution, run).values()]
      .filter(
        ({ finding }) =>
          !run.planVersionId || (finding.status === 'open' && !followUps.has(finding.id)),
      )
      .map(({ finding }) => finding.id),
  );
}

export function latestReviewReport(
  execution: Execution,
  run: AgentRun,
  throughSequence?: number,
): ReviewReportAssessment | undefined {
  if (run.role !== 'review') return undefined;
  if (incompleteRun(execution, run, throughSequence))
    return {
      status: 'invalid',
      fault: 'content',
      issues: [
        'The review exited before background verification and reporting completed. Its provisional report cannot close findings or authorize a merge.',
      ],
    };
  let event: AgentRunEvent | undefined;
  if (throughSequence === undefined)
    event = execution.runEvents.latestOfKind(run.workspaceId, run.id, 'turn-completed');
  else
    for (const candidate of runEvents(execution, run, throughSequence)) {
      if (candidate.kind === 'turn-completed') event = candidate;
    }
  if (event?.kind !== 'turn-completed')
    return { status: 'unstructured', issues: ['The review has no completed turn yet.'] };
  const stored = event.payload.reviewReport;
  if (stored === undefined)
    return assessReviewReport(event.payload.resultText, event.payload.truncated);
  if (stored.status !== 'invalid' || stored.fault !== undefined) return stored;
  // Recorded before faults were typed: the report's own structure decides. If the text alone
  // is invalid, its structure is at fault; otherwise the issues came from content checks.
  const structural = assessReviewReport(event.payload.resultText, event.payload.truncated);
  return {
    ...stored,
    fault:
      event.payload.outcome === 'error' || structural.status === 'complete' ? 'content' : 'format',
  };
}
