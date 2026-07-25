import type { PlanVersionId, ProjectId, WorkItemId } from './ids.js';
import type { DependencyKind, WorkItemRisk, WorkItemStatus } from './planning.js';

/**
 * The initial work-contract draft produced by admitting a work item
 * (work-items/CT-03/CT-03.md §5.12).
 *
 * The document is deliberately missing an `approved`, `executable`, or `ready`
 * field. Nothing here may be read as authorization: CT-03 cannot approve a
 * contract, create a change request, create a worktree, or start an agent.
 */

export const WORK_CONTRACT_DRAFT_SCHEMA_VERSION = 1;

/**
 * Fields a draft cannot resolve in CT-03 because the capability that would
 * supply them belongs to CT-04 or later. Rendered to the operator verbatim.
 */
export const WORK_CONTRACT_UNRESOLVED_FIELDS = [
  'registered-repository',
  'exact-base-revision',
  'path-scope',
  'verification-policy',
  'protected-acceptance-criteria',
  'agent-backend',
  'execution-environment',
] as const;
export type WorkContractUnresolvedField = (typeof WORK_CONTRACT_UNRESOLVED_FIELDS)[number];

/** Review perspectives a future review run would need. Not executed in CT-03. */
export const DEFAULT_REVIEW_PERSPECTIVES = ['specification', 'correctness'] as const;

/** Bounded remediation default carried forward from the implementation plan. */
export const DEFAULT_MAX_REMEDIATION_GENERATIONS = 3;

export interface WorkContractDraftDependency {
  readonly sourceId: string;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly kind: DependencyKind;
}

export interface WorkContractDraftDocument {
  readonly schemaVersion: typeof WORK_CONTRACT_DRAFT_SCHEMA_VERSION;
  readonly status: 'draft';
  readonly completeness: 'incomplete';
  readonly source: {
    readonly projectId: ProjectId;
    readonly planVersionId: PlanVersionId;
    readonly workItemId: WorkItemId;
    readonly sourceWorkItemId: string;
  };
  readonly objective: {
    readonly title: string;
    readonly exitGate: string;
  };
  readonly classification: {
    readonly risk: WorkItemRisk;
    readonly primaryAreas: readonly string[];
  };
  readonly dependencies: {
    readonly required: readonly WorkContractDraftDependency[];
    readonly recommended: readonly WorkContractDraftDependency[];
  };
  readonly repository: { readonly status: 'unresolved' };
  readonly baseRevision: { readonly status: 'unresolved' };
  readonly scope: {
    readonly status: 'unresolved';
    readonly writable: readonly string[];
    readonly forbidden: readonly string[];
  };
  readonly verification: {
    readonly status: 'unresolved';
    readonly checkIds: readonly string[];
  };
  readonly review: {
    readonly requiredPerspectives: readonly string[];
    readonly maxRemediationGenerations: number;
  };
  readonly merge: { readonly humanAuthorizationRequired: true };
  readonly missing: readonly WorkContractUnresolvedField[];
}
