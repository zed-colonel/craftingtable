import type { Roadmap, RoadmapDefinition, WorkspaceId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
export interface RoadmapRepository {
  list(workspaceId?: WorkspaceId): readonly Roadmap[];
  find(workspaceId: WorkspaceId, id: string): Roadmap | undefined;
  save(roadmap: Roadmap, expectedVersion: number): boolean;
  addDefinition(definition: RoadmapDefinition): void;
  history(workspaceId: WorkspaceId, id: string): readonly RoadmapDefinition[];
  /** One immutable revision by primary key, without parsing the rest of the history. */
  definition(workspaceId: WorkspaceId, id: string, revision: number): RoadmapDefinition | undefined;
}
function map(row: unknown): Roadmap | undefined {
  return row === undefined
    ? undefined
    : (JSON.parse((row as { state_json: string }).state_json) as Roadmap);
}
export class SqliteRoadmapRepository implements RoadmapRepository {
  constructor(private readonly db: Database.Database) {}
  list(workspaceId?: WorkspaceId): readonly Roadmap[] {
    const rows =
      workspaceId === undefined
        ? this.db.prepare('SELECT state_json FROM roadmaps ORDER BY rowid').all()
        : this.db
            .prepare('SELECT state_json FROM roadmaps WHERE workspace_id = ? ORDER BY rowid DESC')
            .all(workspaceId);
    return rows.map((row) => map(row) as Roadmap);
  }
  find(workspaceId: WorkspaceId, id: string) {
    return map(
      this.db
        .prepare('SELECT state_json FROM roadmaps WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, id),
    );
  }
  save(roadmap: Roadmap, expectedVersion: number): boolean {
    if (expectedVersion === 0)
      return (
        this.db
          .prepare(
            'INSERT INTO roadmaps(id, workspace_id, status, version, state_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
          )
          .run(
            roadmap.id,
            roadmap.workspaceId,
            roadmap.status,
            roadmap.version,
            JSON.stringify(roadmap),
          ).changes === 1
      );
    return (
      this.db
        .prepare(
          'UPDATE roadmaps SET status = ?, version = ?, state_json = ? WHERE workspace_id = ? AND id = ? AND version = ?',
        )
        .run(
          roadmap.status,
          roadmap.version,
          JSON.stringify(roadmap),
          roadmap.workspaceId,
          roadmap.id,
          expectedVersion,
        ).changes === 1
    );
  }
  addDefinition(definition: RoadmapDefinition): void {
    this.db
      .prepare(
        'INSERT INTO roadmap_definitions(roadmap_id, revision, definition_json) VALUES (?, ?, ?)',
      )
      .run(definition.roadmapId, definition.revision, JSON.stringify(definition));
  }
  history(workspaceId: WorkspaceId, id: string): readonly RoadmapDefinition[] {
    return this.db
      .prepare(
        'SELECT definition_json FROM roadmap_definitions d JOIN roadmaps r ON r.id = d.roadmap_id WHERE r.workspace_id = ? AND r.id = ? ORDER BY revision DESC',
      )
      .all(workspaceId, id)
      .map(
        (row) =>
          JSON.parse((row as { definition_json: string }).definition_json) as RoadmapDefinition,
      );
  }
  definition(workspaceId: WorkspaceId, id: string, revision: number) {
    const row = this.db
      .prepare(
        'SELECT definition_json FROM roadmap_definitions d JOIN roadmaps r ON r.id = d.roadmap_id WHERE r.workspace_id = ? AND r.id = ? AND d.revision = ?',
      )
      .get(workspaceId, id, revision) as { definition_json: string } | undefined;
    return row && (JSON.parse(row.definition_json) as RoadmapDefinition);
  }
}
