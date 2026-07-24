import type { AuditEvent, WorkspaceId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type { AppendAuditInput, AuditRepository } from '../types.js';

interface AuditRow {
  sequence: number;
  id: string;
  occurred_at: string;
  actor_kind: 'system' | 'user';
  actor_user_id: string | null;
  session_id: string | null;
  workspace_id: string | null;
  request_id: string | null;
  action: AuditEvent['action'];
  target_type: string | null;
  target_id: string | null;
  outcome: AuditEvent['outcome'];
  prior_version: number | null;
  resulting_version: number | null;
  metadata_json: string;
}

function mapAudit(row: AuditRow): AuditEvent {
  return {
    sequence: row.sequence,
    id: row.id as AuditEvent['id'],
    occurredAt: row.occurred_at,
    actorKind: row.actor_kind,
    ...(row.actor_user_id === null
      ? {}
      : { actorUserId: row.actor_user_id as NonNullable<AuditEvent['actorUserId']> }),
    ...(row.session_id === null
      ? {}
      : { sessionId: row.session_id as NonNullable<AuditEvent['sessionId']> }),
    ...(row.workspace_id === null
      ? {}
      : { workspaceId: row.workspace_id as NonNullable<AuditEvent['workspaceId']> }),
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    action: row.action,
    ...(row.target_type === null ? {} : { targetType: row.target_type }),
    ...(row.target_id === null ? {} : { targetId: row.target_id }),
    outcome: row.outcome,
    ...(row.prior_version === null ? {} : { priorVersion: row.prior_version }),
    ...(row.resulting_version === null ? {} : { resultingVersion: row.resulting_version }),
    metadata: JSON.parse(row.metadata_json) as AuditEvent['metadata'],
  };
}

export class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly database: Database.Database) {}

  append(input: AppendAuditInput): AuditEvent {
    const result = this.database
      .prepare(
        `INSERT INTO audit_events (
          id, occurred_at, actor_kind, actor_user_id, session_id, workspace_id,
          request_id, action, target_type, target_id, outcome, prior_version,
          resulting_version, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.occurredAt,
        input.actorKind,
        input.actorUserId ?? null,
        input.sessionId ?? null,
        input.workspaceId ?? null,
        input.requestId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.outcome,
        input.priorVersion ?? null,
        input.resultingVersion ?? null,
        JSON.stringify(input.metadata ?? {}),
      );
    const row = this.database
      .prepare(`SELECT * FROM audit_events WHERE sequence = ?`)
      .get(Number(result.lastInsertRowid)) as AuditRow;
    return mapAudit(row);
  }

  count(): number {
    return (
      this.database.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get() as {
        count: number;
      }
    ).count;
  }

  listWorkspace(input: {
    readonly workspaceId: WorkspaceId;
    readonly limit: number;
    readonly before?: number;
  }): readonly AuditEvent[] {
    const rows =
      input.before === undefined
        ? (this.database
            .prepare(
              `SELECT * FROM audit_events
               WHERE workspace_id = ?
               ORDER BY sequence DESC LIMIT ?`,
            )
            .all(input.workspaceId, input.limit) as AuditRow[])
        : (this.database
            .prepare(
              `SELECT * FROM audit_events
               WHERE workspace_id = ? AND sequence < ?
               ORDER BY sequence DESC LIMIT ?`,
            )
            .all(input.workspaceId, input.before, input.limit) as AuditRow[]);
    return rows.map(mapAudit);
  }
}
