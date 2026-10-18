/**
 * The run side's shared types and helpers (R-B7): what the agent run service and the modules it
 * is made of all read, in a leaf no service imports back, so the services that only need a
 * run's log or launch input import no service for it.
 */
import type { AgentBackend, AgentSession, AgentSessionItem } from '@craftingtable/agents';
import {
  type AgentBackendKind,
  type AgentPermissionMode,
  type AgentRun,
  type AgentRunId,
  type AgentRunRole,
  type AgentRunStatus,
  modelSpelling,
  OUTCOME_SUMMARY_LIMIT_BYTES,
  truncateUtf8Bytes,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import type { OutputContext } from '../brief-output.js';

export interface StartRunInput {
  readonly backend?: AgentBackendKind;
  readonly worktreeId: WorktreeId;
  readonly role: AgentRunRole;
  readonly permissionMode: AgentPermissionMode;
  readonly model?: string;
  readonly reasoningEffort?: AgentRun['reasoningEffort'];
  /** Operator-authored instructions (a manual run's request, or the cycle's start text). */
  readonly instructions?: string;
  /** One-shot operator guidance for this run only. */
  readonly stepGuidance?: string;
  /** Controller-authored rules for an automated step; never presented as operator text. */
  readonly controllerInstructions?: string;
  /**
   * What the controller's step adds to the run's final message, which the role's instructions
   * state (`brief-output.ts`, AGT-54): the workflow block, a finalization stage's report.
   */
  readonly output?: Pick<OutputContext, 'workflow' | 'finalizationStage'>;
  /** Controller records for this step, written into the run's plan directory and named in its brief. */
  readonly records?: readonly {
    readonly filename: string;
    readonly content: string;
    readonly about: string;
  }[];
  readonly parentRunId?: AgentRunId;
}

/** A question stop's investigation, as the cycle service launches it (R-C16). */
export interface InvestigationLaunch {
  readonly value: import('@craftingtable/domain').CycleInvestigation;
  /** The run's `investigation/` context: the questions, the reports and the branch. */
  readonly documents: readonly { readonly name: string; readonly content: string }[];
  /** Refuses the launch once the cycle no longer holds this investigation. */
  readonly check: () => void;
}

export interface RunLog {
  warn(message: string, detail?: Readonly<Record<string, unknown>>): void;
}

export class CycleLaunchCancelledError extends Error {}

export interface LiveRun {
  readonly workspaceId: WorkspaceId;
  readonly runId: AgentRunId;
  readonly session: AgentSession;
  cancelRequested: boolean;
  /** Why it was cancelled, recorded when its process exits (an investigation's End, R-C16). */
  cancelMessage?: string;
  /** Set when a restart drain terminates the session; it then ends `interrupted`. */
  drainInterrupted?: boolean;
  /** The consumer is blocked on the session's next item (see `quiesce`). */
  awaitingItem?: boolean;
  done: Promise<void>;
}

export const LIVE_STATUSES: readonly AgentRunStatus[] = ['starting', 'running', 'waiting'];

/** How long a killed session's stream is given to report its exit. */
export const SHUTDOWN_GRACE_MS = 10_000;
export const DRAIN_INTERRUPTED_MESSAGE =
  'CraftingTable stopped for a restart while this run was live. A cycle step resumes its session automatically after a clean restart.';

/** What is wrong with a model the backend's catalog lists under another id, if it is. */
export function misnamedModel(
  backend: AgentBackend,
  model: string | undefined,
): string | undefined {
  if (model === undefined) return undefined;
  const { label, models } = backend.describe();
  const spelling = modelSpelling(models, model);
  if (spelling.kind !== 'misnamed') return undefined;
  const what =
    model.trim().toLowerCase() === spelling.label.toLowerCase()
      ? 'the display name of'
      : 'another spelling of';
  return `${JSON.stringify(model)} is ${what} ${JSON.stringify(spelling.id)} in ${label}'s model list. Only the id can be sent.`;
}

export function summarise(text: string): string {
  return truncateUtf8Bytes(text, OUTCOME_SUMMARY_LIMIT_BYTES);
}

/**
 * Reads a killed session until it reports its exit. If the stream ends or fails
 * without one, the backend's SIGTERM-then-SIGKILL escalation is given time to
 * finish before the worktree is released.
 */
export async function drainUntilExit(items: AsyncIterator<AgentSessionItem>): Promise<void> {
  try {
    for (let next = await items.next(); next.done !== true; next = await items.next())
      if (next.value.type === 'exited') return;
  } catch {
    // The backend stream failed; fall through to the grace period.
  }
  await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
}

/** A controller-run launch's identity, deadline, check and time-limit message. */
export type ControlledRun = {
  readonly runId: AgentRunId;
  readonly deadlineAt: string;
  readonly check: () => void;
  readonly limit: string;
};
