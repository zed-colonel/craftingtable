/**
 * What a stored hold or stop waits on, and its release (R-B7; R-C10's follow-up, decision 2): the
 * typed fact asked again, the scheduler's own re-verification under its grant, a stop's resume
 * once its fact cleared; and what Start and Resume ask (`assertRunnable`, `resumable`, the one
 * resume rule, operator decision 1 A).
 */
import type { RoadmapWriter } from './writer.js';
import type { RoadmapState } from './state.js';
import { ended, releaseRecord, RESUMED_REASON, conflict } from './shared.js';
import { investigationHolds } from '../investigation.js';
import { retiredOrRetiring } from '../retired-versions.js';
import { attemptDefinition } from '../roadmap-delegation-policy.js';
import { activeEditor } from '../authority-policy.js';
import {
  required,
  resumeRedirect,
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapEntry,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { crossProjectState, evidenceChangedAt, evidenceStaleness } from '../map-state.js';
import {
  cycleCarriesOn,
  gatePhase,
  holdCheck,
  phaseGateClears,
  type ReleaseCheck,
  REVERIFY_SETTLE_MS,
  roadmapHeld,
  selfReverification,
  stopCheck,
} from '../entry-holds.js';
import { windDownRefused } from '../errors.js';
import {
  resolveScope,
  scopePhaseBlockers,
  unsupportedScopeCapabilities,
} from '../execution-scope.js';
import type { ExecutionService } from '../execution-service.js';
import { mapReadSnapshot } from '../map-read-snapshot.js';
import { planCheckpoint } from '../plan-acceptance-policy.js';
import { acceptedEvidence } from '../runtime-evidence-policy.js';
import type { WorkCycleService } from '../work-cycle-service.js';
import { unsettledDecisionsAt } from '../workflow-policy.js';
import type { RoadmapSelection } from './selection.js';

export class RoadmapHolds {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
    private readonly selection: RoadmapSelection,
  ) {}

  /**
   * Releases a stored hold whose typed fact cleared (R-C10's follow-up, decision 2): one write,
   * audited as the system's with what it released and why, after which the hold's item resolves.
   */
  async releaseHold(roadmap: Roadmap, entry: RoadmapEntry): Promise<Roadmap | undefined> {
    const hold = roadmap.entryHolds?.[entry.id];
    const check = hold && holdCheck(entry.id, hold);
    if (!hold?.attention || !check || !(await this.releasable(roadmap, entry, check))) return;
    const current = this.writer.find(roadmap.workspaceId, roadmap.id);
    if (current.version !== roadmap.version || current.status !== 'running') return;
    const { [entry.id]: _released, ...entryHolds } = current.entryHolds ?? {};
    if (check.fact !== 'reverify')
      return this.writer.change(
        current,
        { entryHolds },
        'release-hold',
        undefined,
        releaseRecord(entry.id, hold.attention, check),
      );
    // Stale evidence the scheduler re-verifies itself, in place, as Re-verify would (decision 4):
    // the queued review names the grantor as its requester; the audit's system actor tells it
    // apart from the operator's own Re-verify.
    const queued = this.selfReverify(current, entry);
    if (!queued) return;
    return this.writer.change(
      current,
      {
        entryHolds,
        attempts: current.attempts.map((a) =>
          a.id === queued.attempt.id
            ? {
                ...a,
                reverification: {
                  requestedAt: this.state.now().toISOString(),
                  requestedByUserId: queued.requestedByUserId,
                  sourceRunId: queued.sourceRunId,
                },
              }
            : a,
        ),
      },
      'reverify-entry',
      undefined,
      // The audit names the grantor the review is queued for (increment 5 review NIT-4).
      {
        ...releaseRecord(entry.id, hold.attention, check),
        requestedByUserId: queued.requestedByUserId,
      },
    );
  }

  /** The in-place re-verification the scheduler makes itself, if decision 4's facts all hold. */
  private selfReverify(roadmap: Roadmap, entry: RoadmapEntry) {
    const scope = entry.executionScope;
    const grant = roadmap.reverificationGrant;
    if (!scope || !grant) return undefined;
    const plan = this.selection.reverification(roadmap, entry);
    const inPlace = 'refused' in plan ? undefined : plan.inPlace ? plan : undefined;
    const definition = inPlace && attemptDefinition(this.storage, roadmap, inPlace.attempt);
    const { reasons, receipt } = evidenceStaleness(
      this.storage,
      roadmap.workspaceId,
      scope,
      entry.workItemId,
    );
    const changedAt = evidenceChangedAt(this.storage, roadmap.workspaceId, scope, entry.workItemId);
    const verdict = selfReverification({
      // The review names its grantor as requester, so they must still be able to request it,
      // as a standing preparation's grantor must (R-C3b).
      granted:
        grant.enabled && !!activeEditor(this.storage, grant.grantedByUserId, roadmap.workspaceId),
      inPlace: !!inPlace,
      // The roadmap verifies the entry itself: a slice verification, or a parent acceptance
      // under automatic acceptance.
      automatic:
        scope.kind === 'slice-verification' ||
        (scope.kind === 'parent-acceptance' &&
          definition?.crossProject?.parentAcceptance === 'automatic'),
      reasons,
      receiptRunId: receipt?.reviewRunId,
      sourceRunId: inPlace?.sourceRunId,
      reverifiedRunId: inPlace?.attempt.reverification?.sourceRunId,
      changedAt,
      now: this.state.now(),
    });
    // Approvals still settling: the roadmap is looked at again once they have (R-B5 part 2).
    if (verdict === 'settling' && changedAt !== undefined)
      this.state.lookAgain(roadmap.id, Date.parse(changedAt) + REVERIFY_SETTLE_MS);
    return verdict === 'reverifies' && inPlace
      ? {
          attempt: inPlace.attempt,
          sourceRunId: inPlace.sourceRunId,
          requestedByUserId: grant.grantedByUserId,
        }
      : undefined;
  }

  /**
   * Resumes a roadmap stopped for a typed fact that cleared (a sequential stop on its entry,
   * decision 2), asking first what the operator's Resume asks: if anything refuses, the stop
   * stays the operator's. The delegator stays the one it has; the reason is a Resume's.
   */
  async resumeCleared(roadmap: Roadmap): Promise<void> {
    if (roadmap.status !== 'needs-attention' || !roadmap.attention) return;
    const check = stopCheck(roadmap.attention);
    const entry = check && roadmap.definition.entries.find((e) => e.id === check.entryId);
    if (!check || !entry || !(await this.releasable(roadmap, entry, check))) return;
    try {
      this.assertRunnable(roadmap.workspaceId, roadmap, 'resume');
    } catch {
      return;
    }
    const current = this.writer.find(roadmap.workspaceId, roadmap.id);
    if (current.version !== roadmap.version) return;
    this.writer.change(
      current,
      { status: 'running', reason: RESUMED_REASON },
      'resume-cleared',
      undefined,
      releaseRecord(entry.id, roadmap.attention, check),
    );
  }

  /**
   * Decision 2's guards, then the fact, then the guards again: a fact read can wait on Git, and a
   * command that has not written yet (a Stop's start, a Resume awaiting its cycle) leaves the
   * roadmap's version alone, so the version check alone would miss it (increment 4 review LOW-1).
   * A read that fails keeps the hold.
   */
  private async releasable(roadmap: Roadmap, entry: RoadmapEntry, check: ReleaseCheck): Promise<boolean> {
    if (!this.releaseGuarded(roadmap, entry)) return false;
    try {
      if (!(await this.cleared(roadmap, check))) return false;
    } catch {
      return false;
    }
    return this.releaseGuarded(this.writer.find(roadmap.workspaceId, roadmap.id), entry);
  }

  /**
   * Never while something holds the whole roadmap (it ended, a wind-down settles it, an amendment
   * awaits, the entry's plan version is retired or being retired), while a roadmap command runs or
   * admissions are held, or once the delegating user lost their authority.
   */
  private releaseGuarded(roadmap: Roadmap, entry: RoadmapEntry): boolean {
    if (
      roadmapHeld(this.storage, roadmap, entry) ||
      this.state.controlling.has(roadmap.id) ||
      this.state.admissionsHeld ||
      this.state.abort.signal.aborted
    )
      return false;
    try {
      this.writer.authority(roadmap);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the typed fact a stored hold or stop waits on has cleared: the same gate the pass
   * refused with, asked again of the entry it names.
   */
  async cleared(roadmap: Roadmap, check: ReleaseCheck): Promise<boolean> {
    const entry = roadmap.definition.entries.find((e) => e.id === check.entryId);
    if (!entry) return false;
    const ws = roadmap.workspaceId;
    // A round's owner is asked with the round's attempt; any other entry with its own. A review
    // entry is never a round's owner (a round's target review is gated with its own id), so it is
    // asked with its own attempt (increment 4 review NIT-1).
    const asRound =
      check.asRound && (!entry.executionScope || entry.executionScope.kind === 'slice');
    const attempt = roadmap.attempts.find((a) =>
      asRound
        ? a.entryId === entry.id && a.recovery !== undefined && a.recovery.phase !== 'completed'
        : a.entryId === entry.id && !a.recovery,
    );
    switch (check.fact) {
      case 'blocker': {
        const blocked = this.selection.blocker(roadmap, entry, attempt, this.storage, asRound);
        return !blocked?.needsAttention && !blocked?.circular;
      }
      case 'phase-gate': {
        const scope = entry.executionScope;
        if (!scope) return false;
        const cycle = attempt && this.storage.execution.cycles.find(ws, attempt.cycleId);
        return phaseGateClears(
          scopePhaseBlockers(
            this.storage,
            ws,
            entry.workItemId,
            scope,
            gatePhase(scope, !!cycle),
            cycle && scope.kind !== 'slice' ? { ownerId: cycle.currentRunId } : {},
          ),
        );
      }
      // A required predecessor that is not complete counts as no missing merge here, as at an
      // attempt; the merge's phase gate waits on it first, so nothing loops (review NIT-2).
      case 'predecessor-merge':
        return !(await this.execution.branches.missingPredecessorMerge(
          ws,
          entry.workItemId,
          entry.repositoryId,
          entry.integrationBranch,
          entry.executionScope,
        ));
      case 'cycle': {
        const cycle = check.cycleId
          ? this.storage.execution.cycles.find(ws, check.cycleId)
          : undefined;
        return cycleCarriesOn(cycle?.status, this.selection.complete(roadmap, entry));
      }
      // Stale evidence the scheduler re-verifies itself, under the roadmap's grant (decision 4).
      case 'reverify':
        return this.selfReverify(roadmap, entry) !== undefined;
    }
  }

  /**
   * What Start and Resume ask before the roadmap runs again; the scheduler's own resume of a
   * stop whose fact cleared asks the same (R-C10's follow-up, decision 2).
   */
  assertRunnable(workspaceId: WorkspaceId, roadmap: Roadmap, action: 'start' | 'resume'): void {
    if (ended(roadmap)) conflict('This roadmap has ended.');
    if (this.storage.windDowns.find(workspaceId, roadmap.id)?.status === 'settling')
      windDownRefused('wind-down-in-progress', 'This roadmap is being stopped.');
    if (this.storage.amendments.list(workspaceId).some((a) => !a.decision))
      conflict('Apply or reject the pending planning amendment before resuming.');
    if (
      action === 'start'
        ? roadmap.status !== 'draft'
        : !['paused', 'needs-attention'].includes(roadmap.status)
    )
      conflict('Only a draft can start; only a paused roadmap can resume.');
    if (
      this.storage.roadmaps
        .list(workspaceId)
        .some((r) => r.id !== roadmap.id && r.status !== 'draft' && !ended(r))
    )
      conflict('This workspace already has a delegated roadmap. Stop or finish it first.');
    // A draft saved before its version was retired cannot run it (R-B11).
    const retiredEntry = roadmap.definition.entries.find((e) =>
      retiredOrRetiring(this.storage, workspaceId, e.planVersionId),
    );
    if (retiredEntry)
      windDownRefused(
        'plan-version-retired',
        `${retiredEntry.sourceId} belongs to a plan version that is retired or being retired. Edit the roadmap's entries first.`,
      );
    if (roadmap.definition.crossProject) {
      const preview = crossProjectState(this.storage, workspaceId, roadmap.definition.crossProject);
      if (preview.blockers.length) conflict(preview.blockers.join(' '));
      const definition = this.storage.imports.definition(
        workspaceId,
        roadmap.definition.crossProject.definitionId,
      );
      const checkpoint = definition && planCheckpoint(definition);
      const plan = checkpoint
        ? acceptedEvidence(
            this.storage,
            workspaceId,
            roadmap.definition.crossProject.definitionId,
            roadmap.definition.crossProject.bindingRevision,
            { kind: 'checkpoint', sourceId: checkpoint },
          )
        : undefined;
      if (plan?.generatedPlan && plan.generatedPlan.roadmapId !== roadmap.id)
        conflict(
          'Generate and review plan-acceptance evidence for this saved roadmap before Start or Resume.',
        );
    }
    {
      const snapshot = mapReadSnapshot(this.storage);
      for (const entry of roadmap.definition.entries) {
        if (!entry.executionScope) continue;
        const unsupported = unsupportedScopeCapabilities(
          resolveScope(snapshot, workspaceId, entry.workItemId, entry.executionScope),
          snapshot,
        );
        if (unsupported.length)
          conflict(`This map scope cannot start yet: ${unsupported.join(' ')}`);
      }
    }
  }

  /**
   * A stop that a plain resume would only reproduce keeps its attention when the roadmap
   * or its item resumes; the operator resolves it with the control it names (R-A7).
   */
  private resumable(cycle: WorkCycle): boolean {
    // A stop's investigation holds it until it ends, and a worktree change it found until the
    // operator acknowledges it (R-C16).
    if (investigationHolds(cycle)) return false;
    // Unsettled shared decisions hold the stop, paused or not; resuming would review into it
    // again (LIVE-18). A report with open questions waits for guidance, not a resume.
    if (
      unsettledDecisionsAt(this.storage, cycle).length ||
      (['paused', 'needs-attention'].includes(cycle.status) &&
        this.cycles.resumeNeedsGuidance(cycle))
    )
      return false;
    return (
      cycle.status !== 'needs-attention' ||
      resumeRedirect(
        cycle,
        this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId)[0]?.id,
      ) === undefined
    );
  }

  /**
   * Whether a Resume resumes this attempt's stopped cycle: one rule for the roadmap's Resume and
   * an item's (R-B7, CTRL-12; decision 1 A). Not a queued review (the scheduler runs it), not a
   * stop recovery owns (a repair round, not another review of unchanged source, answers it), not
   * a stop `resumable` keeps, and not a cycle whose worktree merged or whose merge is reserved
   * (the scheduler, or the operator's merge recovery, finishes those).
   */
  resumesCycle(
    roadmap: Roadmap,
    entry: RoadmapEntry | undefined,
    attempt: RoadmapAttempt,
    cycle: WorkCycle | undefined,
  ): cycle is WorkCycle {
    if (attempt.dependencyRefresh || attempt.reverification || !cycle) return false;
    if (
      cycle.executionScope &&
      cycle.executionScope.kind !== 'slice' &&
      ((roadmap.scopeRecovery?.enabled && cycle.status === 'needs-attention') ||
        !!this.selection.roundFor(roadmap, required(entry, "the resumed review's entry")))
    )
      return false;
    if (!['paused', 'needs-attention'].includes(cycle.status) || !this.resumable(cycle))
      return false;
    const worktree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    return (
      !worktree?.mergedAt &&
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status !==
        'reserved'
    );
  }
}
