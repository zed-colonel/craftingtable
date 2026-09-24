import type {
  ExecutionScope,
  MapAmendment,
  ScopeIntegrationReuse,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { parseRecord, type RecordGuard, readRecord } from '../records.js';
/** One amendment: the proposal document, plus its decision once one is recorded. */
export function mapAmendment(row: {
  readonly proposal_json: string;
  readonly decision_json: string | null;
}): MapAmendment {
  return readRecord('map-amendment', {
    ...JSON.parse(row.proposal_json),
    ...(row.decision_json ? { decision: JSON.parse(row.decision_json) } : {}),
  });
}
export class SqliteMapAmendmentRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  list(ws: WorkspaceId, roadmapId?: string): readonly MapAmendment[] {
    const rows = roadmapId
      ? this.db
          .prepare(
            'SELECT proposal_json,decision_json FROM map_amendments WHERE workspace_id=? AND roadmap_id=? ORDER BY rowid DESC',
          )
          .all(ws, roadmapId)
      : this.db
          .prepare(
            'SELECT proposal_json,decision_json FROM map_amendments WHERE workspace_id=? ORDER BY rowid DESC',
          )
          .all(ws);
    return (rows as { proposal_json: string; decision_json: string | null }[]).map(mapAmendment);
  }
  add(a: MapAmendment) {
    this.guard('map-amendment', a);
    this.db
      .prepare(
        'INSERT INTO map_amendments(id,workspace_id,roadmap_id,proposal_json) VALUES(?,?,?,?)',
      )
      .run(a.id, a.workspaceId, a.roadmapId, JSON.stringify(a));
  }
  decide(ws: WorkspaceId, id: string, decision: NonNullable<MapAmendment['decision']>) {
    const proposal = this.db
      .prepare(
        'SELECT proposal_json, NULL AS decision_json FROM map_amendments WHERE workspace_id=? AND id=?',
      )
      .get(ws, id) as { proposal_json: string; decision_json: null } | undefined;
    if (proposal) this.guard('map-amendment', { ...mapAmendment(proposal), decision });
    return (
      this.db
        .prepare(
          'UPDATE map_amendments SET decision_json=? WHERE workspace_id=? AND id=? AND decision_json IS NULL',
        )
        .run(JSON.stringify(decision), ws, id).changes === 1
    );
  }
  pending(ws: WorkspaceId, roadmapId: string) {
    return this.list(ws, roadmapId).find((a) => !a.decision);
  }
  retire(ws: WorkspaceId, worktreeId: string, amendmentId: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO retired_scope_worktrees VALUES(?,?,?)')
      .run(ws, worktreeId, amendmentId);
  }
  retired(ws: WorkspaceId, worktreeId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM retired_scope_worktrees WHERE workspace_id=? AND worktree_id=?')
      .get(ws, worktreeId);
  }
  supersede(ws: WorkspaceId, id: string, revision: number, amendmentId: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO superseded_map_bindings VALUES(?,?,?,?)')
      .run(ws, id, revision, amendmentId);
  }
  superseded(ws: WorkspaceId, id: string, revision: number): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM superseded_map_bindings WHERE workspace_id=? AND definition_id=? AND binding_revision=?',
      )
      .get(ws, id, revision);
  }
  addIntegration(r: ScopeIntegrationReuse) {
    this.guard('scope-integration-reuse', r);
    this.db
      .prepare('INSERT INTO scope_integration_reuse VALUES(?,?,?,?,?,?,?,?)')
      .run(
        r.id,
        r.amendmentId,
        r.workspaceId,
        r.workItemId,
        r.scope.definitionId,
        r.scope.bindingRevision,
        r.scope.sourceId,
        JSON.stringify(r),
      );
  }
  integrations(
    ws: WorkspaceId,
    item: WorkItemId,
    scope: ExecutionScope,
  ): readonly ScopeIntegrationReuse[] {
    return (
      this.db
        .prepare(
          'SELECT record_json FROM scope_integration_reuse WHERE workspace_id=? AND work_item_id=? AND definition_id=? AND binding_revision=? AND source_id=? ORDER BY rowid DESC',
        )
        .all(ws, item, scope.definitionId, scope.bindingRevision, scope.sourceId) as {
        record_json: string;
      }[]
    ).map((r) => parseRecord('scope-integration-reuse', r.record_json));
  }
}
export type MapAmendmentRepository = Pick<
  SqliteMapAmendmentRepository,
  | 'list'
  | 'add'
  | 'decide'
  | 'pending'
  | 'retire'
  | 'retired'
  | 'supersede'
  | 'superseded'
  | 'addIntegration'
  | 'integrations'
>;
