/**
 * A roadmap's and an item's controls (R-B7): Start, Pause, Resume and Stop (the wind-down's settle
 * path), an item's Pause and Resume under the one resume rule (operator decision 1 A),
 * Re-verify, and the restart's recovery of interrupted preparations and running roadmaps.
 */
import type { RoadmapViews } from '../views.js';
import type { RoadmapSelection } from '../selection.js';
import type { RoadmapHolds } from '../holds.js';
import type { RoadmapWriter } from '../writer.js';
import type { RoadmapState } from '../state.js';
import { ended, RESUMED_REASON, conflict } from '../shared.js';
import { investigationHolds } from '../../investigation.js';
import type { RoadmapSettlement } from '../../roadmap-settlement.js';
import {
  required,
  roadmapAttention,
  type RoadmapEntryId,
  type RoadmapId,
  type RoadmapView,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from '../../auth-service.js';
import { windDownRefused } from '../../errors.js';
import { mapReadSnapshot } from '../../map-read-snapshot.js';
import { scopeRecoveryDecision } from '../../scope-recovery-policy.js';
import type { WorkCycleService } from '../../work-cycle-service.js';
import type { WorkspaceEventNotifier } from '../../workspace-event-notifier.js';
import type { WorkspaceService } from '../../workspace-service.js';

export class RoadmapControl {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly cycles: WorkCycleService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly settlement: RoadmapSettlement,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
    private readonly selection: RoadmapSelection,
    private readonly holds: RoadmapHolds,
    private readonly views: RoadmapViews,
  ) {}

  async control(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    action: 'start' | 'pause' | 'resume' | 'stop',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.state.controlling.has(id)) conflict('A roadmap command is already in progress.');
    this.state.controlling.add(id);
    try {
      return await this.controlWithin(context, workspaceId, id, action, expectedVersion);
    } finally {
      this.state.endControl(id);
      // A notification during control can wake a tick that must skip this lock.
      // Wake again after release so Start/Resume never depend on the idle timer.
      this.notifier.notify();
    }
  }

  async controlWithin(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    action: 'start' | 'pause' | 'resume' | 'stop',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    let roadmap = this.writer.find(workspaceId, id);
    // Stop is the wind-down's settle path with nothing retired (R-B11 decision 4): refused by
    // code before any write, held and resumable once begun.
    if (action === 'stop') {
      await this.settlement.stop(context, workspaceId, id, expectedVersion);
      return this.views.view(this.writer.find(workspaceId, id));
    }
    if (roadmap.version !== expectedVersion)
      conflict('Roadmap changed; refresh before issuing this command.');
    if (ended(roadmap)) conflict('This roadmap has ended.');
    if (this.storage.windDowns.find(workspaceId, id)?.status === 'settling')
      windDownRefused('wind-down-in-progress', 'This roadmap is being stopped.');
    if (action === 'pause' && roadmap.status === 'draft')
      conflict('Start the roadmap before pausing it.');
    if (action === 'start' || action === 'resume') {
      this.holds.assertRunnable(workspaceId, roadmap, action);
      // Explicit resume may adopt the owned cycle's manual handoff, using its normal guards.
      // Resume in priority order too: the cycle worker can wake while these async
      // commands run, before the final roadmap status update has been persisted.
      const resumeAttempts = roadmap.attempts.filter((a) => a.status !== 'completed');
      if (roadmap.definition.scheduling?.mode === 'parallel') {
        const priorities = new Map(roadmap.definition.entries.map((e, i) => [e.id, i]));
        resumeAttempts.sort(
          (a, b) =>
            (priorities.get(a.entryId) ?? Infinity) - (priorities.get(b.entryId) ?? Infinity),
        );
      }
      for (const attempt of resumeAttempts) {
        // An item the operator paused stays paused until its own Resume.
        if (roadmap.entryHolds?.[attempt.entryId]?.status === 'paused') continue;
        const cycle = this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
        // The `!` this replaced let an attempt without its entry through, and its slice cycle
        // resumed; no path to that state is shown, so the `find` keeps it optional (R-B7).
        const entry = roadmap.definition.entries.find((e) => e.id === attempt.entryId);
        if (!this.holds.resumesCycle(roadmap, entry, attempt, cycle)) continue;
        try {
          await this.cycles.control(context, workspaceId, cycle.id, 'resume', cycle.version);
        } catch (error) {
          if (roadmap.definition.scheduling?.mode !== 'parallel') throw error;
          // The item keeps its attention state; independent siblings may resume.
        }
      }
      roadmap = this.writer.change(
        roadmap,
        {
          status: 'running',
          delegatedByUserId: context.user.id,
          reason: RESUMED_REASON,
          entryHolds: Object.fromEntries(
            Object.entries(roadmap.entryHolds ?? {}).filter(([, hold]) => hold.status === 'paused'),
          ),
        },
        action,
        context,
      );
    } else {
      roadmap = this.writer.change(
        roadmap,
        {
          status: 'paused',
          reason: 'Roadmap paused. Manual work is available; no next item will start.',
        },
        action,
        context,
      );
      // A pause leaves its stops' investigations (R-C16) and every cycle not running.
      for (const attempt of roadmap.attempts.filter((a) => a.status !== 'completed')) {
        const cycle = this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
        if (cycle?.status === 'running')
          await this.cycles.control(context, workspaceId, cycle.id, action, cycle.version);
      }
    }
    return this.views.view(this.writer.find(workspaceId, id));
  }

  async controlEntry(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    entryId: RoadmapEntryId,
    action: 'pause' | 'resume',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.state.controlling.has(id)) conflict('A roadmap command is already in progress.');
    this.state.controlling.add(id);
    try {
      let roadmap = this.writer.find(workspaceId, id);
      if (roadmap.version !== expectedVersion)
        conflict('Roadmap changed; refresh before issuing this command.');
      if (roadmap.status !== 'running' || roadmap.definition.scheduling?.mode !== 'parallel')
        conflict('Item controls require a running parallel roadmap.');
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry || this.selection.complete(roadmap, entry))
        conflict('This entry is unavailable or completed.');
      const holds = { ...roadmap.entryHolds };
      const attempt = roadmap.attempts.find((a) => a.entryId === entryId);
      const cycle = attempt && this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
      const recovery = this.selection.recoveryFor(roadmap, entry);
      const repairCycle =
        recovery && this.storage.execution.cycles.find(workspaceId, recovery.cycleId);
      if (action === 'pause') {
        holds[entryId] = {
          status: 'paused',
          reason: 'Item paused by operator. Independent items may continue.',
        };
        roadmap = this.writer.change(roadmap, { entryHolds: holds }, 'pause-entry', context);
        // A stop being investigated, or held by a worktree change its investigation found, is
        // already still; the hold covers it (R-C16).
        if (
          cycle &&
          ['running', 'needs-attention'].includes(cycle.status) &&
          !investigationHolds(cycle)
        )
          await this.cycles.control(context, workspaceId, cycle.id, 'pause', cycle.version);
        if (
          repairCycle &&
          ['running', 'needs-attention'].includes(repairCycle.status) &&
          !investigationHolds(repairCycle)
        )
          await this.cycles.control(
            context,
            workspaceId,
            repairCycle.id,
            'pause',
            repairCycle.version,
          );
      } else {
        // Automatic recovery stopped converging: Resume would stop again the same way until the
        // rounds, the allowance or the policy change (R-C5 increment 4), also after the operator
        // paused the item, which would otherwise re-run the review without a repair (R-C5 review).
        if (
          holds[entryId] &&
          roadmap.scopeRecovery?.enabled &&
          (cycle?.status === 'needs-attention' || cycle?.status === 'paused') &&
          cycle.executionScope &&
          cycle.executionScope.kind !== 'slice' &&
          !recovery
        ) {
          const decision = scopeRecoveryDecision(
            mapReadSnapshot(this.storage),
            roadmap,
            entry,
            cycle,
          );
          if (decision.escalation) conflict(required(decision.reason, "the escalation's reason"));
        }
        if (cycle && ['stopped', 'completed'].includes(cycle.status) && !recovery)
          conflict(
            'This cycle has ended. For imported maps, use Planning amendments and reconciliation to review a replacement attempt.',
          );
        if (attempt && this.holds.resumesCycle(roadmap, entry, attempt, cycle))
          await this.cycles.control(context, workspaceId, cycle.id, 'resume', cycle.version);
        if (repairCycle?.status === 'paused' && !investigationHolds(repairCycle))
          await this.cycles.control(
            context,
            workspaceId,
            repairCycle.id,
            'resume',
            repairCycle.version,
          );
        delete holds[entryId];
        roadmap = this.writer.change(roadmap, { entryHolds: holds }, 'resume-entry', context);
      }
      return this.views.view(roadmap);
    } finally {
      this.state.endControl(id);
      // A notification during control can wake a tick that must skip this lock.
      // Wake again after release so Start/Resume never depend on the idle timer.
      this.notifier.notify();
    }
  }

  /**
   * Re-run the independent review of a verification or acceptance entry whose evidence is no
   * longer current (for example after the approved decisions changed), without stopping the
   * roadmap. The reviewer assignment is kept, so the fresh review can record evidence. A completed
   * review cycle whose worktree is still active reviews again in place; otherwise the ended
   * attempt is retired into the roadmap's history and the entry is scheduled afresh.
   */
  async reverifyEntry(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    entryId: RoadmapEntryId,
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.state.controlling.has(id)) conflict('A roadmap command is already in progress.');
    this.state.controlling.add(id);
    try {
      const roadmap = this.writer.find(workspaceId, id);
      if (roadmap.version !== expectedVersion)
        conflict('Roadmap changed; refresh before issuing this command.');
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry) conflict('This entry is unavailable.');
      const plan = this.selection.reverification(roadmap, entry);
      if ('refused' in plan) conflict(plan.refused.message);
      const at = this.state.now().toISOString();
      const { [entry.id]: _released, ...entryHolds } = roadmap.entryHolds ?? {};
      const attempt = plan.attempt;
      this.writer.change(
        roadmap,
        plan.inPlace
          ? {
              entryHolds,
              attempts: roadmap.attempts.map((a) =>
                a.id === attempt.id
                  ? {
                      ...a,
                      reverification: {
                        requestedAt: at,
                        requestedByUserId: context.user.id,
                        sourceRunId: plan.sourceRunId,
                      },
                    }
                  : a,
              ),
            }
          : {
              entryHolds,
              attempts: roadmap.attempts.filter((a) => a.id !== attempt.id),
              retiredAttempts: [
                ...(roadmap.retiredAttempts ?? []),
                {
                  ...attempt,
                  retiredAt: at,
                  retiredByUserId: context.user.id,
                  reason: 'Re-verification requested: the recorded evidence is no longer current.',
                },
              ],
            },
        'reverify-entry',
        context,
      );
      return this.views.view(this.writer.find(workspaceId, id));
    } finally {
      this.state.endControl(id);
      this.notifier.notify();
    }
  }

  /**
   * Returns the roadmaps this restart stopped, so notifications can coalesce them per boot.
   * After a clean stop (a completed drain, R-B9) running roadmaps keep running; only a
   * crash leaves them waiting for an explicit resume.
   */
  recoverInterrupted(options: { readonly cleanStop?: boolean } = {}): string[] {
    for (const roadmap of this.storage.roadmaps.list()) {
      if (
        roadmap.decisionPreparations?.some(
          (p) => !p.failure && !this.storage.execution.runs.find(roadmap.workspaceId, p.runId),
        )
      )
        this.writer.change(
          roadmap,
          {
            decisionPreparations: roadmap.decisionPreparations.map((p) =>
              !p.failure && !this.storage.execution.runs.find(roadmap.workspaceId, p.runId)
                ? {
                    ...p,
                    failure: 'Controller restarted before launch; start a fresh preparation.',
                  }
                : p,
            ),
          },
          'decision-preparation-interrupted',
        );
    }

    const stopped: string[] = [];
    if (options.cleanStop) return stopped;
    // A roadmap being settled resumes its settle on the first pass instead (R-B11).
    const settling = this.settlement.held();
    for (const roadmap of this.storage.roadmaps.list())
      if (roadmap.status === 'running' && !settling.has(roadmap.id)) {
        this.writer.change(roadmap, {
          status: 'needs-attention',
          attention: roadmapAttention('restart-resume'),
          reason: 'Daemon restarted. Inspect the current item and explicitly resume the roadmap.',
        });
        stopped.push(roadmap.id);
      }
    return stopped;
  }
}
