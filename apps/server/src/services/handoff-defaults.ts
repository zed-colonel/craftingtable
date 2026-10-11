import type {
  AgentProfilePurpose,
  AgentRun,
  AgentRunRole,
  EffectiveAgent,
} from '@craftingtable/domain';
import { type AgentContext, resolveAgent } from './agent-resolution.js';

/** What a run hands to (R-E5b): the next run's role, and the purpose its default is read for. */
const TARGET: Readonly<
  Record<AgentRunRole, { role: 'implement' | 'review'; purpose: AgentProfilePurpose }>
> = {
  design: { role: 'implement', purpose: 'implement' },
  implement: { role: 'review', purpose: 'review' },
  // A review hands its findings to remediation, which is an implement run.
  review: { role: 'implement', purpose: 'remediate' },
};

export type RunHandoff = { readonly role: 'implement' | 'review'; readonly agent: EffectiveAgent };

type ListedRun = Pick<
  AgentRun,
  | 'id'
  | 'role'
  | 'status'
  | 'worktreeId'
  | 'backend'
  | 'model'
  | 'resolvedModel'
  | 'reasoningEffort'
  | 'createdAt'
>;

/** The model a run asked for, or the one its backend reported when that was not its default. */
function runModel(run: ListedRun): string | undefined {
  return run.model ?? (run.resolvedModel === 'default' ? undefined : run.resolvedModel);
}

/**
 * Each run's hand-off default (R-E5b, from R-E5a's recommendation): the saved workspace default
 * for the purpose it hands to, or the nearest it inherits (remediation, then implementation),
 * else the run it continues, with `auto` permissions. A review's remediation continues the
 * worktree's latest finished implement run, not the reviewer that found the problems. Whether the
 * hand-off is offered now (its status, its turns) stays with the page; the default does not
 * depend on it, so a page that sees a run finish before it reads again still has one.
 */
export function runHandoffs(
  runs: readonly ListedRun[],
  workspace: NonNullable<AgentContext['workspace']>,
): Readonly<Record<string, RunHandoff>> {
  const implementer = (worktreeId: string) =>
    runs
      .filter(
        (r) => r.worktreeId === worktreeId && r.role === 'implement' && r.status === 'finished',
      )
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  return Object.fromEntries(
    runs.map((run) => {
      const target = TARGET[run.role];
      const source = (run.role === 'review' ? implementer(run.worktreeId) : undefined) ?? run;
      const model = runModel(source);
      return [
        run.id,
        {
          role: target.role,
          agent: resolveAgent({
            purpose: target.purpose,
            workspace,
            continued: {
              runId: source.id,
              profile: {
                backend: source.backend,
                ...(model === undefined ? {} : { model }),
                ...(source.reasoningEffort ? { reasoningEffort: source.reasoningEffort } : {}),
                permissionMode: 'auto',
              },
            },
          }),
        },
      ];
    }),
  );
}
