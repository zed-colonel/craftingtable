/** A cycle's agent settings, checked as a command or a start submits them (R-B7). */

import {
  cycleAgents,
  finalizationAgents,
  workspaceCycleProfiles,
} from '../agent-profile-policy.js';
import type { StartWorkCycleRequest } from '@craftingtable/contracts';
import type { WorkCycle, WorkspaceId } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from '../agent-run-service.js';
import { ExecutionRequestError } from '../errors.js';

export class CycleSettings {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly runs: AgentRunService,
    private readonly git: GitOperations | undefined,
  ) {}

  validateAgentSelections(profiles: import('@craftingtable/domain').AgentSelections): void {
    for (const profile of Object.values(profiles)) {
      if (!this.runs.hasBackend(profile.backend))
        throw new ExecutionRequestError(
          'unavailable',
          `Agent backend ${profile.backend} is unavailable.`,
        );
    }
  }

  /**
   * A submitted model must be a catalog id, not a display name (R-G15, LIVE-34); one the record
   * already saved (`saved`) is let through. Only command handlers call this: the scheduler's
   * launches meet the launch check, which stops with `agent-model-misnamed`.
   */
  requireModelIds(
    selections: Iterable<
      readonly [string, import('@craftingtable/domain').AgentSelection | undefined]
    >,
    saved: Iterable<
      readonly [string, import('@craftingtable/domain').AgentSelection | undefined]
    > = [],
  ): void {
    this.runs.requireModelIds(selections, saved);
  }

  /**
   * The profiles a new roadmap entry or map settings level stores: the workspace's defaults now,
   * with the save's permissions (R-E5b).
   */
  workspaceProfiles(
    workspaceId: WorkspaceId,
    permissions?: import('@craftingtable/contracts').StepPermissions,
  ): import('@craftingtable/domain').CycleProfiles {
    return workspaceCycleProfiles(
      this.runs.workspaceLayerIn(this.storage, workspaceId),
      permissions,
    );
  }

  /** A finalization's agents with their sources (R-E5a, E5-3), for its view. */
  finalizationAgentsView(value: import('@craftingtable/domain').Finalization, cycle?: WorkCycle) {
    return {
      ...finalizationAgents(
        value,
        cycle,
        this.runs.workspaceLayerIn(this.storage, value.workspaceId),
      ),
      ...(cycle ? { conflict: cycleAgents(this.storage, cycle).conflict } : {}),
    };
  }

  validateSettings(input: Pick<StartWorkCycleRequest, 'profiles'>): void {
    this.validateAgentSelections(input.profiles);
    if (this.git === undefined)
      throw new ExecutionRequestError('unavailable', 'Git is required for an automated cycle');
  }
}
