/**
 * Cycles as the browser reads them (R-B7): the workspace's attention list and a work item's
 * detail, each cycle beside its projection (its agents, the actions the daemon would accept, its
 * waits and routes), and whether a cycle's item wait holds its reminders. Nothing here writes a
 * cycle; a refused read records its denial, as `requireAuthorized` does everywhere.
 */
import {
  type CycleProjection,
  type CycleView,
  cycleActions,
  guidanceAccepted,
  settingsChangeable,
  type WorkCycle,
  type WorkCycleId,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { cycleAgents } from '../agent-profile-policy.js';
import { selectionSet } from '../agent-resolution.js';
import type { CommandContext } from '../auth-service.js';
import { investigationLive, stopQuestions, worktreeChangeOpen } from '../investigation.js';
import { mapReadSnapshot } from '../map-read-snapshot.js';
import { automatedScopeRecoveryWait } from '../scope-recovery-policy.js';
import { scopeMergeWait, scopeReviewWait } from '../scope-repair.js';
import { operatorQuestionRoutes, unsettledDecisionsAt } from '../workflow-policy.js';
import type { WorkspaceService } from '../workspace-service.js';
import { guidedRemediationRefused, resumeAtRoundLimit } from './core/commands.js';
import type { CycleLocks } from './locks.js';
import {
  latestOutsideLineage,
  PREPARING_RECOVERY,
  reviewFacts,
  reviewNeedsRounds,
  TERMINAL_CYCLE_STATUSES,
  withoutFindings,
} from './shared.js';

export class CycleProjections {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly locks: CycleLocks,
  ) {}

  /** The stored cycle, for the access guard's step-up check (R-G9), as `RoadmapService.storedWork`. */
  storedWork(workspaceId: WorkspaceId, cycleId: WorkCycleId): unknown {
    return this.storage.execution.cycles.find(workspaceId, cycleId);
  }

  /**
   * Cycles as the browser reads them.
   *
   * Without a work item this is the workspace-wide attention list: only cycles
   * that have not ended, without the design-recovery blob. Ended cycles are
   * history, and every page used to download all of them on every refresh
   * (PERF-05). With a work item it is that item's full detail, history
   * included. Derived waits and routes are computed only for cycles that have
   * not ended; they never apply to an ended cycle, except the preparation
   * notice of a completed cycle being reviewed again.
   */
  list(
    context: CommandContext,
    workspaceId: WorkspaceId,
    filter: { readonly workItemId?: WorkItemId } = {},
  ): readonly CycleView[] {
    this.workspaceService.requireAuthorized(context, workspaceId);
    return this.views(mapReadSnapshot(this.storage), workspaceId, filter);
  }

  /**
   * `list` inside a read the caller holds (one transaction and one map snapshot per page
   * region, R-D5).
   */
  views(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    filter: { readonly workItemId?: WorkItemId } = {},
  ): readonly CycleView[] {
    const stored = tx.execution.cycles.listForWorkspace(workspaceId);
    const selected =
      filter.workItemId === undefined
        ? stored
            .filter((c) => !TERMINAL_CYCLE_STATUSES.has(c.status))
            .map(({ designRecovery: _omitted, ...c }): WorkCycle => withoutFindings(c))
        : stored.filter((c) => c.workItemId === filter.workItemId);
    return selected.map((c) => ({ cycle: c, projection: this.projection(tx, c) }));
  }

  /** A cycle as a response returns it: the record beside its projection (CTRL-22, R-D5). */
  present(cycle: WorkCycle): CycleView {
    return { cycle, projection: this.projection(mapReadSnapshot(this.storage), cycle) };
  }

  private projection(tx: StorageRepositories, c: WorkCycle): CycleProjection {
    const agents = cycleAgents(tx, c);
    const nextAgentSelections = selectionSet(agents);
    if (TERMINAL_CYCLE_STATUSES.has(c.status))
      return {
        nextAgentSelections,
        agents,
        actions: [],
        // A completed cycle can be reviewed again; its preparation still shows.
        ...(this.locks.isTransitioning(c.id) ? { scopeReviewWait: PREPARING_RECOVERY } : {}),
      };
    const wait = this.locks.isTransitioning(c.id)
      ? PREPARING_RECOVERY
      : (automatedScopeRecoveryWait(tx, c) ?? scopeReviewWait(tx, c));
    const mergeWait = scopeMergeWait(tx, c);
    const unsettled = unsettledDecisionsAt(tx, c);
    const currentRun = tx.execution.runs.find(c.workspaceId, c.currentRunId);
    const turn =
      currentRun &&
      tx.execution.runEvents.latestOfKind(c.workspaceId, currentRun.id, 'turn-completed');
    // The browser offers what the daemon would accept: the same rule, with the tree's
    // newest run, which a resume adopts when it continues the cycle's lineage.
    const latestRunId = tx.execution.runs.latestIdForWorktree(c.workspaceId, c.worktreeId);
    const actions = cycleActions(
      { ...c, ...(unsettled.length ? { unsettledDecisions: unsettled } : {}) },
      latestRunId,
      reviewNeedsRounds(tx, c, currentRun),
      {
        questions: !!stopQuestions(tx, c),
        live: investigationLive(c),
        changed: worktreeChangeOpen(c),
      },
      latestOutsideLineage(tx, c, latestRunId),
      resumeAtRoundLimit(
        c,
        latestRunId && tx.execution.runs.find(c.workspaceId, latestRunId),
        reviewFacts(tx, c),
      ),
      // The guided resume's rule, read as the command reads it (R-C17 part 4, decision 1).
      guidanceAccepted(
        c,
        latestRunId,
        tx.execution.runs.liveForWorktree(c.workspaceId, c.worktreeId).length > 0,
        guidedRemediationRefused(
          c,
          latestRunId && tx.execution.runs.find(c.workspaceId, latestRunId),
          reviewFacts(tx, c),
        ),
      ),
      // And the settings change's (decision 3).
      settingsChangeable(c, {
        investigationLive: investigationLive(c),
        worktreeChangeOpen: worktreeChangeOpen(c),
        amendmentRetired: tx.amendments.retired(c.workspaceId, c.worktreeId),
        transitioning: this.locks.isTransitioning(c.id),
      }),
    );
    const routes =
      c.status === 'needs-attention' &&
      c.executionScope?.kind === 'slice' &&
      turn?.kind === 'turn-completed'
        ? operatorQuestionRoutes(tx, c, turn.payload.resultText)
        : [];
    return {
      nextAgentSelections,
      agents,
      actions,
      ...(unsettled.length ? { unsettledDecisions: unsettled } : {}),
      ...(wait ? { scopeReviewWait: wait } : {}),
      ...(mergeWait ? { mergeRequirementsWait: mergeWait } : {}),
      ...(routes.length ? { questionRoutes: routes } : {}),
    };
  }

  /**
   * Reminders for this cycle's item wait: a command is preparing its transition, or an
   * investigation is gathering what the operator needs to answer (R-C16).
   */
  holdsReminders(workspaceId: WorkspaceId, id: WorkCycleId): boolean {
    if (this.locks.isTransitioning(id)) return true;
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    return !!cycle && investigationLive(cycle);
  }
}
