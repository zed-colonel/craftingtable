import {
  type AgentRun,
  type AgentRunEvent,
  type AgentRunEventKind,
  type AgentRunId,
  isAgentRunEventKind,
  isTerminalAgentRunStatus,
  type SourceRepository,
  type SourceRepositoryId,
  type WorkItemId,
  type WorkspaceAgentProfile,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type {
  AgentRunEventRepository,
  AgentRunRepository,
  AppendAgentRunEventInput,
  CreateAgentRunInput,
  CreateSourceRepositoryInput,
  CreateWorktreeInput,
  ExecutionRepositories,
  RunEventCompaction,
  ReplaceRunProfilesInput,
  RunProfileRepository,
  SourceRepositoryRepository,
  TransitionAgentRunInput,
  WorktreeRepository,
} from '../../execution-types.js';
import { type RecordGuard, readRecord } from '../../records.js';
import { SqlitePlanBranchSettingsRepository } from './branch-settings.js';
import { SqliteFinalizationRepository } from './finalizations.js';
import { SqliteMergeOperationRepository } from './merges.js';
import { SqliteWorkCycleRepository } from './work-cycles.js';

/* -------------------------------------------------------------------------- */
/* Rows and mappers                                                            */
/* -------------------------------------------------------------------------- */

interface SourceRepositoryRow {
  id: string;
  workspace_id: string;
  display_name: string;
  root_path: string;
  default_branch: string;
  registered_head_sha: string;
  status: SourceRepository['status'];
  registered_at: string;
  registered_by_user_id: string;
  retired_at: string | null;
  version: number;
}

function mapSourceRepository(row: SourceRepositoryRow): SourceRepository {
  return {
    id: row.id as SourceRepository['id'],
    workspaceId: row.workspace_id as SourceRepository['workspaceId'],
    displayName: row.display_name,
    rootPath: row.root_path,
    defaultBranch: row.default_branch,
    registeredHeadSha: row.registered_head_sha,
    status: row.status,
    registeredAt: row.registered_at,
    registeredByUserId: row.registered_by_user_id as SourceRepository['registeredByUserId'],
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    version: row.version,
  };
}

export interface WorktreeRow {
  execution_scope_json: string | null;
  id: string;
  workspace_id: string;
  repository_id: string;
  project_id: string;
  work_item_id: string | null;
  plan_version_id: string | null;
  branch_name: string;
  base_sha: string;
  base_branch: string;
  integration_branch: string | null;
  path: string;
  status: Worktree['status'];
  created_at: string;
  created_by_user_id: string;
  removed_at: string | null;
  merged_at: string | null;
  merge_sha: string | null;
  version: number;
}

export function mapWorktree(row: WorktreeRow): Worktree {
  return readRecord('worktree', {
    ...(row.execution_scope_json ? { executionScope: JSON.parse(row.execution_scope_json) } : {}),
    id: row.id as Worktree['id'],
    workspaceId: row.workspace_id as Worktree['workspaceId'],
    repositoryId: row.repository_id as Worktree['repositoryId'],
    projectId: row.project_id as Worktree['projectId'],
    ...(row.work_item_id
      ? { workItemId: row.work_item_id as Worktree['workItemId'] }
      : { planVersionId: row.plan_version_id as Worktree['planVersionId'] }),
    branchName: row.branch_name,
    baseSha: row.base_sha,
    baseBranch: row.base_branch,
    ...(row.integration_branch === null ? {} : { integrationBranch: row.integration_branch }),
    path: row.path,
    status: row.status,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id as Worktree['createdByUserId'],
    ...(row.removed_at === null ? {} : { removedAt: row.removed_at }),
    ...(row.merged_at === null ? {} : { mergedAt: row.merged_at }),
    ...(row.merge_sha === null ? {} : { mergeSha: row.merge_sha }),
    version: row.version,
  });
}

export interface AgentRunRow {
  reasoning_effort: AgentRun['reasoningEffort'] | null;
  profile_selection_json: string | null;
  id: string;
  workspace_id: string;
  worktree_id: string;
  repository_id: string;
  project_id: string;
  work_item_id: string | null;
  plan_version_id: string | null;
  parent_run_id: string | null;
  backend: AgentRun['backend'];
  role: AgentRun['role'];
  status: AgentRun['status'];
  permission_mode: AgentRun['permissionMode'];
  model: string | null;
  resolved_model: string | null;
  billing: AgentRun['billing'] | null;
  verdict: AgentRun['verdict'] | null;
  review_branch_context_json: string | null;
  brief: string;
  backend_session_id: string | null;
  created_at: string;
  created_by_user_id: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  outcome_summary: string | null;
  cost_usd: number | null;
  turn_count: number;
  version: number;
}

export function mapAgentRun(row: AgentRunRow): AgentRun {
  return readRecord('agent-run', {
    ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
    ...(row.profile_selection_json
      ? { profileSelection: JSON.parse(row.profile_selection_json) }
      : {}),
    id: row.id as AgentRun['id'],
    workspaceId: row.workspace_id as AgentRun['workspaceId'],
    worktreeId: row.worktree_id as AgentRun['worktreeId'],
    repositoryId: row.repository_id as AgentRun['repositoryId'],
    projectId: row.project_id as AgentRun['projectId'],
    ...(row.work_item_id
      ? { workItemId: row.work_item_id as AgentRun['workItemId'] }
      : { planVersionId: row.plan_version_id as AgentRun['planVersionId'] }),
    ...(row.parent_run_id === null
      ? {}
      : { parentRunId: row.parent_run_id as NonNullable<AgentRun['parentRunId']> }),
    backend: row.backend,
    role: row.role,
    status: row.status,
    permissionMode: row.permission_mode,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.resolved_model === null ? {} : { resolvedModel: row.resolved_model }),
    ...(row.billing === null ? {} : { billing: row.billing }),
    ...(row.verdict === null ? {} : { verdict: row.verdict }),
    ...(row.review_branch_context_json === null
      ? {}
      : { reviewBranchContext: JSON.parse(row.review_branch_context_json) }),
    brief: row.brief,
    ...(row.backend_session_id === null ? {} : { backendSessionId: row.backend_session_id }),
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id as AgentRun['createdByUserId'],
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.outcome_summary === null ? {} : { outcomeSummary: row.outcome_summary }),
    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
    turnCount: row.turn_count,
    version: row.version,
  });
}

export interface AgentRunEventRow {
  sequence: number;
  id: string;
  workspace_id: string;
  run_id: string;
  occurred_at: string;
  kind: string;
  payload_json: string;
  raw_json: string | null;
}

export function mapAgentRunEvent(row: AgentRunEventRow): AgentRunEvent {
  if (!isAgentRunEventKind(row.kind)) {
    throw new Error(`Agent run event ${row.id} has an unregistered kind`);
  }
  return readRecord('run-event', {
    sequence: row.sequence,
    id: row.id as AgentRunEvent['id'],
    workspaceId: row.workspace_id as AgentRunEvent['workspaceId'],
    runId: row.run_id as AgentRunEvent['runId'],
    occurredAt: row.occurred_at,
    ...(row.raw_json === null ? {} : { raw: row.raw_json }),
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
  });
}

/* -------------------------------------------------------------------------- */
/* Repositories                                                                */
/* -------------------------------------------------------------------------- */

class SqliteSourceRepositoryRepository implements SourceRepositoryRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: CreateSourceRepositoryInput): SourceRepository {
    this.database
      .prepare(
        `INSERT INTO source_repositories (
          id, workspace_id, display_name, root_path, default_branch,
          registered_head_sha, status, registered_at, registered_by_user_id, version
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.displayName,
        input.rootPath,
        input.defaultBranch,
        input.registeredHeadSha,
        input.registeredAt,
        input.registeredByUserId,
      );
    const created = this.find(input.workspaceId, input.id);
    if (created === undefined) {
      throw new Error('Source repository insert did not produce a readable row');
    }
    return created;
  }

  find(workspaceId: WorkspaceId, repositoryId: SourceRepositoryId): SourceRepository | undefined {
    const row = this.database
      .prepare(`SELECT * FROM source_repositories WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, repositoryId) as SourceRepositoryRow | undefined;
    return row === undefined ? undefined : mapSourceRepository(row);
  }

  findActiveByPath(workspaceId: WorkspaceId, rootPath: string): SourceRepository | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM source_repositories
         WHERE workspace_id = ? AND root_path = ? AND status = 'active'`,
      )
      .get(workspaceId, rootPath) as SourceRepositoryRow | undefined;
    return row === undefined ? undefined : mapSourceRepository(row);
  }

  list(workspaceId: WorkspaceId): readonly SourceRepository[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM source_repositories
           WHERE workspace_id = ?
           ORDER BY status ASC, registered_at ASC, id ASC`,
        )
        .all(workspaceId) as SourceRepositoryRow[]
    ).map(mapSourceRepository);
  }

  retire(input: {
    readonly workspaceId: WorkspaceId;
    readonly repositoryId: SourceRepositoryId;
    readonly occurredAt: string;
  }): SourceRepository | undefined {
    const result = this.database
      .prepare(
        `UPDATE source_repositories
         SET status = 'retired', retired_at = ?, version = version + 1
         WHERE workspace_id = ? AND id = ? AND status = 'active'`,
      )
      .run(input.occurredAt, input.workspaceId, input.repositoryId);
    return result.changes === 0 ? undefined : this.find(input.workspaceId, input.repositoryId);
  }

  count(): number {
    return (
      this.database.prepare(`SELECT COUNT(*) AS count FROM source_repositories`).get() as {
        count: number;
      }
    ).count;
  }
}

class SqliteWorktreeRepository implements WorktreeRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
  ) {}

  /** Reads a worktree back after a write and guards it, inside the write's transaction. */
  private written(workspaceId: WorkspaceId, worktreeId: WorktreeId): Worktree | undefined {
    const worktree = this.find(workspaceId, worktreeId);
    if (worktree) this.guard('worktree', worktree);
    return worktree;
  }

  insert(input: CreateWorktreeInput): Worktree {
    this.database
      .prepare(
        `INSERT INTO worktrees (
          id, workspace_id, repository_id, project_id, work_item_id, plan_version_id, branch_name,
          base_sha, base_branch, integration_branch, path, status, created_at, created_by_user_id, execution_scope_json, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.repositoryId,
        input.projectId,
        input.workItemId ?? null,
        input.planVersionId ?? null,
        input.branchName,
        input.baseSha,
        input.baseBranch,
        input.integrationBranch ?? null,
        input.path,
        input.createdAt,
        input.createdByUserId,
        input.executionScope ? JSON.stringify(input.executionScope) : null,
      );
    const created = this.written(input.workspaceId, input.id);
    if (created === undefined) {
      throw new Error('Worktree insert did not produce a readable row');
    }
    return created;
  }

  find(workspaceId: WorkspaceId, worktreeId: WorktreeId): Worktree | undefined {
    const row = this.database
      .prepare(`SELECT * FROM worktrees WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, worktreeId) as WorktreeRow | undefined;
    return row === undefined ? undefined : mapWorktree(row);
  }

  listForWorkItem(workspaceId: WorkspaceId, workItemId: WorkItemId): readonly Worktree[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM worktrees
           WHERE workspace_id = ? AND work_item_id = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(workspaceId, workItemId) as WorktreeRow[]
    ).map(mapWorktree);
  }

  listActive(workspaceId?: WorkspaceId): readonly Worktree[] {
    const rows =
      workspaceId === undefined
        ? this.database
            .prepare(
              "SELECT * FROM worktrees WHERE status = 'active' ORDER BY created_at DESC, id DESC",
            )
            .all()
        : this.database
            .prepare(
              "SELECT * FROM worktrees WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC",
            )
            .all(workspaceId);
    return (rows as WorktreeRow[]).map(mapWorktree);
  }

  setIntegrationBranch(input: {
    workspaceId: WorkspaceId;
    worktreeId: WorktreeId;
    integrationBranch: string;
    expectedVersion: number;
  }): Worktree | undefined {
    const result = this.database
      .prepare(`UPDATE worktrees SET integration_branch = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND status = 'active' AND version = ?`)
      .run(input.integrationBranch, input.workspaceId, input.worktreeId, input.expectedVersion);
    return result.changes === 0 ? undefined : this.written(input.workspaceId, input.worktreeId);
  }

  markRemoved(input: {
    readonly workspaceId: WorkspaceId;
    readonly worktreeId: WorktreeId;
    readonly occurredAt: string;
  }): Worktree | undefined {
    const result = this.database
      .prepare(
        `UPDATE worktrees
         SET status = 'removed', removed_at = ?, version = version + 1
         WHERE workspace_id = ? AND id = ? AND status = 'active'`,
      )
      .run(input.occurredAt, input.workspaceId, input.worktreeId);
    return result.changes === 0 ? undefined : this.written(input.workspaceId, input.worktreeId);
  }

  markMerged(input: {
    readonly workspaceId: WorkspaceId;
    readonly worktreeId: WorktreeId;
    readonly occurredAt: string;
    readonly mergeSha: string;
  }): Worktree | undefined {
    const result = this.database
      .prepare(
        `UPDATE worktrees
         SET status = 'removed', removed_at = ?, merged_at = ?, merge_sha = ?,
             version = version + 1
         WHERE workspace_id = ? AND id = ? AND status = 'active'`,
      )
      .run(input.occurredAt, input.occurredAt, input.mergeSha, input.workspaceId, input.worktreeId);
    return result.changes === 0 ? undefined : this.written(input.workspaceId, input.worktreeId);
  }

  count(): number {
    return (
      this.database.prepare(`SELECT COUNT(*) AS count FROM worktrees`).get() as {
        count: number;
      }
    ).count;
  }
}

class SqliteAgentRunRepository implements AgentRunRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
  ) {}

  /** Reads a run back after a write and guards it, inside the write's transaction. */
  private written(workspaceId: WorkspaceId, runId: AgentRunId): AgentRun | undefined {
    const run = this.find(workspaceId, runId);
    if (run) this.guard('agent-run', run);
    return run;
  }

  insert(input: CreateAgentRunInput): AgentRun {
    this.database
      .prepare(
        `INSERT INTO agent_runs (
          id, workspace_id, worktree_id, repository_id, project_id, work_item_id, plan_version_id,
          parent_run_id, backend, role, status, permission_mode, model, reasoning_effort, profile_selection_json, brief,
          created_at, created_by_user_id, review_branch_context_json, turn_count, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.worktreeId,
        input.repositoryId,
        input.projectId,
        input.workItemId ?? null,
        input.planVersionId ?? null,
        input.parentRunId ?? null,
        input.backend,
        input.role,
        input.permissionMode,
        input.model ?? null,
        input.reasoningEffort ?? null,
        input.profileSelection ? JSON.stringify(input.profileSelection) : null,
        input.brief,
        input.createdAt,
        input.createdByUserId,
        input.reviewBranchContext === undefined ? null : JSON.stringify(input.reviewBranchContext),
      );
    const created = this.written(input.workspaceId, input.id);
    if (created === undefined) {
      throw new Error('Agent run insert did not produce a readable row');
    }
    return created;
  }

  find(workspaceId: WorkspaceId, runId: AgentRunId): AgentRun | undefined {
    const row = this.database
      .prepare(`SELECT * FROM agent_runs WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, runId) as AgentRunRow | undefined;
    return row === undefined ? undefined : mapAgentRun(row);
  }

  listForWorkItem(workspaceId: WorkspaceId, workItemId: WorkItemId): readonly AgentRun[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_runs
           WHERE workspace_id = ? AND work_item_id = ?
           ORDER BY created_at DESC, rowid DESC`,
        )
        .all(workspaceId, workItemId) as AgentRunRow[]
    ).map(mapAgentRun);
  }

  listForWorktree(workspaceId: WorkspaceId, worktreeId: WorktreeId): readonly AgentRun[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_runs
           WHERE workspace_id = ? AND worktree_id = ?
           ORDER BY created_at DESC, rowid DESC`,
        )
        .all(workspaceId, worktreeId) as AgentRunRow[]
    ).map(mapAgentRun);
  }

  listLive(): readonly AgentRun[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_runs
           WHERE status IN ('starting', 'running', 'waiting')
           ORDER BY created_at ASC, id ASC`,
        )
        .all() as AgentRunRow[]
    ).map(mapAgentRun);
  }

  listRecent(workspaceId: WorkspaceId, limit: number): readonly AgentRun[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_runs
           WHERE workspace_id = ?
           ORDER BY CASE WHEN status IN ('starting', 'running', 'waiting') THEN 0 ELSE 1 END,
                    created_at DESC, rowid DESC
           LIMIT ?`,
        )
        .all(workspaceId, limit) as AgentRunRow[]
    ).map(mapAgentRun);
  }

  countLive(workspaceId: WorkspaceId): number {
    return (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM agent_runs
           WHERE workspace_id = ? AND status IN ('starting', 'running', 'waiting')`,
        )
        .get(workspaceId) as { count: number }
    ).count;
  }

  activityBetween(workspaceId: WorkspaceId, from: string, to: string) {
    return (
      this.database
        .prepare(
          `SELECT started_at, finished_at, status FROM agent_runs
           WHERE workspace_id = ? AND started_at IS NOT NULL AND started_at < ?
             AND (finished_at IS NULL OR finished_at > ?)`,
        )
        .all(workspaceId, to, from) as {
        started_at: string;
        finished_at: string | null;
        status: AgentRun['status'];
      }[]
    ).flatMap((row) =>
      row.finished_at !== null
        ? [{ startedAt: row.started_at, endedAt: row.finished_at }]
        : ['starting', 'running', 'waiting'].includes(row.status)
          ? [{ startedAt: row.started_at }]
          : [],
    );
  }

  transition(input: TransitionAgentRunInput): AgentRun | undefined {
    if (input.expectedStatuses.length === 0) {
      return undefined;
    }
    const terminal = isTerminalAgentRunStatus(input.toStatus);
    const finishedAt = terminal ? (input.finishedAt ?? input.occurredAt) : null;
    const placeholders = input.expectedStatuses.map(() => '?').join(', ');
    const result = this.database
      .prepare(
        `UPDATE agent_runs
         SET status = ?,
             backend_session_id = COALESCE(?, backend_session_id),
             resolved_model = COALESCE(?, resolved_model),
             billing = COALESCE(?, billing),
             verdict = CASE WHEN ? THEN ? ELSE verdict END,
             started_at = COALESCE(?, started_at),
             finished_at = COALESCE(?, finished_at),
             exit_code = COALESCE(?, exit_code),
             outcome_summary = COALESCE(?, outcome_summary),
             cost_usd = COALESCE(?, cost_usd),
             turn_count = turn_count + ?,
             version = version + 1
         WHERE workspace_id = ? AND id = ? AND status IN (${placeholders})`,
      )
      .run(
        input.toStatus,
        input.backendSessionId ?? null,
        input.resolvedModel ?? null,
        input.billing ?? null,
        input.verdict !== undefined ? 1 : 0,
        input.verdict ?? null,
        input.startedAt ?? null,
        finishedAt,
        input.exitCode ?? null,
        input.outcomeSummary ?? null,
        input.costUsd ?? null,
        input.turnCountIncrement ?? 0,
        input.workspaceId,
        input.runId,
        ...input.expectedStatuses,
      );
    return result.changes === 0 ? undefined : this.written(input.workspaceId, input.runId);
  }

  listEnded(): readonly AgentRun[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_runs
           WHERE status IN ('finished', 'failed', 'cancelled', 'interrupted')
           ORDER BY created_at, id`,
        )
        .all() as AgentRunRow[]
    ).map(mapAgentRun);
  }

  count(): number {
    return (
      this.database.prepare(`SELECT COUNT(*) AS count FROM agent_runs`).get() as {
        count: number;
      }
    ).count;
  }
}

class SqliteAgentRunEventRepository implements AgentRunEventRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
  ) {}

  append(input: AppendAgentRunEventInput): AgentRunEvent {
    const result = this.database
      .prepare(
        `INSERT INTO agent_run_events (
          id, workspace_id, run_id, occurred_at, kind, payload_json, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.runId,
        input.occurredAt,
        input.kind,
        JSON.stringify(input.payload),
        input.raw ?? null,
      );
    const row = this.database
      .prepare(`SELECT * FROM agent_run_events WHERE sequence = ?`)
      .get(Number(result.lastInsertRowid)) as AgentRunEventRow | undefined;
    if (row === undefined) {
      throw new Error('Agent run event append did not produce a readable row');
    }
    const event = mapAgentRunEvent(row);
    this.guard('run-event', event);
    return event;
  }

  listAfter(input: {
    readonly workspaceId: WorkspaceId;
    readonly runId: AgentRunId;
    readonly after: number;
    readonly limit: number;
  }): readonly AgentRunEvent[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_run_events
           WHERE workspace_id = ? AND run_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(input.workspaceId, input.runId, input.after, input.limit) as AgentRunEventRow[]
    ).map(mapAgentRunEvent);
  }

  latestOfKind(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    kind: AgentRunEventKind,
  ): AgentRunEvent | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM agent_run_events
         WHERE workspace_id = ? AND run_id = ? AND kind = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(workspaceId, runId, kind) as AgentRunEventRow | undefined;
    return row === undefined ? undefined : mapAgentRunEvent(row);
  }

  compact(runId: AgentRunId, changes: readonly RunEventCompaction[]): void {
    if (!this.database.inTransaction)
      throw new Error('Journal compaction must run inside a transaction');
    const trigger = this.database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'agent_run_events_no_update'",
      )
      .get() as { sql: string } | undefined;
    if (trigger === undefined)
      throw new Error('The run-event journal has lost its append-only trigger');
    const update = this.database.prepare(
      `UPDATE agent_run_events
       SET payload_json = COALESCE(?, payload_json),
           raw_json = CASE WHEN ? THEN NULL ELSE raw_json END
       WHERE sequence = ? AND run_id = ?`,
    );
    const read = this.database.prepare('SELECT * FROM agent_run_events WHERE sequence = ?');
    this.database.exec('DROP TRIGGER agent_run_events_no_update');
    try {
      for (const change of changes) {
        const result = update.run(
          change.payload === undefined ? null : JSON.stringify(change.payload),
          change.clearRaw ? 1 : 0,
          change.sequence,
          runId,
        );
        if (result.changes !== 1)
          throw new Error(`Run event ${change.sequence} is not an event of run ${runId}`);
        this.guard('run-event', mapAgentRunEvent(read.get(change.sequence) as AgentRunEventRow));
      }
    } finally {
      this.database.exec(trigger.sql);
    }
    const restored = this.database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'agent_run_events_no_update'",
      )
      .get() as { sql: string } | undefined;
    if (restored?.sql !== trigger.sql)
      throw new Error('The run-event journal trigger was not restored unchanged');
  }

  countForRun(workspaceId: WorkspaceId, runId: AgentRunId): number {
    return (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM agent_run_events WHERE workspace_id = ? AND run_id = ?`,
        )
        .get(workspaceId, runId) as { count: number }
    ).count;
  }
}

const ROLE_ORDER = `CASE role WHEN 'design' THEN 0 WHEN 'implement' THEN 1 ELSE 2 END`;

class SqliteRunProfileRepository implements RunProfileRepository {
  constructor(private readonly database: Database.Database) {}

  list(workspaceId: WorkspaceId): readonly WorkspaceAgentProfile[] {
    const rows = this.database
      .prepare(
        `SELECT role, backend, model, permission_mode, reasoning_effort
         FROM workspace_run_profiles WHERE workspace_id = ? ORDER BY ${ROLE_ORDER}`,
      )
      .all(workspaceId) as {
      reasoning_effort: WorkspaceAgentProfile['reasoningEffort'] | null;
      role: WorkspaceAgentProfile['role'];
      backend: WorkspaceAgentProfile['backend'];
      model: string | null;
      permission_mode: WorkspaceAgentProfile['permissionMode'];
    }[];
    return rows.map((row) => ({
      ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
      role: row.role,
      backend: row.backend,
      ...(row.model === null ? {} : { model: row.model }),
      permissionMode: row.permission_mode,
    }));
  }

  replace(input: ReplaceRunProfilesInput): void {
    this.database
      .prepare('DELETE FROM workspace_run_profiles WHERE workspace_id = ?')
      .run(input.workspaceId);
    const insert = this.database.prepare(
      `INSERT INTO workspace_run_profiles
         (workspace_id, role, backend, model, permission_mode, reasoning_effort, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const profile of input.profiles) {
      insert.run(
        input.workspaceId,
        profile.role,
        profile.backend,
        profile.model ?? null,
        profile.permissionMode,
        profile.reasoningEffort ?? null,
        input.occurredAt,
        input.updatedByUserId,
      );
    }
  }
}

export function executionRepositories(
  database: Database.Database,
  guard: RecordGuard,
): ExecutionRepositories {
  return {
    finalizations: new SqliteFinalizationRepository(database, guard),
    merges: new SqliteMergeOperationRepository(database, guard),
    cycles: new SqliteWorkCycleRepository(database, guard),
    branchSettings: new SqlitePlanBranchSettingsRepository(database, guard),
    sourceRepositories: new SqliteSourceRepositoryRepository(database),
    worktrees: new SqliteWorktreeRepository(database, guard),
    runs: new SqliteAgentRunRepository(database, guard),
    runEvents: new SqliteAgentRunEventRepository(database, guard),
    runProfiles: new SqliteRunProfileRepository(database),
  };
}
