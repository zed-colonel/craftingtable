/**
 * What the scheduler does with an attempt's cycle under its delegation (R-B7): the delegated
 * conflict resolution and merge (with their grant's re-check and the merge's target-moved
 * retries), the declared-checks review, leaving a merge to the operator, the cycle's refresh from
 * integration before either, and leaving the cycle to its own controller or the operator.
 */

import type { RoadmapWriter } from './writer.js';
import type { RoadmapState } from './state.js';
import {
  SupersededRoadmapOperation,
  MergeTargetMovedRetry,
  TARGET_MOVED_RETRY_MS,
  conflict,
} from './shared.js';
import { attemptDelegation, effectiveDelegation } from '../roadmap-delegation-policy.js';
import {
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapEntry,
  mergeAdoptsChecks,
  roadmapAttention,
  sameExecutionScope,
  type WorkCycle,
  cycleStop,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { delegatedResolutionProfile } from '../agent-profile-policy.js';
import type { CommandContext } from '../auth-service.js';
import { cycleStep, type EntryStep, MOVED, waiting } from '../entry-waits.js';
import {
  CheckAdoptionRequiredError,
  DeclaredChecksMissingError,
  ExecutionRequestError,
} from '../errors.js';
import { scopePhaseBlockers } from '../execution-scope.js';
import type { ExecutionService } from '../execution-service.js';
import { PhaseGateError } from '../phase-resources.js';
import { roadmapCarriesRound } from '../scope-recovery-policy.js';
import type { WorkCycleService } from '../work-cycle-service.js';
import { securityReviewCurrent, workflowContext } from '../workflow-policy.js';

export class RoadmapIntegration {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
  ) {}

  /**
   * What the scheduler does with an attempt's cycle under its delegation (R-B7: `evaluateEntry`'s
   * block, moved as one): the conflict resolution, the delegated merge with its target-moved
   * retries, the declared-checks review, leaving a merge to the operator, or leaving the cycle to
   * its own controller. Every path returns or throws.
   */
  async integrate(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    attempt: RoadmapAttempt,
    cycle: WorkCycle,
    context: CommandContext,
    parallel: boolean,
  ): Promise<EntryStep> {
    const boundAttempt = attempt;
    const delegation =
      attemptDelegation(this.storage, roadmap, boundAttempt, entry.id) ??
      effectiveDelegation(roadmap, entry, roadmap.definition);
    const automation = delegation.automation;
    // A grant that lands across the merge's or resolution's awaits stands it down, as a pause
    // does: the next pass decides it under the new grant (R-B6, decision 2; review H-1).
    const grantOf = (r: Roadmap) =>
      r.delegationAssignments?.findLast((a) => a.entryIds.includes(entry.id))?.id;
    const grant = grantOf(roadmap);
    const check = () => {
      const current = this.writer.find(roadmap.workspaceId, roadmap.id);
      if (
        current.status !== 'running' ||
        current.entryHolds?.[entry.id] ||
        this.state.controlling.has(current.id) ||
        this.state.abort.signal.aborted ||
        grantOf(current) !== grant
      )
        throw new SupersededRoadmapOperation();
      this.writer.authority(current);
      if (
        boundAttempt.recovery &&
        (!roadmapCarriesRound(current, boundAttempt) ||
          current.entryHolds?.[boundAttempt.recovery.sourceEntryId] ||
          !current.attempts.some((a) => a.id === boundAttempt.id && a.recovery?.phase === 'repair'))
      )
        throw new SupersededRoadmapOperation();
      const tree = this.storage.execution.worktrees.find(
        roadmap.workspaceId,
        boundAttempt.worktreeId,
      );
      if (
        tree?.integrationBranch !== entry.integrationBranch ||
        tree.repositoryId !== entry.repositoryId ||
        !sameExecutionScope(tree.executionScope, entry.executionScope)
      )
        conflict('Roadmap integration binding changed.');
    };
    if (
      cycle.status === 'needs-attention' &&
      cycle.integrationResolution?.status === 'detected' &&
      automation.integrationConflicts === 'automatic'
    ) {
      check();
      await this.cycles.resolveIntegration(
        context,
        roadmap.workspaceId,
        cycle.id,
        {
          action: 'start',
          expectedVersion: cycle.version,
          profile: delegatedResolutionProfile(this.storage, cycle, {
            ...(delegation.assignment ? { id: delegation.assignment.id } : {}),
            ...(automation.resolutionProfile ? { profile: automation.resolutionProfile } : {}),
          }),
        },
        { check },
      );
      return MOVED;
    }
    const pending = this.storage.execution.merges.latest(roadmap.workspaceId, attempt.worktreeId);
    // A merge that adopts check definitions waits for a person (R-G13 increment 5); a
    // reserved merge is completed as reserved.
    if (
      automation.integrationMerge === 'automatic' &&
      ((cycle.status === 'awaiting-merge' && !mergeAdoptsChecks(cycleStop(cycle))) ||
        pending?.status === 'reserved')
    ) {
      check();
      // A paused roadmap may have a technically approved candidate with controller
      // reviews still queued. Let the cycle reserve those before attempting a merge.
      if (pending?.status !== 'reserved' && cycle.workflow) {
        const review = this.storage.execution.runs.find(roadmap.workspaceId, cycle.currentRunId);
        if (
          cycle.workflow.activeReview ||
          (cycle.workflow.securityRequired &&
            (!review || !securityReviewCurrent(this.storage, cycle, review))) ||
          // A checkpoint review the cycle runs itself, e.g. after evidence went stale.
          workflowContext(this.storage, cycle)?.checkpoints.some(
            (c) => !c.accepted && c.supported && c.assigned && !c.pending.length,
          )
        )
          return cycleStep(cycle);
      }
      if (entry.executionScope && pending?.status !== 'reserved') {
        const blockers = scopePhaseBlockers(
          this.storage,
          roadmap.workspaceId,
          entry.workItemId,
          entry.executionScope,
          'merge',
        );
        if (blockers.length) throw new PhaseGateError(blockers);
      }
      // A completed predecessor's merge missing from the branch is asked before the merge, as
      // before an attempt (R-B4, decision 1): the entry waits on the operator's fix instead of
      // the merge refusing and holding it (R-C10's follow-up, decision 2).
      if (pending?.status !== 'reserved') {
        const missing = await this.execution.branches.missingPredecessorMerge(
          roadmap.workspaceId,
          entry.workItemId,
          entry.repositoryId,
          entry.integrationBranch,
          entry.executionScope,
        );
        if (missing) {
          const reason = `${entry.sourceId}: ${missing}.`;
          if (!parallel) this.writer.reason(roadmap, reason);
          return waiting('predecessor-merge-missing', reason, { entryId: entry.id });
        }
      }
      // A merge refused as `target-moved` is tried again no sooner than a second on, as the
      // next pass came: its own reservation and refusal are waking writes, which would
      // otherwise run the retries back to back (R-B5 part 2, review MEDIUM-2);
      // asked before the refresh, which the wait would otherwise run each look (increment 9
      // review M-1).
      const notBefore = this.state.targetMovedNotBefore.get(attempt.worktreeId);
      if (notBefore !== undefined && notBefore > this.state.now().getTime()) {
        this.state.lookAgain(roadmap.id, notBefore);
        throw new MergeTargetMovedRetry('The merge is tried again shortly.');
      }
      if (pending?.status !== 'reserved' && (await this.refreshed(roadmap, cycle))) return MOVED;
      try {
        await this.execution.mergeWorktree(
          context,
          roadmap.workspaceId,
          attempt.worktreeId,
          {},
          undefined,
          {
            roadmapId: roadmap.id,
            definitionRevision: attempt.definitionRevision,
            actor: { check },
          },
        );
        this.state.targetMovedRefusals.delete(attempt.worktreeId);
        this.state.targetMovedNotBefore.delete(attempt.worktreeId);
      } catch (error) {
        if (error instanceof ExecutionRequestError && error.detail?.reason === 'target-moved') {
          const refusals = (this.state.targetMovedRefusals.get(attempt.worktreeId) ?? 0) + 1;
          const wait = TARGET_MOVED_RETRY_MS[refusals - 1];
          if (wait !== undefined) {
            this.state.targetMovedRefusals.set(attempt.worktreeId, refusals);
            const at = this.state.now().getTime() + wait;
            this.state.targetMovedNotBefore.set(attempt.worktreeId, at);
            this.state.lookAgain(roadmap.id, at);
            throw new MergeTargetMovedRetry(error.message);
          }
          this.state.targetMovedRefusals.delete(attempt.worktreeId);
          this.state.targetMovedNotBefore.delete(attempt.worktreeId);
        }
        // The review skipped adopted checks: one fresh review runs them (LIVE-24). A second
        // refusal of the same commit holds, with the refusal as its reason.
        if (
          error instanceof DeclaredChecksMissingError &&
          pending?.status !== 'reserved' &&
          (await this.cycles.reviewForDeclaredChecks(cycle, { check }))
        )
          return MOVED;
        // The merge adopts changed check definitions: a person approves it (R-G13).
        if (error instanceof CheckAdoptionRequiredError) {
          this.cycles.leaveMergeToOperator(cycle, error.repositoryId);
          this.writer.reason(roadmap, `${entry.sourceId}: Awaiting your merge approval.`);
          return cycleStep(cycle);
        }
        throw error;
      }
      return MOVED;
    }
    return this.leaveToCycle(roadmap, entry, cycle, parallel);
  }

  /**
   * The cycle's integration refreshed before the scheduler goes on (`true` when it moved, or
   * could not tell yet). It could not tell when the cycle's own refresh was in flight, or the
   * merge lane held: the roadmap waits on that one's end, not on every release (R-B5 part 2,
   * review MEDIUM-3). One that refreshed wrote, which marks every roadmap; its extra waiter costs
   * one look at the next merge's end.
   */
  async refreshed(roadmap: Roadmap, cycle: WorkCycle): Promise<boolean> {
    const inFlight = this.cycles.isRefreshing(cycle.id);
    const moved = await this.cycles.refreshIntegration(
      cycle,
      this.storage.execution.runs.find(roadmap.workspaceId, cycle.currentRunId),
    );
    if (moved) this.state.waitOnLock(roadmap.id, inFlight ? `refresh:${cycle.id}` : 'lane');
    return moved;
  }

  /** The roadmap leaves this cycle to its own controller or to the operator. */
  leaveToCycle(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    cycle: WorkCycle,
    parallel: boolean,
  ): EntryStep {
    if (parallel) return cycleStep(cycle);
    // One fact, one stop (R-C10's follow-up, decision 1): a cycle at its own stop, or paused,
    // carries the fact, and the roadmap waits on it running. Only a cycle that ended, which no
    // item carries, stops the roadmap.
    if (cycle.status === 'stopped' || cycle.status === 'completed')
      this.writer.change(roadmap, {
        status: 'needs-attention',
        attention: roadmapAttention('cycle-needs-attention', {
          cycleId: cycle.id,
          entryId: entry.id,
        }),
        reason: `${entry.sourceId}: ${cycle.reason} Inspect its cycle before resuming the roadmap.`,
      });
    else
      this.writer.reason(
        roadmap,
        `${entry.sourceId}: ${cycle.status === 'awaiting-merge' ? 'Awaiting your merge approval.' : cycle.reason}`,
      );
    return cycleStep(cycle);
  }
}
