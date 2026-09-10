import type { WorkCycle, WorkspaceId, WorktreeId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';

export interface WorkCycleRepository {
  insert(cycle: WorkCycle): WorkCycle;
  find(workspaceId: WorkspaceId, id: string): WorkCycle | undefined;
  list(workspaceId?: WorkspaceId): readonly WorkCycle[];
  activeForWorktree(workspaceId: WorkspaceId, worktreeId: WorktreeId): WorkCycle | undefined;
  replace(cycle: WorkCycle, expectedVersion: number): WorkCycle | undefined;
}
function map(row: unknown): WorkCycle | undefined {
  return row === undefined
    ? undefined
    : (JSON.parse((row as { state_json: string }).state_json) as WorkCycle);
}
export class SqliteWorkCycleRepository implements WorkCycleRepository {
  constructor(private readonly database: Database.Database) {}
  insert(cycle: WorkCycle): WorkCycle {
    const state = cycle;
    this.database
      .prepare(
        'INSERT INTO work_cycles (id, workspace_id, work_item_id, worktree_id, status, version, state_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        state.id,
        state.workspaceId,
        state.workItemId,
        state.worktreeId,
        state.status,
        state.version,
        JSON.stringify(state),
      );
    return state;
  }
  find(workspaceId: WorkspaceId, id: string): WorkCycle | undefined {
    return map(
      this.database
        .prepare('SELECT state_json FROM work_cycles WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, id),
    );
  }
  list(workspaceId?: WorkspaceId): readonly WorkCycle[] {
    const rows =
      workspaceId === undefined
        ? this.database
            .prepare(
              "SELECT state_json FROM work_cycles WHERE status NOT IN ('stopped', 'completed') ORDER BY rowid",
            )
            .all()
        : this.database
            .prepare(
              'SELECT state_json FROM work_cycles WHERE workspace_id = ? ORDER BY rowid DESC',
            )
            .all(workspaceId);
    return rows.map((row) => map(row) as WorkCycle);
  }
  activeForWorktree(workspaceId: WorkspaceId, worktreeId: WorktreeId): WorkCycle | undefined {
    return map(
      this.database
        .prepare(
          "SELECT state_json FROM work_cycles WHERE workspace_id = ? AND worktree_id = ? AND status NOT IN ('stopped', 'completed')",
        )
        .get(workspaceId, worktreeId),
    );
  }
  replace(cycle: WorkCycle, expectedVersion: number): WorkCycle | undefined {
    const state = cycle;
    const result = this.database
      .prepare(
        'UPDATE work_cycles SET status = ?, version = ?, state_json = ? WHERE workspace_id = ? AND id = ? AND version = ?',
      )
      .run(
        state.status,
        state.version,
        JSON.stringify(state),
        state.workspaceId,
        state.id,
        expectedVersion,
      );
    return result.changes === 0 ? undefined : state;
  }
}
