import type Database from 'better-sqlite3';
import type { WorkspaceId } from '@craftingtable/domain';
import { SqliteRoadmapRepository } from './repositories/roadmaps.js';
import {
  acceptAnyRecord,
  observeUpcasts,
  type PersistedRecordKind,
  type PersistedRecords,
  parseRecord,
  type UpcastObserver,
} from './records.js';
import { type AuditRow, mapAudit } from './repositories/audit.js';
import {
  mapPlanBranchSettings,
  PLAN_BRANCH_SETTINGS_SELECT,
  type PlanBranchSettingsRow,
} from './repositories/execution/branch-settings.js';
import {
  type AgentRunEventRow,
  type AgentRunRow,
  mapAgentRun,
  mapAgentRunEvent,
  mapWorktree,
  type WorktreeRow,
} from './repositories/execution/index.js';
import { mapAmendment } from './repositories/map-amendments.js';
import {
  mapVersion,
  mapWorkItem,
  type PlanVersionRow,
  WORK_ITEM_FROM,
  WORK_ITEM_SELECT,
  type WorkItemDbRow,
} from './repositories/planning/rows.js';
import { mapWorkspaceEvent, type WorkspaceEventRow } from './repositories/workspace-events.js';

/** One stored record, read exactly as the repositories read it. */
export interface ScannedRecord<K extends PersistedRecordKind = PersistedRecordKind> {
  readonly kind: K;
  /** Identifies the row in a report: its id, or the columns of its key. */
  readonly key: string;
  readonly record: PersistedRecords[K];
}

/** A record that could not be read at all: invalid JSON or a mapper refusal. */
export interface UnreadableRecord {
  readonly kind: PersistedRecordKind;
  readonly key: string;
  readonly error: string;
}

interface Source {
  readonly kind: PersistedRecordKind;
  readonly table: string;
  /** Rows as the repository selects them, with a `scan_key` column for reports. */
  readonly sql: string;
  readonly read: (row: never, database: Database.Database) => unknown;
  /** Journals are streamed row by row; other tables are small and read at once. */
  readonly stream?: boolean;
}

const documents = (
  kind: PersistedRecordKind,
  table: string,
  key: string,
  column = 'record_json',
): Source => ({
  kind,
  table,
  sql: `SELECT ${key} AS scan_key, ${column} AS document FROM ${table} ORDER BY rowid`,
  read: (row: { document: string }) => parseRecord(kind, row.document),
});

/**
 * Where each record kind lives and how the repositories map it. Every table that holds
 * record data appears here or in `RELATIONAL_TABLES`; a storage test fails on a table in
 * neither, so a new table cannot escape `db:verify`.
 */
const SOURCES: readonly Source[] = [
  documents('work-cycle', 'work_cycles', 'id', 'state_json'),
  {
    // The control row holds only the revision; the repository rehydrates the definition.
    kind: 'roadmap',
    table: 'roadmaps',
    sql: 'SELECT workspace_id, id, id AS scan_key FROM roadmaps ORDER BY rowid',
    read: (row: { workspace_id: WorkspaceId; id: string }, database) =>
      new SqliteRoadmapRepository(database, acceptAnyRecord).find(row.workspace_id, row.id),
  },
  documents(
    'roadmap-definition',
    'roadmap_definitions',
    "roadmap_id || '@' || revision",
    'definition_json',
  ),
  documents('finalization', 'finalizations', 'id', 'state_json'),
  documents('merge-operation', 'merge_operations', 'id', 'state_json'),
  documents(
    'repository-policy',
    'plan_repository_policies',
    "plan_version_id || '@' || version",
    'state_json',
  ),
  {
    kind: 'plan-branch-settings',
    table: 'plan_branch_settings',
    sql: `SELECT ${PLAN_BRANCH_SETTINGS_SELECT}, plan_version_id AS scan_key FROM plan_branch_settings ORDER BY rowid`,
    read: (row: PlanBranchSettingsRow) => mapPlanBranchSettings(row),
  },
  documents('notification-settings', 'notification_settings', 'workspace_id', 'state_json'),
  documents('notification-record', 'notification_records', 'id', 'state_json'),
  documents('attention-item', 'attention_items', 'id', 'state_json'),
  documents('notification-delivery', 'notification_deliveries', 'id', 'state_json'),
  documents('storage-settings', 'storage_settings', 'id', 'state_json'),
  {
    kind: 'worktree',
    table: 'worktrees',
    sql: 'SELECT *, id AS scan_key FROM worktrees ORDER BY rowid',
    read: (row: WorktreeRow) => mapWorktree(row),
  },
  {
    kind: 'agent-run',
    table: 'agent_runs',
    sql: 'SELECT *, id AS scan_key FROM agent_runs ORDER BY rowid',
    read: (row: AgentRunRow) => mapAgentRun(row),
  },
  {
    kind: 'run-event',
    stream: true,
    table: 'agent_run_events',
    sql: 'SELECT *, sequence AS scan_key FROM agent_run_events ORDER BY sequence',
    read: (row: AgentRunEventRow) => mapAgentRunEvent(row),
  },
  {
    kind: 'workspace-event',
    stream: true,
    table: 'workspace_events',
    sql: 'SELECT *, sequence AS scan_key FROM workspace_events ORDER BY sequence',
    read: (row: WorkspaceEventRow) => mapWorkspaceEvent(row),
  },
  {
    kind: 'audit-event',
    stream: true,
    table: 'audit_events',
    sql: 'SELECT *, sequence AS scan_key FROM audit_events ORDER BY sequence',
    read: (row: AuditRow) => mapAudit(row),
  },
  documents('runtime-generation', 'runtime_generations', 'id'),
  documents('evidence-submission', 'evidence_submissions', 'id'),
  documents('evidence-decision', 'evidence_decisions', 'id'),
  documents('run-environment', 'run_environments', 'run_id'),
  documents('run-build-record', 'run_build_records', 'run_id'),
  documents('run-check-receipt', 'run_check_receipts', "run_id || '#' || sequence"),
  documents('native-approval', 'native_verification_approvals', 'id'),
  documents('upstream-transition-record', 'upstream_transition_records', 'id'),
  documents('scope-receipt', 'scope_receipts', 'id'),
  documents('archive-import-attempt', 'archive_import_attempts', 'id'),
  documents('concurrency-definition', 'concurrency_definitions', 'id'),
  documents('concurrency-binding', 'concurrency_bindings', "definition_id || '@' || revision"),
  documents('plan-archive-link', 'plan_archive_links', "plan_version_id || '/' || archive_id"),
  documents('map-adoption', 'map_adoptions', 'id'),
  {
    kind: 'map-amendment',
    table: 'map_amendments',
    sql: 'SELECT id AS scan_key, proposal_json, decision_json FROM map_amendments ORDER BY rowid',
    read: (row: { proposal_json: string; decision_json: string | null }) => mapAmendment(row),
  },
  documents('scope-integration-reuse', 'scope_integration_reuse', 'id'),
  {
    kind: 'plan-version',
    table: 'plan_versions',
    sql: 'SELECT *, id AS scan_key FROM plan_versions ORDER BY rowid',
    read: (row: PlanVersionRow) => mapVersion(row),
  },
  {
    kind: 'work-item',
    table: 'work_items',
    sql: `SELECT ${WORK_ITEM_SELECT}, w.id AS scan_key ${WORK_ITEM_FROM} ORDER BY w.rowid`,
    read: (row: WorkItemDbRow) => mapWorkItem(row),
  },
];

/**
 * Tables that hold no record kind, with why. They are plain rows whose columns SQL
 * constraints already type, catalogs, or bookkeeping; `db:verify` checks them only through
 * SQLite's own integrity and foreign-key checks.
 */
export const RELATIONAL_TABLES: Readonly<Record<string, string>> = {
  schema_migrations: 'migration bookkeeping',
  audit_action_kinds: 'append-only vocabulary catalog (ADR-013)',
  workspace_event_kinds: 'append-only vocabulary catalog (ADR-013)',
  users: 'relational; credentials never leave storage',
  sessions: 'relational; credentials never leave storage',
  workspaces: 'relational',
  workspace_memberships: 'relational',
  projects: 'relational',
  plan_bundles: 'relational',
  plan_import_attempts: 'relational',
  plan_artifacts: 'immutable source files as imported; the plan format validates them',
  plan_import_diagnostics: 'relational',
  work_item_dependencies: 'relational',
  work_item_completions: 'relational',
  work_item_integration_evidence: 'relational',
  source_repositories: 'relational',
  workspace_run_profiles: 'relational',
  run_directories: 'relational bookkeeping for ADR-034 retention',
  storage_backups: 'relational bookkeeping for ADR-034 retention',
  daemon_clean_stop: 'one-row restart bookkeeping (R-B9)',
  worktree_build_caches: 'relational bookkeeping for ADR-039 cleanup (R-G7)',
  import_archives: 'immutable ZIP bytes as uploaded; imports validate them',
  phase_reservations: 'relational',
  phase_resource_limits: 'relational',
  scope_scheduling_authorizations: 'relational',
  retired_scope_worktrees: 'relational',
  superseded_map_bindings: 'relational',
  repository_inspections: 'retired CT-04A1 inspector; must stay empty until R-H6 drops it',
  registered_repositories: 'retired CT-04A2 registry; must stay empty until R-H6 drops it',
  project_repository_bindings: 'retired CT-04A2 registry; must stay empty until R-H6 drops it',
};

/** Tables whose rows would be records nothing reads; any row in them is a defect. */
export const RETIRED_TABLES = [
  'repository_inspections',
  'registered_repositories',
  'project_repository_bindings',
] as const;

/** The table behind each scanned record kind. */
export const RECORD_TABLES: Readonly<Record<PersistedRecordKind, string>> = Object.fromEntries(
  SOURCES.map((source) => [source.kind, source.table]),
) as Record<PersistedRecordKind, string>;

/**
 * Reads every stored record through the repositories' own mappers and upcasters, one at a
 * time so a large journal never sits in memory at once. Records that cannot be read go to
 * `unreadable` instead of stopping the scan.
 */
export function scanRecords(
  database: Database.Database,
  visit: (record: ScannedRecord) => void,
  unreadable: (record: UnreadableRecord) => void,
  observe?: UpcastObserver,
): void {
  const run = () => {
    for (const source of SOURCES) {
      const statement = database.prepare(source.sql);
      for (const row of (source.stream ? statement.iterate() : statement.all()) as Iterable<{
        scan_key: string | number;
      }>) {
        const { scan_key: scanKey, ...columns } = row;
        const key = String(scanKey);
        let record: unknown;
        try {
          record = source.read(columns as never, database);
        } catch (error) {
          unreadable({ kind: source.kind, key, error: (error as Error).message });
          continue;
        }
        visit({ kind: source.kind, key, record } as ScannedRecord);
      }
    }
  };
  if (observe) observeUpcasts(observe, run);
  else run();
}
