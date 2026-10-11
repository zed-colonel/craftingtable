import type { AgentRunSummary } from '@craftingtable/contracts';
import {
  AGENT_BACKEND_LABELS,
  type AgentBackendKind,
  type AgentPermissionMode,
  type AgentReasoningEffort,
  type AgentRunId,
  type AgentRunRole,
  type EffectiveAgent,
  type WorktreeId,
} from '@craftingtable/domain';

/**
 * Handing one run's output to the next: which agent runs the child. The form pre-fills from the
 * daemon's default for the run and the role it hands to (the saved workspace default, else the
 * run it continues; R-E5b) and lets the operator change it for this launch.
 */

export interface LaunchInput {
  readonly backend?: AgentBackendKind;
  readonly worktreeId: WorktreeId;
  readonly role: AgentRunRole;
  readonly permissionMode: AgentPermissionMode;
  readonly model?: string;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly instructions?: string;
  readonly parentRunId?: AgentRunId;
}

/** The agent, model, and posture a handoff form starts from and ends with. */
export interface HandoffChoice {
  readonly backend: AgentBackendKind;
  readonly model?: string;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly permissionMode: AgentPermissionMode;
  /** Free-form guidance appended to the child's brief as operator instructions. */
  readonly instructions?: string;
}

/** The model a run asked for, or the one its backend reported if it was not the default. */
export function runModel(run: AgentRunSummary): string | undefined {
  return run.model ?? (run.resolvedModel === 'default' ? undefined : run.resolvedModel);
}

/**
 * A hand-off form's starting choice: the daemon's default for this run and target role
 * (R-E5b), reshaped as the form holds it. The daemon decides it; the browser derives nothing.
 */
export function handoffChoice(agent: EffectiveAgent): HandoffChoice {
  return {
    ...agent.selection,
    permissionMode: agent.permissionMode ?? 'auto',
  };
}

export function describeAgent(backend: AgentBackendKind, model: string | undefined): string {
  return model === undefined
    ? AGENT_BACKEND_LABELS[backend]
    : `${AGENT_BACKEND_LABELS[backend]} · ${model}`;
}

/** The most recent finished implement run in a worktree, if any. */
export function latestImplementer(
  runs: readonly AgentRunSummary[],
  worktreeId: WorktreeId,
): AgentRunSummary | undefined {
  return runs
    .filter(
      (run) =>
        run.worktreeId === worktreeId && run.role === 'implement' && run.status === 'finished',
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
}

/** A note for a remediation form when the last implementer differs from the default choice. */
export function previousImplementerHint(
  runs: readonly AgentRunSummary[],
  worktreeId: WorktreeId,
  choice: HandoffChoice,
): string | undefined {
  const previous = latestImplementer(runs, worktreeId);
  if (previous === undefined) {
    return undefined;
  }
  const model = runModel(previous);
  if (previous.backend === choice.backend && model === choice.model) {
    return undefined;
  }
  return `The last implement run here used ${describeAgent(previous.backend, model)}.`;
}

/** What a finished run can be handed to, and how the buttons name it. */
export interface HandoffTarget {
  readonly role: Extract<AgentRunRole, 'implement' | 'review'>;
  /** Accessible name of the inline form. */
  readonly label: string;
  /** Button text in the runs table. */
  readonly button: string;
  /** Button text on the run page. */
  readonly pageButton: string;
  readonly title: string;
  /** Example guidance for the form's instructions box. */
  readonly placeholder: string;
}

/**
 * The edges of the loop: a completed review turn hands to manual remediation, a
 * finished design to implementation, a finished implementation to review.
 */
export function handoffTarget(run: AgentRunSummary): HandoffTarget | undefined {
  if (
    run.role === 'review' &&
    run.turnCount > 0 &&
    (run.status === 'waiting' || run.status === 'finished')
  ) {
    return {
      role: 'implement',
      label: 'Remediate with',
      button: 'Remediate',
      pageButton: 'Remediate findings',
      title: 'Launch an implement run in this worktree with these findings as its brief',
      placeholder:
        'e.g. Address findings 1 and 3; leave the nits. Disagree in writing if a finding is wrong.',
    };
  }
  if (run.role === 'design' && run.status === 'finished') {
    return {
      role: 'implement',
      label: 'Implement with',
      button: 'Implement',
      pageButton: 'Implement this design',
      title: 'Launch an implement run in this worktree with this design as its plan',
      placeholder: 'e.g. Take option B for the open question; keep the migration out of this run.',
    };
  }
  if (run.role === 'implement' && run.status === 'finished') {
    return {
      role: 'review',
      label: 'Review with',
      button: 'Review',
      pageButton: 'Review this implementation',
      title: 'Launch a review run in this worktree with this implementation as its claim to verify',
      placeholder: 'e.g. Focus on the storage changes; treat missing tests as major.',
    };
  }
  return undefined;
}
