import type {
  PlanArtifactId,
  PlanBundleId,
  PlanImportAttemptId,
  PlanVersionId,
  ProjectId,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type {
  AdmitWorkItemInput,
  CreatePlanArtifactInput,
  CreatePlanBundleInput,
  CreatePlanImportAttemptInput,
  CreatePlanImportDiagnosticInput,
  CreatePlanVersionInput,
  CreateProjectInput,
  CreateWorkContractDraftInput,
  CreateWorkItemDependencyInput,
  CreateWorkItemInput,
  PlanArtifactRepository,
  PlanBundleRepository,
  PlanImportAttemptRepository,
  PlanImportDiagnosticRepository,
  PlanningQueryRepository,
  PlanningRepositories,
  PlanningStatusCounts,
  PlanVersionRepository,
  PlanVersionSummaryRow,
  ProjectRepository,
  ProjectSummaryRow,
  StoredPlanArtifact,
  WorkContractDraftRepository,
  WorkItemDependencyRepository,
  WorkItemDependencySummary,
  WorkItemRepository,
  WorkItemRow,
  WorkspacePlanningSummary,
} from '../../planning-types.js';
import {
  mapArtifact,
  mapAttempt,
  mapBundle,
  mapDependency,
  mapDiagnostic,
  mapDraft,
  mapProject,
  mapVersion,
  mapWorkItem,
  type PlanArtifactRow,
  type PlanBundleRow,
  type PlanImportAttemptRow,
  type PlanImportDiagnosticRow,
  type PlanVersionRow,
  type ProjectRow,
  type WorkContractDraftRow,
  type WorkItemDbRow,
  type WorkItemDependencyRow,
} from './rows.js';

/** ASCII unit separator: cannot occur inside a validated work-item source ID. */
const BLOCKER_SEPARATOR = '\u001f';

function countOf(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

/**
 * Derived readiness, written in the general "predecessor not Completed" form.
 *
 * CT-03's status CHECK admits only `proposed` and `admitted`, so this is
 * currently equivalent to "has no required predecessor". Writing the general
 * form means CT-04's completion workflow only has to widen the status
 * vocabulary rather than rewrite every readiness query.
 */
const UNSATISFIED_PREDECESSOR_EXISTS = `
  EXISTS (
    SELECT 1 FROM work_item_dependencies d
    JOIN work_items p ON p.plan_version_id = d.plan_version_id
                     AND p.id = d.predecessor_work_item_id
    WHERE d.successor_work_item_id = w.id
      AND d.kind = 'required'
      AND p.status <> 'completed'
  )`;

class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: CreateProjectInput) {
    this.database
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, slug, active_plan_version_id,
           created_at, created_by_user_id, version)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 1)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.name,
        input.slug,
        input.createdAt,
        input.createdByUserId,
      );
    const project = this.find(input.workspaceId, input.id);
    if (project === undefined) {
      throw new Error('Project insert did not produce a readable row');
    }
    return project;
  }

  find(workspaceId: WorkspaceId, projectId: ProjectId) {
    const row = this.database
      .prepare(`SELECT * FROM projects WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, projectId) as ProjectRow | undefined;
    return row === undefined ? undefined : mapProject(row);
  }

  findBySlug(workspaceId: WorkspaceId, slug: string) {
    const row = this.database
      .prepare(`SELECT * FROM projects WHERE workspace_id = ? AND slug = ?`)
      .get(workspaceId, slug) as ProjectRow | undefined;
    return row === undefined ? undefined : mapProject(row);
  }

  list(workspaceId: WorkspaceId) {
    return (
      this.database
        .prepare(`SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at, id`)
        .all(workspaceId) as ProjectRow[]
    ).map(mapProject);
  }

  setActivePlanVersionIfUnset(input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly planVersionId: PlanVersionId;
  }) {
    // The WHERE clause is the guarantee: a changed import can never silently
    // replace the active version (CT03-A31).
    this.database
      .prepare(
        `UPDATE projects SET active_plan_version_id = ?, version = version + 1
         WHERE workspace_id = ? AND id = ? AND active_plan_version_id IS NULL`,
      )
      .run(input.planVersionId, input.workspaceId, input.projectId);
    return this.find(input.workspaceId, input.projectId);
  }

  count() {
    return countOf(this.database, 'projects');
  }
}

class SqlitePlanBundleRepository implements PlanBundleRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: CreatePlanBundleInput) {
    this.database
      .prepare(
        `INSERT INTO plan_bundles (id, workspace_id, project_id, logical_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.workspaceId, input.projectId, input.logicalName, input.createdAt);
    const bundle = this.findForProject(input.workspaceId, input.projectId);
    if (bundle === undefined) {
      throw new Error('Plan bundle insert did not produce a readable row');
    }
    return bundle;
  }

  findForProject(workspaceId: WorkspaceId, projectId: ProjectId) {
    const row = this.database
      .prepare(
        `SELECT * FROM plan_bundles WHERE workspace_id = ? AND project_id = ?
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(workspaceId, projectId) as PlanBundleRow | undefined;
    return row === undefined ? undefined : mapBundle(row);
  }

  count() {
    return countOf(this.database, 'plan_bundles');
  }
}

class SqlitePlanVersionRepository implements PlanVersionRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: CreatePlanVersionInput) {
    this.database
      .prepare(
        `INSERT INTO plan_versions (
           id, workspace_id, project_id, bundle_id, version_number, content_digest,
           digest_algorithm, digest_format_version, source_profile, document,
           normalized_source_json, item_count, required_dependency_count,
           created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.projectId,
        input.bundleId,
        input.versionNumber,
        input.contentDigest,
        input.digestAlgorithm,
        input.digestFormatVersion,
        input.sourceProfile,
        input.document,
        JSON.stringify(input.normalizedSource),
        input.itemCount,
        input.requiredDependencyCount,
        input.createdAt,
        input.createdByUserId,
      );
    const version = this.find(input.workspaceId, input.id);
    if (version === undefined) {
      throw new Error('Plan version insert did not produce a readable row');
    }
    return version;
  }

  find(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    const row = this.database
      .prepare(`SELECT * FROM plan_versions WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, planVersionId) as PlanVersionRow | undefined;
    return row === undefined ? undefined : mapVersion(row);
  }

  findByDigest(workspaceId: WorkspaceId, contentDigest: string) {
    const row = this.database
      .prepare(`SELECT * FROM plan_versions WHERE workspace_id = ? AND content_digest = ?`)
      .get(workspaceId, contentDigest) as PlanVersionRow | undefined;
    return row === undefined ? undefined : mapVersion(row);
  }

  listForProject(workspaceId: WorkspaceId, projectId: ProjectId) {
    return (
      this.database
        .prepare(
          `SELECT * FROM plan_versions WHERE workspace_id = ? AND project_id = ?
           ORDER BY version_number DESC`,
        )
        .all(workspaceId, projectId) as PlanVersionRow[]
    ).map(mapVersion);
  }

  nextVersionNumber(bundleId: PlanBundleId) {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(version_number), 0) AS highest FROM plan_versions WHERE bundle_id = ?`,
      )
      .get(bundleId) as { highest: number };
    return row.highest + 1;
  }

  count() {
    return countOf(this.database, 'plan_versions');
  }
}

class SqlitePlanImportAttemptRepository implements PlanImportAttemptRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: CreatePlanImportAttemptInput) {
    this.database
      .prepare(
        `INSERT INTO plan_import_attempts (
           id, workspace_id, actor_user_id, outcome, requested_project_name,
           requested_project_id, bundle_digest, digest_format_version, project_id,
           plan_version_id, artifact_count, total_byte_length, error_count,
           warning_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.actorUserId,
        input.outcome,
        input.requestedProjectName,
        input.requestedProjectId ?? null,
        input.bundleDigest ?? null,
        input.digestFormatVersion ?? null,
        input.projectId ?? null,
        input.planVersionId ?? null,
        input.artifactCount,
        input.totalByteLength,
        input.errorCount,
        input.warningCount,
        input.createdAt,
      );
    const attempt = this.find(input.workspaceId, input.id);
    if (attempt === undefined) {
      throw new Error('Import attempt insert did not produce a readable row');
    }
    return attempt;
  }

  find(workspaceId: WorkspaceId, attemptId: PlanImportAttemptId) {
    const row = this.database
      .prepare(`SELECT * FROM plan_import_attempts WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, attemptId) as PlanImportAttemptRow | undefined;
    return row === undefined ? undefined : mapAttempt(row);
  }

  listRecent(workspaceId: WorkspaceId, limit: number) {
    return (
      this.database
        .prepare(
          `SELECT * FROM plan_import_attempts WHERE workspace_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(workspaceId, limit) as PlanImportAttemptRow[]
    ).map(mapAttempt);
  }

  count() {
    return countOf(this.database, 'plan_import_attempts');
  }
}

const ARTIFACT_COLUMNS = `id, workspace_id, import_attempt_id, plan_version_id,
  logical_filename, role, media_type, byte_length, sha256, created_at`;

class SqlitePlanArtifactRepository implements PlanArtifactRepository {
  constructor(private readonly database: Database.Database) {}

  insertMany(inputs: readonly CreatePlanArtifactInput[]) {
    const statement = this.database.prepare(
      `INSERT INTO plan_artifacts (
         id, workspace_id, import_attempt_id, plan_version_id, logical_filename,
         role, media_type, byte_length, sha256, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const input of inputs) {
      statement.run(
        input.id,
        input.workspaceId,
        input.importAttemptId,
        input.planVersionId ?? null,
        input.logicalFilename,
        input.role,
        input.mediaType,
        input.byteLength,
        input.sha256,
        Buffer.from(input.content),
        input.createdAt,
      );
    }
    return inputs.map((input) => {
      const row = this.database
        .prepare(`SELECT ${ARTIFACT_COLUMNS} FROM plan_artifacts WHERE id = ?`)
        .get(input.id) as PlanArtifactRow;
      return mapArtifact(row);
    });
  }

  listForVersion(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    return (
      this.database
        .prepare(
          `SELECT ${ARTIFACT_COLUMNS} FROM plan_artifacts
           WHERE workspace_id = ? AND plan_version_id = ?
           ORDER BY role, logical_filename`,
        )
        .all(workspaceId, planVersionId) as PlanArtifactRow[]
    ).map(mapArtifact);
  }

  listForAttempt(workspaceId: WorkspaceId, attemptId: PlanImportAttemptId) {
    return (
      this.database
        .prepare(
          `SELECT ${ARTIFACT_COLUMNS} FROM plan_artifacts
           WHERE workspace_id = ? AND import_attempt_id = ?
           ORDER BY role, logical_filename`,
        )
        .all(workspaceId, attemptId) as PlanArtifactRow[]
    ).map(mapArtifact);
  }

  findWithContent(workspaceId: WorkspaceId, artifactId: PlanArtifactId) {
    // Ownership is resolved through the parent import attempt rather than by
    // trusting the workspace route parameter (CT03-A39).
    const row = this.database
      .prepare(
        `SELECT a.id, a.workspace_id, a.import_attempt_id, a.plan_version_id,
                a.logical_filename, a.role, a.media_type, a.byte_length, a.sha256,
                a.created_at, a.content
         FROM plan_artifacts a
         JOIN plan_import_attempts t ON t.id = a.import_attempt_id
         WHERE a.id = ? AND a.workspace_id = ? AND t.workspace_id = ?`,
      )
      .get(artifactId, workspaceId, workspaceId) as
      | (PlanArtifactRow & { content: Buffer })
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const artifact: StoredPlanArtifact = {
      ...mapArtifact(row),
      content: new Uint8Array(row.content),
    };
    return artifact;
  }

  count() {
    return countOf(this.database, 'plan_artifacts');
  }
}

class SqlitePlanImportDiagnosticRepository implements PlanImportDiagnosticRepository {
  constructor(private readonly database: Database.Database) {}

  insertMany(inputs: readonly CreatePlanImportDiagnosticInput[]) {
    const statement = this.database.prepare(
      `INSERT INTO plan_import_diagnostics (
         id, workspace_id, import_attempt_id, plan_version_id, ordinal, severity,
         code, artifact_name, path, work_item_source_id, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const input of inputs) {
      statement.run(
        input.id,
        input.workspaceId,
        input.importAttemptId,
        input.planVersionId ?? null,
        input.ordinal,
        input.severity,
        input.code,
        input.artifactName ?? null,
        input.path ?? null,
        input.workItemSourceId ?? null,
        input.message,
      );
    }
    return inputs.map((input) => {
      const row = this.database
        .prepare(`SELECT * FROM plan_import_diagnostics WHERE id = ?`)
        .get(input.id) as PlanImportDiagnosticRow;
      return mapDiagnostic(row);
    });
  }

  listForAttempt(workspaceId: WorkspaceId, attemptId: PlanImportAttemptId) {
    return (
      this.database
        .prepare(
          `SELECT * FROM plan_import_diagnostics
           WHERE workspace_id = ? AND import_attempt_id = ? ORDER BY ordinal`,
        )
        .all(workspaceId, attemptId) as PlanImportDiagnosticRow[]
    ).map(mapDiagnostic);
  }

  listForVersion(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    return (
      this.database
        .prepare(
          `SELECT * FROM plan_import_diagnostics
           WHERE workspace_id = ? AND plan_version_id = ? ORDER BY ordinal`,
        )
        .all(workspaceId, planVersionId) as PlanImportDiagnosticRow[]
    ).map(mapDiagnostic);
  }

  count() {
    return countOf(this.database, 'plan_import_diagnostics');
  }
}

class SqliteWorkItemRepository implements WorkItemRepository {
  constructor(private readonly database: Database.Database) {}

  insertMany(inputs: readonly CreateWorkItemInput[]) {
    const statement = this.database.prepare(
      `INSERT INTO work_items (
         id, workspace_id, project_id, plan_version_id, source_id, ordinal, title,
         status, risk, phase, primary_areas_json, exit_gate, source_fields_json,
         admitted_at, admitted_by_user_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, NULL, NULL, 1)`,
    );
    for (const input of inputs) {
      statement.run(
        input.id,
        input.workspaceId,
        input.projectId,
        input.planVersionId,
        input.sourceId,
        input.ordinal,
        input.title,
        input.risk,
        input.phase ?? null,
        JSON.stringify(input.primaryAreas),
        input.exitGate,
        JSON.stringify(input.sourceFields),
      );
    }
    return inputs.map((input) => {
      const row = this.database
        .prepare(`SELECT * FROM work_items WHERE id = ?`)
        .get(input.id) as WorkItemDbRow;
      return mapWorkItem(row);
    });
  }

  find(workspaceId: WorkspaceId, workItemId: WorkItemId) {
    const row = this.database
      .prepare(`SELECT * FROM work_items WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, workItemId) as WorkItemDbRow | undefined;
    return row === undefined ? undefined : mapWorkItem(row);
  }

  listForVersion(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    // One statement with correlated aggregates rather than a query per item.
    const rows = this.database
      .prepare(
        `SELECT w.*,
           (SELECT COUNT(*) FROM work_item_dependencies d
              WHERE d.successor_work_item_id = w.id AND d.kind = 'required')
             AS required_predecessor_count,
           (SELECT COUNT(*) FROM work_item_dependencies d
              WHERE d.successor_work_item_id = w.id AND d.kind = 'recommended')
             AS recommended_predecessor_count,
           (SELECT COALESCE(GROUP_CONCAT(p.source_id, char(31)), '')
              FROM work_item_dependencies d
              JOIN work_items p ON p.plan_version_id = d.plan_version_id
                               AND p.id = d.predecessor_work_item_id
              WHERE d.successor_work_item_id = w.id
                AND d.kind = 'required'
                AND p.status <> 'completed')
             AS blocker_source_ids
         FROM work_items w
         WHERE w.workspace_id = ? AND w.plan_version_id = ?
         ORDER BY w.ordinal`,
      )
      .all(workspaceId, planVersionId) as (WorkItemDbRow & {
      required_predecessor_count: number;
      recommended_predecessor_count: number;
      blocker_source_ids: string;
    })[];
    return rows.map((row): WorkItemRow => {
      const blockers =
        row.blocker_source_ids === '' ? [] : row.blocker_source_ids.split(BLOCKER_SEPARATOR);
      return {
        ...mapWorkItem(row),
        blockerSourceIds: blockers.toSorted((left, right) => left.localeCompare(right, 'en')),
        requiredPredecessorCount: row.required_predecessor_count,
        recommendedPredecessorCount: row.recommended_predecessor_count,
      };
    });
  }

  admit(input: AdmitWorkItemInput) {
    // The status guard makes the update itself the concurrency control: a second
    // admission matches no row (CT03-A54).
    const result = this.database
      .prepare(
        `UPDATE work_items
         SET status = 'admitted', admitted_at = ?, admitted_by_user_id = ?, version = version + 1
         WHERE workspace_id = ? AND id = ? AND status = 'proposed'`,
      )
      .run(input.admittedAt, input.admittedByUserId, input.workspaceId, input.workItemId);
    return result.changes === 0 ? undefined : this.find(input.workspaceId, input.workItemId);
  }

  count() {
    return countOf(this.database, 'work_items');
  }
}

const DEPENDENCY_SUMMARY_COLUMNS = `
  other.id AS work_item_id, other.source_id, other.title, other.status, other.risk, d.kind`;

interface DependencySummaryRow {
  work_item_id: string;
  source_id: string;
  title: string;
  status: WorkItemDependencySummary['status'];
  risk: WorkItemDependencySummary['risk'];
  kind: WorkItemDependencySummary['kind'];
}

function mapDependencySummary(row: DependencySummaryRow): WorkItemDependencySummary {
  return {
    workItemId: row.work_item_id as WorkItemId,
    sourceId: row.source_id,
    title: row.title,
    status: row.status,
    risk: row.risk,
    kind: row.kind,
  };
}

class SqliteWorkItemDependencyRepository implements WorkItemDependencyRepository {
  constructor(private readonly database: Database.Database) {}

  insertMany(inputs: readonly CreateWorkItemDependencyInput[]) {
    const statement = this.database.prepare(
      `INSERT INTO work_item_dependencies (
         id, workspace_id, plan_version_id, predecessor_work_item_id,
         successor_work_item_id, kind, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const input of inputs) {
      statement.run(
        input.id,
        input.workspaceId,
        input.planVersionId,
        input.predecessorWorkItemId,
        input.successorWorkItemId,
        input.kind,
        input.ordinal,
      );
    }
    return inputs.map((input) => {
      const row = this.database
        .prepare(`SELECT * FROM work_item_dependencies WHERE id = ?`)
        .get(input.id) as WorkItemDependencyRow;
      return mapDependency(row);
    });
  }

  listForVersion(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    return (
      this.database
        .prepare(
          `SELECT * FROM work_item_dependencies
           WHERE workspace_id = ? AND plan_version_id = ?
           ORDER BY successor_work_item_id, kind, ordinal`,
        )
        .all(workspaceId, planVersionId) as WorkItemDependencyRow[]
    ).map(mapDependency);
  }

  listPredecessors(workspaceId: WorkspaceId, workItemId: WorkItemId) {
    return this.database
      .prepare(
        `SELECT ${DEPENDENCY_SUMMARY_COLUMNS}
         FROM work_item_dependencies d
         JOIN work_items other ON other.plan_version_id = d.plan_version_id
                              AND other.id = d.predecessor_work_item_id
         WHERE d.workspace_id = ? AND d.successor_work_item_id = ?
         ORDER BY d.kind, d.ordinal`,
      )
      .all(workspaceId, workItemId)
      .map((row) => mapDependencySummary(row as DependencySummaryRow));
  }

  listSuccessors(workspaceId: WorkspaceId, workItemId: WorkItemId) {
    return this.database
      .prepare(
        `SELECT ${DEPENDENCY_SUMMARY_COLUMNS}
         FROM work_item_dependencies d
         JOIN work_items other ON other.plan_version_id = d.plan_version_id
                              AND other.id = d.successor_work_item_id
         WHERE d.workspace_id = ? AND d.predecessor_work_item_id = ?
         ORDER BY d.kind, other.ordinal`,
      )
      .all(workspaceId, workItemId)
      .map((row) => mapDependencySummary(row as DependencySummaryRow));
  }

  count() {
    return countOf(this.database, 'work_item_dependencies');
  }
}

class SqliteWorkContractDraftRepository implements WorkContractDraftRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: CreateWorkContractDraftInput) {
    this.database
      .prepare(
        `INSERT INTO work_contract_drafts (
           id, workspace_id, project_id, plan_version_id, work_item_id,
           schema_version, status, completeness, document_json, created_at,
           created_by_user_id)
         VALUES (?, ?, ?, ?, ?, 1, 'draft', 'incomplete', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.projectId,
        input.planVersionId,
        input.workItemId,
        JSON.stringify(input.document),
        input.createdAt,
        input.createdByUserId,
      );
    const draft = this.findForWorkItem(input.workspaceId, input.workItemId);
    if (draft === undefined) {
      throw new Error('Draft insert did not produce a readable row');
    }
    return draft;
  }

  findForWorkItem(workspaceId: WorkspaceId, workItemId: WorkItemId) {
    const row = this.database
      .prepare(`SELECT * FROM work_contract_drafts WHERE workspace_id = ? AND work_item_id = ?`)
      .get(workspaceId, workItemId) as WorkContractDraftRow | undefined;
    return row === undefined ? undefined : mapDraft(row);
  }

  count() {
    return countOf(this.database, 'work_contract_drafts');
  }
}

interface StatusCountRow {
  proposed_count: number;
  admitted_count: number;
  planning_ready_count: number;
  dependency_blocked_count: number;
  low: number;
  medium: number;
  high: number;
  critical: number;
  unspecified: number;
}

/** Aggregate expressions shared by the workspace, project, and version rollups. */
const STATUS_AGGREGATES = `
  COALESCE(SUM(CASE WHEN w.status = 'proposed' THEN 1 ELSE 0 END), 0) AS proposed_count,
  COALESCE(SUM(CASE WHEN w.status = 'admitted' THEN 1 ELSE 0 END), 0) AS admitted_count,
  COALESCE(SUM(CASE WHEN w.status = 'proposed' AND NOT ${UNSATISFIED_PREDECESSOR_EXISTS}
                    THEN 1 ELSE 0 END), 0) AS planning_ready_count,
  COALESCE(SUM(CASE WHEN ${UNSATISFIED_PREDECESSOR_EXISTS} THEN 1 ELSE 0 END), 0)
    AS dependency_blocked_count,
  COALESCE(SUM(CASE WHEN w.risk = 'low' THEN 1 ELSE 0 END), 0) AS low,
  COALESCE(SUM(CASE WHEN w.risk = 'medium' THEN 1 ELSE 0 END), 0) AS medium,
  COALESCE(SUM(CASE WHEN w.risk = 'high' THEN 1 ELSE 0 END), 0) AS high,
  COALESCE(SUM(CASE WHEN w.risk = 'critical' THEN 1 ELSE 0 END), 0) AS critical,
  COALESCE(SUM(CASE WHEN w.risk = 'unspecified' THEN 1 ELSE 0 END), 0) AS unspecified`;

function toStatusCounts(row: StatusCountRow | undefined): PlanningStatusCounts {
  return {
    proposedCount: row?.proposed_count ?? 0,
    admittedCount: row?.admitted_count ?? 0,
    planningReadyCount: row?.planning_ready_count ?? 0,
    dependencyBlockedCount: row?.dependency_blocked_count ?? 0,
    riskCounts: {
      low: row?.low ?? 0,
      medium: row?.medium ?? 0,
      high: row?.high ?? 0,
      critical: row?.critical ?? 0,
      unspecified: row?.unspecified ?? 0,
    },
  };
}

/**
 * Summaries count only the work items of each project's *active* plan version.
 * Counting every version would inflate the dashboard as soon as a second import
 * lands, and the dashboard answers "what is on my agenda", not "what has ever
 * been proposed".
 */
class SqlitePlanningQueryRepository implements PlanningQueryRepository {
  constructor(private readonly database: Database.Database) {}

  workspaceSummary(workspaceId: WorkspaceId): WorkspacePlanningSummary {
    const counts = this.database
      .prepare(
        `SELECT ${STATUS_AGGREGATES}
         FROM work_items w
         JOIN projects pr ON pr.id = w.project_id
         WHERE w.workspace_id = ? AND pr.active_plan_version_id = w.plan_version_id`,
      )
      .get(workspaceId) as StatusCountRow | undefined;
    const projectCount = (
      this.database
        .prepare(`SELECT COUNT(*) AS count FROM projects WHERE workspace_id = ?`)
        .get(workspaceId) as { count: number }
    ).count;
    const importAttentionCount = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM plan_import_attempts
           WHERE workspace_id = ? AND (outcome = 'failed-validation' OR warning_count > 0)`,
        )
        .get(workspaceId) as { count: number }
    ).count;
    return { ...toStatusCounts(counts), projectCount, importAttentionCount };
  }

  projectSummaries(workspaceId: WorkspaceId, limit: number): readonly ProjectSummaryRow[] {
    const rows = this.database
      .prepare(
        `SELECT pr.id, pr.name, pr.slug, pr.active_plan_version_id, pr.created_at,
                v.document AS document,
                (SELECT COUNT(*) FROM plan_versions pv WHERE pv.project_id = pr.id)
                  AS version_count,
                (SELECT COALESCE(SUM(a.warning_count), 0) FROM plan_import_attempts a
                   WHERE a.project_id = pr.id) AS warning_count,
                ${STATUS_AGGREGATES}
         FROM projects pr
         LEFT JOIN plan_versions v ON v.id = pr.active_plan_version_id
         LEFT JOIN work_items w ON w.plan_version_id = pr.active_plan_version_id
         WHERE pr.workspace_id = ?
         GROUP BY pr.id
         ORDER BY pr.created_at, pr.id
         LIMIT ?`,
      )
      .all(workspaceId, limit) as (StatusCountRow & {
      id: string;
      name: string;
      slug: string;
      active_plan_version_id: string | null;
      created_at: string;
      document: string | null;
      version_count: number;
      warning_count: number;
    })[];
    return rows.map((row) => ({
      id: row.id as ProjectId,
      name: row.name,
      slug: row.slug,
      ...(row.active_plan_version_id === null
        ? {}
        : { activePlanVersionId: row.active_plan_version_id as PlanVersionId }),
      ...(row.document === null ? {} : { document: row.document }),
      versionCount: row.version_count,
      warningCount: row.warning_count,
      createdAt: row.created_at,
      ...toStatusCounts(row),
    }));
  }

  versionSummaries(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): readonly PlanVersionSummaryRow[] {
    return (
      this.database
        .prepare(
          `SELECT v.id, v.version_number, v.content_digest, v.document, v.item_count,
                  v.required_dependency_count, v.created_at,
                  CASE WHEN pr.active_plan_version_id = v.id THEN 1 ELSE 0 END AS is_active
           FROM plan_versions v
           JOIN projects pr ON pr.id = v.project_id
           WHERE v.workspace_id = ? AND v.project_id = ?
           ORDER BY v.version_number DESC`,
        )
        .all(workspaceId, projectId) as {
        id: string;
        version_number: number;
        content_digest: string;
        document: string;
        item_count: number;
        required_dependency_count: number;
        created_at: string;
        is_active: number;
      }[]
    ).map((row) => ({
      id: row.id as PlanVersionId,
      versionNumber: row.version_number,
      contentDigest: row.content_digest,
      document: row.document,
      itemCount: row.item_count,
      requiredDependencyCount: row.required_dependency_count,
      createdAt: row.created_at,
      isActive: row.is_active === 1,
    }));
  }

  versionStatusCounts(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    const row = this.database
      .prepare(
        `SELECT ${STATUS_AGGREGATES}
         FROM work_items w WHERE w.workspace_id = ? AND w.plan_version_id = ?`,
      )
      .get(workspaceId, planVersionId) as StatusCountRow | undefined;
    return toStatusCounts(row);
  }
}

export function planningRepositories(database: Database.Database): PlanningRepositories {
  return {
    projects: new SqliteProjectRepository(database),
    bundles: new SqlitePlanBundleRepository(database),
    versions: new SqlitePlanVersionRepository(database),
    importAttempts: new SqlitePlanImportAttemptRepository(database),
    artifacts: new SqlitePlanArtifactRepository(database),
    diagnostics: new SqlitePlanImportDiagnosticRepository(database),
    workItems: new SqliteWorkItemRepository(database),
    dependencies: new SqliteWorkItemDependencyRepository(database),
    drafts: new SqliteWorkContractDraftRepository(database),
    queries: new SqlitePlanningQueryRepository(database),
  };
}
