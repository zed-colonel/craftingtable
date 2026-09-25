import type { WorkspaceId, UserId, SourceRepositoryId } from './ids.js';
/** Approval grants bounded local fixture execution, never a test pass or Kata authority. */
export interface NativeVerificationApproval {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly definitionId: string;
  readonly bindingRevision: number;
  readonly runtimeId: string;
  readonly approved: boolean;
  readonly hostDigest: string;
  readonly auditDigest: string;
  readonly audit: string;
  readonly rationale: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
export interface DependencyPin {
  readonly alias: string;
  readonly ref: string;
  readonly repositoryId: SourceRepositoryId;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly conformanceRevision: string;
  readonly packages: readonly {
    readonly name: string;
    readonly path: string;
    readonly version?: string;
  }[];
}
export interface QualificationEnvironment {
  readonly id: string;
  readonly kind: 'local-development' | 'external-native' | 'external-kata';
  readonly identityDigest: string;
  readonly fixtureDigest: string;
  readonly toolchainDigest: string;
  readonly authorization: string;
  /** Readable inputs to the three fingerprints; local observations are not qualification. */
  readonly discovery?: {
    readonly kind: 'local-discovery-v1';
    readonly environment: string;
    readonly fixtures: string;
    readonly toolchains: string;
  };
}
export interface RuntimeGeneration {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly definitionId: string;
  readonly bindingRevision: number;
  readonly generation: number;
  readonly digest: string;
  readonly pins: readonly DependencyPin[];
  readonly consumers: readonly { readonly alias: string; readonly upstreams: readonly string[] }[];
  readonly environments: readonly QualificationEnvironment[];
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
export interface EvidenceSubject {
  readonly kind: 'checkpoint' | 'slice' | 'parent';
  readonly sourceId: string;
}
export interface EvidenceArtifact {
  readonly name: string;
  readonly content: string;
  readonly digest: string;
}
export interface GeneratedPlanEvidence {
  readonly kind: 'saved-plan-v1';
  readonly roadmapId: string;
  readonly definitionRevision: number;
  readonly snapshotDigest: string;
}
export interface EvidenceSubmission {
  /** Saved review of a pre-merge candidate; never authorizes another unmerged slice. */
  readonly candidateCheckpoint?: {
    readonly kind: 'reviewed-candidate-v1';
    readonly delegatedReview?: {
      readonly cycleId: string;
      readonly roadmapId: string;
      readonly definitionRevision: number;
      readonly roles: readonly string[];
    };
    readonly worktreeId: string;
    readonly sliceId: string;
    readonly runId: string;
    readonly reportDigest: string;
    readonly buildDigest: string;
    readonly headSha: string;
    readonly treeSha: string;
    readonly integrationSha: string;
    readonly snapshotDigest: string;
  };
  /** A proposal is not authority until separately accepted by the authenticated operator. */
  readonly architectureDecision?: ArchitectureDecision;
  /** Daemon-collected setup facts; the separate operator decision supplies plan review. */
  readonly generatedPlan?: GeneratedPlanEvidence;
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly definitionId: string;
  readonly bindingRevision: number;
  readonly runtimeId: string;
  readonly subject: EvidenceSubject;
  readonly subjectCommit?: string;
  readonly testedCode?: readonly { readonly alias: string; readonly commitSha: string }[];
  readonly sliceMergeSha?: string;
  readonly environmentId: string;
  readonly executedBy: string;
  readonly executedAt: string;
  readonly reviewers: readonly {
    readonly identity: string;
    readonly roles: readonly string[];
    readonly artifact: string;
  }[];
  readonly requirements: readonly { readonly requirement: string; readonly artifact: string }[];
  readonly cases: readonly {
    readonly id: string;
    readonly sourceRecordDigest: string;
    readonly result: 'passed' | 'failed';
    readonly artifact: string;
  }[];
  readonly artifacts: readonly EvidenceArtifact[];
  readonly sourceRunId?: string;
  readonly sourceRunDigest?: string;
  readonly sourceRunCommit?: string;
  readonly kata?: {
    readonly runtime: 'kata';
    readonly hostIdentity: string;
    readonly vmIdentity: string;
    readonly imageDigest: string;
    readonly configurationDigest: string;
    readonly observationArtifact: string;
    readonly noNativeFallback: true;
  };
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
export interface EvidenceDecision {
  /** Recorded checkpoint reviewer roles; candidate provenance distinguishes operator and delegated agent review. */
  readonly checkpointReviewRoles?: readonly string[];
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly submissionId: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly rationale: string;
  readonly decidedAt: string;
  readonly decidedByUserId: UserId;
}
export interface RunEnvironment {
  readonly architectureDecisionDigest?: string;
  readonly nativeApprovalId?: string;
  readonly runId: string;
  readonly workspaceId: WorkspaceId;
  readonly runtimeId: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  /**
   * Present when a scoped scope's tree had every upstream link on its current pin at launch, so
   * the run was held to a current-upstream build (ADR-069). Absent on earlier records.
   */
  readonly verificationMode?: 'current-upstream-build';
}

export interface ArchitectureDecision {
  readonly kind: 'architecture-decision-v1';
  readonly bindingDigest: string;
  readonly coverage: 'full' | 'clauses';
  readonly proposal: string;
  readonly sourceReferences: string;
  readonly retainedObligations: string;
  /** Clause staging changes only these named slices; the full checkpoint remains open. */
  readonly consumers: readonly {
    readonly sliceId: string;
    readonly phase: 'start' | 'merge';
    readonly replacesFullCheckpoint: boolean;
  }[];
}

export interface RunBuildRecord {
  readonly runId: string;
  readonly workspaceId: WorkspaceId;
  readonly runtimeId: string;
  readonly manifestDigest: string;
  readonly receipts: string;
  readonly digest: string;
  readonly error?: string;
}
