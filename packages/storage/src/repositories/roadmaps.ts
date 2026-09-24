import type { Roadmap, RoadmapDefinition, WorkspaceId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { parseRecord, type RecordGuard, readRecord } from '../records.js';

export interface RoadmapRepository {
  list(workspaceId?: WorkspaceId): readonly Roadmap[];
  find(workspaceId: WorkspaceId, id: string): Roadmap | undefined;
  save(roadmap: Roadmap, expectedVersion: number): boolean;
  addDefinition(definition: RoadmapDefinition): void;
  history(workspaceId: WorkspaceId, id: string): readonly RoadmapDefinition[];
  /** One immutable revision by primary key, without parsing the rest of the history. */
  definition(workspaceId: WorkspaceId, id: string, revision: number): RoadmapDefinition | undefined;
}

/**
 * Parsed roadmap definitions by roadmap and revision, shared by every transaction on one
 * storage (R-B3). Revisions are immutable, so a committed entry never goes stale. A
 * revision read inside a write transaction is kept only when that transaction commits,
 * because a rolled-back insert could be followed by a different definition under the same
 * revision number.
 */
export class DefinitionCache {
  private readonly committed = new Map<string, RoadmapDefinition>();
  private readonly pending: Map<string, RoadmapDefinition>[] = [];

  private static key(roadmapId: string, revision: number) {
    return `${roadmapId}@${revision}`;
  }

  get(roadmapId: string, revision: number): RoadmapDefinition | undefined {
    const key = DefinitionCache.key(roadmapId, revision);
    for (let level = this.pending.length - 1; level >= 0; level--) {
      const found = this.pending[level]?.get(key);
      if (found) return found;
    }
    return this.committed.get(key);
  }

  put(definition: RoadmapDefinition): RoadmapDefinition {
    const frozen = deepFreeze(definition);
    (this.pending.at(-1) ?? this.committed).set(
      DefinitionCache.key(definition.roadmapId, definition.revision),
      frozen,
    );
    return frozen;
  }

  /** Brackets one (possibly nested) write transaction. */
  begin(): void {
    this.pending.push(new Map());
  }
  commit(): void {
    const level = this.pending.pop();
    for (const [key, value] of level ?? []) (this.pending.at(-1) ?? this.committed).set(key, value);
  }
  rollback(): void {
    this.pending.pop();
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The stored control row: the roadmap without its definition, which lives in
 * `roadmap_definitions` under `definitionRevision` (R-B3, schema 29).
 */
type StoredRoadmap = Omit<Roadmap, 'definition'> & { readonly definitionRevision: number };

export class SqliteRoadmapRepository implements RoadmapRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly guard: RecordGuard,
    private readonly definitions: DefinitionCache = new DefinitionCache(),
  ) {}

  /** Rehydrates a stored row with its definition, so readers see the same `Roadmap` shape. */
  private map(row: unknown): Roadmap | undefined {
    if (row === undefined) return undefined;
    const { definitionRevision, ...state } = JSON.parse(
      (row as { state_json: string }).state_json,
    ) as StoredRoadmap;
    const definition = this.load(state.id, definitionRevision);
    if (definition === undefined)
      throw new Error(
        `Roadmap ${state.id} has no stored definition revision ${definitionRevision}`,
      );
    return readRecord('roadmap', { ...state, definition });
  }

  private load(id: string, revision: number): RoadmapDefinition | undefined {
    const cached = this.definitions.get(id, revision);
    if (cached) return cached;
    const row = this.db
      .prepare(
        'SELECT definition_json FROM roadmap_definitions WHERE roadmap_id = ? AND revision = ?',
      )
      .get(id, revision) as { definition_json: string } | undefined;
    return row && this.definitions.put(parseRecord('roadmap-definition', row.definition_json));
  }

  list(workspaceId?: WorkspaceId): readonly Roadmap[] {
    const rows =
      workspaceId === undefined
        ? this.db.prepare('SELECT state_json FROM roadmaps ORDER BY rowid').all()
        : this.db
            .prepare('SELECT state_json FROM roadmaps WHERE workspace_id = ? ORDER BY rowid DESC')
            .all(workspaceId);
    return rows.map((row) => this.map(row) as Roadmap);
  }
  find(workspaceId: WorkspaceId, id: string) {
    return this.map(
      this.db
        .prepare('SELECT state_json FROM roadmaps WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, id),
    );
  }

  /**
   * Writes the control row without its definition. A revision not stored yet is stored
   * with it; a stored revision must be exactly this definition, because definitions change
   * only through a new revision.
   */
  save(roadmap: Roadmap, expectedVersion: number): boolean {
    this.guard('roadmap', roadmap);
    const { definition, ...state } = roadmap;
    const stored: StoredRoadmap = { ...state, definitionRevision: definition.revision };
    const json = JSON.stringify(stored);
    const written =
      expectedVersion === 0
        ? this.db
            .prepare(
              'INSERT INTO roadmaps(id, workspace_id, status, version, state_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
            )
            .run(roadmap.id, roadmap.workspaceId, roadmap.status, roadmap.version, json).changes ===
          1
        : this.db
            .prepare(
              'UPDATE roadmaps SET status = ?, version = ?, state_json = ? WHERE workspace_id = ? AND id = ? AND version = ?',
            )
            .run(
              roadmap.status,
              roadmap.version,
              json,
              roadmap.workspaceId,
              roadmap.id,
              expectedVersion,
            ).changes === 1;
    if (written) this.addDefinition(definition);
    return written;
  }

  /** Stores a revision once. Storing the same revision again is a no-op; a different one fails. */
  addDefinition(definition: RoadmapDefinition): void {
    if (this.definitions.get(definition.roadmapId, definition.revision) === definition) return;
    this.guard('roadmap-definition', definition);
    const json = JSON.stringify(definition);
    const existing = this.db
      .prepare(
        'SELECT definition_json FROM roadmap_definitions WHERE roadmap_id = ? AND revision = ?',
      )
      .get(definition.roadmapId, definition.revision) as { definition_json: string } | undefined;
    if (existing) {
      if (existing.definition_json !== json)
        throw new Error(
          `Roadmap ${definition.roadmapId} revision ${definition.revision} is stored with a different definition; save a new revision`,
        );
      return;
    }
    this.db
      .prepare(
        'INSERT INTO roadmap_definitions(roadmap_id, revision, definition_json) VALUES (?, ?, ?)',
      )
      .run(definition.roadmapId, definition.revision, json);
  }
  history(workspaceId: WorkspaceId, id: string): readonly RoadmapDefinition[] {
    return this.db
      .prepare(
        'SELECT definition_json FROM roadmap_definitions d JOIN roadmaps r ON r.id = d.roadmap_id WHERE r.workspace_id = ? AND r.id = ? ORDER BY revision DESC',
      )
      .all(workspaceId, id)
      .map((row) =>
        parseRecord('roadmap-definition', (row as { definition_json: string }).definition_json),
      );
  }
  definition(workspaceId: WorkspaceId, id: string, revision: number) {
    const owned = this.db
      .prepare('SELECT 1 FROM roadmaps WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, id);
    return owned ? this.load(id, revision) : undefined;
  }
}
