import type {
  EvidenceDecision,
  EvidenceSubmission,
  EvidenceSubmissionHead,
  NativeVerificationApproval,
  RunBuildRecord,
  RunCheckReceipt,
  RunEnvironment,
  RuntimeGeneration,
  RepositoryCheckDeclaration,
  UpstreamTransitionRecord,
  WorkspaceId,
  ConcurrencyDefinitionId,
  SourceRepositoryId,
  RepositoryCheckDeclarationId,
  EvidenceSubmissionId,
  AgentRunId,
} from '@craftingtable/domain';
import { submissionHead } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { type PersistedRecordKind, parseRecord, type RecordGuard } from '../records.js';

const decode = <K extends PersistedRecordKind>(kind: K, rows: unknown[], column = 'record_json') =>
  rows.map((row) => parseRecord(kind, (row as Record<string, string>)[column] as string));

export interface RuntimeEvidenceRepository {
  nativeApprovals(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
    bindingRevision: number,
  ): readonly NativeVerificationApproval[];
  addNativeApproval(value: NativeVerificationApproval): void;
  /** Oldest first, so declarations keep their approval order (ADR-069). */
  upstreamTransitions(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
  ): readonly UpstreamTransitionRecord[];
  addUpstreamTransitions(value: UpstreamTransitionRecord): void;
  /** A repository's adopted check declarations (R-G13), newest version first. */
  checkDeclarations(
    ws: WorkspaceId,
    repositoryId: SourceRepositoryId,
  ): readonly RepositoryCheckDeclaration[];
  checkDeclaration(
    ws: WorkspaceId,
    id: RepositoryCheckDeclarationId,
  ): RepositoryCheckDeclaration | undefined;
  addCheckDeclaration(value: RepositoryCheckDeclaration): void;
  generations(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
    bindingRevision: number,
  ): readonly RuntimeGeneration[];
  addGeneration(value: RuntimeGeneration): void;
  /**
   * A map's submissions, newest first, as heads: without their artifacts' contents (R-H4).
   * Only `submission` reads a record.
   */
  submissions(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
  ): readonly EvidenceSubmissionHead[];
  /** One submission's full record, with its artifacts' contents (R-H4). */
  submission(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
    id: EvidenceSubmissionId,
  ): EvidenceSubmission | undefined;
  /** Writes the record and its head together. */
  addSubmission(value: EvidenceSubmission): void;
  decisions(ws: WorkspaceId): readonly EvidenceDecision[];
  addDecision(value: EvidenceDecision): void;
  run(ws: WorkspaceId, runId: AgentRunId): RunEnvironment | undefined;
  addRun(value: RunEnvironment): void;
  build(ws: WorkspaceId, runId: AgentRunId): RunBuildRecord | undefined;
  addBuild(value: RunBuildRecord): void;
  /** In the order the daemon recorded them (R-G4). */
  checkReceipts(ws: WorkspaceId, runId: AgentRunId): readonly RunCheckReceipt[];
  addCheckReceipt(value: RunCheckReceipt): void;
}
export class SqliteRuntimeEvidenceRepository implements RuntimeEvidenceRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  nativeApprovals(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
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
  upstreamTransitions(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
  ): readonly UpstreamTransitionRecord[] {
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
  checkDeclarations(
    ws: WorkspaceId,
    repositoryId: SourceRepositoryId,
  ): readonly RepositoryCheckDeclaration[] {
    return decode(
      'repository-check-declaration',
      this.db
        .prepare(
          'SELECT record_json FROM repository_check_declarations WHERE workspace_id=? AND repository_id=? ORDER BY version DESC',
        )
        .all(ws, repositoryId),
    );
  }
  checkDeclaration(
    ws: WorkspaceId,
    id: RepositoryCheckDeclarationId,
  ): RepositoryCheckDeclaration | undefined {
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
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
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
  submissions(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
  ): readonly EvidenceSubmissionHead[] {
    return decode(
      'evidence-submission-head',
      this.db
        .prepare(
          'SELECT head_json FROM evidence_submission_heads WHERE workspace_id=? AND definition_id=? ORDER BY rowid DESC',
        )
        .all(ws, definitionId),
      'head_json',
    );
  }
  submission(
    ws: WorkspaceId,
    definitionId: ConcurrencyDefinitionId,
    id: EvidenceSubmissionId,
  ): EvidenceSubmission | undefined {
    return decode(
      'evidence-submission',
      this.db
        .prepare(
          "SELECT record_json FROM evidence_submissions WHERE workspace_id=? AND id=? AND json_extract(record_json,'$.definitionId')=?",
        )
        .all(ws, id, definitionId),
    )[0];
  }
  addSubmission(v: EvidenceSubmission): void {
    this.guard('evidence-submission', v);
    const head = submissionHead(v);
    this.guard('evidence-submission-head', head);
    // In submission order, so the heads' rowids keep it (migration 0039).
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO evidence_submissions VALUES (?,?,?,?)')
        .run(v.id, v.workspaceId, v.runtimeId, JSON.stringify(v));
      this.db
        .prepare('INSERT INTO evidence_submission_heads VALUES (?,?,?,?)')
        .run(v.id, v.workspaceId, v.definitionId, JSON.stringify(head));
    })();
  }
  decisions(ws: WorkspaceId): readonly EvidenceDecision[] {
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
  run(ws: WorkspaceId, id: AgentRunId): RunEnvironment | undefined {
    return decode(
      'run-environment',
      this.db
        .prepare('SELECT record_json FROM run_environments WHERE workspace_id=? AND run_id=?')
        .all(ws, id),
    )[0];
  }
  build(ws: WorkspaceId, id: AgentRunId): RunBuildRecord | undefined {
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
  checkReceipts(ws: WorkspaceId, id: AgentRunId): readonly RunCheckReceipt[] {
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
      // A check-only run has no runtime (R-G13 increment 4, migration 0038).
      .run(v.runId, v.workspaceId, v.runtimeId ?? null, JSON.stringify(v));
  }
}
