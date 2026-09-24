import type { ExecutionScope, WorkItemId, WorkspaceId } from '@craftingtable/domain';
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
 * roadmap entry). Moving the launch's Git check ahead of the scheduler's attempt creation
 * would change when stops happen, and is left to R-B4's decision core.
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
