import type { AgentRunSummary } from '@craftingtable/contracts';
import {
  AGENT_BACKEND_LABELS,
  type AgentBackendKind,
  type AgentPermissionMode,
  type AgentRunId,
  type AgentRunProfile,
  type AgentRunRole,
  type WorktreeId,
} from '@craftingtable/domain';

/**
 * Handing one run's output to the next: which agent runs the child.
 *
 * The operator's standing preference is the role profile; a handoff form
 * pre-fills from it and lets the operator override per launch. With no
 * profile the child follows the run it continues from.
 */

export interface LaunchInput {
  readonly backend?: AgentBackendKind;
  readonly worktreeId: WorktreeId;
  readonly role: AgentRunRole;
  readonly permissionMode: AgentPermissionMode;
  readonly model?: string;
  readonly instructions?: string;
  readonly parentRunId?: AgentRunId;
}

/** The agent, model, and posture a handoff form starts from and ends with. */
export interface HandoffChoice {
  readonly backend: AgentBackendKind;
  readonly model?: string;
  readonly permissionMode: AgentPermissionMode;
}

/** The model a run asked for, or the one its backend reported if it was not the default. */
export function runModel(run: AgentRunSummary): string | undefined {
  return run.model ?? (run.resolvedModel === 'default' ? undefined : run.resolvedModel);
}

/** A profile as the daemon lists it: every role, flagged when it is only the default. */
export type ProfileEntry = AgentRunProfile & { readonly stored?: boolean };

/**
 * The operator's stated choice for a role. An entry the daemon marks as
 * unstored is its own fallback, not a preference, so it never overrides what
 * the operator or the previous run already chose.
 */
export function profileChoice(
  role: AgentRunRole,
  profiles: readonly ProfileEntry[],
): HandoffChoice | undefined {
  const profile = profiles.find((candidate) => candidate.role === role);
  if (profile === undefined || profile.stored === false) {
    return undefined;
  }
  return {
    backend: profile.backend,
    ...(profile.model === undefined ? {} : { model: profile.model }),
    permissionMode: profile.permissionMode,
  };
}

/**
 * The stored role profile when there is one. Otherwise the run being continued
 * sets the default, except that remediation returns to the worktree's previous
 * implementer rather than to the reviewer that found the problems.
 */
export function handoffDefaults(
  role: AgentRunRole,
  profiles: readonly ProfileEntry[],
  parent: AgentRunSummary,
  runs: readonly AgentRunSummary[] = [],
): HandoffChoice {
  const fromProfile = profileChoice(role, profiles);
  if (fromProfile !== undefined) {
    return fromProfile;
  }
  const source =
    role === 'implement' && parent.role === 'review'
      ? (latestImplementer(runs, parent.worktreeId) ?? parent)
      : parent;
  const model = runModel(source);
  return {
    backend: source.backend,
    ...(model === undefined ? {} : { model }),
    permissionMode: 'auto',
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
