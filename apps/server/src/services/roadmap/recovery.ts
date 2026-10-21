/**
 * The roadmap's recovery rounds the operator asks for or the pass adopts (R-C5; R-B7): Delegate
 * source fixes on a review the roadmap owns, and repairs delegated by hand before they kept their
 * roadmap, adopted as operator-requested rounds.
 */
import type { RoadmapSelection } from './selection.js';
import type { RoadmapWriter } from './writer.js';
import type { RoadmapState } from './state.js';
import { ended, holdCause, answeredHolds, conflict } from './shared.js';
import { cycleOwnership, ownerOf } from '../cycle-ownership.js';
import { attemptDefinition } from '../roadmap-delegation-policy.js';
import { randomUUID } from 'node:crypto';
import type { ScopeRepairRequest } from '@craftingtable/contracts';
import {
  asAgentRunId,
  asRoadmapAttemptId,
  asWorkCycleId,
  asWorktreeId,
  type Roadmap,
  type RoadmapAttempt,
  roadmapAttention,
  sameExecutionScope,
  type WorkCycle,
  type WorkspaceId,
  type WorkCycleId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from '../auth-service.js';
import { RepositoryMutationBusyError } from '../branch-service.js';
import { ConcurrentModificationError, ExecutionRequestError } from '../errors.js';
import { mapReadSnapshot } from '../map-read-snapshot.js';
import { findingFingerprint } from '../scope-recovery-policy.js';
import { collectScopeRepair } from '../scope-repair.js';
import type { WorkCycleService } from '../work-cycle-service.js';
import type { WorkspaceService } from '../workspace-service.js';
import { WorktreeMutationBusyError } from '../worktree-mutation-guard.js';

export class RoadmapRecoveryRounds {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly cycles: WorkCycleService,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
    private readonly selection: RoadmapSelection,
  ) {}

  /**
   * Delegates source fixes the operator chose from an independent review. When a live roadmap
   * owns that review and the owning slice, the repair is an operator-requested recovery round
   * of the roadmap: it keeps the roadmap's reviewer delegation, holds and merge policy, and
   * the roadmap re-runs verification and parent review afterwards. Otherwise the repair is
   * the operator's own cycle.
   */
  async delegateScopeRepair(
    context: AuthContext,
    ws: WorkspaceId,
    cycleId: WorkCycleId,
    input: ScopeRepairRequest,
  ): Promise<WorkCycle> {
    const source = this.storage.execution.cycles.find(ws, cycleId);
    const owned = source && cycleOwnership(this.storage, source);
    let roadmap = owned?.roadmap;
    const sourceEntry = roadmap?.definition.entries.find((e) => e.id === owned!.attempt.entryId);
    const owner = roadmap?.definition.entries.find(
      (e) =>
        e.workItemId === source!.workItemId &&
        e.executionScope?.kind === 'slice' &&
        e.executionScope.sourceId === input.sourceId,
    );
    if (!roadmap || ended(roadmap) || roadmap.status === 'draft' || !sourceEntry || !owner)
      return this.cycles.delegateScopeRepair(context, ws, cycleId, input);
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const ownerAttempt = roadmap.attempts.find((a) => a.entryId === owner.id && !a.recovery);
    if (!ownerAttempt)
      conflict('The owning slice has not run in this roadmap yet. Start it from the roadmap.');
    const frozen = attemptDefinition(this.storage, roadmap, ownerAttempt)?.entries.find(
      (e) => e.id === owner.id,
    );
    if (!frozen) conflict('The owning slice’s roadmap settings are unavailable.');
    const open = this.selection.recoveryFor(roadmap, sourceEntry);
    // A round this command prepared earlier and that created nothing is retried in place.
    const retry =
      open?.status === 'preparing' &&
      open.recovery!.requestedByUserId &&
      !this.state.preparingRounds.has(open.id) &&
      open.entryId === owner.id &&
      !this.storage.execution.cycles.find(ws, open.cycleId)
        ? open
        : undefined;
    if (open && !retry)
      conflict('A recovery round for this work item is already open. Continue it from its cycle.');
    let reserved = retry;
    if (!reserved) {
      const turn = this.storage.execution.runEvents.latestOfKind(
        ws,
        source!.currentRunId,
        'turn-completed',
      );
      const report = turn?.kind === 'turn-completed' ? turn.payload.reviewReport : undefined;
      if (!turn || report?.status !== 'complete')
        conflict('Source fixes need the review’s complete report.');
      // The owning slice's existing worktree, if any, is where the repair continues.
      const existing = collectScopeRepair(mapReadSnapshot(this.storage), source!).candidates.find(
        (c) => c.scope.sourceId === input.sourceId,
      )?.worktreeId;
      reserved = {
        id: asRoadmapAttemptId(randomUUID()),
        entryId: owner.id,
        definitionRevision: ownerAttempt.definitionRevision,
        worktreeId: existing ?? asWorktreeId(randomUUID()),
        cycleId: asWorkCycleId(randomUUID()),
        status: 'preparing',
        createdAt: this.state.now().toISOString(),
        recovery: {
          sourceEntryId: sourceEntry.id,
          sourceRunId: source!.currentRunId,
          sourceSequence: turn.sequence,
          findingFingerprint: findingFingerprint(report.report.findings),
          phase: 'repair',
          reviewRunIds: this.selection.reviewRunIds(roadmap, sourceEntry),
          requestedByUserId: context.user.id,
        },
      };
      roadmap = this.writer.change(
        roadmap,
        { attempts: [...roadmap.attempts, reserved] },
        'reserve-scope-recovery',
        context,
      );
    }
    const round = reserved;
    const id = roadmap.id;
    // No other request may take this reservation over, or remove it, while this one prepares it.
    this.state.preparingRounds.add(round.id);
    try {
      return await this.cycles.delegateScopeRepair(
        context,
        ws,
        cycleId,
        {
          ...input,
          instructions: [frozen.instructions, input.instructions]
            .map((text) => text.trim())
            .filter(Boolean)
            .join('\n\n'),
        },
        {
          worktreeId: round.worktreeId,
          cycleId: round.cycleId,
          owner: ownerOf(roadmap, round),
          profiles: frozen.profiles,
          policy: { ...frozen.policy, maxRemediationRounds: input.maxRemediationRounds },
          check: () => {
            const current = this.writer.find(ws, id);
            if (
              ended(current) ||
              !current.attempts.some((a) => a.id === round.id && a.status === 'preparing')
            )
              conflict('The roadmap changed while this repair was being prepared. Refresh.');
          },
          // The stop is answered once the repair exists, in the transaction that creates it;
          // a refused request leaves it as it was.
          attach: () => {
            const current = this.writer.find(ws, id);
            this.writer.change(current, {
              attempts: current.attempts.map((a) =>
                a.id === round.id ? { ...a, status: 'active' } : a,
              ),
              entryHolds: answeredHolds(current, sourceEntry.id),
            });
          },
        },
      );
    } catch (error) {
      // Nothing was created: release the reservation so it does not hold the work item.
      const current = this.writer.find(ws, id);
      if (
        !this.storage.execution.worktrees.find(ws, round.worktreeId) &&
        !this.storage.execution.cycles.find(ws, round.cycleId) &&
        current.attempts.some((a) => a.id === round.id && a.status === 'preparing')
      )
        this.writer.change(current, {
          attempts: current.attempts.filter((a) => a.id !== round.id),
        });
      throw error;
    } finally {
      this.state.preparingRounds.delete(round.id);
      // The scheduler's look that turns a failed preparation into its hold (R-B5 part 2).
      this.state.kernel.mark('release', [id]);
    }
  }

  /**
   * Repairs delegated from a roadmap's review before they kept their roadmap (2026-09-26) are
   * adopted as operator-requested rounds while they are still open, so they get the roadmap's
   * reviewer delegation and the roadmap finishes them.
   */
  adoptManualRepairs(roadmap: Roadmap): Roadmap {
    const ws = roadmap.workspaceId;
    for (const cycle of this.storage.execution.cycles.listActive()) {
      if (
        cycle.workspaceId !== ws ||
        cycle.owner !== null ||
        !cycle.scopeRepair ||
        cycle.executionScope?.kind !== 'slice' ||
        this.cycles.isTransitioning(cycle.id)
      ) {
        if (cycle.workspaceId === ws && this.cycles.isTransitioning(cycle.id))
          this.state.waitOnLock(roadmap.id, `cycle:${cycle.id}`);
        continue;
      }
      const source = this.storage.execution.cycles.find(ws, cycle.scopeRepair.sourceCycleId);
      const owned = source && cycleOwnership(this.storage, source);
      if (owned?.roadmap.id !== roadmap.id) continue;
      const sourceEntry = roadmap.definition.entries.find((e) => e.id === owned.attempt.entryId);
      const owner = roadmap.definition.entries.find(
        (e) =>
          e.workItemId === cycle.workItemId &&
          sameExecutionScope(e.executionScope, cycle.executionScope),
      );
      const ownerAttempt =
        owner && roadmap.attempts.find((a) => a.entryId === owner.id && !a.recovery);
      if (
        !sourceEntry ||
        !owner ||
        !ownerAttempt ||
        this.selection.recoveryFor(roadmap, sourceEntry)
      )
        continue;
      // A roadmap's cycles are held to their repository's adopted checks, and fail closed without
      // them (R-G13 increment 4, D2). A repair delegated by hand was not: with no adoption, or a
      // run prepared with no record, its merge would rest on the review alone. It stays the
      // operator's (independent review L1).
      const tree = this.storage.execution.worktrees.find(ws, cycle.worktreeId);
      if (
        !tree ||
        !this.storage.runtimeEvidence.checkDeclarations(ws, tree.repositoryId).length ||
        this.storage.execution.runs
          .listForWorktree(ws, cycle.worktreeId)
          .some((run) => !this.storage.runtimeEvidence.run(ws, run.id))
      )
        continue;
      // The pinned source the repair was delegated from: the review in the source worktree.
      const pinned =
        cycle.scopeRepair.sources.find(
          (s) =>
            this.storage.execution.runs.find(ws, asAgentRunId(s.runId))?.worktreeId ===
            source!.worktreeId,
        ) ?? cycle.scopeRepair.sources[0];
      if (!pinned) continue;
      const turn = this.storage.execution.runEvents.latestOfKind(
        ws,
        asAgentRunId(pinned.runId),
        'turn-completed',
      );
      const report = turn?.kind === 'turn-completed' ? turn.payload.reviewReport : undefined;
      const round: RoadmapAttempt = {
        id: asRoadmapAttemptId(randomUUID()),
        entryId: owner.id,
        definitionRevision: ownerAttempt.definitionRevision,
        worktreeId: cycle.worktreeId,
        cycleId: cycle.id,
        status: 'active',
        createdAt: this.state.now().toISOString(),
        recovery: {
          sourceEntryId: sourceEntry.id,
          sourceRunId: asAgentRunId(pinned.runId),
          sourceSequence: pinned.sequence,
          findingFingerprint: findingFingerprint(
            report?.status === 'complete' ? report.report.findings : [],
          ),
          phase: 'repair',
          reviewRunIds: this.selection.reviewRunIds(roadmap, sourceEntry),
          requestedByUserId: cycle.createdByUserId,
        },
      };
      const adopted = roadmap;
      try {
        roadmap = this.storage.transaction(() => {
          const next = this.writer.change(
            adopted,
            {
              attempts: [...adopted.attempts, round],
              entryHolds: answeredHolds(adopted, sourceEntry.id),
            },
            'adopt-scope-repair',
          );
          this.cycles.adoptRoadmapRound(cycle, ownerOf(next, round));
          return next;
        });
      } catch (error) {
        // A lost race is retried on the next pass. Any other failure leaves the repair the
        // operator's own cycle, and the review it came from says so (R-C12), instead of the
        // failure passing silently or stopping the whole roadmap.
        if (
          error instanceof ConcurrentModificationError ||
          error instanceof RepositoryMutationBusyError ||
          error instanceof WorktreeMutationBusyError
        )
          continue;
        const current = this.writer.find(ws, roadmap.id);
        // The operator's own pause of that review stays; the failure is recorded once it lifts.
        if (current.entryHolds?.[sourceEntry.id]?.status === 'paused') {
          roadmap = current;
          continue;
        }
        const hold = {
          status: 'needs-attention' as const,
          reason: `Could not adopt the open repair of ${owner.sourceId} into this roadmap: ${
            error instanceof ExecutionRequestError ? error.message : 'unexpected error'
          } The repair continues as your own cycle.`.slice(0, 4000),
          attention: roadmapAttention('entry-preparation-failed', {
            entryId: sourceEntry.id,
            cycleId: cycle.id,
            ...holdCause(error),
          }),
        };
        roadmap =
          JSON.stringify(current.entryHolds?.[sourceEntry.id]) === JSON.stringify(hold)
            ? current
            : this.writer.change(current, {
                entryHolds: { ...current.entryHolds, [sourceEntry.id]: hold },
              });
      }
    }
    return roadmap;
  }
}
