export type ExecutionPhase = 'start' | 'merge' | 'verify' | 'accept';
export interface PhaseBlocker {
  readonly kind: 'dependency' | 'evidence' | 'review' | 'authorization' | 'resource';
  /** Display text only; never parsed. `code` carries the meaning. */
  readonly message: string;
  /** Absent only on blockers stored before R-A3; read through `phaseBlockerCode`. */
  readonly code?: import('./attention.js').PhaseBlockerCode;
  readonly refs?: {
    readonly checkpointId?: string;
    readonly sliceId?: string;
    readonly resourceKey?: string;
  };
}
export interface PhaseReservation {
  readonly id: string;
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly ownerId: string;
  readonly phase: ExecutionPhase;
  readonly resourceKey: string;
  readonly capacity: number;
  readonly acquiredAt: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
}
