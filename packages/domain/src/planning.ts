import type { JsonValue } from './audit.js';
import type {
  PlanArtifactId,
  PlanBundleId,
  PlanImportAttemptId,
  PlanImportDiagnosticId,
  PlanVersionId,
  ProjectId,
  UserId,
  WorkContractDraftId,
  WorkItemDependencyId,
  WorkItemId,
  WorkspaceId,
} from './ids.js';

/**
 * CT-03 planning vocabulary and durable records (work-items/CT-03/CT-03.md §5.5).
 *
 * These are pure records. They depend on no HTTP, SQL, React, filesystem, or
 * parser code, and they carry no behaviour beyond membership predicates.
 */

/** The only source profile CT-03 supports (CT-03 §5.3). */
export const PLAN_SOURCE_PROFILES = ['exo-work-breakdown-v1'] as const;
export type PlanSourceProfile = (typeof PLAN_SOURCE_PROFILES)[number];

/**
 * Artifact roles. The multipart field name *is* the role, so these strings are
 * part of the import wire contract and must stay stable (CT-03 §5.1).
 */
export const PLAN_ARTIFACT_ROLES = [
  'implementation-plan',
  'work-breakdown',
  'assumption-ledger',
  'validation-manifest',
  'decision-log',
  'supporting',
] as const;
export type PlanArtifactRole = (typeof PLAN_ARTIFACT_ROLES)[number];

/** Roles a bundle must contain exactly once (CT-03 §5.1). */
export const REQUIRED_PLAN_ARTIFACT_ROLES = ['implementation-plan', 'work-breakdown'] as const;

/** Roles that may appear more than once. Every other role is at most one. */
export const REPEATABLE_PLAN_ARTIFACT_ROLES = ['supporting'] as const;

export function isPlanArtifactRole(value: unknown): value is PlanArtifactRole {
  return (PLAN_ARTIFACT_ROLES as readonly string[]).includes(value as string);
}

export const PLAN_IMPORT_OUTCOMES = ['succeeded', 'failed-validation', 'duplicate'] as const;
export type PlanImportOutcome = (typeof PLAN_IMPORT_OUTCOMES)[number];

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/**
 * CT-03 exposes exactly one transition, Proposed -> Admitted (CT-03 §5.11).
 * Later statuses (Active, Completed, Canceled, Superseded) are deliberately
 * absent so no unsupported transition can be represented.
 */
export const WORK_ITEM_STATUSES = ['proposed', 'admitted'] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * Closed risk vocabulary. An unrecognized source risk normalizes to
 * `unspecified` with a warning rather than failing the import; the raw value is
 * preserved in the work item's source fields (accepted plan §5.3).
 */
export const WORK_ITEM_RISKS = ['low', 'medium', 'high', 'critical', 'unspecified'] as const;
export type WorkItemRisk = (typeof WORK_ITEM_RISKS)[number];

export function isWorkItemRisk(value: unknown): value is WorkItemRisk {
  return (WORK_ITEM_RISKS as readonly string[]).includes(value as string);
}

export const DEPENDENCY_KINDS = ['required', 'recommended'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** Digest format version for the canonical plan-bundle digest (CT-03 §5.6). */
export const PLAN_BUNDLE_DIGEST_FORMAT_VERSION = 1;
export const PLAN_BUNDLE_DIGEST_ALGORITHM = 'sha-256';

export interface Project {
  readonly id: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly slug: string;
  /** Set by the first successful import; never silently replaced (CT-03 §5.6). */
  readonly activePlanVersionId?: PlanVersionId;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly version: number;
}

export interface PlanBundle {
  readonly id: PlanBundleId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly logicalName: string;
  readonly createdAt: string;
}

/** Immutable once committed. Storage enforces this with no-update triggers. */
export interface PlanVersion {
  readonly id: PlanVersionId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly bundleId: PlanBundleId;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly digestAlgorithm: typeof PLAN_BUNDLE_DIGEST_ALGORITHM;
  readonly digestFormatVersion: typeof PLAN_BUNDLE_DIGEST_FORMAT_VERSION;
  readonly sourceProfile: PlanSourceProfile;
  readonly document: string;
  /** Version-scoped normalized source, sufficient for future re-projection. */
  readonly normalizedSource: JsonValue;
  readonly itemCount: number;
  readonly requiredDependencyCount: number;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}

export interface PlanImportAttempt {
  readonly id: PlanImportAttemptId;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId: UserId;
  readonly outcome: PlanImportOutcome;
  readonly requestedProjectName: string;
  readonly requestedProjectId?: ProjectId;
  readonly bundleDigest?: string;
  readonly digestFormatVersion?: number;
  readonly projectId?: ProjectId;
  readonly planVersionId?: PlanVersionId;
  readonly artifactCount: number;
  readonly totalByteLength: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly createdAt: string;
}

/** Metadata only. Bytes are fetched through the authorized artifact route. */
export interface PlanArtifact {
  readonly id: PlanArtifactId;
  readonly workspaceId: WorkspaceId;
  readonly importAttemptId: PlanImportAttemptId;
  /** Null for artifacts retained from a failed validation attempt. */
  readonly planVersionId?: PlanVersionId;
  readonly logicalFilename: string;
  readonly role: PlanArtifactRole;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface PlanImportDiagnostic {
  readonly id: PlanImportDiagnosticId;
  readonly workspaceId: WorkspaceId;
  readonly importAttemptId: PlanImportAttemptId;
  readonly planVersionId?: PlanVersionId;
  readonly ordinal: number;
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly artifactName?: string;
  readonly path?: string;
  readonly workItemSourceId?: string;
  readonly message: string;
}

export interface WorkItem {
  readonly id: WorkItemId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly planVersionId: PlanVersionId;
  /** Unique within a plan version only; never a primary key. */
  readonly sourceId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly risk: WorkItemRisk;
  readonly phase?: string;
  readonly primaryAreas: readonly string[];
  readonly exitGate: string;
  /** Every source field, recognized or not, preserved verbatim (CT03-I16). */
  readonly sourceFields: JsonValue;
  readonly admittedAt?: string;
  readonly admittedByUserId?: UserId;
  readonly version: number;
}

export interface WorkItemDependency {
  readonly id: WorkItemDependencyId;
  readonly workspaceId: WorkspaceId;
  readonly planVersionId: PlanVersionId;
  readonly predecessorWorkItemId: WorkItemId;
  readonly successorWorkItemId: WorkItemId;
  readonly kind: DependencyKind;
  readonly ordinal: number;
}

/**
 * Derived readiness of a proposed or admitted item (CT-03 §5.11).
 *
 * `planning-ready` deliberately never reads as "ready to execute" or "ready to
 * merge"; CT-03 owns only the planning half of that vocabulary.
 */
export const WORK_ITEM_READINESS = ['planning-ready', 'dependency-blocked', 'active'] as const;
export type WorkItemReadiness = (typeof WORK_ITEM_READINESS)[number];

export interface WorkContractDraft {
  readonly id: WorkContractDraftId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly planVersionId: PlanVersionId;
  readonly workItemId: WorkItemId;
  readonly schemaVersion: 1;
  readonly status: 'draft';
  readonly completeness: 'incomplete';
  readonly document: JsonValue;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
