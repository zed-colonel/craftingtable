import type {
  ArchiveImportAttempt,
  ConcurrencyBindingRevision,
  ConcurrencyDefinition,
  ImportedArchive,
  MapAdoption,
  PlanArchiveLink,
  PlanVersionId,
  ProjectId,
  WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { type PersistedRecordKind, parseRecord, type RecordGuard } from '../records.js';

const record = <K extends PersistedRecordKind>(kind: K, row: unknown) =>
  row === undefined ? undefined : parseRecord(kind, (row as { record_json: string }).record_json);
export interface ImportRepository {
  addAdoption(adoption: MapAdoption): void;
  adoptions(workspaceId: WorkspaceId, definitionId: string): readonly MapAdoption[];
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
  constructor(
    private readonly db: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  addAdoption(a: MapAdoption) {
    this.guard('map-adoption', a);
    this.db
      .prepare(
        'INSERT INTO map_adoptions(id,workspace_id,definition_id,binding_revision,record_json) VALUES(?,?,?,?,?)',
      )
      .run(a.id, a.workspaceId, a.definitionId, a.bindingRevision, JSON.stringify(a));
  }
  adoptions(ws: WorkspaceId, id: string): readonly MapAdoption[] {
    return this.db
      .prepare(
        'SELECT record_json FROM map_adoptions WHERE workspace_id=? AND definition_id=? ORDER BY rowid DESC',
      )
      .all(ws, id)
      .map((r) => record('map-adoption', r)!);
  }
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
    this.guard('archive-import-attempt', attempt);
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
      .map((r) => record('archive-import-attempt', r) as ArchiveImportAttempt);
  }
  addDefinition(d: ConcurrencyDefinition) {
    this.guard('concurrency-definition', d);
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
      .map((r) => record('concurrency-definition', r) as ConcurrencyDefinition);
  }
  definition(workspaceId: WorkspaceId, id: string) {
    return record(
      'concurrency-definition',
      this.db
        .prepare(
          'SELECT record_json FROM concurrency_definitions WHERE workspace_id = ? AND id = ?',
        )
        .get(workspaceId, id),
    );
  }
  addBindings(b: ConcurrencyBindingRevision) {
    this.guard('concurrency-binding', b);
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
      .map((r) => record('concurrency-binding', r) as ConcurrencyBindingRevision);
  }
  linkPlan(link: PlanArchiveLink) {
    this.guard('plan-archive-link', link);
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
      .map((r) => record('plan-archive-link', r) as PlanArchiveLink);
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
