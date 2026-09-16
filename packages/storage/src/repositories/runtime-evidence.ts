import type {
  RuntimeGeneration,
  EvidenceSubmission,
  EvidenceDecision,
  RunEnvironment,
  RunBuildRecord,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
const decode = <T>(rows: unknown[]) =>
  rows.map((row) => JSON.parse((row as { record_json: string }).record_json) as T);
export interface RuntimeEvidenceRepository {
  generations(
    ws: string,
    definitionId: string,
    bindingRevision: number,
  ): readonly RuntimeGeneration[];
  addGeneration(value: RuntimeGeneration): void;
  submissions(ws: string, definitionId: string): readonly EvidenceSubmission[];
  addSubmission(value: EvidenceSubmission): void;
  decisions(ws: string): readonly EvidenceDecision[];
  addDecision(value: EvidenceDecision): void;
  run(ws: string, runId: string): RunEnvironment | undefined;
  addRun(value: RunEnvironment): void;
  build(ws: string, runId: string): RunBuildRecord | undefined;
  addBuild(value: RunBuildRecord): void;
}
export class SqliteRuntimeEvidenceRepository implements RuntimeEvidenceRepository {
  constructor(private readonly db: Database.Database) {}
  generations(
    ws: string,
    definitionId: string,
    bindingRevision: number,
  ): readonly RuntimeGeneration[] {
    return decode(
      this.db
        .prepare(
          'SELECT record_json FROM runtime_generations WHERE workspace_id=? AND definition_id=? AND binding_revision=? ORDER BY generation DESC',
        )
        .all(ws, definitionId, bindingRevision),
    );
  }
  addGeneration(v: RuntimeGeneration): void {
    this.db
      .prepare('INSERT INTO runtime_generations VALUES (?,?,?,?,?,?)')
      .run(v.id, v.workspaceId, v.definitionId, v.bindingRevision, v.generation, JSON.stringify(v));
  }
  submissions(ws: string, definitionId: string): readonly EvidenceSubmission[] {
    return decode(
      this.db
        .prepare(
          "SELECT record_json FROM evidence_submissions WHERE workspace_id=? AND json_extract(record_json,'$.definitionId')=? ORDER BY rowid DESC",
        )
        .all(ws, definitionId),
    );
  }
  addSubmission(v: EvidenceSubmission): void {
    this.db
      .prepare('INSERT INTO evidence_submissions VALUES (?,?,?,?)')
      .run(v.id, v.workspaceId, v.runtimeId, JSON.stringify(v));
  }
  decisions(ws: string): readonly EvidenceDecision[] {
    return decode(
      this.db
        .prepare(
          'SELECT record_json FROM evidence_decisions WHERE workspace_id=? ORDER BY rowid DESC',
        )
        .all(ws),
    );
  }
  addDecision(v: EvidenceDecision): void {
    this.db
      .prepare('INSERT INTO evidence_decisions VALUES (?,?,?,?)')
      .run(v.id, v.workspaceId, v.submissionId, JSON.stringify(v));
  }
  run(ws: string, id: string): RunEnvironment | undefined {
    return decode<RunEnvironment>(
      this.db
        .prepare('SELECT record_json FROM run_environments WHERE workspace_id=? AND run_id=?')
        .all(ws, id),
    )[0];
  }
  build(ws: string, id: string): RunBuildRecord | undefined {
    return decode<RunBuildRecord>(
      this.db
        .prepare('SELECT record_json FROM run_build_records WHERE workspace_id=? AND run_id=?')
        .all(ws, id),
    )[0];
  }
  addBuild(v: RunBuildRecord): void {
    this.db
      .prepare('INSERT INTO run_build_records VALUES (?,?,?)')
      .run(v.runId, v.workspaceId, JSON.stringify(v));
  }
  addRun(v: RunEnvironment): void {
    this.db
      .prepare('INSERT INTO run_environments VALUES (?,?,?,?)')
      .run(v.runId, v.workspaceId, v.runtimeId, JSON.stringify(v));
  }
}
