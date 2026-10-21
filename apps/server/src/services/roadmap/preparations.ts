/**
 * Shared decisions prepared beside the slices that need them (R-C3b, ADR-065; R-B7): the
 * operator's request, the standing grant's preparations each pass, their reservation, worktree and
 * read-only launch, and the release of settled preparations' worktrees.
 */

import type { GitOperations } from '@craftingtable/git';
import type { AgentRunService } from '../agent-run-service.js';
import type { RoadmapWriter } from './writer.js';
import type { RoadmapState } from './state.js';
import { retried, PREPARATION_RETRY_MS, type PreparationTarget, conflict } from './shared.js';
import {
  decisionBindingDigest,
  supportsArchitectureDecision,
} from '../architecture-decision-policy.js';
import { SWEEP_MS } from '../kernel/controller-kernel.js';
import {
  currentDecisionPreparation,
  preparedDecisionAccepted,
} from '../decision-preparation-policy.js';
import { randomUUID } from 'node:crypto';
import { activeEditor } from '../authority-policy.js';
import type { PrepareRoadmapDecision } from '@craftingtable/contracts';
import {
  asAgentRunId,
  asCheckpointId,
  asDecisionPreparationId,
  asWorktreeId,
  required,
  type Roadmap,
  type RoadmapId,
  type RoadmapView,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { entryAgentSelections, preparationAgent } from '../agent-profile-policy.js';
import type { AuthContext, CommandContext } from '../auth-service.js';
import { RepositoryMutationBusyError } from '../branch-service.js';
import { crossProjectState } from '../map-state.js';
import { neededDecisions } from '../decision-demand.js';
import { DaemonDrainingError, NotFoundError } from '../errors.js';
import type { ExecutionService } from '../execution-service.js';
import type { WorkCycleService } from '../work-cycle-service.js';
import type { WorkspaceService } from '../workspace-service.js';
import { WorktreeMutationBusyError } from '../worktree-mutation-guard.js';
import type { RoadmapViews } from './views.js';

export class RoadmapPreparations {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly agents: AgentRunService,
    private readonly git: GitOperations | undefined,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
    private readonly views: RoadmapViews,
  ) {}

  async prepareDecision(
    context: AuthContext,
    ws: WorkspaceId,
    id: RoadmapId,
    input: PrepareRoadmapDecision,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const old = this.writer.find(ws, id),
      cp = old.definition.crossProject;
    if (!this.git) conflict('Decision preparation is unavailable on this controller.');
    // A running roadmap writes itself on every pass, so only a stopped form is stale there; the
    // preparation itself binds to the exact map binding (R-C3b, ADR-065).
    if (
      (old.version !== input.expectedVersion && old.status !== 'running') ||
      this.state.controlling.has(id)
    )
      conflict('Roadmap changed. Refresh before preparing a decision.');
    if (!cp || !['paused', 'draft', 'needs-attention', 'running'].includes(old.status))
      conflict('Decisions are prepared for a draft, running or paused cross-project roadmap.');
    if (this.storage.amendments.pending(ws, id))
      conflict('Resolve the pending planning amendment first.');
    const target = this.preparationTarget(old, input.checkpointId);
    if ('refused' in target) conflict(target.refused);
    this.cycles.validateAgentSelections({
      ...entryAgentSelections(old, target.entry).selections,
      investigation: input.profile,
    });
    this.cycles.requireModelIds([['investigation', input.profile]]);
    this.state.controlling.add(id);
    try {
      const profile = preparationAgent(old, target.entry, input.profile).selection;
      await this.launchPreparation(old, target, { ...input, profile }, context, () =>
        this.workspaces.requireRole(context, ws, ['owner', 'editor']),
      );
    } finally {
      this.state.endControl(id);
    }
    return this.views.view(this.writer.find(ws, id));
  }

  /** The exact map checkpoint a preparation would prepare, and its bound owner, or why not. */
  preparationTarget(
    roadmap: Roadmap,
    checkpointId: string,
  ): PreparationTarget | { readonly refused: string } {
    const ws = roadmap.workspaceId,
      cp = roadmap.definition.crossProject;
    const d = cp && this.storage.imports.definition(ws, cp.definitionId);
    const binding = cp && this.storage.imports.bindings(ws, cp.definitionId)[0];
    if (
      !cp ||
      !d ||
      binding?.revision !== cp.bindingRevision ||
      !supportsArchitectureDecision(d, checkpointId)
    )
      return { refused: 'Choose an architecture decision from the exact current map binding.' };
    const checkpoint = required(
      d.source.checkpoints.find((c) => c.id === checkpointId),
      "the architecture decision's checkpoint",
    );
    const owner = binding.bindings.find((b) => b.alias === checkpoint.owner);
    if (
      !owner?.repositoryId ||
      !owner.projectId ||
      !owner.planVersionId ||
      !owner.integrationBranch
    )
      return {
        refused: 'Bind this decision owner to an exact plan and integration branch first.',
      };
    const entry = roadmap.definition.entries.find((e) => e.planVersionId === owner.planVersionId);
    if (!entry) return { refused: 'This decision owner is outside the selected roadmap.' };
    return {
      d,
      binding,
      checkpoint,
      entry,
      owner: {
        repositoryId: owner.repositoryId,
        projectId: owner.projectId,
        planVersionId: owner.planVersionId,
        integrationBranch: owner.integrationBranch,
      },
    };
  }

  /**
   * Removes the worktrees of preparations whose run ended and whose decision is accepted
   * (LIVE-16): nothing of them is needed any more, and the brief stays on the run. A preparation
   * still open for the operator keeps its worktree, which holds no slice capacity.
   */
  async releaseSettledPreparations(roadmap: Roadmap): Promise<void> {
    for (const p of roadmap.decisionPreparations ?? []) {
      if (this.state.abort.signal.aborted) return;
      if (
        this.preparationInFlight(p) ||
        this.storage.execution.worktrees.find(p.workspaceId, p.worktreeId)?.status !== 'active' ||
        !preparedDecisionAccepted(this.storage, p)
      )
        continue;
      await this.execution
        .releaseDecisionWorktree(p.workspaceId, p.worktreeId, p.id)
        .catch(() => undefined);
    }
  }

  /** A preparation whose run has not ended: it holds its checkpoint and a place in the bound. */
  preparationInFlight(p: import('@craftingtable/domain').DecisionPreparation): boolean {
    const run = this.storage.execution.runs.find(p.workspaceId, p.runId);
    return !p.failure && (!run || ['starting', 'running', 'waiting'].includes(run.status));
  }

  /**
   * Reserves, prepares the worktree for, and launches one read-only preparation. Its record binds
   * the exact map binding and digest; `authorize` re-checks who may still prepare it. A failure
   * after the reservation is recorded on the preparation.
   */
  async launchPreparation(
    roadmap: Roadmap,
    target: PreparationTarget,
    input: {
      readonly profile: import('@craftingtable/domain').AgentSelection;
      readonly minutes: number;
      readonly instructions: string;
    },
    context: CommandContext,
    authorize: () => void,
  ): Promise<void> {
    const ws = roadmap.workspaceId,
      { d, binding, checkpoint, owner } = target;
    const repo = this.storage.execution.sourceRepositories.find(ws, owner.repositoryId);
    if (!repo) throw new NotFoundError();
    let reserved: import('@craftingtable/domain').DecisionPreparation | undefined;
    try {
      const result = await required(this.git, "the daemon's Git").resolveBranch(
        repo.rootPath,
        owner.integrationBranch,
      );
      if (!result.ok) conflict(result.failure.message);
      const latest = this.writer.find(ws, roadmap.id);
      if (
        latest.definition.revision !== roadmap.definition.revision ||
        this.storage.imports.bindings(ws, d.id)[0]?.revision !== binding.revision
      )
        conflict('Roadmap changed during preparation. Refresh and try again.');
      if (
        latest.decisionPreparations?.some(
          (p) => p.checkpointId === checkpoint.id && this.preparationInFlight(p),
        )
      )
        conflict(
          'This decision already has a preparation in flight. Open its run or wait for completion.',
        );
      const at = this.state.now();
      const p: import('@craftingtable/domain').DecisionPreparation = {
        id: asDecisionPreparationId(randomUUID()),
        definitionId: d.id,
        bindingRevision: binding.revision,
        bindingDigest: decisionBindingDigest(this.storage, d, binding.revision),
        checkpointId: asCheckpointId(checkpoint.id),
        workspaceId: ws,
        ...owner,
        integrationSha: result.value,
        worktreeId: asWorktreeId(randomUUID()),
        runId: asAgentRunId(randomUUID()),
        profile: input.profile,
        deadlineAt: new Date(at.getTime() + input.minutes * 60000).toISOString(),
        instructions: input.instructions,
        createdAt: at.toISOString(),
        createdByUserId: context.user.id,
      };
      this.writer.change(
        latest,
        { decisionPreparations: [...(latest.decisionPreparations ?? []), p] },
        'prepare-decision',
        context.session ? (context as AuthContext) : undefined,
      );
      reserved = p;
      const check = () => {
        authorize();
        const recorded = this.writer
          .find(ws, roadmap.id)
          .decisionPreparations?.find((q) => q.id === p.id);
        if (
          !recorded ||
          recorded.failure ||
          !currentDecisionPreparation(this.storage, p) ||
          this.state.now().getTime() >= Date.parse(p.deadlineAt)
        )
          conflict('Decision preparation authority or binding changed. Start a fresh preparation.');
      };
      check();
      await this.execution.createDecisionWorktree(context, p, { check });
      check();
      await this.agents.startDecisionPreparation(context, p, { check });
    } catch (e) {
      if (reserved) {
        const current = this.writer.find(ws, roadmap.id);
        // Busy Git, a lost race or a draining daemon before anything was created is not the
        // preparation's failure: the reservation goes, and the next pass or request tries again
        // (R-C3b review).
        const transient =
          (retried(e) || e instanceof DaemonDrainingError) &&
          !this.storage.execution.worktrees.find(ws, reserved.worktreeId);
        this.writer.change(
          current,
          {
            decisionPreparations: transient
              ? required(
                  current.decisionPreparations,
                  "the roadmap's decision preparations",
                ).filter((p) => p.id !== required(reserved, 'the reserved preparation').id)
              : required(current.decisionPreparations, "the roadmap's decision preparations").map(
                  (p) =>
                    p.id === required(reserved, 'the reserved preparation').id
                      ? { ...p, failure: e instanceof Error ? e.message : 'Preparation failed' }
                      : p,
                ),
          },
          'decision-preparation-failed',
          context.session ? (context as AuthContext) : undefined,
        );
      }
      throw e;
    }
  }

  /**
   * Under the roadmap's standing grant (R-C3b, ADR-065), prepares the shared decisions its
   * selected slices still need, those that unblock the most slices first, keeping at most the
   * granted number in flight. A decision is prepared once per binding; a failed preparation
   * waits for the operator's explicit retry. Preparation proposes only.
   */
  async prepareNeededDecisions(roadmap: Roadmap): Promise<void> {
    const grant = roadmap.decisionPreparationGrant,
      cp = roadmap.definition.crossProject,
      ws = roadmap.workspaceId;
    if (!grant?.enabled || !cp || !this.git) return;
    // Held back by a busy lock until its release (or a sweep's length at most, should the release
    // be missed: increment 10 review LOW-1), or by a transient refusal for a second.
    const held = this.state.preparationsHeld.get(roadmap.id);
    if (held !== undefined) {
      if (held.at + SWEEP_MS > this.state.now().getTime()) return;
      this.state.preparationsHeld.delete(roadmap.id);
    }
    const notBefore = this.state.preparationsNotBefore.get(roadmap.id);
    if (notBefore !== undefined) {
      if (notBefore > this.state.now().getTime()) {
        this.state.lookAgain(roadmap.id, notBefore);
        return;
      }
      this.state.preparationsNotBefore.delete(roadmap.id);
    }
    const grantor = this.grantor(roadmap);
    if (!grantor) return;
    const d = this.storage.imports.definition(ws, cp.definitionId);
    const binding = this.storage.imports.bindings(ws, cp.definitionId)[0];
    if (!d || binding?.revision !== cp.bindingRevision) return;
    const digest = decisionBindingDigest(this.storage, d, binding.revision);
    const preparations = roadmap.decisionPreparations ?? [];
    let room = grant.maxConcurrent - preparations.filter((p) => this.preparationInFlight(p)).length;
    const done = new Set(
      preparations
        .filter((p) => p.bindingRevision === binding.revision && p.bindingDigest === digest)
        .map((p) => p.checkpointId),
    );
    for (const { checkpointId } of neededDecisions(
      d,
      crossProjectState(this.storage, ws, cp).nodes,
    )) {
      if (room <= 0 || this.state.abort.signal.aborted) return;
      if (done.has(checkpointId)) continue;
      const key = `${roadmap.id}:${checkpointId}`;
      const retryAt = this.state.preparationRetryAt.get(key);
      if (retryAt !== undefined && retryAt > this.state.now().getTime()) {
        // Looked at again when it may be tried (R-B5 part 2).
        this.state.lookAgain(roadmap.id, retryAt);
        continue;
      }
      // A retry time passed is forgotten (part 2 review MEDIUM-4).
      if (retryAt !== undefined) this.state.preparationRetryAt.delete(key);
      const current = this.writer.find(ws, roadmap.id);
      if (current.status !== 'running' || !current.decisionPreparationGrant?.enabled) return;
      const target = this.preparationTarget(current, checkpointId);
      if ('refused' in target) continue;
      const reservations = () =>
        (this.writer.find(ws, roadmap.id).decisionPreparations ?? []).filter(
          (p) => p.checkpointId === checkpointId,
        ).length;
      const before = reservations();
      try {
        await this.launchPreparation(
          current,
          target,
          {
            profile: preparationAgent(current, target.entry).selection,
            minutes: grant.minutes,
            instructions: 'Prepared under the standing decision preparation grant of this roadmap.',
          },
          { user: grantor },
          () => {
            // Still granted, by the same user this preparation acts as (R-C3b review).
            const latest = this.writer.find(ws, roadmap.id);
            if (
              !latest.decisionPreparationGrant?.enabled ||
              this.grantor(latest)?.id !== grantor.id
            )
              conflict('The standing decision preparation grant was revoked.');
          },
        );
      } catch (error) {
        // A failure after the reservation is recorded on the preparation. One before it (the
        // owner's branch is gone, a lost race) leaves no record: this decision gives its place
        // to the next and waits before it is tried again, unless the cause clears by itself.
        // A busy repository or a draining daemon holds every decision alike: the next pass
        // resumes in order.
        if (retried(error) || error instanceof DaemonDrainingError) {
          // Its reservation was written and removed, which marks every roadmap: tried again at
          // the lock's release, or a second on, not at once (increment 9 review HIGH-2).
          const at = this.state.now().getTime();
          if (error instanceof RepositoryMutationBusyError)
            this.state.preparationsHeld.set(roadmap.id, { key: 'lane', at });
          else if (error instanceof WorktreeMutationBusyError)
            this.state.preparationsHeld.set(roadmap.id, { key: 'guard', at });
          else {
            const at = this.state.now().getTime() + 1000;
            this.state.preparationsNotBefore.set(roadmap.id, at);
            this.state.lookAgain(roadmap.id, at);
          }
          this.state.metRetried(roadmap.id, error);
          return;
        }
        if (reservations() === before) {
          const at = this.state.now().getTime() + PREPARATION_RETRY_MS;
          this.state.preparationRetryAt.set(key, at);
          this.state.lookAgain(roadmap.id, at);
        }
      }
      if (reservations() > before) room -= 1;
    }
  }

  /** Whoever granted standing preparation, while they may still prepare decisions. */
  grantor(roadmap: Roadmap) {
    return activeEditor(
      this.storage,
      roadmap.decisionPreparationGrant?.grantedByUserId,
      roadmap.workspaceId,
    );
  }
}
