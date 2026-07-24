import type { WorkspaceEvent, WorkspaceId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type { AppendWorkspaceCreatedInput, WorkspaceEventRepository } from '../types.js';

interface WorkspaceEventRow {
  sequence: number;
  id: string;
  schema_version: 1;
  occurred_at: string;
  workspace_id: string;
  actor_user_id: string | null;
  project_id: string | null;
  work_item_id: string | null;
  run_id: string | null;
  kind: 'workspace-created';
  payload_json: string;
}

function mapEvent(row: WorkspaceEventRow): WorkspaceEvent {
  const payload = JSON.parse(row.payload_json) as WorkspaceEvent['payload'];
  return {
    sequence: row.sequence,
    id: row.id as WorkspaceEvent['id'],
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    workspaceId: row.workspace_id as WorkspaceEvent['workspaceId'],
    ...(row.actor_user_id === null
      ? {}
      : { actorUserId: row.actor_user_id as NonNullable<WorkspaceEvent['actorUserId']> }),
    ...(row.project_id === null
      ? {}
      : { projectId: row.project_id as NonNullable<WorkspaceEvent['projectId']> }),
    ...(row.work_item_id === null
      ? {}
      : { workItemId: row.work_item_id as NonNullable<WorkspaceEvent['workItemId']> }),
    ...(row.run_id === null ? {} : { runId: row.run_id as NonNullable<WorkspaceEvent['runId']> }),
    kind: row.kind,
    payload,
  };
}

export class SqliteWorkspaceEventRepository implements WorkspaceEventRepository {
  constructor(private readonly database: Database.Database) {}

  appendWorkspaceCreated(input: AppendWorkspaceCreatedInput): WorkspaceEvent {
    const result = this.database
      .prepare(
        `INSERT INTO workspace_events (
          id, schema_version, occurred_at, workspace_id, actor_user_id, kind, payload_json
        ) VALUES (?, 1, ?, ?, ?, 'workspace-created', ?)`,
      )
      .run(
        input.id,
        input.occurredAt,
        input.workspaceId,
        input.actorUserId ?? null,
        JSON.stringify({ name: input.name, slug: input.slug }),
      );
    const row = this.database
      .prepare(`SELECT * FROM workspace_events WHERE sequence = ?`)
      .get(Number(result.lastInsertRowid)) as WorkspaceEventRow;
    return mapEvent(row);
  }

  count(): number {
    return (
      this.database.prepare(`SELECT COUNT(*) AS count FROM workspace_events`).get() as {
        count: number;
      }
    ).count;
  }

  maxSequence(): number {
    const row = this.database
      .prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workspace_events`)
      .get() as { sequence: number };
    return row.sequence;
  }

  listAfter(input: {
    readonly workspaceId: WorkspaceId;
    readonly after: number;
    readonly limit: number;
  }): readonly WorkspaceEvent[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM workspace_events
           WHERE workspace_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(input.workspaceId, input.after, input.limit) as WorkspaceEventRow[]
    ).map(mapEvent);
  }

  listRecentAtOrBefore(input: {
    readonly workspaceId: WorkspaceId;
    readonly asOfSequence: number;
    readonly limit: number;
  }): readonly WorkspaceEvent[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM (
             SELECT * FROM workspace_events
             WHERE workspace_id = ? AND sequence <= ?
             ORDER BY sequence DESC LIMIT ?
           ) ORDER BY sequence ASC`,
        )
        .all(input.workspaceId, input.asOfSequence, input.limit) as WorkspaceEventRow[]
    ).map(mapEvent);
  }
}
