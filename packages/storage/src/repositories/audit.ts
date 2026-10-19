import type { AuditEvent, UserId, WorkspaceId } from '@craftingtable/domain';
import { asRoadmapId, asWorkCycleId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { type RecordGuard, readRecord, readWritten } from '../records.js';
import type { AppendAuditInput, AuditRepository } from '../types.js';

export interface AuditRow {
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

export function mapAudit(row: AuditRow): AuditEvent {
  return readRecord('audit-event', {
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
    metadata: JSON.parse(row.metadata_json),
  });
}

export class SqliteAuditRepository implements AuditRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
  ) {}

  /**
   * Appends and guards one audit record. Its own transaction (a savepoint inside a caller's)
   * keeps a record the guard refuses from staying committed when the caller has none.
   */
  append(input: AppendAuditInput): AuditEvent {
    return this.database.transaction(() => this.insert(input))();
  }

  lastUserAction(workspaceId: WorkspaceId, userId?: UserId): string | undefined {
    const row = (
      userId === undefined
        ? this.database
            .prepare(
              "SELECT max(occurred_at) AS at FROM audit_events WHERE workspace_id = ? AND actor_kind = 'user'",
            )
            .get(workspaceId)
        : this.database
            .prepare(
              "SELECT max(occurred_at) AS at FROM audit_events WHERE workspace_id = ? AND actor_kind = 'user' AND actor_user_id = ?",
            )
            .get(workspaceId, userId)
    ) as { at: string | null };
    return row.at ?? undefined;
  }

  private insert(input: AppendAuditInput): AuditEvent {
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
    const event = readWritten(() => mapAudit(row));
    this.guard('audit-event', event);
    return event;
  }

  /**
   * Cycle transitions recorded up to `until`: every one from `from` on, plus each cycle's
   * last transition before `from`, which gives the state the cycle was in when the window
   * opened. Older rows are not read or parsed. Each is a step of the cycle's history (R-B4
   * decision 9): the status it left, and the controller decision's kind and guard that wrote it,
   * where the row records them (rows before R-B4b, and operator commands, carry no decision).
   */
  listCycleTransitions(workspaceId: WorkspaceId, from: string, until: string) {
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    return this.transitions('work-cycle.updated', workspaceId, from, until).map(
      ({ targetId, ...row }) => ({
        cycleId: asWorkCycleId(targetId),
        ...row,
        previousStatus: text(row.metadata.previousStatus),
        decision: text(row.metadata.decision),
        guard: text(row.metadata.guard),
      }),
    );
  }

  /** Roadmap writes recorded up to `until`, read as cycle transitions are (R-C10's follow-up). */
  listRoadmapTransitions(workspaceId: WorkspaceId, from: string, until: string) {
    return this.transitions('roadmap.updated', workspaceId, from, until).map(
      ({ targetId, ...row }) => ({ roadmapId: asRoadmapId(targetId), ...row }),
    );
  }

  private transitions(action: string, workspaceId: WorkspaceId, from: string, until: string) {
    return (
      this.database
        .prepare(
          `SELECT target_id, occurred_at, metadata_json FROM audit_events
           WHERE workspace_id = ? AND action = ? AND target_id IS NOT NULL
             AND occurred_at <= ?
             AND (occurred_at >= ? OR sequence IN (
               SELECT MAX(sequence) FROM audit_events
               WHERE workspace_id = ? AND action = ?
                 AND target_id IS NOT NULL AND occurred_at < ?
               GROUP BY target_id))
           ORDER BY sequence`,
        )
        .all(workspaceId, action, until, from, workspaceId, action, from) as {
        target_id: string;
        occurred_at: string;
        metadata_json: string;
      }[]
    ).map((row) => ({
      targetId: row.target_id,
      occurredAt: row.occurred_at,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    }));
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
