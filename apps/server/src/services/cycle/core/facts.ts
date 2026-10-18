import { activeEditor } from '../../authority-policy.js';
import {
  type AgentRun,
  type AgentRunEvent,
  DEFAULT_ROADMAP_AUTOMATION,
  DEFAULT_ROADMAP_SCHEDULING,
  type ExecutionScope,
  type PhaseBlocker,
  type RoadmapEntryId,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
  type DesignRequirement,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { CommandContext } from '../../auth-service.js';
import { type CycleOwnership, cycleOwnership } from '../../cycle-ownership.js';
import { designDependencyState } from '../../design-dependency-policy.js';
import { type Readiness, readinessOf } from './effect-decisions.js';
import { TypedRefusalError } from '../../errors.js';
import { requireScope, scopePhaseBlockers } from '../../execution-scope.js';
import { finalizationForCycle } from '../../finalization-policy.js';
import { mapReadSnapshot } from '../../map-read-snapshot.js';
import { attemptDelegation } from '../../roadmap-delegation-policy.js';
import { roadmapCarriesRound } from '../../scope-recovery-policy.js';
import { type StepOutcomeFacts, stepOutcomeFacts } from './step-outcome.js';
import { type ItemRefusal, itemGate, predecessorGate } from '../../transition-gate.js';
import {
  controllerReviewRunnable,
  securityReviewCurrent,
  workflowContext,
  workflowDelegation,
} from '../../workflow-policy.js';

/**
 * What the cycle controller decides from (R-B4): one cycle's facts for one pass.
 *
 * Every storage-derived fact is a function, read the first time `decide` asks for it and then
 * remembered, so a pass reads only what the deciding guard needs, as `reconcile` did (R-B1's
 * idle cost). The reads go through one read snapshot (`mapReadSnapshot`), so the helpers the
 * facts share (ownership, delegation, scope evaluation) are computed once per cycle. The facts
 * are made, used and dropped inside one synchronous `decide`: never across an await or a write.
 *
 * A fact that stands for one of the gates commands also pass (the item's readiness, the
 * finalization's activity) answers with a typed result, never by throwing (R-B4, decision 3).
 */
type TurnCompleted = Extract<AgentRunEvent, { kind: 'turn-completed' }>;

export interface CycleFacts {
  /** The cycle's roadmap is being settled (R-B11): its settle stops the cycle. */
  readonly settling: () => boolean;
  readonly worktree: () => Worktree | undefined;
  /** A review-only scope cycle whose current review already has its scope evidence recorded. */
  readonly scopeEvidenceRecorded: () => boolean;
  /** The step's reserved run, once it has been launched. */
  readonly currentRun: () => AgentRun | undefined;
  /** The run the step continues from (`parentRunId`). */
  readonly parentRun: () => AgentRun | undefined;
  /** The worktree's newest run, which a manual run can make another than the cycle's. */
  readonly newestRun: () => AgentRun | undefined;
  readonly lastTurn: (run: AgentRun) => TurnCompleted | undefined;
  /** Whether the cycle's cross-project delegation lets a controller review run now. */
  readonly delegationRunnable: () => boolean | undefined;
  /** Every shared-decision question of the cycle's workflow names an accepted checkpoint. */
  readonly sharedDecisionsAccepted: () => boolean;
  /** The user who started the cycle is active and may still run it. */
  readonly creatorAuthorized: () => boolean;
  /** No controller review or integration refresh may advance this `awaiting-merge` cycle. */
  readonly onlyOperatorCanAdvance: () => boolean;
  /** The item's admission and predecessor gate, or the finalization's activity. */
  readonly readiness: () => Readiness;
  /** The item's status alone, as the item gate reads it; nothing for a plan finalization. */
  readonly itemRefusal: () => ItemRefusal | undefined;
  readonly mergeReserved: () => boolean;
  readonly controllerReviewRunnable: () => boolean;
  /** The worktree scope's phase blockers, for a scoped worktree. */
  readonly phaseBlockers: () => readonly PhaseBlocker[];
  readonly designDependencies: (requirements: readonly DesignRequirement[]) => {
    readonly supported: boolean;
    readonly pending: readonly string[];
  };
  /** The owning roadmap is not running (its pauses hold service retries and design rechecks). */
  readonly roadmapPaused: () => boolean;
  /** The facts `decideStepOutcome` classifies the current run with (R-B2). */
  readonly stepOutcome: (run: AgentRun) => StepOutcomeFacts;
}

/**
 * Process-local state the controller decides from (R-B4): what this daemon is doing right now,
 * not what is stored. R-B5's kernel replaces it with its per-aggregate mutex.
 */
export interface KernelFacts {
  /** An integration refresh for this cycle is in flight in this process. */
  readonly refreshing: () => boolean;
  /** The storage service is cleaning a run of this worktree. */
  readonly cleaningRun: () => boolean;
  /** The daemon is draining: it admits no launch. */
  readonly draining: () => boolean;
}

/** Remembers a fact's first answer; a fact that throws is asked again next time. */
function once<T>(read: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = read();
      done = true;
    }
    return value;
  };
}

export function cycleFacts(
  storage: CraftingTableStorage,
  cycle: WorkCycle,
  options: {
    readonly now: Date;
    /**
     * The roadmaps being settled when the pass began, and the cycle's owner as the pass resolved
     * it: a settling roadmap's id does not change while the pass runs (R-B11).
     */
    readonly settling: ReadonlySet<string>;
    readonly owner: () => CycleOwnership | undefined;
  },
): CycleFacts {
  const tx = mapReadSnapshot(storage);
  const turns = new Map<string, TurnCompleted | undefined>();
  const delegation = once(() => workflowDelegation(tx, cycle));
  return {
    settling: once(
      () => options.settling.size > 0 && options.settling.has(options.owner()?.roadmap.id ?? ''),
    ),
    worktree: once(() => tx.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId)),
    scopeEvidenceRecorded: once(
      () =>
        !!cycle.executionScope &&
        cycle.executionScope.kind !== 'slice' &&
        !!cycle.workItemId &&
        tx.scopeReceipts
          .list(cycle.workspaceId, cycle.workItemId)
          .some((r) => r.worktreeId === cycle.worktreeId && r.reviewRunId === cycle.currentRunId),
    ),
    currentRun: once(() => tx.execution.runs.find(cycle.workspaceId, cycle.currentRunId)),
    parentRun: once(() =>
      cycle.parentRunId ? tx.execution.runs.find(cycle.workspaceId, cycle.parentRunId) : undefined,
    ),
    newestRun: once(
      () => tx.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId)[0],
    ),
    lastTurn: (run) => {
      if (!turns.has(run.id)) {
        const turn = tx.execution.runEvents.latestOfKind(
          cycle.workspaceId,
          run.id,
          'turn-completed',
        );
        turns.set(run.id, turn?.kind === 'turn-completed' ? turn : undefined);
      }
      return turns.get(run.id);
    },
    delegationRunnable: () => delegation()?.runnable,
    sharedDecisionsAccepted: once(() => {
      const context = workflowContext(tx, cycle);
      return (cycle.workflow?.questions ?? []).every((q) =>
        context?.checkpoints.some((c) => c.id === q.checkpointId && c.accepted),
      );
    }),
    creatorAuthorized: once(() => creatorAuthorized(tx, cycle)),
    onlyOperatorCanAdvance: once(() => onlyOperatorCanAdvance(storage, cycle)),
    itemRefusal: once(() =>
      cycle.workItemId
        ? itemGate(
            tx.planning.workItems.find(cycle.workspaceId, cycle.workItemId),
            cycle.executionScope,
            { admits: false },
          )
        : undefined,
    ),
    readiness: once((): Readiness => {
      try {
        if (cycle.workItemId)
          requireReady(tx, cycle.workspaceId, cycle.workItemId, cycle.executionScope);
        else finalizationForCycle(storage, cycle);
        return { kind: 'ready' };
      } catch (error) {
        const readiness = readinessOf(error);
        if (readiness) return readiness;
        throw error;
      }
    }),
    mergeReserved: once(
      () => tx.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status === 'reserved',
    ),
    controllerReviewRunnable: once(() => controllerReviewRunnable(tx, cycle)),
    phaseBlockers: once(() => {
      const tree = tx.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
      if (!tree?.executionScope || !tree.workItemId) return [];
      return scopePhaseBlockers(
        tx,
        cycle.workspaceId,
        tree.workItemId,
        tree.executionScope,
        tree.executionScope.kind === 'parent-acceptance'
          ? 'accept'
          : tree.executionScope.kind === 'slice-verification'
            ? 'verify'
            : 'start',
      );
    }),
    designDependencies: (requirements) => designDependencyState(tx, cycle, requirements),
    // Read in this cycle's own snapshot, never the pass's: the roadmap may have been paused
    // while an earlier cycle of the pass awaited Git.
    roadmapPaused: once(() => {
      const owner = cycleOwnership(tx, cycle);
      return !!owner && owner.roadmap.status !== 'running';
    }),
    stepOutcome: (run) => stepOutcomeFacts(storage, cycle, run, options.now),
  };
}

/**
 * The gate a command or the controller passes before acting on a work item's cycle: the item's
 * status (`itemGate`), then the scope's phase requirements, then its required predecessors.
 */
export function requireReady(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  /** Absent for a cycle with no work item: no item, so the same refusal as an unknown one. */
  workItemId: WorkItemId | undefined,
  scope?: ExecutionScope,
) {
  // The item's own status first: a completed or withdrawn item is the stop, whatever its scope's
  // phase says (R-B4, decision 2).
  const item =
    workItemId === undefined ? undefined : tx.planning.workItems.find(workspaceId, workItemId);
  const refused = itemGate(item, scope, { admits: false });
  if (refused || !item)
    throw new TypedRefusalError(
      refused ?? 'item-unavailable',
      // An item cannot be made incomplete again, so the stop says the way out (R-B4 increment 5
      // review).
      refused === 'item-completed-unmerged'
        ? 'This work item was marked complete without merging its worktree. Merge the worktree by hand, after stopping its cycle if one runs, or reconcile the queue.'
        : 'Automation requires an admitted, incomplete work item',
    );
  // Found by its id, so the item's id is the one asked for.
  if (scope)
    requireScope(
      tx,
      workspaceId,
      item.id,
      scope,
      scope.kind === 'parent-acceptance'
        ? 'accept'
        : scope.kind === 'slice-verification'
          ? 'verify'
          : 'start',
    );
  const predecessors = predecessorGate(tx, workspaceId, item.id, scope);
  if (predecessors.blocked)
    throw new TypedRefusalError(
      'predecessors-incomplete',
      `Required predecessors are incomplete: ${predecessors.pending.map((dependency) => dependency.sourceId).join(', ')}`,
    );
  return item;
}

/** The user who started the cycle is active and an owner or editor of its workspace. */
export function creatorAuthorized(tx: StorageRepositories, cycle: WorkCycle): boolean {
  return !!activeEditor(tx, cycle.createdByUserId, cycle.workspaceId);
}

/**
 * Who may refresh this cycle from integration automatically, under which settings: only an
 * actively delegated attempt, with settings bound to its revision.
 * `launching`: the cycle is running and about to start or approve a review (R-C4), for
 * example after the operator resumed it while its roadmap was paused, needed attention, or
 * held its entry. The review would otherwise meet an advanced integration branch and stop;
 * refreshing touches only the cycle's own branch, so the pause does not hold it. A stopped
 * or completed roadmap has ended its delegation, and a hold the system placed stays in
 * force. Delegation, binding and authority still apply, and merges keep the full gate.
 */
export function refreshOwner(
  storage: CraftingTableStorage,
  cycle: WorkCycle,
  launching = false,
):
  | { readonly settings: typeof DEFAULT_ROADMAP_SCHEDULING; readonly context: CommandContext }
  | undefined {
  const finalization = finalizationForCycle(storage, cycle);
  if (finalization) {
    const user = activeEditor(storage, cycle.createdByUserId, cycle.workspaceId);
    if (!user) throw new TypedRefusalError('authority-lost', 'Finalization authority was revoked');
    return {
      settings: { ...DEFAULT_ROADMAP_SCHEDULING, maxIntegrationRefreshes: 3 },
      context: { user },
    };
  }
  const owner = cycleOwnership(storage, cycle);
  if (owner?.attempt.status !== 'active') return;
  const { roadmap, attempt } = owner;
  const held = (entryId: RoadmapEntryId | undefined) => {
    const hold = entryId === undefined ? undefined : roadmap.entryHolds?.[entryId];
    return !!hold && (!launching || hold.status !== 'paused');
  };
  const scheduled =
    (launching
      ? cycle.status === 'running' &&
        ['running', 'paused', 'needs-attention'].includes(roadmap.status)
      : roadmap.status === 'running') &&
    !held(attempt.entryId) &&
    !held(attempt.recovery?.sourceEntryId);
  if (!scheduled) return;
  if (attempt.recovery && !roadmapCarriesRound(roadmap, attempt)) return;
  const entry = roadmap.definition.entries.find((e) => e.id === attempt.entryId);
  const tree = storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
  if (
    !entry ||
    tree?.integrationBranch !== entry.integrationBranch ||
    tree.repositoryId !== entry.repositoryId
  )
    throw new TypedRefusalError(
      'roadmap-binding-changed',
      'The roadmap worktree branch binding changed. Reconcile it before resuming.',
    );
  // Same resolution as the scheduler, including ADR-065 grants: a grant that makes an
  // entry's merge automatic must also refresh it, or the delegated merge meets a stale review.
  const delegation = attemptDelegation(storage, roadmap, attempt);
  const settings = delegation?.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING;
  const automation = delegation?.automation ?? DEFAULT_ROADMAP_AUTOMATION;
  if (
    settings.mode !== 'parallel' &&
    automation.integrationMerge !== 'automatic' &&
    automation.integrationConflicts !== 'automatic'
  )
    return;
  const user = activeEditor(storage, roadmap.delegatedByUserId, cycle.workspaceId);
  if (!user)
    throw new TypedRefusalError(
      'delegation-authority-lost',
      'The roadmap initiating user no longer has permission.',
    );
  return { settings, context: { user } };
}

/**
 * True when neither a controller review (ADR-063) nor an integration refresh may start
 * for this cycle, so reconciling it cannot act. Errors mean "may act": the full path
 * then reports them exactly as before.
 */
export function onlyOperatorCanAdvance(storage: CraftingTableStorage, cycle: WorkCycle): boolean {
  try {
    if (refreshOwner(storage, cycle)) return false;
    if (cycle.executionScope?.kind !== 'slice' || !cycle.workflow) return true;
    const delegation = workflowDelegation(storage, cycle);
    if (delegation) return delegation.runnable !== true;
    // Without a delegating roadmap, only a due security review can advance the cycle.
    const review = storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    return (
      !cycle.workflow.securityRequired ||
      !review ||
      securityReviewCurrent(storage, cycle, review) ||
      !controllerReviewRunnable(storage, cycle)
    );
  } catch {
    return false;
  }
}
