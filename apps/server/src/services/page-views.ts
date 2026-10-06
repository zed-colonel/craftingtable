import type { AgentRunId, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { AuthContext } from './auth-service.js';
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
      // The cycles' projections and the slices evaluate the map; one that fails leaves its
      // part empty and named, so the rest of the page still works (R-D5 review). The item's
      // own detail and execution failing fail the read, as their own reads did.
      const unavailable: ('cycles' | 'scopes')[] = [];
      const part = <T>(name: 'cycles' | 'scopes', read: () => T, empty: T): T => {
        try {
          return read();
        } catch {
          unavailable.push(name);
          return empty;
        }
      };
      return {
        detail: this.planning.workItemDetailIn(tx, workspaceId, workItemId),
        execution: this.execution.executionIn(tx, workspaceId, workItemId),
        cycles: part('cycles', () => this.cycles.views(tx, workspaceId, { workItemId }), []),
        scopes: part('scopes', () => this.execution.scopesIn(tx, workspaceId, workItemId), {
          choices: [],
        }),
        repositories: tx.execution.sourceRepositories.list(workspaceId),
        profiles: this.runs.profilesIn(tx, workspaceId),
        ...(unavailable.length ? { unavailable } : {}),
      };
    });
    return {
      ...read,
      execution: await this.execution.confirmGates(read.execution),
      backends: this.executionStatus().backends,
    };
  }

  /**
   * A run page's region: the run's detail, the runs of its work item a hand-off can start from,
   * and what the hand-off form offers. The run's events are read by page and stream apart.
   */
  run(context: AuthContext, workspaceId: WorkspaceId, runId: AgentRunId, requestId?: string) {
    this.workspaces.requireAuthorized(context, workspaceId, requestId);
    const read = this.storage.readTransaction((tx) => {
      const detail = this.runs.detailIn(tx, workspaceId, runId);
      return {
        detail,
        runs:
          detail.run.workItemId === undefined
            ? []
            : tx.execution.runs.listForWorkItem(workspaceId, detail.run.workItemId),
        profiles: this.runs.profilesIn(tx, workspaceId),
      };
    });
    return { ...read, backends: this.executionStatus().backends };
  }
}
