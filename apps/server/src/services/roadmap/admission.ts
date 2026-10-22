/**
 * The roadmap scheduler's admission and attempts (R-B7; CTRL-13): one pass over a running
 * roadmap (its decision preparations first, then each entry in order), an entry's evaluation (its
 * hold's release, a review entry's queued review, recovery and receipt, the delegated merge or
 * resolution, its blocker and decision hold, and a new attempt with its worktree and cycle), the
 * attempts a completed entry closes, and scope recovery's rounds, which evaluate their owner and
 * target entries in turn.
 */

import type { RuntimeEvidenceService } from '../runtime-evidence-service.js';
import type { RoadmapPreparations } from './preparations.js';
import type { RoadmapSelection } from './selection.js';
import type { RoadmapHolds } from './holds.js';
import type { RoadmapWriter } from './writer.js';
import type { RoadmapState } from './state.js';
import {
  SupersededRoadmapOperation,
  retried,
  gated,
  holdRefs,
  refuseBlocked,
  EntryHoldError,
  conflict,
  entryReason,
} from './shared.js';
import { investigationLive, worktreeChangeOpen } from '../investigation.js';
import { ownerOf } from '../cycle-ownership.js';
import { itemGate } from '../transition-gate.js';
import { attemptDefinition } from '../roadmap-delegation-policy.js';
import { randomUUID } from 'node:crypto';
import {
  asRoadmapAttemptId,
  asWorkCycleId,
  asWorktreeId,
  DEFAULT_ROADMAP_SCHEDULING,
  required,
  type Roadmap,
  type RoadmapAttempt,
  roadmapAttention,
  type RoadmapEntry,
  sameExecutionScope,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { IntegrationHeldError } from '../branch-service.js';
import { bindingIssues } from '../map-binding-policy.js';
import { crossProjectState } from '../map-state.js';
import {
  blockerWait,
  cycleStep,
  cycleWait,
  type EntryStep,
  MOVED,
  nextEntryWaits,
  phaseWait,
  roundStep,
  sameEntryWaits,
  waiting,
} from '../entry-waits.js';
import { ExecutionRequestError, TypedRefusalError } from '../errors.js';
import { scopePhaseBlockers } from '../execution-scope.js';
import type { ExecutionService } from '../execution-service.js';
import { mapReadSnapshot } from '../map-read-snapshot.js';
import { PhaseGateError } from '../phase-resources.js';
import { roadmapCarriesRound, scopeRecoveryDecision } from '../scope-recovery-policy.js';
import { collectScopeRepair } from '../scope-repair.js';
import type { WorkCycleService } from '../work-cycle-service.js';
import type { WorkItemService } from '../work-item-service.js';
import type { RoadmapIntegration } from './integration.js';

export class RoadmapAdmission {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly items: WorkItemService,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly runtimeEvidence: RuntimeEvidenceService,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
    private readonly selection: RoadmapSelection,
    private readonly holds: RoadmapHolds,
    private readonly preparations: RoadmapPreparations,
    private readonly integration: RoadmapIntegration,
  ) {}

  async advance(roadmap: Roadmap): Promise<void> {
    this.writer.authority(roadmap);
    if (this.storage.amendments.pending(roadmap.workspaceId, roadmap.id)) return;
    // Shared decisions are prepared beside the slices that will need them (R-C3b).
    await this.preparations.prepareNeededDecisions(roadmap).catch(() => undefined);
    await this.preparations.releaseSettledPreparations(roadmap);
    // The launch awaited: a pause, a command or an amendment may have come meanwhile.
    roadmap = this.writer.find(roadmap.workspaceId, roadmap.id);
    if (
      roadmap.status !== 'running' ||
      this.state.controlling.has(roadmap.id) ||
      this.storage.amendments.pending(roadmap.workspaceId, roadmap.id) ||
      this.storage.windDowns.find(roadmap.workspaceId, roadmap.id)?.status === 'settling'
    )
      return;
    if (roadmap.definition.crossProject) {
      const c = roadmap.definition.crossProject,
        issues = bindingIssues(
          this.storage,
          roadmap.workspaceId,
          c.definitionId,
          c.bindingRevision,
        );
      if (issues.length) conflict(issues.join(' '));
    }
    if (roadmap.definition.scheduling?.mode === 'parallel') {
      // Manual acceptance can finish while scheduling is paused. Reconcile every
      // completed attempt before freezing this pass's priority/eligibility decisions.
      roadmap = this.reconcileCompletedAttempts(roadmap);
      // Advisory deferral only. Read once synchronously, then discard the snapshot before
      // any await/mutation. Eligible entries still pass every fresh admission check below.
      const deferred = this.selection.deferredEntries(roadmap);
      // What this pass left each evaluated entry waiting on (R-C12).
      const evaluated = new Map<string, EntryStep | 'keep'>();
      for (const entry of roadmap.definition.entries) {
        const skipped = deferred.get(entry.id);
        if (skipped) {
          this.state.observer?.entry(
            roadmap,
            entry,
            skipped === 'complete' ? { kind: 'complete' } : { kind: 'deferred', blocker: skipped },
          );
          continue;
        }
        let current = this.writer.find(roadmap.workspaceId, roadmap.id);
        if (
          current.status !== 'running' ||
          this.state.controlling.has(current.id) ||
          this.state.abort.signal.aborted
        )
          return;
        this.writer.authority(current);
        if (this.selection.complete(current, entry)) {
          this.state.observer?.entry(current, entry, { kind: 'complete' });
          const attempt = current.attempts.find((a) => a.entryId === entry.id);
          // Evidence that became current again also ends a queued re-verification.
          if (attempt && (attempt.status !== 'completed' || attempt.reverification))
            this.writer.change(current, {
              attempts: current.attempts.map((a) =>
                a.id === attempt.id
                  ? {
                      ...a,
                      status: 'completed' as const,
                      completedAt: a.completedAt ?? this.state.now().toISOString(),
                      reverification: undefined,
                    }
                  : a,
              ),
            });
          continue;
        }
        const heldAttempt = current.attempts.find((a) => a.entryId === entry.id);
        const merged =
          heldAttempt &&
          this.storage.execution.worktrees.find(current.workspaceId, heldAttempt.worktreeId)
            ?.mergedAt;
        if (current.entryHolds?.[entry.id] && !merged) {
          // A hold whose typed fact cleared is released, and the entry evaluated as any other
          // (R-C10's follow-up, decision 2).
          const released = await this.holds.releaseHold(current, entry);
          if (!released) {
            this.state.observer?.entry(current, entry, { kind: 'held' });
            continue;
          }
          current = released;
        }
        let step: EntryStep;
        try {
          step = await this.advanceEntry(current, entry);
        } catch (error) {
          if (error instanceof SupersededRoadmapOperation) throw error;
          if (retried(error)) {
            this.state.metRetried(current.id, error);
            // Gates that clear by themselves are typed waits; a lost race keeps the last one.
            evaluated.set(
              entry.id,
              error instanceof PhaseGateError
                ? { wait: phaseWait(error) }
                : error instanceof IntegrationHeldError
                  ? waiting('integration-held', error.message)
                  : 'keep',
            );
            this.state.observer?.entry(current, entry, { kind: 'retry', error });
            continue;
          }
          const latest = this.writer.find(roadmap.workspaceId, roadmap.id);
          if (latest.status !== 'running' || this.state.controlling.has(latest.id)) return;
          const reason =
            error instanceof ExecutionRequestError
              ? error.message
              : 'Could not prepare this item. Inspect it before resuming.';
          this.writer.change(latest, {
            entryHolds: {
              ...latest.entryHolds,
              [entry.id]: {
                status: 'needs-attention',
                reason: reason.slice(0, 4000),
                attention: roadmapAttention(
                  error instanceof EntryHoldError
                    ? error.attentionCode
                    : 'entry-preparation-failed',
                  holdRefs(entry.id, error),
                ),
              },
            },
          });
          this.state.observer?.entry(current, entry, { kind: 'hold-recorded', error });
          continue;
        }
        evaluated.set(entry.id, step);
        this.state.observer?.entry(current, entry, { kind: 'evaluated', step });
      }
      let current = this.writer.find(roadmap.workspaceId, roadmap.id);
      if (current.status !== 'running') return;
      const waits = nextEntryWaits(current.entryWaits, evaluated, this.state.now().toISOString());
      if (!sameEntryWaits(current.entryWaits, waits))
        current = this.writer.change(current, { entryWaits: waits });
      if (
        this.selection.entriesComplete(current) &&
        (!current.definition.crossProject ||
          crossProjectState(this.storage, current.workspaceId, current.definition.crossProject)
            .selectedScopeComplete)
      ) {
        if (current.definition.crossProject) {
          const c = current.definition.crossProject,
            view = crossProjectState(this.storage, current.workspaceId, c);
          await this.runtimeEvidence.assertSubjectsCurrent(
            current.workspaceId,
            c.definitionId,
            c.bindingRevision,
            view.nodes
              .filter((n) => n.included && n.kind === 'checkpoint')
              .map((n) => ({ kind: 'checkpoint' as const, sourceId: n.sourceId })),
          );
          const fresh = this.writer.find(current.workspaceId, current.id);
          if (
            fresh.version !== current.version ||
            this.state.controlling.has(current.id) ||
            this.state.abort.signal.aborted
          )
            throw new SupersededRoadmapOperation();
          this.writer.authority(fresh);
          if (!crossProjectState(this.storage, fresh.workspaceId, c).selectedScopeComplete) return;
        }
        this.writer.change(current, {
          status: 'completed',
          reason: current.definition.crossProject
            ? 'Selected roadmap scope complete. Excluded obligations, finalization and publication retain their separate gates.'
            : 'All roadmap entries are completed.',
        });
      } else
        this.writer.reason(
          current,
          'Parallel scheduling enabled. Items progress independently; integration follows each item’s merge policy.',
        );
      return;
    }
    const entry = roadmap.definition.entries.find((e) => !this.selection.complete(roadmap, e));
    if (!entry) {
      this.writer.change(roadmap, {
        status: 'completed',
        reason: 'All roadmap entries are completed.',
      });
      return;
    }
    try {
      const step = await this.advanceEntry(roadmap, entry);
      this.state.observer?.entry(roadmap, entry, { kind: 'evaluated', step });
      // A sequential pass evaluates one entry, and records its wait the same way (R-C12).
      const current = this.writer.find(roadmap.workspaceId, roadmap.id);
      const waits = nextEntryWaits(
        current.entryWaits,
        new Map([[entry.id, step]]),
        this.state.now().toISOString(),
      );
      if (current.status === 'running' && !sameEntryWaits(current.entryWaits, waits))
        this.writer.change(current, { entryWaits: waits });
    } catch (error) {
      this.state.observer?.entry(
        roadmap,
        entry,
        retried(error) ? { kind: 'retry', error } : { kind: 'failed', error },
      );
      throw error;
    }
  }

  /** Evaluates one entry; a refusal it meets names the entry whose gate refused (`gated`). */
  async advanceEntry(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    recoveryAttempt?: RoadmapAttempt,
    reviewingRecovery = false,
  ): Promise<EntryStep> {
    try {
      return await this.evaluateEntry(roadmap, entry, recoveryAttempt, reviewingRecovery);
    } catch (error) {
      throw gated(error, entry.id);
    }
  }

  async evaluateEntry(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    recoveryAttempt?: RoadmapAttempt,
    reviewingRecovery = false,
  ): Promise<EntryStep> {
    const context = this.writer.authority(roadmap);
    const parallel = roadmap.definition.scheduling?.mode === 'parallel';
    let attempt =
      recoveryAttempt ?? roadmap.attempts.find((a) => a.entryId === entry.id && !a.recovery);
    // A command on the cycle is in flight, or an investigation of its stop is at work (R-C16):
    // the scheduler leaves the stop to it. One that found its worktree changed waits on the
    // operator alone, and is recorded as the stop's wait (R-C16 review M2).
    if (attempt && this.cycles.isTransitioning(attempt.cycleId)) {
      // The transition's end marks the roadmap (R-B5 part 2).
      this.state.waitOnLock(roadmap.id, `cycle:${attempt.cycleId}`);
      return MOVED;
    }
    const investigated =
      attempt && this.storage.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
    if (investigated && investigationLive(investigated)) return MOVED;
    if (investigated && worktreeChangeOpen(investigated)) return cycleStep(investigated);
    if (attempt) {
      const worktree = this.storage.execution.worktrees.find(
        roadmap.workspaceId,
        attempt.worktreeId,
      );
      if (
        worktree &&
        (worktree.integrationBranch !== entry.integrationBranch ||
          worktree.repositoryId !== entry.repositoryId ||
          !sameExecutionScope(worktree.executionScope, entry.executionScope))
      )
        conflict(
          `${entry.sourceId}: The execution branch binding changed. Stop this roadmap and reconcile the remaining queue with the new target.`,
        );
      if (entry.executionScope && entry.executionScope.kind !== 'slice' && worktree) {
        const cycle = this.storage.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
        if (cycle) {
          if (attempt.dependencyRefresh || attempt.reverification) {
            const refresh = attempt.dependencyRefresh;
            const requested = attempt.reverification;
            const check = () => {
              const current = this.writer.find(roadmap.workspaceId, roadmap.id);
              this.writer.authority(current);
              const queued = current.attempts.find(
                (a) => a.id === required(attempt, "the queued review's attempt").id,
              );
              if (
                current.status !== 'running' ||
                current.entryHolds?.[entry.id] ||
                this.state.controlling.has(current.id) ||
                this.state.abort.signal.aborted ||
                (refresh
                  ? queued?.dependencyRefresh?.runtimeId !== refresh.runtimeId
                  : queued?.reverification?.requestedAt !== requested?.requestedAt)
              )
                throw new SupersededRoadmapOperation();
              if (
                refresh &&
                this.storage.runtimeEvidence.generations(
                  roadmap.workspaceId,
                  required(entry.executionScope, "the review entry's execution scope").definitionId,
                  required(entry.executionScope, "the review entry's execution scope")
                    .bindingRevision,
                )[0]?.id !== refresh.runtimeId
              )
                conflict(
                  'Dependencies changed again. Preview the current dependency refresh before resuming this review.',
                );
              if (
                this.storage.execution.cycles.find(roadmap.workspaceId, cycle.id)?.currentRunId !==
                required(refresh ?? requested, "the queued review's request").sourceRunId
              )
                conflict('The queued review changed. Inspect its manual recovery before resuming.');
              const blockers = scopePhaseBlockers(
                this.storage,
                roadmap.workspaceId,
                entry.workItemId,
                required(entry.executionScope, "the review entry's execution scope"),
                required(entry.executionScope, "the review entry's execution scope").kind ===
                  'slice-verification'
                  ? 'verify'
                  : 'accept',
                { ownerId: cycle.currentRunId },
              );
              if (blockers.length) throw new PhaseGateError(blockers);
            };
            check();
            await this.cycles.repeatScopeReview(
              context,
              roadmap.workspaceId,
              cycle.id,
              cycle.version,
              '',
              {
                check,
                attach: () => {
                  const current = this.writer.find(roadmap.workspaceId, roadmap.id);
                  this.writer.change(current, {
                    attempts: current.attempts.map((a) =>
                      a.id === required(attempt, "the queued review's attempt").id
                        ? {
                            ...a,
                            status: 'active',
                            completedAt: undefined,
                            dependencyRefresh: undefined,
                            reverification: undefined,
                          }
                        : a,
                    ),
                  });
                },
              },
            );
            return MOVED;
          }
          if (
            !reviewingRecovery &&
            (roadmap.scopeRecovery?.enabled || this.selection.roundFor(roadmap, entry))
          ) {
            const recovery = await this.advanceScopeRecovery(roadmap, entry, cycle);
            if (recovery) return recovery;
          }
          if (cycle.status === 'completed')
            throw new EntryHoldError(
              'evidence-not-current',
              'This review evidence is no longer current; prior attempts remain in history.',
            );
          if (cycle.status === 'awaiting-merge') {
            const definition = attemptDefinition(this.storage, roadmap, attempt);
            if (
              entry.executionScope.kind === 'slice-verification' ||
              definition?.crossProject?.parentAcceptance === 'automatic'
            ) {
              const check = () => {
                const latest = this.writer.find(roadmap.workspaceId, roadmap.id);
                if (
                  latest.status !== 'running' ||
                  latest.entryHolds?.[entry.id] ||
                  this.state.controlling.has(latest.id) ||
                  this.state.abort.signal.aborted
                )
                  throw new SupersededRoadmapOperation();
                this.writer.authority(latest);
              };
              check();
              if (await this.integration.refreshed(roadmap, cycle)) return MOVED;
              await this.execution.recordScopeReceipt(
                context,
                roadmap.workspaceId,
                worktree.id,
                worktree.version,
                { actor: { check } },
              );
              return MOVED;
            }
          }
          // The review runs, or stopped with no round to carry it: its cycle says who acts.
          return cycleStep(cycle);
        }
      }
      if (worktree?.mergedAt) {
        this.writer.change(roadmap, {
          attempts: roadmap.attempts.map((a) =>
            a.id === attempt?.id
              ? { ...a, status: 'completed' as const, completedAt: worktree.mergedAt }
              : a,
          ),
          ...entryReason(parallel, `${entry.sourceId} integrated.`),
          entryHolds: Object.fromEntries(
            Object.entries(roadmap.entryHolds ?? {}).filter(([id]) => id !== entry.id),
          ),
        });
        return MOVED;
      }
      const refused = itemGate(
        this.storage.planning.workItems.find(roadmap.workspaceId, entry.workItemId),
        entry.executionScope,
        { admits: true, planVersionId: entry.planVersionId },
      );
      if (refused) {
        // One fact, one stop (R-B4, decision 2): the cycle stops with the item gate's code and the
        // entry waits on it; before its cycle exists, the entry holds with the gate's cause.
        const stopping = this.storage.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
        if (stopping) return this.integration.leaveToCycle(roadmap, entry, stopping, parallel);
        throw new TypedRefusalError(
          refused,
          refused === 'item-completed-unmerged'
            ? `${entry.sourceId}: Marked complete without merging the roadmap worktree. Merge its reviewed branch or stop this roadmap to reconcile the queue.`
            : `${entry.sourceId}: Bound plan item is unavailable.`,
        );
      }
      const cycle = this.storage.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
      if (cycle)
        return this.integration.integrate(roadmap, entry, attempt, cycle, context, parallel);
    }
    const blocker = this.selection.blocker(roadmap, entry, attempt);
    if (blocker) {
      if (parallel) {
        if (blocker.needsAttention) refuseBlocked(blocker);
        return blockerWait(blocker);
      }
      if (blocker.needsAttention)
        this.writer.change(roadmap, {
          status: 'needs-attention',
          attention: roadmapAttention('entry-blocked', {
            entryId: entry.id,
            ...(blocker.cause ? { cause: blocker.cause } : {}),
          }),
          reason: blocker.reason,
        });
      else this.writer.reason(roadmap, blocker.reason);
      return blockerWait(blocker);
    }
    // A slice waits for the decisions its merge needs once each has a brief, rather than
    // starting a design that would stop to ask for them (R-C3b, operator decision 2026-09-29).
    if (!attempt) {
      const held = this.selection.decisionHold(this.storage, roadmap, entry);
      if (held.length) {
        const wait = phaseWait(new PhaseGateError(held));
        if (!parallel) this.writer.reason(roadmap, `${entry.sourceId}: ${wait.reason}`);
        return { wait };
      }
      // A completed predecessor's merge that is unrecorded or not in the integration branch
      // holds the new attempt back, as the operator's wait (R-B4, decision 1): the launch would
      // only refuse it. It clears by itself once the merge is in the branch.
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
    this.cycles.validateSettings(entry);
    if (!attempt) {
      attempt = {
        id: asRoadmapAttemptId(randomUUID()),
        entryId: entry.id,
        definitionRevision: roadmap.definition.revision,
        worktreeId: asWorktreeId(randomUUID()),
        cycleId: asWorkCycleId(randomUUID()),
        status: 'preparing',
        createdAt: this.state.now().toISOString(),
      };
      roadmap = this.writer.change(roadmap, {
        attempts: [...roadmap.attempts, attempt],
        ...entryReason(parallel, `Preparing ${entry.sourceId}.`),
      });
    }
    const reserved = attempt;
    const check = () => {
      if (this.state.abort.signal.aborted) throw new SupersededRoadmapOperation();
      const current = this.writer.find(roadmap.workspaceId, roadmap.id);
      if (current.version !== roadmap.version || current.status !== 'running')
        throw new SupersededRoadmapOperation();
      this.writer.authority(current);
      const blocked = this.selection.blocker(current, entry, reserved);
      if (blocked) refuseBlocked(blocked);
    };
    check();
    this.items.admit(context, roadmap.workspaceId, entry.workItemId);
    let worktree = this.storage.execution.worktrees.find(roadmap.workspaceId, reserved.worktreeId);
    if (!worktree)
      worktree = await this.execution.createWorktree(
        context,
        roadmap.workspaceId,
        entry.workItemId,
        {
          repositoryId: entry.repositoryId,
          ...(entry.executionScope ? { executionScope: entry.executionScope } : {}),
        },
        undefined,
        { id: reserved.worktreeId, actor: { check } },
      );
    check();
    if (worktree.status !== 'active')
      conflict(
        'Reserved worktree was removed. For imported maps, use Planning amendments and reconciliation to review a replacement attempt.',
      );
    if (
      worktree.integrationBranch !== entry.integrationBranch ||
      worktree.repositoryId !== entry.repositoryId ||
      !sameExecutionScope(worktree.executionScope, entry.executionScope)
    )
      conflict('Reserved worktree no longer matches this entry’s branch binding.');
    // Cycle creation and attempt attachment commit together, before the cycle worker can launch.
    this.storage.transaction(() => {
      this.cycles.start(
        context,
        roadmap.workspaceId,
        entry.workItemId,
        {
          worktreeId: reserved.worktreeId,
          profiles: entry.profiles,
          policy: entry.policy,
          instructions: entry.instructions,
        },
        reserved.cycleId,
        !!roadmap.definition.crossProject,
        ownerOf(roadmap, reserved),
      );
      this.writer.change(roadmap, {
        attempts: roadmap.attempts.map((a) =>
          a.id === reserved.id ? { ...a, status: 'active' } : a,
        ),
        ...entryReason(parallel, `Running ${entry.sourceId}.`),
      });
    });
    return MOVED;
  }

  private reconcileCompletedAttempts(roadmap: Roadmap): Roadmap {
    const tx = mapReadSnapshot(this.storage);
    let changed = false;
    const entryHolds = { ...roadmap.entryHolds };
    const attempts = roadmap.attempts.map((attempt) => {
      if (!attempt.recovery && this.cycles.isTransitioning(attempt.cycleId))
        this.state.waitOnLock(roadmap.id, `cycle:${attempt.cycleId}`);
      if (
        attempt.recovery ||
        this.cycles.isTransitioning(attempt.cycleId) ||
        (attempt.status === 'completed' && !entryHolds[attempt.entryId])
      )
        return attempt;
      const entry = roadmap.definition.entries.find((e) => e.id === attempt.entryId);
      if (!entry) return attempt;
      const tree =
        !entry.executionScope &&
        tx.execution.worktrees.find(roadmap.workspaceId, attempt.worktreeId);
      const mergedAt =
        tree &&
        !tree.executionScope &&
        tree.repositoryId === entry.repositoryId &&
        tree.integrationBranch === entry.integrationBranch
          ? tree.mergedAt
          : undefined;
      if (!mergedAt && !this.selection.complete(roadmap, entry, tx)) return attempt;
      changed = true;
      delete entryHolds[entry.id];
      return {
        ...attempt,
        status: 'completed' as const,
        completedAt: mergedAt ?? this.state.now().toISOString(),
      };
    });
    return changed ? this.writer.change(roadmap, { attempts, entryHolds }) : roadmap;
  }

  /** Each round survives worktree replacement and returns through the original independent reviewers. */
  private async advanceScopeRecovery(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    sourceCycle: import('@craftingtable/domain').WorkCycle,
  ): Promise<EntryStep | undefined> {
    const ws = roadmap.workspaceId;
    let attempt = this.selection.recoveryFor(roadmap, entry);
    if (
      attempt &&
      required(attempt.recovery, "the recovery round's state").sourceEntryId !== entry.id
    )
      return waiting('recovery-round', 'A recovery round for this work item is in progress.', {
        entryId: required(attempt.recovery, "the recovery round's state").sourceEntryId,
        cycleId: attempt.cycleId,
      });
    if (!attempt) {
      if (sourceCycle.status !== 'needs-attention' || !roadmap.scopeRecovery?.enabled) return;
      const decision = scopeRecoveryDecision(
        mapReadSnapshot(this.storage),
        roadmap,
        entry,
        sourceCycle,
      );
      if (decision.waiting)
        return waiting(
          'review-running',
          'An independent review of this work item is still running; recovery starts after it.',
          { cycleId: sourceCycle.id },
        );
      if (!decision.owner) {
        if (decision.escalation)
          throw new EntryHoldError(
            'recovery-not-converging',
            required(decision.reason, "the escalation's reason"),
          );
        // One fact, one stop (R-C10's follow-up, decision 1): the review's own stop carries a
        // round recovery declined; the entry waits on it with the reason, and recovery asks again
        // on the next pass, so the round starts once the reason clears. A stop the controller
        // claims has no item to carry it, so the decline holds the entry for the operator.
        const reason = required(decision.reason, 'why no recovery round starts');
        const waited = cycleWait(sourceCycle, reason, entry.id);
        if (waited) return waited;
        conflict(reason);
      }
      const ownerAttempt = roadmap.attempts.find(
        (a) => a.entryId === required(decision.owner, 'the owning slice').id && !a.recovery,
      );
      if (!ownerAttempt) conflict('The owning slice has no roadmap-bound implementation settings.');
      const blocked = this.selection.blocker(
        roadmap,
        decision.owner,
        undefined,
        this.storage,
        true,
      );
      if (blocked) {
        if (blocked.circular)
          throw gated(new EntryHoldError('entry-blocked', blocked.reason), decision.owner.id);
        if (blocked.needsAttention) refuseBlocked(blocked, decision.owner.id);
        return blockerWait(blocked, decision.owner.id);
      }
      attempt = {
        id: asRoadmapAttemptId(randomUUID()),
        entryId: decision.owner.id,
        definitionRevision: ownerAttempt.definitionRevision,
        worktreeId: asWorktreeId(randomUUID()),
        cycleId: asWorkCycleId(randomUUID()),
        status: 'preparing',
        createdAt: this.state.now().toISOString(),
        recovery: {
          sourceEntryId: entry.id,
          sourceRunId: sourceCycle.currentRunId,
          sourceSequence: required(decision.sourceSequence, "the source review's turn"),
          findingFingerprint: required(decision.fingerprint, "the findings' fingerprint"),
          phase: 'repair',
          reviewRunIds: this.selection.reviewRunIds(roadmap, entry),
        },
      };
      roadmap = this.writer.change(
        roadmap,
        { attempts: [...roadmap.attempts, attempt] },
        'reserve-scope-recovery',
      );
    }
    const reserved = attempt;
    const owner = required(
      roadmap.definition.entries.find((e) => e.id === reserved.entryId),
      "the recovery round's owning entry",
    );
    const check = () => {
      const current = this.writer.find(ws, roadmap.id);
      if (
        current.status !== 'running' ||
        !current.attempts.some((a) => a.id === reserved.id && roadmapCarriesRound(current, a)) ||
        this.state.controlling.has(current.id) ||
        this.state.abort.signal.aborted ||
        current.entryHolds?.[entry.id] ||
        current.entryHolds?.[owner.id] ||
        !current.attempts.some((a) => a.id === reserved.id && a.recovery?.phase !== 'completed')
      )
        throw new SupersededRoadmapOperation();
      this.writer.authority(current);
      if (
        bindingIssues(
          this.storage,
          ws,
          required(owner.executionScope, "the owning slice's scope").definitionId,
          required(owner.executionScope, "the owning slice's scope").bindingRevision,
        ).length
      )
        conflict('The recovery map binding changed. Reconcile the roadmap before continuing.');
    };
    check();
    const context = this.writer.authority(roadmap);
    if (required(reserved.recovery, "the recovery round's state").phase === 'repair') {
      const tree = this.storage.execution.worktrees.find(ws, reserved.worktreeId);
      if (tree?.mergedAt) {
        this.writer.updateRecovery(roadmap, reserved, {
          status: 'completed',
          completedAt: tree.mergedAt,
          recovery: {
            ...required(reserved.recovery, "the recovery round's state"),
            phase: 'verification',
          },
        });
        return MOVED;
      }
      // The operator's command prepares its own round; a failed one is retried from there. One
      // that no request is preparing (it failed, or the daemon stopped) waits on the operator.
      if (
        reserved.status === 'preparing' &&
        required(reserved.recovery, "the recovery round's state").requestedByUserId
      ) {
        if (this.state.preparingRounds.has(reserved.id)) return MOVED;
        conflict(
          'Delegating source fixes did not finish. Repeat Delegate source fixes on the stopped review to continue this repair.',
        );
      }
      if (reserved.status === 'preparing') {
        const sourceTurn = this.storage.execution.runEvents.latestOfKind(
          ws,
          sourceCycle.currentRunId,
          'turn-completed',
        );
        if (
          sourceCycle.currentRunId !==
            required(reserved.recovery, "the recovery round's state").sourceRunId ||
          sourceTurn?.sequence !==
            required(reserved.recovery, "the recovery round's state").sourceSequence
        )
          conflict(
            'The source review changed during recovery preparation. Inspect the reserved attempt.',
          );
        const blocked = this.selection.blocker(roadmap, owner, reserved, this.storage, true);
        if (blocked) {
          if (blocked.circular)
            throw gated(new EntryHoldError('entry-blocked', blocked.reason), owner.id);
          if (blocked.needsAttention) refuseBlocked(blocked, owner.id);
          return blockerWait(blocked, owner.id);
        }
        const preview = collectScopeRepair(mapReadSnapshot(this.storage), sourceCycle);
        const frozen = attemptDefinition(this.storage, roadmap, reserved)?.entries.find(
          (e) => e.id === owner.id,
        );
        if (!frozen) conflict('Recovery settings are unavailable.');
        // The owner slice's own gates (its start phase, its predecessors' merges) refuse inside
        // the delegation: they are the owner's (increment 2 review M-1).
        await this.cycles
          .delegateScopeRepair(
            context,
            ws,
            sourceCycle.id,
            {
              expectedVersion: sourceCycle.version,
              snapshotDigest: preview.snapshotDigest,
              sourceId: required(owner.executionScope, "the owning slice's scope").sourceId,
              maxRemediationRounds: frozen.policy.maxRemediationRounds,
              instructions: frozen.instructions,
            },
            {
              worktreeId: reserved.worktreeId,
              cycleId: reserved.cycleId,
              owner: ownerOf(roadmap, reserved),
              profiles: frozen.profiles,
              policy: frozen.policy,
              actor: {
                check: () => {
                  check();
                  const blocker = this.selection.blocker(
                    this.writer.find(ws, roadmap.id),
                    owner,
                    reserved,
                    this.storage,
                    true,
                  );
                  if (blocker) refuseBlocked(blocker, owner.id);
                },
                attach: () =>
                  this.writer.updateRecovery(this.writer.find(ws, roadmap.id), reserved, {
                    status: 'active',
                  }),
              },
            },
          )
          .catch((error: unknown) => {
            throw gated(error, owner.id);
          });
        return MOVED;
      }
      const repair = this.storage.execution.cycles.find(ws, reserved.cycleId);
      if (!repair) conflict('The reserved recovery cycle is unavailable.');
      if (!repair.integrationResolution) {
        // A repair that stopped ends the round's work: the operator decides how it goes on.
        if (repair.status === 'stopped')
          conflict(`Owning-slice recovery needs your input: ${repair.reason}`);
        // One fact, one stop (decision 1): the repair's own stop, or its pause, carries it.
        if (repair.status === 'needs-attention' || repair.status === 'paused')
          return cycleStep(repair);
      }
      return roundStep(
        await this.advanceEntry(roadmap, owner, reserved),
        'Roadmap recovery: owning-slice repair and integration.',
        { entryId: owner.id, cycleId: repair.id },
      );
    }
    const reviews = roadmap.definition.entries.filter(
      (e) =>
        e.workItemId === entry.workItemId && e.executionScope && e.executionScope.kind !== 'slice',
    );
    const verification = reviews.filter(
      (e) => required(e.executionScope, "the review entry's scope").kind === 'slice-verification',
    );
    const phase = verification.every((e) => this.selection.complete(roadmap, e, this.storage, true))
      ? 'parent-review'
      : 'verification';
    if (phase !== required(reserved.recovery, "the recovery round's state").phase) {
      this.writer.updateRecovery(roadmap, reserved, {
        recovery: { ...required(reserved.recovery, "the recovery round's state"), phase },
      });
      return MOVED;
    }
    const target = (
      phase === 'verification'
        ? verification
        : reviews.filter(
            (e) =>
              required(e.executionScope, "the review entry's scope").kind === 'parent-acceptance',
          )
    ).find((e) => !this.selection.complete(roadmap, e, this.storage, true));
    if (!target) {
      this.writer.updateRecovery(roadmap, reserved, {
        recovery: {
          ...required(reserved.recovery, "the recovery round's state"),
          phase: 'completed',
        },
      });
      return MOVED;
    }
    const next =
      phase === 'verification'
        ? 'Roadmap recovery: fresh independent verification.'
        : 'Roadmap recovery: parent acceptance.';
    if (roadmap.entryHolds?.[target.id])
      return waiting('entry-held', `${next} ${target.sourceId} is held.`, { entryId: target.id });
    const reviewAttempt = roadmap.attempts.find((a) => a.entryId === target.id && !a.recovery);
    const cycle = reviewAttempt && this.storage.execution.cycles.find(ws, reviewAttempt.cycleId);
    if (!cycle)
      return roundStep(await this.advanceEntry(roadmap, target, undefined, true), next, {
        entryId: target.id,
      });
    const blockers = scopePhaseBlockers(
      this.storage,
      ws,
      target.workItemId,
      required(target.executionScope, "the review entry's scope"),
      phase === 'verification' ? 'verify' : 'accept',
      { ownerId: cycle.currentRunId },
    );
    if (blockers.length) throw gated(new PhaseGateError(blockers), target.id);
    const prior = required(reserved.recovery, "the recovery round's state").reviewRunIds[target.id];
    if (
      cycle.status === 'completed' ||
      (cycle.currentRunId === prior && ['needs-attention', 'paused'].includes(cycle.status))
    ) {
      const restarts =
        required(reserved.recovery, "the recovery round's state").reviewRestarts?.[target.id] ?? 0;
      const settings =
        attemptDefinition(this.storage, roadmap, required(reviewAttempt, "the review's attempt"))
          ?.scheduling ?? DEFAULT_ROADMAP_SCHEDULING;
      if (restarts >= settings.maxIntegrationRefreshes)
        conflict(
          'Recovery review refresh allowance exhausted. Inspect and refresh this scope manually before resuming.',
        );
      const attach = () => {
        const current = this.writer.find(ws, roadmap.id);
        const round = required(
          current.attempts.find((a) => a.id === reserved.id),
          'the recovery round',
        );
        this.writer.change(current, {
          attempts: current.attempts.map((a) =>
            a.id === required(reviewAttempt, "the review's attempt").id
              ? { ...a, status: 'active', completedAt: undefined }
              : a.id === reserved.id
                ? {
                    ...a,
                    recovery: {
                      ...required(round.recovery, "the recovery round's state"),
                      reviewRestarts: {
                        ...required(round.recovery, "the recovery round's state").reviewRestarts,
                        [target.id]: restarts + 1,
                      },
                    },
                  }
                : a,
          ),
        });
      };
      // The target review's own gates refuse its restart: they are the target's (review M-1).
      await (cycle.status === 'completed'
        ? this.cycles.repeatScopeReview(context, ws, cycle.id, cycle.version, '', { check, attach })
        : this.cycles.control(context, ws, cycle.id, 'resume', cycle.version, undefined, {
            check,
            attach,
          })
      ).catch((error: unknown) => {
        throw gated(error, target.id);
      });
      return MOVED;
    }
    if (['needs-attention', 'paused', 'stopped'].includes(cycle.status)) {
      // This round reached an independent verdict. Any further repair consumes a new round.
      this.writer.updateRecovery(roadmap, reserved, {
        recovery: {
          ...required(reserved.recovery, "the recovery round's state"),
          phase: 'completed',
        },
      });
      return MOVED;
    }
    return roundStep(await this.advanceEntry(roadmap, target, undefined, true), next, {
      entryId: target.id,
      cycleId: cycle.id,
    });
  }
}
