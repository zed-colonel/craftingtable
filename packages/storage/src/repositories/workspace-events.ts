import type {
  WorkspaceEvent,
  WorkspaceEventKind,
  WorkspaceEventPayload,
  WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type {
  AppendWorkspaceCreatedInput,
  AppendWorkspaceEventInput,
  WorkspaceEventRepository,
} from '../types.js';

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
  kind: WorkspaceEventKind;
  payload_json: string;
}

type EventBase = Omit<WorkspaceEvent, 'kind' | 'payload'>;

function mapBase(row: WorkspaceEventRow): EventBase {
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
  };
}

/**
 * Maps a journal row to its discriminated domain event.
 *
 * The switch is exhaustive by kind, so registering a new workspace-event kind
 * fails to compile until this mapper handles it — the row shape and the domain
 * union cannot drift apart silently. Payload *shape* is enforced by the strict
 * contracts before anything crosses the wire (ADR-003).
 */
function mapEvent(row: WorkspaceEventRow): WorkspaceEvent {
  const base = mapBase(row);
  switch (row.kind) {
    case 'workspace-created':
      return {
        ...base,
        kind: 'workspace-created',
        payload: JSON.parse(row.payload_json) as WorkspaceEventPayload<'workspace-created'>,
      };
    case 'project-created':
      return {
        ...base,
        kind: 'project-created',
        payload: JSON.parse(row.payload_json) as WorkspaceEventPayload<'project-created'>,
      };
    case 'plan-version-imported':
      return {
        ...base,
        kind: 'plan-version-imported',
        payload: JSON.parse(row.payload_json) as WorkspaceEventPayload<'plan-version-imported'>,
      };
    case 'work-item-admitted':
      return {
        ...base,
        kind: 'work-item-admitted',
        payload: JSON.parse(row.payload_json) as WorkspaceEventPayload<'work-item-admitted'>,
      };
  }
}

export class SqliteWorkspaceEventRepository implements WorkspaceEventRepository {
  constructor(private readonly database: Database.Database) {}

  appendWorkspaceCreated(input: AppendWorkspaceCreatedInput): WorkspaceEvent {
    return this.appendEvent({
      id: input.id,
      occurredAt: input.occurredAt,
      workspaceId: input.workspaceId,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      kind: 'workspace-created',
      payload: { name: input.name, slug: input.slug },
    });
  }

  appendEvent<K extends WorkspaceEventKind>(input: AppendWorkspaceEventInput<K>): WorkspaceEvent {
    const result = this.database
      .prepare(
        `INSERT INTO workspace_events (
          id, schema_version, occurred_at, workspace_id, actor_user_id,
          project_id, work_item_id, kind, payload_json
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.occurredAt,
        input.workspaceId,
        input.actorUserId ?? null,
        input.projectId ?? null,
        input.workItemId ?? null,
        input.kind,
        JSON.stringify(input.payload),
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
