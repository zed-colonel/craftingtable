import type { AgentRunSummary } from '@craftingtable/contracts';
import type { LaunchInput } from './DelegationPanel.js';

/** Remediation belongs to the latest successful implementer of this worktree. */
export function remediationInput(
  review: AgentRunSummary,
  runs: readonly AgentRunSummary[],
): LaunchInput {
  const implementer =
    runs
      .filter(
        (run) =>
          run.worktreeId === review.worktreeId &&
          run.role === 'implement' &&
          run.status === 'finished',
      )
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ??
    review;
  const model =
    implementer.model ??
    (implementer.resolvedModel === 'default' ? undefined : implementer.resolvedModel);
  return {
    backend: implementer.backend,
    worktreeId: review.worktreeId,
    role: 'implement',
    permissionMode: 'auto',
    ...(model === undefined ? {} : { model }),
    parentRunId: review.id,
  };
}

/**
 * Implementing an accepted design continues with the agent that wrote it.
 * From the launch form the operator can choose otherwise; this is the default
 * used where there is no form, such as the run page.
 */
export function implementDesignInput(design: AgentRunSummary): LaunchInput {
  const model =
    design.model ?? (design.resolvedModel === 'default' ? undefined : design.resolvedModel);
  return {
    backend: design.backend,
    worktreeId: design.worktreeId,
    role: 'implement',
    permissionMode: 'auto',
    ...(model === undefined ? {} : { model }),
    parentRunId: design.id,
  };
}
