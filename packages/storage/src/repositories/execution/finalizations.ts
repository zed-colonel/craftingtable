import type { Finalization, WorkspaceId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { parseRecord, type RecordGuard } from '../../records.js';
export interface FinalizationRepository {
  save(value: Finalization, expectedVersion: number): boolean;
  find(workspaceId: WorkspaceId, id: string): Finalization | undefined;
  list(workspaceId?: WorkspaceId): readonly Finalization[];
}
function map(row: unknown): Finalization | undefined {
  return row === undefined
    ? undefined
    : parseRecord('finalization', (row as { state_json: string }).state_json);
}
export class SqliteFinalizationRepository implements FinalizationRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  save(value: Finalization, expectedVersion: number): boolean {
    this.guard('finalization', value);
    if (!expectedVersion) {
      this.database
        .prepare(
          'INSERT INTO finalizations (id, workspace_id, plan_version_id, status, version, state_json) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          value.id,
          value.workspaceId,
          value.planVersionId,
          value.status,
          value.version,
          JSON.stringify(value),
        );
      return true;
    }
    return (
      this.database
        .prepare(
          'UPDATE finalizations SET status = ?, version = ?, state_json = ? WHERE workspace_id = ? AND id = ? AND version = ?',
        )
        .run(
          value.status,
          value.version,
          JSON.stringify(value),
          value.workspaceId,
          value.id,
          expectedVersion,
        ).changes === 1
    );
  }
  find(workspaceId: WorkspaceId, id: string): Finalization | undefined {
    return map(
      this.database
        .prepare('SELECT state_json FROM finalizations WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, id),
    );
  }
  list(workspaceId?: WorkspaceId): readonly Finalization[] {
    const rows = workspaceId
      ? this.database
          .prepare(
            'SELECT state_json FROM finalizations WHERE workspace_id = ? ORDER BY rowid DESC',
          )
          .all(workspaceId)
      : this.database.prepare('SELECT state_json FROM finalizations ORDER BY rowid DESC').all();
    return rows.map((row) => map(row) as Finalization);
  }
}
