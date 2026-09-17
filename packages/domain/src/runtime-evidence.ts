import type { WorkspaceId, UserId, SourceRepositoryId } from './ids.js';
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
export interface EvidenceSubmission {
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
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly submissionId: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly rationale: string;
  readonly decidedAt: string;
  readonly decidedByUserId: UserId;
}
export interface RunEnvironment {
  readonly runId: string;
  readonly workspaceId: WorkspaceId;
  readonly runtimeId: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
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
