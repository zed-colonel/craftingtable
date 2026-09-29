import type { ProtectedRefMove, UserId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { parseRecord, type RecordGuard } from '../records.js';

/**
 * Protected ref moves the daemon flagged (R-G5, SEC-02d). A move is written once and never
 * deleted; the only change is its acknowledgement, which the table's trigger allows once.
 */
export interface ProtectedRefRepository {
  add(move: ProtectedRefMove): void;
  find(ws: string, id: string): ProtectedRefMove | undefined;
  /** The moves on a repository no one has acknowledged yet, oldest first. */
  unacknowledged(ws: string, repositoryId: string): readonly ProtectedRefMove[];
  /** Records who acknowledged a move and when; false if it was already acknowledged. */
  acknowledge(ws: string, id: string, at: string, userId: UserId): boolean;
}

export class SqliteProtectedRefRepository implements ProtectedRefRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  add(move: ProtectedRefMove): void {
    this.guard('protected-ref-move', move);
    this.db
      .prepare('INSERT INTO protected_ref_moves VALUES (?,?,?,?)')
      .run(move.id, move.workspaceId, move.repositoryId, JSON.stringify(move));
  }
  find(ws: string, id: string): ProtectedRefMove | undefined {
    const row = this.db
      .prepare('SELECT record_json FROM protected_ref_moves WHERE workspace_id=? AND id=?')
      .get(ws, id) as { record_json: string } | undefined;
    return row && parseRecord('protected-ref-move', row.record_json);
  }
  unacknowledged(ws: string, repositoryId: string): readonly ProtectedRefMove[] {
    return (
      this.db
        .prepare(
          "SELECT record_json FROM protected_ref_moves WHERE workspace_id=? AND repository_id=? AND json_extract(record_json, '$.acknowledgedAt') IS NULL ORDER BY rowid",
        )
        .all(ws, repositoryId) as { record_json: string }[]
    ).map((row) => parseRecord('protected-ref-move', row.record_json));
  }
  acknowledge(ws: string, id: string, at: string, userId: UserId): boolean {
    const move = this.find(ws, id);
    if (!move || move.acknowledgedAt !== undefined) return false;
    const acknowledged: ProtectedRefMove = {
      ...move,
      acknowledgedAt: at,
      acknowledgedByUserId: userId,
    };
    this.guard('protected-ref-move', acknowledged);
    return (
      this.db
        .prepare(
          "UPDATE protected_ref_moves SET record_json=? WHERE workspace_id=? AND id=? AND json_extract(record_json, '$.acknowledgedAt') IS NULL",
        )
        .run(JSON.stringify(acknowledged), ws, id).changes === 1
    );
  }
}
