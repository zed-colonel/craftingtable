import type { AttentionItem, NotificationDelivery, WorkspaceId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type { AttentionRepository } from '../notification-types.js';
import { parseRecord, type RecordGuard } from '../records.js';

const item = (row: unknown) =>
  parseRecord('attention-item', (row as { state_json: string }).state_json);
const delivery = (row: unknown) =>
  parseRecord('notification-delivery', (row as { state_json: string }).state_json);

export class SqliteAttentionRepository implements AttentionRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  open(workspaceId?: WorkspaceId): readonly AttentionItem[] {
    return (
      workspaceId === undefined
        ? this.database
            .prepare("SELECT state_json FROM attention_items WHERE state = 'open' ORDER BY rowid")
            .all()
        : this.database
            .prepare(
              "SELECT state_json FROM attention_items WHERE workspace_id = ? AND state = 'open' ORDER BY rowid",
            )
            .all(workspaceId)
    ).map(item);
  }
  openInScope(workspaceId: WorkspaceId, scopeKey: string): readonly AttentionItem[] {
    return this.database
      .prepare(
        "SELECT state_json FROM attention_items WHERE workspace_id = ? AND scope_key = ? AND state = 'open' ORDER BY rowid",
      )
      .all(workspaceId, scopeKey)
      .map(item);
  }
  openScopes(): readonly { readonly workspaceId: WorkspaceId; readonly scopeKey: string }[] {
    return (
      this.database
        .prepare(
          "SELECT DISTINCT workspace_id, scope_key FROM attention_items WHERE state = 'open' ORDER BY workspace_id, scope_key",
        )
        .all() as { workspace_id: string; scope_key: string }[]
    ).map((row) => ({ workspaceId: row.workspace_id as WorkspaceId, scopeKey: row.scope_key }));
  }
  find(workspaceId: WorkspaceId, id: string): AttentionItem | undefined {
    const row = this.database
      .prepare('SELECT state_json FROM attention_items WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, id);
    return row === undefined ? undefined : item(row);
  }
  latest(workspaceId: WorkspaceId, subjectKey: string, code: string): AttentionItem | undefined {
    const row = this.database
      .prepare(
        'SELECT state_json FROM attention_items WHERE workspace_id = ? AND subject_key = ? AND code = ? ORDER BY opened_at DESC, rowid DESC LIMIT 1',
      )
      .get(workspaceId, subjectKey, code);
    return row === undefined ? undefined : item(row);
  }
  recent(workspaceId: WorkspaceId, limit: number): readonly AttentionItem[] {
    return this.database
      .prepare(
        'SELECT state_json FROM attention_items WHERE workspace_id = ? ORDER BY max(opened_at, coalesce(resolved_at, opened_at)) DESC, rowid DESC LIMIT ?',
      )
      .all(workspaceId, limit)
      .map(item);
  }
  insert(value: AttentionItem): void {
    this.guard('attention-item', value);
    this.database
      .prepare(
        `INSERT INTO attention_items
         (id, workspace_id, scope_key, subject_key, code, state, opened_at, resolved_at, resolved_by, state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...this.columns(value));
  }
  update(value: AttentionItem): void {
    this.guard('attention-item', value);
    const [
      id,
      workspaceId,
      scopeKey,
      subjectKey,
      code,
      state,
      openedAt,
      resolvedAt,
      resolvedBy,
      json,
    ] = this.columns(value);
    const result = this.database
      .prepare(
        `UPDATE attention_items SET scope_key = ?, subject_key = ?, code = ?, state = ?, opened_at = ?,
         resolved_at = ?, resolved_by = ?, state_json = ? WHERE id = ? AND workspace_id = ?`,
      )
      .run(
        scopeKey,
        subjectKey,
        code,
        state,
        openedAt,
        resolvedAt,
        resolvedBy,
        json,
        id,
        workspaceId,
      );
    if (result.changes !== 1) throw new Error(`Attention item ${value.id} does not exist.`);
  }
  appendDelivery(value: NotificationDelivery): void {
    this.guard('notification-delivery', value);
    this.database
      .prepare(
        'INSERT INTO notification_deliveries (id, workspace_id, attempted_at, result, state_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(value.id, value.workspaceId, value.attemptedAt, value.result, JSON.stringify(value));
  }
  deliveries(workspaceId: WorkspaceId, limit: number): readonly NotificationDelivery[] {
    return this.database
      .prepare(
        'SELECT state_json FROM notification_deliveries WHERE workspace_id = ? ORDER BY attempted_at DESC, rowid DESC LIMIT ?',
      )
      .all(workspaceId, limit)
      .map(delivery);
  }
  falseAlarms(workspaceId: WorkspaceId): readonly AttentionItem[] {
    return this.database
      .prepare(
        `SELECT i.state_json FROM attention_items i
         WHERE i.workspace_id = ? AND i.resolved_by = 'automation' AND EXISTS (
           SELECT 1 FROM notification_deliveries d, json_each(d.state_json, '$.itemIds') e
           WHERE d.workspace_id = i.workspace_id AND d.result = 'accepted' AND e.value = i.id)
         ORDER BY i.rowid`,
      )
      .all(workspaceId)
      .map(item);
  }
  private columns(value: AttentionItem) {
    return [
      value.id,
      value.workspaceId,
      value.scopeKey,
      value.subjectKey,
      value.code,
      value.state,
      value.openedAt,
      value.resolvedAt ?? null,
      value.resolvedBy ?? null,
      JSON.stringify(value),
    ] as const;
  }
}
