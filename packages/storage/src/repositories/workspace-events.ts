import {
  isWorkspaceEventKind,
  type WorkspaceEvent,
  type WorkspaceEventBase,
  type WorkspaceEventKind,
  type WorkspaceEventPayload,
  type WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import {
  type AppendWorkspaceCreatedInput,
  type AppendWorkspaceEventInput,
  WorkspaceEventAppendError,
  WorkspaceEventMappingError,
  type WorkspaceEventRepository,
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
  repository_id: string | null;
  repository_inspection_id: string | null;
  repository_binding_id: string | null;
  kind: string;
  payload_json: string;
}

type CommonEventFields = Pick<
  WorkspaceEventBase,
  'id' | 'sequence' | 'occurredAt' | 'workspaceId' | 'actorUserId' | 'schemaVersion'
>;

function mapBase(row: WorkspaceEventRow): WorkspaceEventBase {
  return {
    sequence: row.sequence,
    id: row.id as WorkspaceEventBase['id'],
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    workspaceId: row.workspace_id as WorkspaceEventBase['workspaceId'],
    ...(row.actor_user_id === null
      ? {}
      : { actorUserId: row.actor_user_id as NonNullable<WorkspaceEventBase['actorUserId']> }),
    ...(row.project_id === null
      ? {}
      : { projectId: row.project_id as NonNullable<WorkspaceEventBase['projectId']> }),
    ...(row.work_item_id === null
      ? {}
      : { workItemId: row.work_item_id as NonNullable<WorkspaceEventBase['workItemId']> }),
    ...(row.run_id === null
      ? {}
      : { runId: row.run_id as NonNullable<WorkspaceEventBase['runId']> }),
    ...(row.repository_id === null
      ? {}
      : {
          repositoryId: row.repository_id as NonNullable<WorkspaceEventBase['repositoryId']>,
        }),
    ...(row.repository_inspection_id === null
      ? {}
      : {
          repositoryInspectionId: row.repository_inspection_id as NonNullable<
            WorkspaceEventBase['repositoryInspectionId']
          >,
        }),
    ...(row.repository_binding_id === null
      ? {}
      : {
          repositoryBindingId: row.repository_binding_id as NonNullable<
            WorkspaceEventBase['repositoryBindingId']
          >,
        }),
  };
}

function commonFields(base: WorkspaceEventBase): CommonEventFields {
  return {
    id: base.id,
    sequence: base.sequence,
    occurredAt: base.occurredAt,
    workspaceId: base.workspaceId,
    schemaVersion: base.schemaVersion,
    ...(base.actorUserId === undefined ? {} : { actorUserId: base.actorUserId }),
  };
}

function legacyFields(base: WorkspaceEventBase) {
  return {
    ...commonFields(base),
    ...(base.projectId === undefined ? {} : { projectId: base.projectId }),
    ...(base.workItemId === undefined ? {} : { workItemId: base.workItemId }),
    ...(base.runId === undefined ? {} : { runId: base.runId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(row: WorkspaceEventRow): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch {
    throw new WorkspaceEventMappingError(
      'invalid-json',
      `Workspace event ${row.id} contains invalid JSON`,
    );
  }
  if (!isRecord(value)) {
    throw new WorkspaceEventMappingError(
      'invalid-json',
      `Workspace event ${row.id} payload is not an object`,
    );
  }
  return value;
}

function invalidStructural(row: WorkspaceEventRow): never {
  throw new WorkspaceEventMappingError(
    'invalid-structural-correlations',
    `Workspace event ${row.id} has correlations forbidden for ${row.kind}`,
  );
}

function assertStructuralShape(row: WorkspaceEventRow, kind: WorkspaceEventKind): void {
  const repositoryCorrelationsNull =
    row.repository_id === null &&
    row.repository_inspection_id === null &&
    row.repository_binding_id === null;
  switch (kind) {
    case 'workspace-created':
    case 'project-created':
    case 'plan-version-imported':
    case 'work-item-admitted':
      if (!repositoryCorrelationsNull) invalidStructural(row);
      return;
    case 'repository-registered':
    case 'repository-evidence-changed':
      if (
        row.repository_id === null ||
        row.repository_inspection_id === null ||
        row.repository_binding_id !== null ||
        row.project_id !== null ||
        row.work_item_id !== null ||
        row.run_id !== null
      ) {
        invalidStructural(row);
      }
      return;
    case 'repository-status-changed':
      if (
        row.repository_id === null ||
        row.repository_binding_id !== null ||
        row.project_id !== null ||
        row.work_item_id !== null ||
        row.run_id !== null
      ) {
        invalidStructural(row);
      }
      return;
    case 'project-repository-bound':
    case 'project-repository-binding-retired':
      if (
        row.repository_id === null ||
        row.repository_inspection_id !== null ||
        row.repository_binding_id === null ||
        row.project_id === null ||
        row.work_item_id !== null ||
        row.run_id !== null
      ) {
        invalidStructural(row);
      }
      return;
  }
}

function requireMatchingPayloadId(
  row: WorkspaceEventRow,
  payload: Record<string, unknown>,
  payloadKey: string,
  structuralValue: string,
): void {
  if (payload[payloadKey] !== structuralValue) {
    throw new WorkspaceEventMappingError(
      'payload-correlation-mismatch',
      `Workspace event ${row.id} payload ${payloadKey} disagrees with structural correlation`,
    );
  }
}

function assertPayloadCorrelations(
  row: WorkspaceEventRow,
  kind: WorkspaceEventKind,
  payload: Record<string, unknown>,
): void {
  switch (kind) {
    case 'workspace-created':
    case 'project-created':
    case 'plan-version-imported':
    case 'work-item-admitted':
      return;
    case 'repository-registered':
    case 'repository-evidence-changed':
      requireMatchingPayloadId(row, payload, 'repositoryId', row.repository_id as string);
      requireMatchingPayloadId(
        row,
        payload,
        'inspectionId',
        row.repository_inspection_id as string,
      );
      return;
    case 'repository-status-changed': {
      requireMatchingPayloadId(row, payload, 'repositoryId', row.repository_id as string);
      if (typeof payload.toStatus !== 'string' || typeof payload.statusReason !== 'string') {
        throw new WorkspaceEventMappingError(
          'invalid-retirement-correlation',
          `Workspace event ${row.id} cannot prove retirement correlation semantics`,
        );
      }
      const retirement =
        payload.toStatus === 'retired' && payload.statusReason === 'operator-retired';
      if (retirement) {
        if (row.repository_inspection_id !== null || payload.inspectionId !== undefined) {
          throw new WorkspaceEventMappingError(
            'invalid-retirement-correlation',
            `Workspace event ${row.id} operator retirement carries an inspection`,
          );
        }
        return;
      }
      if (row.repository_inspection_id === null) {
        throw new WorkspaceEventMappingError(
          'invalid-retirement-correlation',
          `Workspace event ${row.id} non-retirement status lacks an inspection`,
        );
      }
      requireMatchingPayloadId(row, payload, 'inspectionId', row.repository_inspection_id);
      return;
    }
    case 'project-repository-bound':
    case 'project-repository-binding-retired':
      requireMatchingPayloadId(row, payload, 'projectId', row.project_id as string);
      requireMatchingPayloadId(row, payload, 'repositoryId', row.repository_id as string);
      requireMatchingPayloadId(row, payload, 'bindingId', row.repository_binding_id as string);
      return;
  }
}

function mapPayload<K extends WorkspaceEventKind>(
  payload: Record<string, unknown>,
): WorkspaceEventPayload<K> {
  return payload as WorkspaceEventPayload<K>;
}

/**
 * Maps one untrusted journal row to its exact discriminated domain event.
 *
 * SQL proves structural ownership. This mapper fails closed on unknown kinds,
 * contradictory structural shapes, payload/structural ID disagreement, and
 * invalid retirement coupling before a snapshot or SSE query can observe a
 * partial mapped batch.
 */
function mapEvent(row: WorkspaceEventRow): WorkspaceEvent {
  if (!isWorkspaceEventKind(row.kind)) {
    throw new WorkspaceEventMappingError(
      'unknown-kind',
      `Workspace event ${row.id} has an unregistered runtime kind`,
    );
  }
  const kind = row.kind;
  assertStructuralShape(row, kind);
  const payload = parsePayload(row);
  assertPayloadCorrelations(row, kind, payload);
  const base = mapBase(row);

  switch (kind) {
    case 'workspace-created':
      return {
        ...legacyFields(base),
        kind,
        payload: mapPayload<'workspace-created'>(payload),
      };
    case 'project-created':
      return {
        ...legacyFields(base),
        kind,
        payload: mapPayload<'project-created'>(payload),
      };
    case 'plan-version-imported':
      return {
        ...legacyFields(base),
        kind,
        payload: mapPayload<'plan-version-imported'>(payload),
      };
    case 'work-item-admitted':
      return {
        ...legacyFields(base),
        kind,
        payload: mapPayload<'work-item-admitted'>(payload),
      };
    case 'repository-registered':
      return {
        ...commonFields(base),
        kind,
        repositoryId: base.repositoryId as NonNullable<WorkspaceEventBase['repositoryId']>,
        repositoryInspectionId: base.repositoryInspectionId as NonNullable<
          WorkspaceEventBase['repositoryInspectionId']
        >,
        payload: mapPayload<'repository-registered'>(payload),
      };
    case 'repository-status-changed':
      return {
        ...commonFields(base),
        kind,
        repositoryId: base.repositoryId as NonNullable<WorkspaceEventBase['repositoryId']>,
        ...(base.repositoryInspectionId === undefined
          ? {}
          : { repositoryInspectionId: base.repositoryInspectionId }),
        payload: mapPayload<'repository-status-changed'>(payload),
      };
    case 'repository-evidence-changed':
      return {
        ...commonFields(base),
        kind,
        repositoryId: base.repositoryId as NonNullable<WorkspaceEventBase['repositoryId']>,
        repositoryInspectionId: base.repositoryInspectionId as NonNullable<
          WorkspaceEventBase['repositoryInspectionId']
        >,
        payload: mapPayload<'repository-evidence-changed'>(payload),
      };
    case 'project-repository-bound':
      return {
        ...commonFields(base),
        kind,
        projectId: base.projectId as NonNullable<WorkspaceEventBase['projectId']>,
        repositoryId: base.repositoryId as NonNullable<WorkspaceEventBase['repositoryId']>,
        repositoryBindingId: base.repositoryBindingId as NonNullable<
          WorkspaceEventBase['repositoryBindingId']
        >,
        payload: mapPayload<'project-repository-bound'>(payload),
      };
    case 'project-repository-binding-retired':
      return {
        ...commonFields(base),
        kind,
        projectId: base.projectId as NonNullable<WorkspaceEventBase['projectId']>,
        repositoryId: base.repositoryId as NonNullable<WorkspaceEventBase['repositoryId']>,
        repositoryBindingId: base.repositoryBindingId as NonNullable<
          WorkspaceEventBase['repositoryBindingId']
        >,
        payload: mapPayload<'project-repository-binding-retired'>(payload),
      };
    default: {
      const unreachable: never = kind;
      throw new WorkspaceEventMappingError(
        'unknown-kind',
        `Workspace event ${row.id} has unhandled kind ${String(unreachable)}`,
      );
    }
  }
}

function assertAppendAgreement(input: AppendWorkspaceEventInput): void {
  const mismatch = (label: string): never => {
    throw new WorkspaceEventAppendError(
      'payload-correlation-mismatch',
      `Workspace event append ${label} disagrees with its structural correlation`,
    );
  };
  switch (input.kind) {
    case 'workspace-created':
    case 'project-created':
    case 'plan-version-imported':
    case 'work-item-admitted':
      return;
    case 'repository-registered':
    case 'repository-evidence-changed':
      if (input.payload.repositoryId !== input.repositoryId) mismatch('repositoryId');
      if (input.payload.inspectionId !== input.repositoryInspectionId) mismatch('inspectionId');
      return;
    case 'repository-status-changed':
      if (input.payload.repositoryId !== input.repositoryId) mismatch('repositoryId');
      if (input.payload.inspectionId !== input.repositoryInspectionId) mismatch('inspectionId');
      return;
    case 'project-repository-bound':
    case 'project-repository-binding-retired':
      if (input.payload.projectId !== input.projectId) mismatch('projectId');
      if (input.payload.repositoryId !== input.repositoryId) mismatch('repositoryId');
      if (input.payload.bindingId !== input.repositoryBindingId) mismatch('bindingId');
      return;
  }
}

export class SqliteWorkspaceEventRepository implements WorkspaceEventRepository {
  constructor(private readonly database: Database.Database) {}

  private hasRepositoryCorrelationColumns(): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1
           FROM pragma_table_info('workspace_events')
           WHERE name = 'repository_id'`,
        )
        .get() !== undefined
    );
  }

  appendWorkspaceCreated(input: AppendWorkspaceCreatedInput): WorkspaceEvent {
    // This compatibility append is also used by the migration-preservation
    // fixtures against schema 1. Name only the columns present in every schema;
    // the schema-4 generic append below owns repository correlations.
    const payload = { name: input.name, slug: input.slug };
    const result = this.database
      .prepare(
        `INSERT INTO workspace_events (
          id, schema_version, occurred_at, workspace_id, actor_user_id,
          project_id, work_item_id, kind, payload_json
        ) VALUES (?, 1, ?, ?, ?, NULL, NULL, 'workspace-created', ?)`,
      )
      .run(
        input.id,
        input.occurredAt,
        input.workspaceId,
        input.actorUserId ?? null,
        JSON.stringify(payload),
      );
    return {
      id: input.id,
      sequence: Number(result.lastInsertRowid),
      occurredAt: input.occurredAt,
      workspaceId: input.workspaceId,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      schemaVersion: 1,
      kind: 'workspace-created',
      payload,
    };
  }

  appendEvent(input: AppendWorkspaceEventInput): WorkspaceEvent {
    assertAppendAgreement(input);
    if (
      !this.hasRepositoryCorrelationColumns() &&
      (input.kind === 'workspace-created' ||
        input.kind === 'project-created' ||
        input.kind === 'plan-version-imported' ||
        input.kind === 'work-item-admitted')
    ) {
      return this.database
        .transaction(() => {
          const result = this.database
            .prepare(
              `INSERT INTO workspace_events (
                id, schema_version, occurred_at, workspace_id, actor_user_id,
                project_id, work_item_id, run_id, kind, payload_json
              ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.id,
              input.occurredAt,
              input.workspaceId,
              input.actorUserId ?? null,
              input.projectId ?? null,
              input.workItemId ?? null,
              input.runId ?? null,
              input.kind,
              JSON.stringify(input.payload),
            );
          const row = this.database
            .prepare(
              `SELECT *,
                 NULL AS repository_id,
                 NULL AS repository_inspection_id,
                 NULL AS repository_binding_id
               FROM workspace_events WHERE sequence = ?`,
            )
            .get(Number(result.lastInsertRowid)) as WorkspaceEventRow;
          return mapEvent(row);
        })
        .immediate();
    }
    return this.database
      .transaction(() => {
        const result = this.database
          .prepare(
            `INSERT INTO workspace_events (
              id, schema_version, occurred_at, workspace_id, actor_user_id,
              project_id, work_item_id, run_id, repository_id,
              repository_inspection_id, repository_binding_id, kind, payload_json
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.occurredAt,
            input.workspaceId,
            input.actorUserId ?? null,
            input.projectId ?? null,
            input.workItemId ?? null,
            input.runId ?? null,
            input.repositoryId ?? null,
            input.repositoryInspectionId ?? null,
            input.repositoryBindingId ?? null,
            input.kind,
            JSON.stringify(input.payload),
          );
        const row = this.database
          .prepare(`SELECT * FROM workspace_events WHERE sequence = ?`)
          .get(Number(result.lastInsertRowid)) as WorkspaceEventRow;
        return mapEvent(row);
      })
      .immediate();
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
    const rows = this.database
      .prepare(
        `SELECT * FROM workspace_events
         WHERE workspace_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(input.workspaceId, input.after, input.limit) as WorkspaceEventRow[];
    return rows.map(mapEvent);
  }

  listRecentAtOrBefore(input: {
    readonly workspaceId: WorkspaceId;
    readonly asOfSequence: number;
    readonly limit: number;
  }): readonly WorkspaceEvent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM (
           SELECT * FROM workspace_events
           WHERE workspace_id = ? AND sequence <= ?
           ORDER BY sequence DESC LIMIT ?
         ) ORDER BY sequence ASC`,
      )
      .all(input.workspaceId, input.asOfSequence, input.limit) as WorkspaceEventRow[];
    return rows.map(mapEvent);
  }
}
