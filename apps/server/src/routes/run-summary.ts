import type { AgentRunService } from '../services/agent-run-service.js';
import type { AgentRun } from '@craftingtable/domain';

/**
 * The wire summary of a run omits the brief, which has its own detail field. Summaries
 * stored by an earlier build that counted characters are bounded by the storage upcaster.
 */
export function runSummary(run: AgentRun): Omit<AgentRun, 'brief'> {
  const { brief: _brief, ...summary } = run;
  return summary;
}

/**
 * A run as a list row: the summary without the outcome text. The outcome is
 * most of a list body and no list view shows it (PERF-12); the run detail and
 * the work item's execution view still carry it.
 */
export function runListRow(run: AgentRun): Omit<AgentRun, 'brief' | 'outcomeSummary'> {
  const { brief: _brief, outcomeSummary: _outcome, ...row } = run;
  return row;
}

/** A run's detail as its read answers it, and the run view with it (R-D5). */
export function runDetail(detail: ReturnType<AgentRunService['detail']>) {
  return {
    run: runSummary(detail.run),
    worktree: detail.worktree,
    brief: detail.run.brief,
    eventCount: detail.eventCount,
    ...(detail.completionIssue ? { completionIssue: detail.completionIssue } : {}),
    ...(detail.latestOutcome ? { latestOutcome: detail.latestOutcome } : {}),
    ...(detail.reviewReport === undefined ? {} : { reviewReport: detail.reviewReport }),
  };
}
