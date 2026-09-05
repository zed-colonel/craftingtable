import type { AgentRun } from '@craftingtable/domain';
import { truncateUtf8Bytes } from '../services/bounded-text.js';

const OUTCOME_SUMMARY_LIMIT_BYTES = 4000;

/**
 * The wire summary of a run omits the brief, which has its own detail field.
 *
 * The outcome summary is re-bounded in bytes here as well as when it is
 * written: a row stored by an earlier build that counted characters must not
 * make every response carrying the run fail validation.
 */
export function runSummary(run: AgentRun): Omit<AgentRun, 'brief'> {
  const { brief: _brief, ...summary } = run;
  return summary.outcomeSummary === undefined
    ? summary
    : {
        ...summary,
        outcomeSummary: truncateUtf8Bytes(summary.outcomeSummary, OUTCOME_SUMMARY_LIMIT_BYTES),
      };
}
