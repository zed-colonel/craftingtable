/**
 * Which roadmap entries may move (R-B7; the target architecture's pure admission): an entry's
 * blocker (its item and scope gates, predecessors, binding and capacity), the decisions a slice
 * not yet started waits on, whether an entry is complete, the recovery round that carries a work
 * item, and whether an entry may be re-verified. It writes nothing; it asks the merge lane and
 * records the lock a round waits on, as the blocker does.
 */

import type { RoadmapState } from './state.js';
import { ended, openRecoveries, type ReverificationRefusal } from './shared.js';
import { inRetiredVersion, retiredVersionIds } from '../retired-versions.js';
import { itemGate, predecessorGate } from '../transition-gate.js';
import {
  type AgentRunId,
  DEFAULT_ROADMAP_SCHEDULING,
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapEntry,
  sameExecutionScope,
  type Worktree,
  type ExecutionScope,
  cycleStop,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { decisionBriefs } from '../architecture-decision-inbox.js';
import { milestoneSatisfied } from '../milestone-policy.js';
import type { EntryBlocker } from '../entry-waits.js';
import { requireScopeOwnership, scopeBlockers, scopePhaseBlockers } from '../execution-scope.js';
import type { ExecutionService } from '../execution-service.js';
import { mapReadSnapshot } from '../map-read-snapshot.js';
import { roadmapCarriesRound } from '../scope-recovery-policy.js';
import { unsettledSliceDecisions } from '../workflow-policy.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';

export class RoadmapSelection {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly execution: ExecutionService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly state: RoadmapState,
  ) {}

  blocker(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    attempt?: RoadmapAttempt,
    tx: StorageRepositories = this.storage,
    /**
     * A recovery round for this slice may take one repository slot beyond the limit while a
     * slot holder's merge waits on this very slice, which would otherwise never free (LIVE-06).
     */
    recoveryRound = false,
  ): EntryBlocker | undefined {
    const blocked = (
      reason: string,
      needsAttention = true,
      kind: EntryBlocker['kind'] = 'dependency-blocked',
      circular = false,
      cause?: EntryBlocker['cause'],
    ): EntryBlocker => ({
      reason,
      needsAttention,
      kind,
      ...(circular ? { circular } : {}),
      ...(cause ? { cause } : {}),
    });
    // The item-status rule every gate shares (R-B4, decision 2); the scheduler admits a proposed
    // item itself.
    const refused = itemGate(
      tx.planning.workItems.find(roadmap.workspaceId, entry.workItemId),
      entry.executionScope,
      { admits: true, planVersionId: entry.planVersionId },
    );
    if (refused === 'item-unavailable')
      return blocked(
        `${entry.sourceId}: Bound plan item is unavailable.`,
        true,
        'dependency-blocked',
        false,
        refused,
      );
    if (refused)
      return blocked(
        `${entry.sourceId}: Marked complete without merging the roadmap worktree. Inspect the item; the queue will not advance.`,
        true,
        'dependency-blocked',
        false,
        refused,
      );
    try {
      requireScopeOwnership(
        tx,
        roadmap.workspaceId,
        entry.workItemId,
        entry.executionScope,
        attempt?.worktreeId,
      );
      if (entry.executionScope) {
        const issues = scopeBlockers(
          tx,
          roadmap.workspaceId,
          entry.workItemId,
          entry.executionScope,
          entry.executionScope.kind === 'slice-verification'
            ? 'verify'
            : entry.executionScope.kind === 'parent-acceptance'
              ? 'accept'
              : 'start',
        );
        if (issues.length) return blocked(`${entry.sourceId}: ${issues.join(' ')}`, false);
      }
    } catch (error) {
      return blocked(error instanceof Error ? error.message : 'Execution scope is unavailable.');
    }
    // The shared predecessor rule, with this roadmap's unfinished attempts still in flight.
    const predecessors = predecessorGate(
      tx,
      roadmap.workspaceId,
      entry.workItemId,
      entry.executionScope,
      (e) =>
        roadmap.attempts.some(
          (a) =>
            a.status !== 'completed' &&
            roadmap.definition.entries.some(
              (bound) => bound.id === a.entryId && bound.workItemId === e.workItemId,
            ),
        ),
    );
    if (predecessors.blocked)
      return blocked(
        `${entry.sourceId}: Waiting for required predecessors: ${predecessors.pending.map((e) => `${e.sourceId}${roadmap.definition.entries.some((item) => item.workItemId === e.workItemId) ? '' : ' (outside this roadmap)'}`).join(', ')}.`,
        false,
      );
    const settings = tx.execution.branchSettings.find(roadmap.workspaceId, entry.planVersionId);
    if (
      settings?.repositoryId !== entry.repositoryId ||
      settings.integrationBranch !== entry.integrationBranch
    )
      return blocked(
        `${entry.sourceId}: Plan branch settings changed. Save queued settings to adopt the new target.`,
      );
    const repo = tx.execution.sourceRepositories.find(roadmap.workspaceId, entry.repositoryId);
    if (repo?.status !== 'active') return blocked(`${entry.sourceId}: Repository is unavailable.`);
    if (!attempt && this.execution.branches.repositoryBusy(repo.rootPath)) {
      // Its release marks the roadmap (R-B5 part 2).
      this.state.waitOnLock(roadmap.id, 'lane');
      return blocked(
        `${entry.sourceId}: Waiting for a repository mutation to finish.`,
        false,
        'capacity-blocked',
      );
    }
    const policy = roadmap.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING;
    const parallel = policy.mode === 'parallel';
    const activeAttempts = roadmap.attempts.filter(
      (a) =>
        a.status !== 'completed' &&
        a.id !== attempt?.id &&
        roadmap.definition.entries.some(
          (e) => e.id === a.entryId && (!e.executionScope || e.executionScope.kind === 'slice'),
        ),
    );
    const reviewOnly = !!entry.executionScope && entry.executionScope.kind !== 'slice';
    // A recovery round whose slots are held by work that waits on the very slice it repairs
    // would wait forever: that is the operator's to resolve (LIVE-06).
    const circular = (holders: readonly Worktree[]) =>
      recoveryRound &&
      entry.executionScope?.kind === 'slice' &&
      holders.some((tree) => this.waitsOnSlice(tx, tree, entry.executionScope!))
        ? ` Work holding those slots waits on ${entry.sourceId}, which this recovery round repairs, so they cannot free by themselves. Raise the limit, or pause or finish a holder.`
        : undefined;
    if (!reviewOnly && parallel && activeAttempts.length >= policy.maxInFlight) {
      const deadlock = circular(
        activeAttempts.flatMap(
          (a) => tx.execution.worktrees.find(roadmap.workspaceId, a.worktreeId) ?? [],
        ),
      );
      return blocked(
        `${entry.sourceId}: All ${policy.maxInFlight} in-flight slots are occupied (including items awaiting merge or attention).${deadlock ?? ''}`,
        !!deadlock,
        'capacity-blocked',
        !!deadlock,
      );
    }
    // A decision preparation's worktree is read-only and never merges, so it holds no place in
    // a repository's slice capacity (LIVE-16): two finished preparations held both of a
    // repository's places for days.
    const preparing = new Set(
      tx.roadmaps.list().flatMap((r) => (r.decisionPreparations ?? []).map((p) => p.worktreeId)),
    );
    // A retired version's worktrees hold no capacity: its work can never run again (R-B11).
    const retired = retiredVersionIds(tx);
    const trees = tx.execution.worktrees
      .listActive()
      .filter(
        (t) =>
          !tx.amendments.retired(t.workspaceId, t.id) &&
          !preparing.has(t.id) &&
          (!t.executionScope || t.executionScope.kind === 'slice') &&
          !inRetiredVersion(tx, t, retired),
      );
    if (
      trees.some(
        (tree) =>
          tree.workspaceId === roadmap.workspaceId &&
          tree.workItemId === entry.workItemId &&
          (!tree.executionScope ||
            !entry.executionScope ||
            sameExecutionScope(tree.executionScope, entry.executionScope)) &&
          tree.id !== attempt?.worktreeId,
      )
    )
      return blocked(
        `${entry.sourceId}: This item already has an unmerged worktree. Finish or remove it before delegating another attempt.`,
        false,
        'capacity-blocked',
      );
    const occupied = trees.filter(
      (w) =>
        w.id !== attempt?.worktreeId &&
        tx.execution.sourceRepositories.find(w.workspaceId, w.repositoryId)?.rootPath ===
          repo.rootPath,
    );
    // Include reserved preparations before a worktree exists, across workspace schedulers.
    let reservations = 0;
    let repositoryLimit = parallel ? policy.maxPerRepository : 1;
    for (const other of tx.roadmaps.list()) {
      for (const reservation of other.attempts) {
        if (reservation.status === 'completed' || reservation.worktreeId === attempt?.worktreeId)
          continue;
        const bound = other.definition.entries.find((e) => e.id === reservation.entryId);
        if (!bound || (bound.executionScope && bound.executionScope.kind !== 'slice')) continue;
        const tree = trees.find((w) => w.id === reservation.worktreeId);
        const pending = !ended(other) && reservation.status === 'preparing' && !tree;
        if (!tree && !pending) continue;
        if (
          other.workspaceId === roadmap.workspaceId &&
          bound.exclusionGroups?.some((group) => entry.exclusionGroups?.includes(group))
        )
          return blocked(
            `${entry.sourceId}: Exclusion group is held by ${bound.sourceId} until merge or worktree removal.`,
            false,
            'exclusion-blocked',
          );
        if (
          tx.execution.sourceRepositories.find(other.workspaceId, bound.repositoryId)?.rootPath !==
          repo.rootPath
        )
          continue;
        if (pending) reservations++;
        if (!ended(other))
          repositoryLimit = Math.min(
            repositoryLimit,
            other.definition.scheduling?.mode === 'parallel'
              ? other.definition.scheduling.maxPerRepository
              : 1,
          );
      }
    }
    const used = occupied.length + reservations;
    const deadlock = used >= repositoryLimit ? circular(occupied) : undefined;
    // The round may take one slot beyond the limit, never more (operator decision 2026-09-27).
    if (!reviewOnly && used >= repositoryLimit && !(deadlock && used === repositoryLimit))
      return blocked(
        `${entry.sourceId}: Repository has ${occupied.length + reservations} unmerged worktree(s) or reservations; capacity is ${repositoryLimit}. Finish or remove existing work before this item starts.${deadlock ?? ''}`,
        !!deadlock,
        'capacity-blocked',
        !!deadlock,
      );
    return undefined;
  }

  /** Whether this unmerged slice worktree's merge waits on the given slice of the same map. */
  waitsOnSlice(tx: StorageRepositories, tree: Worktree, slice: ExecutionScope): boolean {
    if (
      tree.executionScope?.kind !== 'slice' ||
      !tree.workItemId ||
      tree.executionScope.definitionId !== slice.definitionId ||
      tree.executionScope.bindingRevision !== slice.bindingRevision
    )
      return false;
    try {
      return scopePhaseBlockers(
        tx,
        tree.workspaceId,
        tree.workItemId,
        tree.executionScope,
        'merge',
        { resources: false },
      ).some((b) => b.code === 'slice-requirement' && b.refs?.sliceId === slice.sourceId);
    } catch {
      // A scope that no longer resolves lends nothing: the round keeps the ordinary limit.
      return false;
    }
  }

  /**
   * The decisions a slice not yet started waits on (R-C3b, operator decision 2026-09-29): each
   * shared decision its merge needs that is not settled for it and has a brief that would settle
   * it once approved. The scheduler holds the slice on them instead of starting a design that
   * would stop to ask. A decision with no brief does not hold it, nor does a brief that could not
   * release it (R-C3b review): one limited to clauses of other slices, one on a card that cannot
   * be approved yet, or one the operator has rejected since it was written. Only the roadmap
   * waits: the operator may still start the slice by hand.
   */
  decisionHold(
    tx: StorageRepositories,
    roadmap: Roadmap,
    entry: RoadmapEntry,
  ): import('@craftingtable/domain').PhaseBlocker[] {
    const scope = entry.executionScope;
    if (scope?.kind !== 'slice') return [];
    try {
      const definition = tx.imports.definition(roadmap.workspaceId, scope.definitionId);
      const slice = definition?.source.slices.find((s) => s.id === scope.sourceId);
      if (!definition || !slice) return [];
      const merge = new Set(
        slice.merge_requires.filter((r) => r.kind === 'checkpoint').map((r) => r.id),
      );
      if (!merge.size) return [];
      let inboxes =
        tx === this.storage ? this.state.passInboxes : this.state.viewInboxes.get(tx as object);
      if (!inboxes) {
        inboxes = new Map();
        if (tx !== this.storage) this.state.viewInboxes.set(tx as object, inboxes);
      }
      // Rebuilt whenever workflow state changed since, within a pass too (R-C3b review): a brief
      // that finished or a decision settled meanwhile is seen at once. Only the briefs of the
      // decisions this roadmap's slices not yet started need are read, not the whole inbox (R-D7).
      const generation = this.notifier.workflowGeneration;
      let cached = inboxes.get(definition.id);
      if (
        !cached ||
        cached.generation !== generation ||
        [...merge].some((id) => !cached!.checkpoints.has(id))
      ) {
        const checkpoints = new Set([
          ...(cached?.generation === generation ? cached.checkpoints : []),
          ...merge,
          ...roadmap.definition.entries.flatMap((e) =>
            e.executionScope?.kind === 'slice' &&
            e.executionScope.definitionId === definition.id &&
            !roadmap.attempts.some((a) => a.entryId === e.id)
              ? (definition.source.slices
                  .find((s) => s.id === e.executionScope!.sourceId)
                  ?.merge_requires.filter((r) => r.kind === 'checkpoint')
                  .map((r) => r.id) ?? [])
              : [],
          ),
        ]);
        cached = {
          generation,
          checkpoints,
          briefs: decisionBriefs(tx, definition, checkpoints),
          sources: new Map(
            tx.runtimeEvidence
              .submissions(roadmap.workspaceId, definition.id)
              .map((submission) => [submission.id, submission.sourceRunId]),
          ),
        };
        inboxes.set(definition.id, cached);
      }
      const { briefs, sources } = cached;
      const ready = [...briefs.values()].filter((d) => {
        const brief = d.recommendation.brief;
        if (!merge.has(d.checkpointId) || !brief || d.blockers.length) return false;
        if (brief.coverage !== 'full' && !brief.consumers.some((c) => c.sliceId === slice.id))
          return false;
        // Released once the operator rejected a proposal made from this very brief that would
        // have settled this slice; a clause proposal for another slice does not release it.
        return !d.records.some(
          (r) =>
            r.decision?.outcome === 'rejected' &&
            sources.get(r.id) === d.recommendation.sourceRunId &&
            (r.proposal.coverage === 'full' ||
              r.proposal.consumers.some((c) => c.sliceId === slice.id)),
        );
      });
      if (!ready.length) return [];
      const unsettled = unsettledSliceDecisions(tx, roadmap.workspaceId, entry.workItemId, scope);
      return ready
        .filter((d) => unsettled.includes(d.checkpointId))
        .map((d) => ({
          kind: 'evidence' as const,
          code: 'decision-checkpoint-evidence' as const,
          message: `${d.checkpointId} has a prepared brief awaiting your approval; ${entry.sourceId} starts once it is approved, so its design does not stop to ask. Approve it in Shared architecture decisions.`,
          refs: { checkpointId: d.checkpointId },
        }));
    } catch {
      return [];
    }
  }

  complete(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    tx: StorageRepositories = this.storage,
    ignoreRecovery = false,
  ): boolean {
    if (!ignoreRecovery && this.roundFor(roadmap, entry)?.recovery?.sourceEntryId === entry.id)
      return false;
    if (entry.executionScope) {
      const scope = entry.executionScope;
      const d = tx.imports.definition(roadmap.workspaceId, scope.definitionId);
      return (
        !!d &&
        milestoneSatisfied(tx, roadmap.workspaceId, d, scope.bindingRevision, {
          ...(scope.kind === 'parent-acceptance'
            ? { kind: 'work_item' as const, state: 'accepted' as const }
            : {
                kind: 'slice' as const,
                state: scope.kind === 'slice' ? ('merged' as const) : ('verified' as const),
              }),
          id: scope.sourceId,
        })
      );
    }
    const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
    return attempt
      ? attempt.status === 'completed'
      : entry.executionScope
        ? tx.execution.worktrees
            .listForWorkItem(roadmap.workspaceId, entry.workItemId)
            .some((t) => sameExecutionScope(t.executionScope, entry.executionScope) && !!t.mergedAt)
        : tx.planning.workItems.find(roadmap.workspaceId, entry.workItemId)?.status === 'completed';
  }

  entriesComplete(roadmap: Roadmap): boolean {
    const tx = mapReadSnapshot(this.storage);
    return roadmap.definition.entries.every((entry) => this.complete(roadmap, entry, tx));
  }

  /** Entries this pass skips: complete ones, and unstarted ones a blocker defers. */
  deferredEntries(roadmap: Roadmap): ReadonlyMap<string, 'complete' | EntryBlocker> {
    const tx = mapReadSnapshot(this.storage);
    return new Map(
      roadmap.definition.entries.flatMap((entry): [string, 'complete' | EntryBlocker][] => {
        const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
        if (this.complete(roadmap, entry, tx))
          return !attempt || attempt.status === 'completed' ? [[entry.id, 'complete']] : [];
        if (attempt) return [];
        const blocker = this.blocker(roadmap, entry, undefined, tx);
        return blocker && !blocker.needsAttention ? [[entry.id, blocker]] : [];
      }),
    );
  }

  /** The entry's own milestone is already satisfied, so its old hold needs nobody. */
  scopeComplete(tx: StorageRepositories, roadmap: Roadmap, entry: RoadmapEntry): boolean {
    const scope = entry.executionScope;
    const d = scope && tx.imports.definition(roadmap.workspaceId, scope.definitionId);
    return (
      !!scope &&
      !!d &&
      milestoneSatisfied(
        tx,
        roadmap.workspaceId,
        d,
        scope.bindingRevision,
        scope.kind === 'parent-acceptance'
          ? { kind: 'work_item', id: scope.sourceId, state: 'accepted' }
          : {
              kind: 'slice',
              id: scope.sourceId,
              state: scope.kind === 'slice' ? 'merged' : 'verified',
            },
      )
    );
  }

  recoveryFor(roadmap: Roadmap, entry: RoadmapEntry) {
    return openRecoveries(roadmap).get(entry.workItemId);
  }

  /** The live recovery round for this work item that the roadmap carries through. */
  roundFor(roadmap: Roadmap, entry: RoadmapEntry) {
    const round = this.recoveryFor(roadmap, entry);
    return round && roadmapCarriesRound(roadmap, round) ? round : undefined;
  }

  /** The review each of the work item's verification and parent entries last ran. */
  reviewRunIds(roadmap: Roadmap, entry: RoadmapEntry): Record<string, AgentRunId> {
    return Object.fromEntries(
      roadmap.attempts.flatMap((a) => {
        const e = roadmap.definition.entries.find((e) => e.id === a.entryId);
        const c = this.storage.execution.cycles.find(roadmap.workspaceId, a.cycleId);
        return e?.workItemId === entry.workItemId && e.executionScope?.kind !== 'slice' && c
          ? [[e.id, c.currentRunId]]
          : [];
      }),
    );
  }

  /** Whether an entry may be re-verified, and how; the view and the command share it. */
  reverification(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    tx: StorageRepositories = this.storage,
  ):
    | { refused: ReverificationRefusal }
    | { attempt: RoadmapAttempt; inPlace: true; sourceRunId: AgentRunId }
    | { attempt: RoadmapAttempt; inPlace: false } {
    const refused = (code: ReverificationRefusal['code'], message: string) => ({
      refused: { code, message },
    });
    if (['draft', 'stopped', 'completed'].includes(roadmap.status))
      return refused('roadmap-inactive', 'Re-verification needs an active roadmap.');
    if (!entry.executionScope || entry.executionScope.kind === 'slice')
      return refused(
        'not-a-review',
        'Only verification and parent acceptance entries can be re-verified.',
      );
    if (this.recoveryFor(roadmap, entry))
      return refused(
        'recovery-owns-entry',
        'Scope recovery owns this entry; finish its recovery first.',
      );
    const hold = roadmap.entryHolds?.[entry.id];
    if (hold?.status === 'paused')
      return refused(
        'entry-paused',
        'This item is paused. Resume the item before re-verifying it.',
      );
    const attempt = roadmap.attempts.find((a) => a.entryId === entry.id && !a.recovery);
    if (!attempt) return refused('not-started', 'This entry has not run yet; resume the roadmap.');
    // A queued review that failed holds the item; re-verifying replaces it with a fresh route.
    if (attempt.dependencyRefresh || (attempt.reverification && !hold))
      return refused('review-queued', 'A fresh review is already queued for this entry.');
    const cycle = tx.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
    if (!cycle && !hold)
      return refused('preparing', 'This entry is still being prepared; wait for its review cycle.');
    // An entry held for a refusal the scheduler met at its record-scope-evidence gate (usually its
    // receipt's; the refusal hold, `entry-preparation-failed`) while its approved review waits
    // there reviews again in place, as a pause and resume of the cycle would (R-C10 follow-up 2,
    // operator decision 2026-10-17). Any other gate is left to whoever records it: the scheduler,
    // or the operator under manual acceptance.
    const gated =
      hold?.attention?.code === 'entry-preparation-failed' &&
      cycle?.status === 'awaiting-merge' &&
      cycleStop(cycle)?.code === 'record-scope-evidence';
    if (cycle && !['completed', 'stopped'].includes(cycle.status) && !gated)
      return refused('review-open', 'Its review cycle is still open; finish or stop it first.');
    if (this.complete(roadmap, entry, tx))
      return refused(
        'evidence-current',
        'This evidence is current; there is nothing to re-verify.',
      );
    const tree = tx.execution.worktrees.find(roadmap.workspaceId, attempt.worktreeId);
    if (
      (cycle?.status === 'completed' || gated) &&
      tree?.status === 'active' &&
      !tx.amendments.retired(roadmap.workspaceId, tree.id) &&
      sameExecutionScope(tree.executionScope, entry.executionScope)
    )
      return { attempt, inPlace: true, sourceRunId: cycle.currentRunId };
    // The fresh route retires an ended attempt; a gated cycle has not ended.
    if (gated)
      return refused('review-open', 'Its review cycle is still open; finish or stop it first.');
    // A scope has one active worktree; a fresh attempt needs the unused one removed first.
    const other = tx.execution.worktrees
      .listForWorkItem(roadmap.workspaceId, entry.workItemId)
      .find(
        (t) =>
          t.status === 'active' &&
          !tx.amendments.retired(roadmap.workspaceId, t.id) &&
          sameExecutionScope(t.executionScope, entry.executionScope),
      );
    if (other)
      return refused(
        'other-worktree',
        `Remove the unused worktree ${other.branchName} first; a verification scope has one active worktree.`,
      );
    return { attempt, inPlace: false };
  }
}
