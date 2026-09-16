import type { PhaseReservation } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
export interface PhaseSchedulingRepository {
  capacity(key: string): number;
  setCapacity(key: string, capacity: number): void;
  active(): readonly PhaseReservation[];
  acquire(reservation: PhaseReservation): void;
  release(ownerId: string, at: string, reason: string): void;
  releaseOperations(at: string): void;
  authorized(workspaceId: string, workItemId: string, scopeKey: string): boolean;
  authorize(
    workspaceId: string,
    workItemId: string,
    scopeKey: string,
    userId: string,
    at: string,
  ): void;
}
export class SqlitePhaseSchedulingRepository implements PhaseSchedulingRepository {
  constructor(private readonly db: Database.Database) {}
  capacity(key: string): number {
    return (
      (
        this.db
          .prepare('SELECT capacity FROM phase_resource_limits WHERE resource_key=?')
          .get(key) as { capacity: number } | undefined
      )?.capacity ?? 1
    );
  }
  setCapacity(key: string, capacity: number): void {
    this.db
      .prepare(
        'INSERT INTO phase_resource_limits VALUES (?, ?) ON CONFLICT(resource_key) DO UPDATE SET capacity=excluded.capacity',
      )
      .run(key, capacity);
  }
  active(): readonly PhaseReservation[] {
    return this.db
      .prepare(`SELECT id, workspace_id AS workspaceId, worktree_id AS worktreeId,
      owner_id AS ownerId, phase, resource_key AS resourceKey, capacity, acquired_at AS acquiredAt
      FROM phase_reservations WHERE released_at IS NULL ORDER BY acquired_at, id`)
      .all() as PhaseReservation[];
  }
  acquire(r: PhaseReservation): void {
    this.db
      .prepare(`INSERT INTO phase_reservations
      (id, workspace_id, worktree_id, owner_id, phase, resource_key, capacity, acquired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        r.id,
        r.workspaceId,
        r.worktreeId,
        r.ownerId,
        r.phase,
        r.resourceKey,
        r.capacity,
        r.acquiredAt,
      );
  }
  release(ownerId: string, at: string, reason: string): void {
    this.db
      .prepare(
        'UPDATE phase_reservations SET released_at=?, release_reason=? WHERE owner_id=? AND released_at IS NULL',
      )
      .run(at, reason, ownerId);
  }
  releaseOperations(at: string): void {
    this.db
      .prepare(
        "UPDATE phase_reservations SET released_at=?, release_reason='daemon-restarted' WHERE owner_id LIKE 'operation:%' AND released_at IS NULL",
      )
      .run(at);
  }
  authorized(workspaceId: string, workItemId: string, scopeKey: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM scope_scheduling_authorizations WHERE workspace_id=? AND work_item_id=? AND scope_key=?',
      )
      .get(workspaceId, workItemId, scopeKey);
  }
  authorize(
    workspaceId: string,
    workItemId: string,
    scopeKey: string,
    userId: string,
    at: string,
  ): void {
    this.db
      .prepare('INSERT OR IGNORE INTO scope_scheduling_authorizations VALUES (?, ?, ?, ?, ?)')
      .run(workspaceId, workItemId, scopeKey, userId, at);
  }
}
