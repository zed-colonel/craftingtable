import type { AgentRunId, UserId, WorkspaceId, WorktreeId } from './ids.js';

/**
 * A protected ref (a branch no managed worktree owns, or a tag) that moved during a run by
 * something other than the daemon (R-G5, SEC-02d). The daemon records it when the run ends and
 * the inbox shows it until the operator acknowledges it. Only the acknowledgement is ever added.
 */
export interface ProtectedRefMove {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: string;
  readonly runId: AgentRunId;
  readonly worktreeId: WorktreeId;
  readonly detectedAt: string;
  /** A branch by its short name, a tag as `refs/tags/<name>`; null where the ref was absent. */
  readonly moves: readonly {
    readonly branch: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
  readonly acknowledgedAt?: string;
  readonly acknowledgedByUserId?: UserId;
}
