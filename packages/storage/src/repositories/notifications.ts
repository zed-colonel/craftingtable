import type { WorkspaceId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type {
  NotificationRecord,
  NotificationRepository,
  StoredNotificationSettings,
} from '../notification-types.js';
import { parseRecord, type RecordGuard } from '../records.js';

function read<K extends 'notification-settings' | 'notification-record'>(kind: K, row: unknown) {
  return row === undefined
    ? undefined
    : parseRecord(kind, (row as { state_json: string }).state_json);
}
export class SqliteNotificationRepository implements NotificationRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  settings(workspaceId: WorkspaceId): StoredNotificationSettings | undefined {
    return read(
      'notification-settings',
      this.database
        .prepare('SELECT state_json FROM notification_settings WHERE workspace_id = ?')
        .get(workspaceId),
    );
  }
  listSettings(): readonly StoredNotificationSettings[] {
    return this.database
      .prepare('SELECT state_json FROM notification_settings ORDER BY workspace_id')
      .all()
      .map((row) => read('notification-settings', row) as StoredNotificationSettings);
  }
  saveSettings(settings: StoredNotificationSettings): void {
    this.guard('notification-settings', settings);
    this.database
      .prepare(
        'INSERT INTO notification_settings (workspace_id, state_json) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET state_json = excluded.state_json',
      )
      .run(settings.workspaceId, JSON.stringify(settings));
  }
  records(workspaceId: WorkspaceId, activeOnly = false): readonly NotificationRecord[] {
    const rows = activeOnly
      ? this.database
          .prepare(
            "SELECT state_json FROM notification_records WHERE workspace_id = ? AND state = 'active' ORDER BY rowid DESC",
          )
          .all(workspaceId)
      : this.database
          .prepare(
            'SELECT state_json FROM notification_records WHERE workspace_id = ? ORDER BY rowid DESC',
          )
          .all(workspaceId);
    return rows.map((row) => read('notification-record', row) as NotificationRecord);
  }
  find(workspaceId: WorkspaceId, id: string): NotificationRecord | undefined {
    return read(
      'notification-record',
      this.database
        .prepare('SELECT state_json FROM notification_records WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, id),
    );
  }
  saveRecord(record: NotificationRecord): void {
    this.guard('notification-record', record);
    this.database
      .prepare(
        'INSERT INTO notification_records (id, workspace_id, source_key, state, state_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, state_json = excluded.state_json',
      )
      .run(record.id, record.workspaceId, record.sourceKey, record.state, JSON.stringify(record));
  }
}
