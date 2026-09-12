import type { MergeOperation, WorkspaceId, WorktreeId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
export interface MergeOperationRepository {
  save(operation: MergeOperation): void;
  latest(workspaceId: WorkspaceId, worktreeId: WorktreeId): MergeOperation | undefined;
  pending(): readonly MergeOperation[];
}
function map(row: unknown): MergeOperation | undefined {
  return row === undefined
    ? undefined
    : (JSON.parse((row as { state_json: string }).state_json) as MergeOperation);
}
export class SqliteMergeOperationRepository implements MergeOperationRepository {
  constructor(private readonly database: Database.Database) {}
  save(operation: MergeOperation): void {
    this.database
      .prepare(`INSERT INTO merge_operations (id, workspace_id, worktree_id, status, state_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, state_json = excluded.state_json`)
      .run(
        operation.id,
        operation.workspaceId,
        operation.worktreeId,
        operation.status,
        JSON.stringify(operation),
      );
  }
  latest(workspaceId: WorkspaceId, worktreeId: WorktreeId): MergeOperation | undefined {
    return map(
      this.database
        .prepare(
          'SELECT state_json FROM merge_operations WHERE workspace_id = ? AND worktree_id = ? ORDER BY rowid DESC LIMIT 1',
        )
        .get(workspaceId, worktreeId),
    );
  }
  pending(): readonly MergeOperation[] {
    return this.database
      .prepare(
        "SELECT state_json FROM merge_operations WHERE status IN ('reserved','merged') ORDER BY rowid",
      )
      .all()
      .map((row) => map(row) as MergeOperation);
  }
}
