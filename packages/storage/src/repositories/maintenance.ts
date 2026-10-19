import type { AgentRunId, UserId, WorktreeId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type {
  DaemonCleanStop,
  RunDirectory,
  RunLaunchReservation,
  StartupTask,
  StorageBackup,
  StorageMaintenanceRepository,
  StoredStorageSettings,
  WorktreeBuildCache,
} from '../maintenance-types.js';
import { parseRecord, type RecordGuard } from '../records.js';
/**
 * The runs whose `run-finished` event says how their process ended (an exit code or a signal), as
 * a run directory's build cleanup needs (R-B5, decision 11). The journal is append-only (its
 * triggers refuse an update or a delete) and its sequence only grows, so the set is read once and
 * then extended from the last sequence seen, instead of scanning every run's events on each read.
 * A read inside a write transaction keeps nothing it learns: an event a transaction that rolls
 * back appended must never stay in the set.
 */
export class ExitedRuns {
  private through = 0;
  private readonly runs = new Set<string>();

  read(database: Database.Database): ReadonlySet<string> {
    const newer = database
      .prepare(
        `SELECT run_id AS runId FROM agent_run_events WHERE sequence > ? AND kind = 'run-finished'
         AND (json_type(payload_json, '$.exitCode') = 'integer' OR json_type(payload_json, '$.signal') = 'text')`,
      )
      .all(this.through) as { runId: string }[];
    if (database.inTransaction) return new Set([...this.runs, ...newer.map((row) => row.runId)]);
    for (const row of newer) this.runs.add(row.runId);
    this.through =
      (
        database.prepare('SELECT MAX(sequence) AS last FROM agent_run_events').get() as {
          last: number | null;
        }
      ).last ?? 0;
    return this.runs;
  }
}

export class SqliteStorageMaintenanceRepository implements StorageMaintenanceRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
    private readonly exited: ExitedRuns = new ExitedRuns(),
  ) {}
  settings(): StoredStorageSettings | undefined {
    const row = this.database
      .prepare('SELECT state_json FROM storage_settings WHERE id = 1')
      .get() as { state_json: string } | undefined;
    return row ? parseRecord('storage-settings', row.state_json) : undefined;
  }
  saveSettings(value: StoredStorageSettings): void {
    this.guard('storage-settings', value);
    this.database
      .prepare(
        'INSERT INTO storage_settings (id, version, state_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json',
      )
      .run(value.version, JSON.stringify(value));
  }
  worktreeCache(worktreeId: WorktreeId): WorktreeBuildCache | undefined {
    return this.database
      .prepare(
        'SELECT worktree_id AS worktreeId, workspace_id AS workspaceId, path, device, created_at AS createdAt FROM worktree_build_caches WHERE worktree_id = ?',
      )
      .get(worktreeId) as WorktreeBuildCache | undefined;
  }
  registerWorktreeCache(cache: WorktreeBuildCache): void {
    this.database
      .prepare(
        'INSERT INTO worktree_build_caches (worktree_id, workspace_id, path, device, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(worktree_id) DO NOTHING',
      )
      .run(cache.worktreeId, cache.workspaceId, cache.path, cache.device, cache.createdAt);
  }
  worktreeCaches(): readonly (WorktreeBuildCache & { readonly eligible: boolean })[] {
    return (
      this.database
        .prepare(
          `SELECT c.worktree_id AS worktreeId, c.workspace_id AS workspaceId, c.path, c.device,
             c.created_at AS createdAt,
             (w.status = 'removed' AND NOT EXISTS (
               SELECT 1 FROM agent_runs live WHERE live.worktree_id = w.id
                 AND live.status NOT IN ('finished','failed','cancelled','interrupted'))) AS eligible
           FROM worktree_build_caches c JOIN worktrees w ON w.id = c.worktree_id
           ORDER BY c.created_at`,
        )
        .all() as (WorktreeBuildCache & { eligible: number })[]
    ).map((row) => ({ ...row, eligible: row.eligible === 1 }));
  }
  forgetWorktreeCache(worktreeId: WorktreeId): void {
    this.database
      .prepare('DELETE FROM worktree_build_caches WHERE worktree_id = ?')
      .run(worktreeId);
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
  directory(runId: AgentRunId): { path: string; device: number } | undefined {
    return this.database
      .prepare('SELECT path, device FROM run_directories WHERE run_id = ?')
      .get(runId) as { path: string; device: number } | undefined;
  }
  directories(
    scope: { readonly worktreeId?: WorktreeId; readonly runId?: AgentRunId } = {},
  ): readonly RunDirectory[] {
    // One pass over the worktrees with a live run, not one scan of every run per directory
    // (R-B5, decision 11: the correlated form grew with the square of the runs and stalled the
    // event loop for about 100 ms on every storage watch).
    const rows = this.database
      .prepare(`WITH live AS (SELECT DISTINCT worktree_id FROM agent_runs WHERE status NOT IN ('finished','failed','cancelled','interrupted'))
      SELECT d.run_id AS runId, r.workspace_id AS workspaceId, w.id AS worktreeId, d.path, d.device, MAX(COALESCE(r.finished_at, r.created_at), COALESCE(w.removed_at, w.created_at)) AS retainedSince,
      (r.status IN ('finished','failed','cancelled','interrupted') AND w.status = 'removed' AND w.merged_at IS NOT NULL
       AND w.id NOT IN live) AS eligible,
      (r.status IN ('finished','failed','cancelled') AND w.id NOT IN live) AS ended
      FROM run_directories d JOIN agent_runs r ON r.id = d.run_id JOIN worktrees w ON w.id = r.worktree_id
      WHERE (@worktreeId IS NULL OR w.id = @worktreeId) AND (@runId IS NULL OR d.run_id = @runId)`)
      .all({ worktreeId: scope.worktreeId ?? null, runId: scope.runId ?? null }) as (Omit<
      RunDirectory,
      'eligible' | 'buildEligible'
    > & {
      eligible: number;
      ended: number;
    })[];
    const exited = rows.some((row) => row.ended === 1)
      ? this.exited.read(this.database)
      : undefined;
    return rows.map(({ ended, ...row }) => ({
      ...row,
      eligible: row.eligible === 1,
      buildEligible: ended === 1 && !!exited?.has(row.runId),
    }));
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
  recordCleanStop(stop: DaemonCleanStop): void {
    this.database
      .prepare(
        'INSERT INTO daemon_clean_stop (id, stopped_at, interrupted_run_count) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET stopped_at = excluded.stopped_at, interrupted_run_count = excluded.interrupted_run_count',
      )
      .run(stop.stoppedAt, stop.interruptedRunCount);
  }
  takeCleanStop(): DaemonCleanStop | undefined {
    const row = this.database
      .prepare(
        'SELECT stopped_at AS stoppedAt, interrupted_run_count AS interruptedRunCount FROM daemon_clean_stop WHERE id = 1',
      )
      .get() as DaemonCleanStop | undefined;
    this.database.prepare('DELETE FROM daemon_clean_stop').run();
    return row;
  }
  reserveLaunch(reservation: RunLaunchReservation): void {
    this.database
      .prepare(
        `INSERT INTO run_launches (run_id, workspace_id, worktree_id, run_directory, run_device,
           reply_directory, reply_device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reservation.runId,
        reservation.workspaceId,
        reservation.worktreeId,
        reservation.runDirectory,
        reservation.runDevice,
        reservation.replyDirectory,
        reservation.replyDevice,
        reservation.createdAt,
      );
  }
  launchReservation(runId: AgentRunId): RunLaunchReservation | undefined {
    return this.database.prepare(`${LAUNCHES} WHERE run_id = ?`).get(runId) as
      | RunLaunchReservation
      | undefined;
  }
  launchReservations(): readonly RunLaunchReservation[] {
    return this.database
      .prepare(`${LAUNCHES} ORDER BY created_at, run_id`)
      .all() as RunLaunchReservation[];
  }
  dropLaunch(runId: AgentRunId): void {
    this.database.prepare('DELETE FROM run_launches WHERE run_id = ?').run(runId);
  }
  ownsRunDirectory(runId: string, path: string): boolean {
    return !!this.database
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ?)
           OR EXISTS (SELECT 1 FROM run_directories WHERE run_id = ? OR path = ?)
           OR EXISTS (SELECT 1 FROM run_launches WHERE run_id = ? OR run_directory = ?)`,
      )
      .get(runId, runId, path, runId, path);
  }
  startupTaskPending(task: StartupTask): boolean {
    return !!this.database.prepare('SELECT 1 FROM startup_tasks WHERE task = ?').get(task);
  }
  completeStartupTask(task: StartupTask): void {
    this.database.prepare('DELETE FROM startup_tasks WHERE task = ?').run(task);
  }
}

const LAUNCHES = `SELECT run_id AS runId, workspace_id AS workspaceId, worktree_id AS worktreeId,
  run_directory AS runDirectory, run_device AS runDevice, reply_directory AS replyDirectory,
  reply_device AS replyDevice, created_at AS createdAt FROM run_launches`;
