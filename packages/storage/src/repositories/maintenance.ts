import type { AgentRunId, UserId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type {
  RunDirectory,
  StorageBackup,
  StorageMaintenanceRepository,
  StoredStorageSettings,
} from '../maintenance-types.js';
export class SqliteStorageMaintenanceRepository implements StorageMaintenanceRepository {
  constructor(private readonly database: Database.Database) {}
  settings(): StoredStorageSettings | undefined {
    const row = this.database
      .prepare('SELECT state_json FROM storage_settings WHERE id = 1')
      .get() as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as StoredStorageSettings) : undefined;
  }
  saveSettings(value: StoredStorageSettings): void {
    this.database
      .prepare(
        'INSERT INTO storage_settings (id, version, state_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json',
      )
      .run(value.version, JSON.stringify(value));
  }
  ownsInstallation(userId: UserId): boolean {
    return !!this.database
      .prepare(`SELECT 1 WHERE EXISTS (SELECT 1 FROM workspaces WHERE status = 'active') AND NOT EXISTS (
      SELECT 1 FROM workspaces w WHERE w.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = w.id AND m.user_id = ? AND m.role = 'owner' AND m.status = 'active'))`)
      .get(userId);
  }
  registerRunDirectory(runId: AgentRunId, path: string, device: number): void {
    this.database
      .prepare(
        'INSERT INTO run_directories (run_id, path, device) VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING',
      )
      .run(runId, path, device);
  }
  unregisteredRuns(): readonly { id: AgentRunId }[] {
    return this.database
      .prepare('SELECT id FROM agent_runs WHERE id NOT IN (SELECT run_id FROM run_directories)')
      .all() as { id: AgentRunId }[];
  }
  directories(): readonly RunDirectory[] {
    const rows = this.database
      .prepare(`SELECT d.run_id AS runId, r.workspace_id AS workspaceId, d.path, d.device, MAX(COALESCE(r.finished_at, r.created_at), COALESCE(w.removed_at, w.created_at)) AS retainedSince,
      (r.status IN ('finished','failed','cancelled','interrupted') AND w.status = 'removed' AND w.merged_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM agent_runs live WHERE live.worktree_id = w.id AND live.status NOT IN ('finished','failed','cancelled','interrupted'))) AS eligible
      FROM run_directories d JOIN agent_runs r ON r.id = d.run_id JOIN worktrees w ON w.id = r.worktree_id`)
      .all() as (Omit<RunDirectory, 'eligible'> & { eligible: number })[];
    return rows.map((row) => ({ ...row, eligible: row.eligible === 1 }));
  }
  protectedPaths(): readonly string[] {
    return (
      this.database
        .prepare(
          `SELECT root_path AS path FROM source_repositories UNION SELECT path FROM worktrees WHERE status = 'active'`,
        )
        .all() as { path: string }[]
    ).map((row) => row.path);
  }
  activeWorktreePaths(): readonly string[] {
    return (
      this.database.prepare("SELECT path FROM worktrees WHERE status = 'active'").all() as {
        path: string;
      }[]
    ).map((row) => row.path);
  }
  backups(): readonly StorageBackup[] {
    return this.database
      .prepare(
        'SELECT path, created_at AS createdAt, bytes FROM storage_backups ORDER BY created_at DESC, path DESC',
      )
      .all() as StorageBackup[];
  }
  saveBackup(backup: StorageBackup): void {
    this.database
      .prepare('INSERT INTO storage_backups (path, created_at, bytes) VALUES (?, ?, ?)')
      .run(backup.path, backup.createdAt, backup.bytes);
  }
  forgetBackup(path: string): void {
    this.database.prepare('DELETE FROM storage_backups WHERE path = ?').run(path);
  }
}
