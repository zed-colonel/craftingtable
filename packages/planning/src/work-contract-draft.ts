import {
  DEFAULT_MAX_REMEDIATION_GENERATIONS,
  DEFAULT_REVIEW_PERSPECTIVES,
  type PlanVersionId,
  type ProjectId,
  WORK_CONTRACT_DRAFT_SCHEMA_VERSION,
  WORK_CONTRACT_UNRESOLVED_FIELDS,
  type WorkContractDraftDependency,
  type WorkContractDraftDocument,
  type WorkItemId,
  type WorkItemStatus,
} from '@craftingtable/domain';
import type { NormalizedWorkItem } from './normalize.js';

export interface DraftDependencySource {
  readonly sourceId: string;
  readonly title: string;
  readonly status: WorkItemStatus;
}

export interface DraftProjectionInput {
  readonly projectId: ProjectId;
  readonly planVersionId: PlanVersionId;
  readonly workItemId: WorkItemId;
  readonly item: NormalizedWorkItem;
  /** Resolved predecessors, keyed by source ID, for both dependency kinds. */
  readonly requiredDependencies: readonly DraftDependencySource[];
  readonly recommendedDependencies: readonly DraftDependencySource[];
}

function dependency(
  source: DraftDependencySource,
  kind: WorkContractDraftDependency['kind'],
): WorkContractDraftDependency {
  return { sourceId: source.sourceId, title: source.title, status: source.status, kind };
}

/**
 * Projects an admitted work item into its initial work-contract draft
 * (work-items/CT-03/CT-03.md §5.12).
 *
 * Everything CraftingTable actually knows is inherited from the plan version.
 * Everything it does not know is named explicitly in `missing` rather than
 * left blank, because a blank field reads as "nothing required" while an
 * enumerated one reads as "not yet decided". The document deliberately has no
 * `approved`, `executable`, or `ready` field: CT-03 cannot approve a contract,
 * create a change request, create a worktree, or start an agent, and the draft
 * must not imply otherwise.
 */
export function projectWorkContractDraft(input: DraftProjectionInput): WorkContractDraftDocument {
  return {
    schemaVersion: WORK_CONTRACT_DRAFT_SCHEMA_VERSION,
    status: 'draft',
    completeness: 'incomplete',
    source: {
      projectId: input.projectId,
      planVersionId: input.planVersionId,
      workItemId: input.workItemId,
      sourceWorkItemId: input.item.sourceId,
    },
    objective: {
      title: input.item.title,
      exitGate: input.item.exitGate,
    },
    classification: {
      risk: input.item.risk,
      primaryAreas: [...input.item.primaryAreas],
    },
    dependencies: {
      required: input.requiredDependencies.map((source) => dependency(source, 'required')),
      recommended: input.recommendedDependencies.map((source) => dependency(source, 'recommended')),
    },
    repository: { status: 'unresolved' },
    baseRevision: { status: 'unresolved' },
    scope: { status: 'unresolved', writable: [], forbidden: [] },
    verification: { status: 'unresolved', checkIds: [] },
    review: {
      requiredPerspectives: [...DEFAULT_REVIEW_PERSPECTIVES],
      maxRemediationGenerations: DEFAULT_MAX_REMEDIATION_GENERATIONS,
    },
    merge: { humanAuthorizationRequired: true },
    missing: [...WORK_CONTRACT_UNRESOLVED_FIELDS],
  };
}
