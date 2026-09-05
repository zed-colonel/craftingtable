import type { JsonValue } from './audit.js';
import type {
  AgentRunEventId,
  AgentRunId,
  ProjectId,
  SourceRepositoryId,
  UserId,
  WorkItemId,
  WorkspaceId,
  WorktreeId,
} from './ids.js';

/**
 * Execution model: the durable vocabulary for delegating a work item to a
 * coding agent inside a controlled worktree and observing what it does.
 *
 * Vendor event shapes never appear here. A backend adapter translates its
 * native stream into `AgentRunEvent` kinds; the raw line may be retained for
 * diagnostics but is not part of the domain vocabulary.
 */

/* -------------------------------------------------------------------------- */
/* Source repositories                                                         */
/* -------------------------------------------------------------------------- */

export const SOURCE_REPOSITORY_STATUSES = ['active', 'retired'] as const;
export type SourceRepositoryStatus = (typeof SOURCE_REPOSITORY_STATUSES)[number];

export interface SourceRepository {
  readonly id: SourceRepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  /** Canonical absolute path of the primary checkout. */
  readonly rootPath: string;
  readonly defaultBranch: string;
  readonly registeredHeadSha: string;
  readonly status: SourceRepositoryStatus;
  readonly registeredAt: string;
  readonly registeredByUserId: UserId;
  readonly retiredAt?: string;
  readonly version: number;
}

/* -------------------------------------------------------------------------- */
/* Worktrees                                                                   */
/* -------------------------------------------------------------------------- */

export const WORKTREE_STATUSES = ['active', 'removed'] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

export interface Worktree {
  readonly id: WorktreeId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: SourceRepositoryId;
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly branchName: string;
  readonly baseSha: string;
  readonly baseBranch: string;
  /** Absolute path of the linked worktree under the managed worktree root. */
  readonly path: string;
  readonly status: WorktreeStatus;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly removedAt?: string;
  /** Set when removal was the result of merging the branch into its base branch. */
  readonly mergedAt?: string;
  readonly mergeSha?: string;
  readonly version: number;
}

/* -------------------------------------------------------------------------- */
/* Agent runs                                                                  */
/* -------------------------------------------------------------------------- */

export const AGENT_BACKENDS = ['claude-code'] as const;
export type AgentBackendKind = (typeof AGENT_BACKENDS)[number];

/**
 * The role a run plays in the development loop. Roles are the composition
 * seam for orchestrated design/implement/review cycles: each role has its own
 * brief template and a later orchestrator can chain runs by role and lineage
 * (`parentRunId`) without new run vocabulary.
 */
export const AGENT_RUN_ROLES = ['implement', 'review', 'design'] as const;
export type AgentRunRole = (typeof AGENT_RUN_ROLES)[number];

export const AGENT_RUN_STATUSES = [
  /** Process launch requested; no session yet. */
  'starting',
  /** A turn is in progress. */
  'running',
  /** The last turn completed; the session is open for follow-up messages. */
  'waiting',
  /** The operator ended the session and the process exited cleanly. */
  'finished',
  /** The process exited with an error or the backend reported failure. */
  'failed',
  /** The operator cancelled the run; the process was terminated. */
  'cancelled',
  /** The daemon restarted while the run was live; the process is gone. */
  'interrupted',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const TERMINAL_AGENT_RUN_STATUSES = [
  'finished',
  'failed',
  'cancelled',
  'interrupted',
] as const satisfies readonly AgentRunStatus[];

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return (TERMINAL_AGENT_RUN_STATUSES as readonly AgentRunStatus[]).includes(status);
}

/**
 * Vendor-neutral permission posture handed to the backend adapter.
 *
 * - `edit-only`: file edits inside the worktree are pre-approved; anything
 *   that would need a prompt is denied.
 * - `auto`: the backend's own safety classifier approves routine actions and
 *   denies risky ones; prompts are denied.
 * - `unrestricted`: no permission checks. The worktree is the only boundary.
 */
export const AGENT_PERMISSION_MODES = ['edit-only', 'auto', 'unrestricted'] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

/**
 * How the backend session was paid for, as reported by the backend itself.
 * A subscription session still reports an API-equivalent cost figure; the
 * browser labels it as an estimate rather than a bill.
 */
export const AGENT_BILLING_SOURCES = ['subscription', 'api-key', 'unknown'] as const;
export type AgentBillingSource = (typeof AGENT_BILLING_SOURCES)[number];

/**
 * A review run's conclusion, parsed from its final message. Merging a
 * worktree is gated on the latest review of that worktree being `mergeable`.
 */
export const AGENT_RUN_VERDICTS = ['mergeable', 'changes-requested'] as const;
export type AgentRunVerdict = (typeof AGENT_RUN_VERDICTS)[number];

export interface AgentRun {
  readonly id: AgentRunId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly repositoryId: SourceRepositoryId;
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly parentRunId?: AgentRunId;
  readonly backend: AgentBackendKind;
  readonly role: AgentRunRole;
  readonly status: AgentRunStatus;
  readonly permissionMode: AgentPermissionMode;
  /** The model the operator asked for, if any. */
  readonly model?: string;
  /** The model the backend actually used, once its session started. */
  readonly resolvedModel?: string;
  readonly billing?: AgentBillingSource;
  /** Present only on review runs whose final message carried a verdict line. */
  readonly verdict?: AgentRunVerdict;
  /** The composed prompt handed to the agent as its first message. */
  readonly brief: string;
  /** Vendor session identifier, once the backend reports one. */
  readonly backendSessionId?: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly outcomeSummary?: string;
  readonly costUsd?: number;
  readonly turnCount: number;
  readonly version: number;
}

/* -------------------------------------------------------------------------- */
/* Normalized run events                                                       */
/* -------------------------------------------------------------------------- */

export const AGENT_RUN_EVENT_KINDS = [
  'session-started',
  'user-message',
  'assistant-message',
  'tool-call',
  'tool-result',
  'turn-completed',
  'notice',
  'stderr',
  'run-finished',
] as const;
export type AgentRunEventKind = (typeof AGENT_RUN_EVENT_KINDS)[number];

export function isAgentRunEventKind(value: unknown): value is AgentRunEventKind {
  return (AGENT_RUN_EVENT_KINDS as readonly string[]).includes(value as string);
}

export const AGENT_NOTICE_CATEGORIES = [
  'rate-limit',
  'compaction',
  'hook',
  'task',
  'other',
] as const;
export type AgentNoticeCategory = (typeof AGENT_NOTICE_CATEGORIES)[number];

export interface AgentRunEventPayloads {
  readonly 'session-started': {
    readonly backend: AgentBackendKind;
    readonly backendSessionId: string;
    readonly model: string;
    readonly permissionMode: AgentPermissionMode;
    readonly cwd: string;
    readonly billing: AgentBillingSource;
  };
  readonly 'user-message': { readonly text: string };
  readonly 'assistant-message': { readonly text: string };
  readonly 'tool-call': {
    readonly toolUseId: string;
    readonly name: string;
    /** Bounded, serialisable tool input. Large values are truncated by the adapter. */
    readonly input: JsonValue;
    /** One-line human summary derived by the adapter. */
    readonly summary: string;
  };
  readonly 'tool-result': {
    readonly toolUseId: string;
    readonly content: string;
    readonly isError: boolean;
    readonly truncated: boolean;
  };
  readonly 'turn-completed': {
    readonly outcome: 'success' | 'error';
    readonly resultText: string;
    readonly costUsd?: number;
    readonly turns: number;
    readonly durationMs: number;
  };
  readonly notice: { readonly category: AgentNoticeCategory; readonly message: string };
  readonly stderr: { readonly text: string };
  readonly 'run-finished': {
    readonly status: Extract<AgentRunStatus, 'finished' | 'failed' | 'cancelled' | 'interrupted'>;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly message?: string;
  };
}

export type AgentRunEventPayload<K extends AgentRunEventKind = AgentRunEventKind> =
  AgentRunEventPayloads[K];

export interface AgentRunEventBase {
  readonly sequence: number;
  readonly id: AgentRunEventId;
  readonly workspaceId: WorkspaceId;
  readonly runId: AgentRunId;
  readonly occurredAt: string;
  /** Raw backend line retained for diagnostics; bounded by the adapter. */
  readonly raw?: string;
}

export type AgentRunEvent = {
  [K in AgentRunEventKind]: AgentRunEventBase & {
    readonly kind: K;
    readonly payload: AgentRunEventPayloads[K];
  };
}[AgentRunEventKind];
