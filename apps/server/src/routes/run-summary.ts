import type { AgentRun } from '@craftingtable/domain';

/** The wire summary of a run omits the brief, which has its own detail field. */
export function runSummary(run: AgentRun): Omit<AgentRun, 'brief'> {
  const { brief: _brief, ...summary } = run;
  return summary;
}
