import type { AgentRunId, UserId, WorkspaceId, WorktreeId } from './ids.js';

/** A reviewed merge reservation, recorded before Git and reconciled before cleanup. */
export interface MergeOperation {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly status: 'reserved' | 'failed' | 'merged' | 'cleaned';
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly targetBranch: string;
  readonly reviewRunId: AgentRunId;
  readonly createdAt: string;
  readonly authorizedByUserId: UserId;
  readonly roadmapId?: string;
  readonly definitionRevision?: number;
  readonly mergeSha?: string;
  readonly cleanupError?: string;
  readonly removeIntegrationBranch?: boolean;
}
