import type {
  ArchiveImportAttempt,
  ConcurrencyBindingRevision,
  ConcurrencyDefinition,
  ImportedArchive,
  PlanArchiveLink,
  PlanVersionId,
  ProjectId,
  WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';

const record = <T>(row: unknown): T | undefined =>
  row === undefined ? undefined : (JSON.parse((row as { record_json: string }).record_json) as T);
export interface ImportRepository {
  addArchive(archive: ImportedArchive, bytes: Uint8Array): ImportedArchive;
  archiveInfo(workspaceId: WorkspaceId, id: string): ImportedArchive | undefined;
  archive(
    workspaceId: WorkspaceId,
    id: string,
  ): (ImportedArchive & { content: Uint8Array }) | undefined;
  addAttempt(attempt: ArchiveImportAttempt): void;
  attempts(
    workspaceId: WorkspaceId,
    kind: ArchiveImportAttempt['kind'],
  ): readonly ArchiveImportAttempt[];
  addDefinition(definition: ConcurrencyDefinition): void;
  definitions(workspaceId: WorkspaceId): readonly ConcurrencyDefinition[];
  definition(workspaceId: WorkspaceId, id: string): ConcurrencyDefinition | undefined;
  addBindings(bindings: ConcurrencyBindingRevision): void;
  bindings(workspaceId: WorkspaceId, definitionId: string): readonly ConcurrencyBindingRevision[];
  linkPlan(link: PlanArchiveLink): void;
  planLinks(workspaceId: WorkspaceId, planVersionId: PlanVersionId): readonly PlanArchiveLink[];
  activatePlan(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    planVersionId: PlanVersionId,
    expectedVersion: number,
  ): boolean;
}
export class SqliteImportRepository implements ImportRepository {
  constructor(private readonly db: Database.Database) {}
  addArchive(archive: ImportedArchive, bytes: Uint8Array): ImportedArchive {
    this.db
      .prepare(
        'INSERT INTO import_archives(id, workspace_id, digest, filename, byte_length, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, digest) DO NOTHING',
      )
      .run(
        archive.id,
        archive.workspaceId,
        archive.digest,
        archive.filename,
        bytes.length,
        bytes,
        archive.createdAt,
      );
    const row = this.db
      .prepare('SELECT id FROM import_archives WHERE workspace_id = ? AND digest = ?')
      .get(archive.workspaceId, archive.digest) as { id: string };
    return this.archiveInfo(archive.workspaceId, row.id) as ImportedArchive;
  }
  archiveInfo(workspaceId: WorkspaceId, id: string): ImportedArchive | undefined {
    return this.db
      .prepare(
        'SELECT id, workspace_id AS workspaceId, filename, digest, byte_length AS byteLength, created_at AS createdAt FROM import_archives WHERE workspace_id = ? AND id = ?',
      )
      .get(workspaceId, id) as ImportedArchive | undefined;
  }
  archive(workspaceId: WorkspaceId, id: string) {
    const row = this.db
      .prepare('SELECT * FROM import_archives WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, id) as
      | {
          id: string;
          workspace_id: WorkspaceId;
          filename: string;
          digest: string;
          byte_length: number;
          content: Uint8Array;
          created_at: string;
        }
      | undefined;
    return (
      row && {
        id: row.id,
        workspaceId: row.workspace_id,
        filename: row.filename,
        digest: row.digest,
        byteLength: row.byte_length,
        content: row.content,
        createdAt: row.created_at,
      }
    );
  }
  addAttempt(attempt: ArchiveImportAttempt) {
    this.db
      .prepare(
        'INSERT INTO archive_import_attempts(id, workspace_id, archive_id, kind, record_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        attempt.id,
        attempt.workspaceId,
        attempt.archiveId,
        attempt.kind,
        JSON.stringify(attempt),
      );
  }
  attempts(workspaceId: WorkspaceId, kind: ArchiveImportAttempt['kind']) {
    return this.db
      .prepare(
        'SELECT record_json FROM archive_import_attempts WHERE workspace_id = ? AND kind = ? ORDER BY rowid DESC LIMIT 50',
      )
      .all(workspaceId, kind)
      .map((r) => record<ArchiveImportAttempt>(r) as ArchiveImportAttempt);
  }
  addDefinition(d: ConcurrencyDefinition) {
    this.db
      .prepare(
        'INSERT INTO concurrency_definitions(id, workspace_id, archive_id, map_id, revision, digest, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(d.id, d.workspaceId, d.archiveId, d.mapId, d.revision, d.digest, JSON.stringify(d));
  }
  definitions(workspaceId: WorkspaceId) {
    return this.db
      .prepare(
        'SELECT record_json FROM concurrency_definitions WHERE workspace_id = ? ORDER BY rowid DESC',
      )
      .all(workspaceId)
      .map((r) => record<ConcurrencyDefinition>(r) as ConcurrencyDefinition);
  }
  definition(workspaceId: WorkspaceId, id: string) {
    return record<ConcurrencyDefinition>(
      this.db
        .prepare(
          'SELECT record_json FROM concurrency_definitions WHERE workspace_id = ? AND id = ?',
        )
        .get(workspaceId, id),
    );
  }
  addBindings(b: ConcurrencyBindingRevision) {
    this.db
      .prepare(
        'INSERT INTO concurrency_bindings(workspace_id, definition_id, revision, record_json) VALUES (?, ?, ?, ?)',
      )
      .run(b.workspaceId, b.definitionId, b.revision, JSON.stringify(b));
  }
  bindings(workspaceId: WorkspaceId, definitionId: string) {
    return this.db
      .prepare(
        'SELECT record_json FROM concurrency_bindings WHERE workspace_id = ? AND definition_id = ? ORDER BY revision DESC',
      )
      .all(workspaceId, definitionId)
      .map((r) => record<ConcurrencyBindingRevision>(r) as ConcurrencyBindingRevision);
  }
  linkPlan(link: PlanArchiveLink) {
    this.db
      .prepare(
        'INSERT INTO plan_archive_links(workspace_id, plan_version_id, archive_id, record_json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .run(link.workspaceId, link.planVersionId, link.archiveId, JSON.stringify(link));
  }
  planLinks(workspaceId: WorkspaceId, planVersionId: PlanVersionId) {
    return this.db
      .prepare(
        'SELECT record_json FROM plan_archive_links WHERE workspace_id = ? AND plan_version_id = ? ORDER BY rowid',
      )
      .all(workspaceId, planVersionId)
      .map((r) => record<PlanArchiveLink>(r) as PlanArchiveLink);
  }
  activatePlan(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    planVersionId: PlanVersionId,
    expectedVersion: number,
  ) {
    return (
      this.db
        .prepare(
          'UPDATE projects SET active_plan_version_id = ?, version = version + 1 WHERE workspace_id = ? AND id = ? AND version = ?',
        )
        .run(planVersionId, workspaceId, projectId, expectedVersion).changes === 1
    );
  }
}
