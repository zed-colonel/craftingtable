export type ExecutionPhase = 'start' | 'merge' | 'verify' | 'accept';
export interface PhaseBlocker {
  readonly kind: 'dependency' | 'evidence' | 'review' | 'authorization' | 'resource';
  readonly message: string;
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
