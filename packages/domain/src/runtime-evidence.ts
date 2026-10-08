import type { WorkspaceId, UserId, SourceRepositoryId } from './ids.js';
import { utf8ByteLength } from './bounded-text.js';
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
/**
 * What plan acceptance covers (R-C6 D1, ADR-050 as amended): a change to any of these
 * re-opens it; names, instructions, model profiles, automation, policy, timestamps, consumer
 * integration pins and host capacities do not.
 */
export const PLAN_ACCEPTANCE_INPUTS = [
  'map',
  'binding',
  'planArchives',
  'adoptedDecisions',
  'stagedDecisions',
  'reviewerRoles',
  'target',
  'resources',
  'upstreamPins',
] as const;
export type PlanAcceptanceInput = (typeof PLAN_ACCEPTANCE_INPUTS)[number];
/** Frozen: bound to a digest of every saved fact and to the definition revision. */
export interface GeneratedPlanEvidenceV1 {
  readonly kind: 'saved-plan-v1';
  readonly roadmapId: string;
  readonly definitionRevision: number;
  readonly snapshotDigest: string;
}
/** Bound to the plan-acceptance inputs only (R-C6 D3); an older release cannot read it. */
export interface GeneratedPlanEvidenceV2 {
  readonly kind: 'saved-plan-v2';
  readonly roadmapId: string;
  /** The saved revision it was generated from; informational, never checked. */
  readonly definitionRevision: number;
  /** SHA-256 of the inputs' canonical JSON (sorted keys). */
  readonly inputsDigest: string;
  /** The inputs that differ from the roadmap's newest accepted plan; empty when none does. */
  readonly changedInputs: readonly PlanAcceptanceInput[];
}
export type GeneratedPlanEvidence = GeneratedPlanEvidenceV1 | GeneratedPlanEvidenceV2;
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
/** An artifact as a submission's head lists it: everything but its contents (R-H4). */
export interface EvidenceArtifactHead {
  readonly name: string;
  readonly digest: string;
  /** The contents' size in UTF-8 bytes. */
  readonly bytes: number;
  /** The contents are empty or only whitespace, so they evidence nothing. */
  readonly blank: boolean;
}
/**
 * A submission without its artifacts' contents (R-H4). Storage keeps one beside each record,
 * written with it and immutable like it; the views, the decision inbox and the policies read
 * heads, and only a submission's own review reads the full record. An architecture
 * decision's text stays in the head.
 */
export interface EvidenceSubmissionHead extends Omit<EvidenceSubmission, 'artifacts'> {
  readonly artifacts: readonly EvidenceArtifactHead[];
}
/** The head of a submission record: each artifact's contents become their size and blankness. */
export function submissionHead(s: EvidenceSubmission): EvidenceSubmissionHead {
  return {
    ...s,
    artifacts: s.artifacts.map((a) => ({
      name: a.name,
      digest: a.digest,
      bytes: utf8ByteLength(a.content),
      // What trim() would leave empty, without copying the contents: `\s` is its set.
      blank: !/\S/.test(a.content),
    })),
  };
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
  /**
   * The accepted plan decision this one carries forward (R-C6 D2): the operator's own command
   * changed the plan-acceptance inputs, and the daemon accepted the re-generated plan as that
   * operator in the same transaction.
   */
  readonly carriedFrom?: string;
}
export interface RunEnvironment {
  readonly architectureDecisionDigest?: string;
  readonly nativeApprovalId?: string;
  readonly runId: string;
  readonly workspaceId: WorkspaceId;
  /**
   * The pinned dependency environment the run was prepared with. Absent on a check-only run
   * (R-G13 increment 4): one with no pinned environment, held to its repository's adopted checks,
   * so it always names `checkDeclarationId`. A release before schema 38 cannot read such a record.
   */
  readonly runtimeId?: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  /**
   * Present when a scoped scope's tree had every upstream link on its current pin at launch, so
   * the run was held to a current-upstream build (ADR-069). Absent on earlier records.
   */
  readonly verificationMode?: 'current-upstream-build';
  /**
   * `daemon` when the run's checks are run and recorded by the daemon (R-G4): its gating
   * receipts come from the daemon's own records, never from a file the agent can write.
   * Absent on runs prepared before that; their receipts are agent-reported.
   */
  readonly receiptAuthority?: 'daemon';
  /**
   * The adopted check declaration the run's gates are held to (R-G13): only daemon receipts of
   * those checks meet a scoped gate, and a current-upstream gate needs them beside a pinned build
   * (increment 2). A check-only run (increment 4) is held to them alone. Absent on runs prepared
   * before declared checks, on current-upstream runs prepared before increment 2, and on runs
   * without a pinned environment prepared before increment 4, which keep the earlier rule.
   */
  readonly checkDeclarationId?: string;
}

/** One check the daemon ran for a run and recorded as it finished (R-G4). Immutable. */
export interface RunCheckReceipt {
  readonly runId: string;
  readonly workspaceId: WorkspaceId;
  /** 1, 2, ... in the order the checks finished. */
  readonly sequence: number;
  /** One receipt line, in the format frozen into the run's build record. */
  readonly receipt: string;
  readonly recordedAt: string;
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
  /** The run environment's; absent for a check-only run (R-G13 increment 4). */
  readonly runtimeId?: string;
  readonly manifestDigest: string;
  readonly receipts: string;
  readonly digest: string;
  readonly error?: string;
}
