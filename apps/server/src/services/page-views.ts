import type { WorkItemId, WorkspaceId } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { AuthContext } from './auth-service.js';
import { scopeChoices } from './execution-scope.js';
import type { ExecutionService, ExecutionStatus } from './execution-service.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import type { PlanningQueryService } from './planning-query-service.js';
import type { WorkCycleService } from './work-cycle-service.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * One answer per page region (R-D5, PERF-14). Each region is read in one transaction over one
 * map snapshot, so its parts agree with each other and the map's definitions, bindings and
 * accepted evidence are decoded once for all of them; Git, where a region needs it, is asked
 * after the read.
 */
export class PageViews {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly planning: PlanningQueryService,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly runs: AgentRunService,
    private readonly executionStatus: () => ExecutionStatus,
  ) {}

  /**
   * A work item page's region: the item's detail, its worktrees, runs and merge gates, its cycles
   * with their projections, its execution slices, and what its launch forms offer.
   */
  async workItem(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    requestId?: string,
  ) {
    this.workspaces.requireAuthorized(context, workspaceId, requestId);
    const read = this.storage.readTransaction((source) => {
      const tx = mapReadSnapshot(source);
      return {
        detail: this.planning.workItemDetailIn(tx, workspaceId, workItemId),
        execution: this.execution.executionIn(tx, workspaceId, workItemId),
        cycles: this.cycles.views(tx, workspaceId, { workItemId }),
        scopes: { choices: scopeChoices(tx, workspaceId, workItemId) },
        repositories: tx.execution.sourceRepositories.list(workspaceId),
        profiles: this.runs.profilesIn(tx, workspaceId),
      };
    });
    return {
      ...read,
      execution: await this.execution.confirmGates(read.execution),
      backends: this.executionStatus().backends,
    };
  }
}
