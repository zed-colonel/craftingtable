import type {
  EvidenceDecision,
  EvidenceSubmission,
  NativeVerificationApproval,
  RunBuildRecord,
  RunCheckReceipt,
  RunEnvironment,
  RuntimeGeneration,
  RepositoryCheckDeclaration,
  UpstreamTransitionRecord,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { type PersistedRecordKind, parseRecord, type RecordGuard } from '../records.js';

const decode = <K extends PersistedRecordKind>(kind: K, rows: unknown[]) =>
  rows.map((row) => parseRecord(kind, (row as { record_json: string }).record_json));
export interface RuntimeEvidenceRepository {
  nativeApprovals(
    ws: string,
    definitionId: string,
    bindingRevision: number,
  ): readonly NativeVerificationApproval[];
  addNativeApproval(value: NativeVerificationApproval): void;
  /** Oldest first, so declarations keep their approval order (ADR-069). */
  upstreamTransitions(ws: string, definitionId: string): readonly UpstreamTransitionRecord[];
  addUpstreamTransitions(value: UpstreamTransitionRecord): void;
  /** A repository's adopted check declarations (R-G13), newest version first. */
  checkDeclarations(ws: string, repositoryId: string): readonly RepositoryCheckDeclaration[];
  checkDeclaration(ws: string, id: string): RepositoryCheckDeclaration | undefined;
  addCheckDeclaration(value: RepositoryCheckDeclaration): void;
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
  /** In the order the daemon recorded them (R-G4). */
  checkReceipts(ws: string, runId: string): readonly RunCheckReceipt[];
  addCheckReceipt(value: RunCheckReceipt): void;
}
export class SqliteRuntimeEvidenceRepository implements RuntimeEvidenceRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  nativeApprovals(
    ws: string,
    definitionId: string,
    bindingRevision: number,
  ): readonly NativeVerificationApproval[] {
    return decode(
      'native-approval',
      this.db
        .prepare(
          'SELECT record_json FROM native_verification_approvals WHERE workspace_id=? AND definition_id=? AND binding_revision=? ORDER BY rowid DESC',
        )
        .all(ws, definitionId, bindingRevision),
    );
  }
  addNativeApproval(v: NativeVerificationApproval): void {
    this.guard('native-approval', v);
    this.db
      .prepare('INSERT INTO native_verification_approvals VALUES (?,?,?,?,?)')
      .run(v.id, v.workspaceId, v.definitionId, v.bindingRevision, JSON.stringify(v));
  }
  upstreamTransitions(ws: string, definitionId: string): readonly UpstreamTransitionRecord[] {
    return decode(
      'upstream-transition-record',
      this.db
        .prepare(
          'SELECT record_json FROM upstream_transition_records WHERE workspace_id=? AND definition_id=? ORDER BY rowid',
        )
        .all(ws, definitionId),
    );
  }
  addUpstreamTransitions(v: UpstreamTransitionRecord): void {
    this.guard('upstream-transition-record', v);
    this.db
      .prepare('INSERT INTO upstream_transition_records VALUES (?,?,?,?)')
      .run(v.id, v.workspaceId, v.definitionId, JSON.stringify(v));
  }
  checkDeclarations(ws: string, repositoryId: string): readonly RepositoryCheckDeclaration[] {
    return decode(
      'repository-check-declaration',
      this.db
        .prepare(
          'SELECT record_json FROM repository_check_declarations WHERE workspace_id=? AND repository_id=? ORDER BY version DESC',
        )
        .all(ws, repositoryId),
    );
  }
  checkDeclaration(ws: string, id: string): RepositoryCheckDeclaration | undefined {
    return decode(
      'repository-check-declaration',
      this.db
        .prepare(
          'SELECT record_json FROM repository_check_declarations WHERE workspace_id=? AND id=?',
        )
        .all(ws, id),
    )[0];
  }
  addCheckDeclaration(v: RepositoryCheckDeclaration): void {
    this.guard('repository-check-declaration', v);
    this.db
      .prepare('INSERT INTO repository_check_declarations VALUES (?,?,?,?,?)')
      .run(v.id, v.workspaceId, v.repositoryId, v.version, JSON.stringify(v));
  }
  generations(
    ws: string,
    definitionId: string,
    bindingRevision: number,
  ): readonly RuntimeGeneration[] {
    return decode(
      'runtime-generation',
      this.db
        .prepare(
          'SELECT record_json FROM runtime_generations WHERE workspace_id=? AND definition_id=? AND binding_revision=? ORDER BY generation DESC',
        )
        .all(ws, definitionId, bindingRevision),
    );
  }
  addGeneration(v: RuntimeGeneration): void {
    this.guard('runtime-generation', v);
    this.db
      .prepare('INSERT INTO runtime_generations VALUES (?,?,?,?,?,?)')
      .run(v.id, v.workspaceId, v.definitionId, v.bindingRevision, v.generation, JSON.stringify(v));
  }
  submissions(ws: string, definitionId: string): readonly EvidenceSubmission[] {
    return decode(
      'evidence-submission',
      this.db
        .prepare(
          "SELECT record_json FROM evidence_submissions WHERE workspace_id=? AND json_extract(record_json,'$.definitionId')=? ORDER BY rowid DESC",
        )
        .all(ws, definitionId),
    );
  }
  addSubmission(v: EvidenceSubmission): void {
    this.guard('evidence-submission', v);
    this.db
      .prepare('INSERT INTO evidence_submissions VALUES (?,?,?,?)')
      .run(v.id, v.workspaceId, v.runtimeId, JSON.stringify(v));
  }
  decisions(ws: string): readonly EvidenceDecision[] {
    return decode(
      'evidence-decision',
      this.db
        .prepare(
          'SELECT record_json FROM evidence_decisions WHERE workspace_id=? ORDER BY rowid DESC',
        )
        .all(ws),
    );
  }
  addDecision(v: EvidenceDecision): void {
    this.guard('evidence-decision', v);
    this.db
      .prepare('INSERT INTO evidence_decisions VALUES (?,?,?,?)')
      .run(v.id, v.workspaceId, v.submissionId, JSON.stringify(v));
  }
  run(ws: string, id: string): RunEnvironment | undefined {
    return decode(
      'run-environment',
      this.db
        .prepare('SELECT record_json FROM run_environments WHERE workspace_id=? AND run_id=?')
        .all(ws, id),
    )[0];
  }
  build(ws: string, id: string): RunBuildRecord | undefined {
    return decode(
      'run-build-record',
      this.db
        .prepare('SELECT record_json FROM run_build_records WHERE workspace_id=? AND run_id=?')
        .all(ws, id),
    )[0];
  }
  addBuild(v: RunBuildRecord): void {
    this.guard('run-build-record', v);
    this.db
      .prepare('INSERT INTO run_build_records VALUES (?,?,?)')
      .run(v.runId, v.workspaceId, JSON.stringify(v));
  }
  checkReceipts(ws: string, id: string): readonly RunCheckReceipt[] {
    return decode(
      'run-check-receipt',
      this.db
        .prepare(
          'SELECT record_json FROM run_check_receipts WHERE workspace_id=? AND run_id=? ORDER BY sequence',
        )
        .all(ws, id),
    );
  }
  addCheckReceipt(v: RunCheckReceipt): void {
    this.guard('run-check-receipt', v);
    this.db
      .prepare('INSERT INTO run_check_receipts VALUES (?,?,?,?)')
      .run(v.runId, v.sequence, v.workspaceId, JSON.stringify(v));
  }
  addRun(v: RunEnvironment): void {
    this.guard('run-environment', v);
    this.db
      .prepare('INSERT INTO run_environments VALUES (?,?,?,?)')
      .run(v.runId, v.workspaceId, v.runtimeId, JSON.stringify(v));
  }
}
