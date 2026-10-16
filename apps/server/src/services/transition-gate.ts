import type {
  CycleAttentionCode,
  ExecutionScope,
  PlanVersionId,
  WorkItem,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories, WorkItemDependencySummary } from '@craftingtable/storage';
import { scopeAllowsEarlyDevelopment } from './execution-scope.js';

/**
 * The whole-item predecessor rule, in one place (R-A7, CTRL-12). Commands
 * (`WorkCycleService.requireReady`), the launch (`BranchService.requirePredecessors`, which
 * adds Git ancestry) and the roadmap scheduler (`RoadmapService.blocker`, which adds in-flight
 * attempts) all read their verdict from here, instead of each restating it:
 *
 * - a required predecessor that is not completed blocks, unless the slice's early-start
 *   exception applies;
 * - a caller may also count a predecessor as pending while its own work is still in flight.
 *
 * Callers keep their own wording and outcome (a refused command, a stopped launch, a waiting
 * roadmap entry). The launch's Git check, the ancestry of each completed predecessor's recorded
 * merge, is `BranchService.predecessorMerges`; the scheduler asks it before it creates an attempt
 * (R-B4, decision 1).
 */
export interface PredecessorGate {
  /** Every required predecessor edge, in plan order, with whether it is completed. */
  readonly required: readonly WorkItemDependencySummary[];
  /** Required predecessors still pending: not completed, or in flight for the caller. */
  readonly pending: readonly WorkItemDependencySummary[];
  /** The slice may start before its predecessors complete (early-start exception). */
  readonly early: boolean;
  /** Pending predecessors block this transition. */
  readonly blocked: boolean;
}

export function predecessorGate(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope?: ExecutionScope,
  inFlight: (predecessor: WorkItemDependencySummary) => boolean = () => false,
): PredecessorGate {
  const required = tx.planning.dependencies
    .listPredecessors(workspaceId, workItemId)
    .filter((dependency) => dependency.kind === 'required');
  const pending = required.filter(
    (dependency) => dependency.status !== 'completed' || inFlight(dependency),
  );
  // Only evaluated when something is pending, as each caller did before.
  const early =
    pending.length > 0 && scopeAllowsEarlyDevelopment(tx, workspaceId, workItemId, scope);
  return { required, pending, early, blocked: pending.length > 0 && !early };
}

/** Why an item's status refuses its work (R-B4, decisions 2 and 3). */
export type ItemRefusal = Extract<
  CycleAttentionCode,
  'item-unavailable' | 'item-not-admitted' | 'item-completed-unmerged'
>;

/**
 * The item-status rule, in one place (R-B4, decision 2): commands and the cycle core
 * (`requireReady`), the roadmap scheduler (`RoadmapService.blocker` and its started entries) and
 * the launch read their verdict from here. Each caller keeps its own wording and outcome (a
 * refused command, a stopped cycle, a held entry):
 *
 * - a missing item, or for the scheduler one outside the entry's bound plan version, is
 *   `item-unavailable`;
 * - a completed item takes an independent review of a scope of it (a slice verification or a
 *   parent acceptance), and a slice of it only if its completion recorded an integration commit
 *   (a merge, or the parent acceptance, which records the head it accepted): a recovery round
 *   then repairs an accepted item's slice. Its other work, a slice of an item marked complete by
 *   hand included, is `item-completed-unmerged`;
 * - a proposed item is `item-not-admitted`, unless the caller admits it itself (the scheduler).
 */
export function itemGate(
  item: Pick<WorkItem, 'status' | 'planVersionId' | 'mergeSha'> | undefined,
  scope: Pick<ExecutionScope, 'kind'> | undefined,
  options: { readonly admits: boolean; readonly planVersionId?: PlanVersionId },
): ItemRefusal | undefined {
  if (
    !item ||
    (options.planVersionId !== undefined && item.planVersionId !== options.planVersionId)
  )
    return 'item-unavailable';
  if (item.status === 'completed')
    return scope && (scope.kind !== 'slice' || item.mergeSha !== undefined)
      ? undefined
      : 'item-completed-unmerged';
  if (item.status === 'proposed' && !options.admits) return 'item-not-admitted';
  return undefined;
}
