import type { CheckpointId, SliceId, WorkspaceId, WorktreeId } from './ids.js';
export type ExecutionPhase = 'start' | 'merge' | 'verify' | 'accept';
export interface PhaseBlocker {
  readonly kind: 'dependency' | 'evidence' | 'review' | 'authorization' | 'resource';
  /** Display text only; never parsed. `code` carries the meaning. */
  readonly message: string;
  /** What blocks: migration 0047 coded every blocker stored before R-A3 (R-B4b). */
  readonly code: import('./attention.js').PhaseBlockerCode;
  readonly refs?: {
    readonly checkpointId?: CheckpointId;
    readonly sliceId?: SliceId;
    readonly resourceKey?: string;
  };
}
export interface PhaseReservation {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly ownerId: string;
  readonly phase: ExecutionPhase;
  readonly resourceKey: string;
  readonly capacity: number;
  readonly acquiredAt: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
}
