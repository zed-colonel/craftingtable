import type { ScopeReceipt, WorkspaceId, WorkItemId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
export interface ScopeReceiptRepository {
  add(receipt: ScopeReceipt): void;
  list(workspaceId: WorkspaceId, workItemId: WorkItemId): readonly ScopeReceipt[];
}
export class SqliteScopeReceiptRepository implements ScopeReceiptRepository {
  constructor(private readonly db: Database.Database) {}
  add(r: ScopeReceipt): void {
    this.db
      .prepare(
        'INSERT INTO scope_receipts (id, workspace_id, work_item_id, worktree_id, review_run_id, kind, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        r.id,
        r.workspaceId,
        r.workItemId,
        r.worktreeId,
        r.reviewRunId,
        r.scope.kind,
        JSON.stringify(r),
      );
  }
  list(workspaceId: WorkspaceId, workItemId: WorkItemId): readonly ScopeReceipt[] {
    return this.db
      .prepare(
        'SELECT record_json FROM scope_receipts WHERE workspace_id=? AND work_item_id=? ORDER BY rowid DESC',
      )
      .all(workspaceId, workItemId)
      .map((row) => JSON.parse((row as { record_json: string }).record_json) as ScopeReceipt);
  }
}
