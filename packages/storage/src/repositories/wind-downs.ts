import type {
  PlanVersionId,
  PlanVersionRetirement,
  RepositoryCleanup,
  RetirementDisposition,
  RoadmapWindDown,
  RoadmapWindDownId,
  UserId,
  WorkspaceId,
  RoadmapId,
  RepositoryCleanupId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { parseRecord, type RecordGuard } from '../records.js';

/**
 * Winding down a roadmap (R-B11, ADR-073): each roadmap's settlement record, the plan versions
 * its wind-downs retired, and its repository cleanups. Retirements are immutable rows; the two
 * records move forward by version and are never deleted.
 */
export interface WindDownRepository {
  /** The roadmap's settlement record, if a Stop or wind-down ever began. */
  find(ws: WorkspaceId, roadmapId: RoadmapId): RoadmapWindDown | undefined;
  /** Every record still settling, in every workspace, oldest first: the holds to resume. */
  settling(): readonly RoadmapWindDown[];
  insert(record: RoadmapWindDown): void;
  /** Writes the next version; false when the stored one is no longer `expectedVersion`. */
  replace(record: RoadmapWindDown, expectedVersion: number): boolean;
  /** Records a retirement once; a second one of the same version is ignored. */
  retire(retirement: PlanVersionRetirement): boolean;
  retirement(ws: WorkspaceId, planVersionId: PlanVersionId): PlanVersionRetirement | undefined;
  /** The workspace's retired versions, or every workspace's. */
  retirements(ws?: WorkspaceId): readonly PlanVersionRetirement[];
  cleanup(ws: WorkspaceId, id: RepositoryCleanupId): RepositoryCleanup | undefined;
  /** The roadmap's running cleanup, which a repeated command resumes. */
  runningCleanup(ws: WorkspaceId, roadmapId: RoadmapId): RepositoryCleanup | undefined;
  /** The roadmap's newest cleanup, running or done. */
  latestCleanup(ws: WorkspaceId, roadmapId: RoadmapId): RepositoryCleanup | undefined;
  /** Every running cleanup, in every workspace. */
  runningCleanups(): readonly RepositoryCleanup[];
  insertCleanup(record: RepositoryCleanup): void;
  replaceCleanup(record: RepositoryCleanup, expectedVersion: number): boolean;
}

interface RetirementRow {
  readonly plan_version_id: PlanVersionId;
  readonly workspace_id: WorkspaceId;
  readonly disposition: RetirementDisposition;
  readonly wind_down_id: RoadmapWindDownId;
  readonly retired_by_user_id: UserId;
  readonly retired_at: string;
}

function mapRetirement(row: RetirementRow): PlanVersionRetirement {
  return {
    workspaceId: row.workspace_id,
    planVersionId: row.plan_version_id,
    disposition: row.disposition,
    windDownId: row.wind_down_id,
    retiredAt: row.retired_at,
    retiredByUserId: row.retired_by_user_id,
  };
}

export class SqliteWindDownRepository implements WindDownRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  find(ws: WorkspaceId, roadmapId: RoadmapId): RoadmapWindDown | undefined {
    const row = this.db
      .prepare('SELECT record_json FROM roadmap_wind_downs WHERE workspace_id=? AND roadmap_id=?')
      .get(ws, roadmapId) as { record_json: string } | undefined;
    return row && parseRecord('roadmap-wind-down', row.record_json);
  }
  settling(): readonly RoadmapWindDown[] {
    return (
      this.db
        .prepare(
          "SELECT record_json FROM roadmap_wind_downs WHERE status='settling' ORDER BY rowid",
        )
        .all() as { record_json: string }[]
    ).map((row) => parseRecord('roadmap-wind-down', row.record_json));
  }
  insert(record: RoadmapWindDown): void {
    this.guard('roadmap-wind-down', record);
    this.db
      .prepare('INSERT INTO roadmap_wind_downs VALUES (?,?,?,?,?,?)')
      .run(
        record.id,
        record.workspaceId,
        record.roadmapId,
        record.status,
        record.version,
        JSON.stringify(record),
      );
  }
  replace(record: RoadmapWindDown, expectedVersion: number): boolean {
    this.guard('roadmap-wind-down', record);
    return (
      this.db
        .prepare(
          'UPDATE roadmap_wind_downs SET status=?, version=?, record_json=? WHERE workspace_id=? AND id=? AND version=?',
        )
        .run(
          record.status,
          record.version,
          JSON.stringify(record),
          record.workspaceId,
          record.id,
          expectedVersion,
        ).changes === 1
    );
  }
  retire(r: PlanVersionRetirement): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO retired_plan_versions VALUES (?,?,?,?,?,?)')
        .run(
          r.planVersionId,
          r.workspaceId,
          r.disposition,
          r.windDownId,
          r.retiredByUserId,
          r.retiredAt,
        ).changes === 1
    );
  }
  retirement(ws: WorkspaceId, planVersionId: PlanVersionId): PlanVersionRetirement | undefined {
    const row = this.db
      .prepare('SELECT * FROM retired_plan_versions WHERE workspace_id=? AND plan_version_id=?')
      .get(ws, planVersionId) as RetirementRow | undefined;
    return row && mapRetirement(row);
  }
  retirements(ws?: WorkspaceId): readonly PlanVersionRetirement[] {
    const rows = (
      ws === undefined
        ? this.db.prepare('SELECT * FROM retired_plan_versions ORDER BY rowid').all()
        : this.db
            .prepare('SELECT * FROM retired_plan_versions WHERE workspace_id=? ORDER BY rowid')
            .all(ws)
    ) as RetirementRow[];
    return rows.map(mapRetirement);
  }
  cleanup(ws: WorkspaceId, id: RepositoryCleanupId): RepositoryCleanup | undefined {
    const row = this.db
      .prepare('SELECT record_json FROM repository_cleanups WHERE workspace_id=? AND id=?')
      .get(ws, id) as { record_json: string } | undefined;
    return row && parseRecord('repository-cleanup', row.record_json);
  }
  runningCleanup(ws: WorkspaceId, roadmapId: RoadmapId): RepositoryCleanup | undefined {
    const row = this.db
      .prepare(
        "SELECT record_json FROM repository_cleanups WHERE workspace_id=? AND roadmap_id=? AND status='running'",
      )
      .get(ws, roadmapId) as { record_json: string } | undefined;
    return row && parseRecord('repository-cleanup', row.record_json);
  }
  latestCleanup(ws: WorkspaceId, roadmapId: RoadmapId): RepositoryCleanup | undefined {
    const row = this.db
      .prepare(
        'SELECT record_json FROM repository_cleanups WHERE workspace_id=? AND roadmap_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(ws, roadmapId) as { record_json: string } | undefined;
    return row && parseRecord('repository-cleanup', row.record_json);
  }
  runningCleanups(): readonly RepositoryCleanup[] {
    return (
      this.db
        .prepare(
          "SELECT record_json FROM repository_cleanups WHERE status='running' ORDER BY rowid",
        )
        .all() as { record_json: string }[]
    ).map((row) => parseRecord('repository-cleanup', row.record_json));
  }
  insertCleanup(record: RepositoryCleanup): void {
    this.guard('repository-cleanup', record);
    this.db
      .prepare('INSERT INTO repository_cleanups VALUES (?,?,?,?,?,?)')
      .run(
        record.id,
        record.workspaceId,
        record.roadmapId,
        record.status,
        record.version,
        JSON.stringify(record),
      );
  }
  replaceCleanup(record: RepositoryCleanup, expectedVersion: number): boolean {
    this.guard('repository-cleanup', record);
    return (
      this.db
        .prepare(
          'UPDATE repository_cleanups SET status=?, version=?, record_json=? WHERE workspace_id=? AND id=? AND version=?',
        )
        .run(
          record.status,
          record.version,
          JSON.stringify(record),
          record.workspaceId,
          record.id,
          expectedVersion,
        ).changes === 1
    );
  }
}
