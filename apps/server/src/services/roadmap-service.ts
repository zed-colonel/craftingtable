import { acceptedEvidence } from './runtime-evidence-policy.js';
import { collectScopeRepair } from './scope-repair.js';
import { scopeRecoveryDecision } from './scope-recovery-policy.js';
import { PLAN_CHECKPOINT } from './plan-acceptance-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { crossProjectState, bindingIssues, milestoneSatisfied } from './cross-project-service.js';
import { PhaseGateError } from './phase-resources.js';
import { scopePhaseBlockers, scopeAllowsEarlyDevelopment } from './execution-scope.js';
import { sameExecutionScope } from '@craftingtable/domain';
import {
  resolveScope,
  scopeBlockers,
  requireScopeOwnership,
  unsupportedScopeCapabilities,
} from './execution-scope.js';
import { randomUUID } from 'node:crypto';
import type { SaveRoadmapRequest, ScopeRecoveryPolicyRequest } from '@craftingtable/contracts';
import {
  DEFAULT_ROADMAP_SCHEDULING,
  DEFAULT_ROADMAP_AUTOMATION,
  asAuditEventId,
  asEventId,
  asWorktreeId,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapAttempt,
  type RoadmapView,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext, CommandContext } from './auth-service.js';
import { WorktreeMutationBusyError } from './worktree-mutation-guard.js';
import { RepositoryMutationBusyError, IntegrationHeldError } from './branch-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import type { ExecutionService } from './execution-service.js';
import type { WorkItemService } from './work-item-service.js';
import type { WorkCycleService } from './work-cycle-service.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';

class SupersededRoadmapOperation extends Error {}

const ended = (roadmap: Roadmap) => ['stopped', 'completed'].includes(roadmap.status);
function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}

/** One delegated roadmap per workspace. The cycle controller owns every agent step. */
export class RoadmapService {
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;
  private ticking = false;
  private readonly controlling = new Set<string>();
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly items: WorkItemService,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
    private readonly runtimeEvidence?: import('./runtime-evidence-service.js').RuntimeEvidenceService,
  ) {}

  list(context: AuthContext, workspaceId: WorkspaceId): readonly RoadmapView[] {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.roadmaps.list(workspaceId).map((roadmap) => this.view(roadmap));
  }
  history(context: AuthContext, workspaceId: WorkspaceId, id: string) {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.find(workspaceId, id);
    return this.storage.roadmaps.history(workspaceId, id);
  }
  configureScopeRecovery(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    input: ScopeRecoveryPolicyRequest,
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const roadmap = this.find(workspaceId, id);
    if (this.controlling.has(id) || roadmap.version !== input.expectedVersion)
      conflict('Roadmap changed; refresh before changing recovery delegation.');
    if (
      !roadmap.definition.crossProject ||
      !['draft', 'paused', 'needs-attention'].includes(roadmap.status)
    )
      conflict('Pause this cross-project roadmap before changing recovery delegation.');
    if (this.storage.amendments.pending(workspaceId, id))
      conflict('Decide the pending amendment first.');
    return this.view(
      this.change(
        roadmap,
        {
          scopeRecovery: {
            enabled: input.enabled,
            maxRoundsPerParent: input.maxRoundsPerParent,
            grantedByUserId: context.user.id,
            grantedAt: this.now().toISOString(),
          },
        },
        'configure-scope-recovery',
        context,
      ),
    );
  }
  save(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    input: SaveRoadmapRequest,
    crossProject?: import('@craftingtable/domain').CrossProjectConfiguration,
    amendment?: { readonly retainAttemptIds: readonly string[] },
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.controlling.has(id)) conflict('A roadmap command is in progress.');
    const old = this.storage.roadmaps.find(workspaceId, id);
    if (old && this.storage.amendments.pending(workspaceId, id) && !amendment)
      conflict('Decide the pending planning amendment before editing settings.');
    if (old?.definition.crossProject && !crossProject)
      conflict('Use the imported map supervisor to edit this roadmap.');
    if ((old?.version ?? 0) !== input.expectedVersion)
      conflict('Roadmap changed; refresh before saving.');
    if (old && !['draft', 'paused', 'needs-attention'].includes(old.status))
      conflict(
        'Pause the roadmap before editing queued entries. Ended roadmaps retain their history.',
      );
    const lastStarted =
      old?.definition.entries.findLastIndex((e) =>
        old.attempts.some(
          (a) => a.entryId === e.id && (!amendment || amendment.retainAttemptIds.includes(a.id)),
        ),
      ) ?? -1;
    const scheduling = input.scheduling ?? old?.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING;
    const parallel = scheduling.mode === 'parallel';
    if (
      old?.attempts.some((a) => a.status !== 'completed') &&
      scheduling.mode !== (old.definition.scheduling?.mode ?? 'sequential')
    )
      conflict(
        'Finish the in-flight attempts before changing scheduling mode. Capacity limits can be edited while paused.',
      );
    const started =
      (parallel
        ? old?.definition.entries.filter((e) =>
            old.attempts.some(
              (a) =>
                a.entryId === e.id && (!amendment || amendment.retainAttemptIds.includes(a.id)),
            ),
          )
        : old?.definition.entries.slice(0, lastStarted + 1)) ?? [];
    const entries: RoadmapEntry[] = input.entries.map((entry, index) => {
      if (entry.reviewerRoles && !crossProject)
        conflict('Reviewer role assignments require the explicit cross-project settings form.');
      const item = this.storage.planning.workItems.find(workspaceId, entry.workItemId);
      if (!item) throw new NotFoundError();
      const scoped = entry.executionScope
        ? resolveScope(this.storage, workspaceId, entry.workItemId, entry.executionScope)
        : undefined;
      if (!crossProject && entry.executionScope && entry.executionScope.kind !== 'slice')
        conflict('Roadmaps delegate slices, not parent acceptance reviews.');
      const frozen = started.find((e) => e.id === entry.id);
      if (frozen) {
        if (
          JSON.stringify({
            ...(frozen.reviewerRoles ? { reviewerRoles: frozen.reviewerRoles } : {}),
            ...(frozen.executionScope ? { executionScope: frozen.executionScope } : {}),
            id: frozen.id,
            workItemId: frozen.workItemId,
            profiles: frozen.profiles,
            policy: frozen.policy,
            instructions: frozen.instructions,
            ...(frozen.automation ? { automation: frozen.automation } : {}),
            ...(frozen.exclusionGroups === undefined
              ? {}
              : { exclusionGroups: frozen.exclusionGroups }),
          }) !== JSON.stringify(entry)
        )
          conflict('Started entries keep their original work item and settings.');
        return frozen;
      }
      if (!parallel && index < started.length)
        conflict('Started entries must remain at the front in their original order.');
      const settings = this.storage.execution.branchSettings.find(workspaceId, item.planVersionId);
      if (!settings) conflict(`Configure Repository & branches for ${item.sourceId}'s plan first.`);
      const repo = this.storage.execution.sourceRepositories.find(
        workspaceId,
        settings.repositoryId,
      );
      if (repo?.status !== 'active')
        conflict(`The repository for ${item.sourceId} is unavailable.`);
      return {
        ...entry,
        projectId: item.projectId,
        planVersionId: item.planVersionId,
        sourceId: entry.executionScope?.sourceId ?? item.sourceId,
        title: scoped?.slice?.title ?? item.title,
        repositoryId: settings.repositoryId,
        integrationBranch: settings.integrationBranch,
      };
    });
    if (
      started.some((e, index) =>
        parallel ? !entries.some((entry) => entry.id === e.id) : entries[index]?.id !== e.id,
      )
    )
      conflict('Started entries cannot be removed or reordered.');
    for (const [index, entry] of entries.entries()) {
      for (const dependency of this.storage.planning.dependencies.listPredecessors(
        workspaceId,
        entry.workItemId,
      )) {
        if (
          !parallel &&
          dependency.kind === 'required' &&
          dependency.status !== 'completed' &&
          entries.findIndex((e) => e.workItemId === dependency.workItemId) > index
        )
          conflict(
            `${dependency.sourceId} must appear before ${entry.sourceId}. Prerequisites outside the roadmap remain blockers.`,
          );
      }
    }
    const at = this.now().toISOString();
    const definition = {
      roadmapId: id,
      revision: (old?.definition.revision ?? 0) + 1,
      name: input.name,
      ...(crossProject ? { crossProject } : {}),
      scheduling,
      ...(input.automation ? { automation: input.automation } : {}),
      entries,
      createdAt: at,
      createdByUserId: context.user.id,
    };
    const roadmap: Roadmap = old
      ? {
          ...old,
          definition,
          version: old.version + 1,
          updatedAt: at,
          ...(amendment
            ? {
                ...(old.scopeRecovery
                  ? { scopeRecovery: { ...old.scopeRecovery, enabled: false } }
                  : {}),
                attempts: old.attempts.filter((a) => amendment.retainAttemptIds.includes(a.id)),
                entryHolds: {},
                status: 'paused' as const,
                reason:
                  'Reviewed amendment applied. Configure/adopt its exact binding and explicitly resume.',
              }
            : {}),
        }
      : {
          id,
          workspaceId,
          version: 1,
          definition,
          status: 'draft',
          reason: 'Saved. Start explicitly to delegate this ordered queue.',
          createdAt: at,
          updatedAt: at,
          createdByUserId: context.user.id,
          attempts: [],
        };
    this.storage.transaction((tx) => {
      this.persist(tx, roadmap, input.expectedVersion, 'save', context);
      tx.roadmaps.addDefinition(definition);
    });
    this.notifier.notify();
    return this.view(roadmap);
  }

  async control(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    action: 'start' | 'pause' | 'resume' | 'stop',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.controlling.has(id)) conflict('A roadmap command is already in progress.');
    this.controlling.add(id);
    try {
      return await this.controlWithin(context, workspaceId, id, action, expectedVersion);
    } finally {
      this.controlling.delete(id);
      // A notification during control can wake a tick that must skip this lock.
      // Wake again after release so Start/Resume never depend on the idle timer.
      this.notifier.notify();
    }
  }
  private async controlWithin(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    action: 'start' | 'pause' | 'resume' | 'stop',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    let roadmap = this.find(workspaceId, id);
    if (roadmap.version !== expectedVersion)
      conflict('Roadmap changed; refresh before issuing this command.');
    if (ended(roadmap)) conflict('This roadmap has ended.');
    if (action === 'pause' && roadmap.status === 'draft')
      conflict('Start the roadmap before pausing it.');
    if (
      (action === 'start' || action === 'resume') &&
      this.storage.amendments.list(workspaceId).some((a) => !a.decision)
    )
      conflict('Apply or reject the pending planning amendment before resuming.');
    if (action === 'start' || action === 'resume') {
      if (
        action === 'start'
          ? roadmap.status !== 'draft'
          : !['paused', 'needs-attention'].includes(roadmap.status)
      )
        conflict('Only a draft can start; only a paused roadmap can resume.');
      if (
        this.storage.roadmaps
          .list(workspaceId)
          .some((r) => r.id !== id && r.status !== 'draft' && !ended(r))
      )
        conflict('This workspace already has a delegated roadmap. Stop or finish it first.');
      if (roadmap.definition.crossProject) {
        const preview = crossProjectState(
          this.storage,
          workspaceId,
          roadmap.definition.crossProject,
        );
        if (preview.blockers.length) conflict(preview.blockers.join(' '));
        const plan = acceptedEvidence(
          this.storage,
          workspaceId,
          roadmap.definition.crossProject.definitionId,
          roadmap.definition.crossProject.bindingRevision,
          { kind: 'checkpoint', sourceId: PLAN_CHECKPOINT },
        );
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
        if (roadmap.entryHolds?.[attempt.entryId]?.status === 'paused') continue;
        const cycle = this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
        // Recovery, not another review of unchanged source, owns these stopped checkpoints.
        if (
          roadmap.scopeRecovery?.enabled &&
          cycle?.executionScope &&
          cycle.executionScope.kind !== 'slice' &&
          (cycle.status === 'needs-attention' ||
            !!this.recoveryFor(
              roadmap,
              roadmap.definition.entries.find((e) => e.id === attempt.entryId)!,
            ))
        )
          continue;
        if (cycle && ['paused', 'needs-attention'].includes(cycle.status)) {
          const worktree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
          if (
            !worktree?.mergedAt &&
            this.storage.execution.merges.latest(workspaceId, cycle.worktreeId)?.status !==
              'reserved'
          ) {
            try {
              await this.cycles.control(context, workspaceId, cycle.id, 'resume', cycle.version);
            } catch (error) {
              if (roadmap.definition.scheduling?.mode !== 'parallel') throw error;
              // The item keeps its attention state; independent siblings may resume.
            }
          }
        }
      }
      roadmap = this.change(
        roadmap,
        {
          status: 'running',
          delegatedByUserId: context.user.id,
          reason: 'Scheduling enabled. Integration follows each item’s delegated merge policy.',
          entryHolds: Object.fromEntries(
            Object.entries(roadmap.entryHolds ?? {}).filter(([, hold]) => hold.status === 'paused'),
          ),
        },
        action,
        context,
      );
    } else {
      roadmap = this.change(
        roadmap,
        {
          status: action === 'pause' ? 'paused' : 'stopped',
          reason:
            action === 'pause'
              ? 'Roadmap paused. Manual work is available; no next item will start.'
              : 'Roadmap stopped. Existing worktrees remain available for manual work.',
        },
        action,
        context,
      );
      for (const attempt of roadmap.attempts.filter((a) => a.status !== 'completed')) {
        const cycle = this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
        if (
          cycle &&
          !['stopped', 'completed'].includes(cycle.status) &&
          (action === 'stop' || cycle.status === 'running')
        )
          await this.cycles.control(context, workspaceId, cycle.id, action, cycle.version);
      }
    }
    return this.view(this.find(workspaceId, id));
  }

  async controlEntry(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    entryId: string,
    action: 'pause' | 'resume',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.controlling.has(id)) conflict('A roadmap command is already in progress.');
    this.controlling.add(id);
    try {
      let roadmap = this.find(workspaceId, id);
      if (roadmap.version !== expectedVersion)
        conflict('Roadmap changed; refresh before issuing this command.');
      if (roadmap.status !== 'running' || roadmap.definition.scheduling?.mode !== 'parallel')
        conflict('Item controls require a running parallel roadmap.');
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry || this.complete(roadmap, entry))
        conflict('This entry is unavailable or completed.');
      const holds = { ...roadmap.entryHolds };
      const attempt = roadmap.attempts.find((a) => a.entryId === entryId);
      const cycle = attempt && this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
      const recovery = this.recoveryFor(roadmap, entry);
      const repairCycle =
        recovery && this.storage.execution.cycles.find(workspaceId, recovery.cycleId);
      if (action === 'pause') {
        holds[entryId] = {
          status: 'paused',
          reason: 'Item paused by operator. Independent items may continue.',
        };
        roadmap = this.change(roadmap, { entryHolds: holds }, 'pause-entry', context);
        if (cycle && ['running', 'needs-attention'].includes(cycle.status))
          await this.cycles.control(context, workspaceId, cycle.id, 'pause', cycle.version);
        if (repairCycle && ['running', 'needs-attention'].includes(repairCycle.status))
          await this.cycles.control(
            context,
            workspaceId,
            repairCycle.id,
            'pause',
            repairCycle.version,
          );
      } else {
        if (cycle && ['stopped', 'completed'].includes(cycle.status) && !recovery)
          conflict(
            'This cycle has ended. For imported maps, use Planning amendments and reconciliation to review a replacement attempt.',
          );
        if (
          cycle &&
          ['paused', 'needs-attention'].includes(cycle.status) &&
          !(
            roadmap.scopeRecovery?.enabled &&
            cycle.executionScope &&
            cycle.executionScope.kind !== 'slice' &&
            (cycle.status === 'needs-attention' || !!recovery)
          )
        )
          await this.cycles.control(context, workspaceId, cycle.id, 'resume', cycle.version);
        if (repairCycle?.status === 'paused')
          await this.cycles.control(
            context,
            workspaceId,
            repairCycle.id,
            'resume',
            repairCycle.version,
          );
        delete holds[entryId];
        roadmap = this.change(roadmap, { entryHolds: holds }, 'resume-entry', context);
      }
      return this.view(roadmap);
    } finally {
      this.controlling.delete(id);
      // A notification during control can wake a tick that must skip this lock.
      // Wake again after release so Start/Resume never depend on the idle timer.
      this.notifier.notify();
    }
  }

  recoverInterrupted(): void {
    for (const roadmap of this.storage.roadmaps.list())
      if (roadmap.status === 'running')
        this.change(roadmap, {
          status: 'needs-attention',
          reason: 'Daemon restarted. Inspect the current item and explicitly resume the roadmap.',
        });
  }
  startWorker(): void {
    this.task ??= this.loop();
  }
  async shutdown(): Promise<void> {
    this.abort.abort();
    await this.task;
  }
  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const generation = this.notifier.workflowGeneration;
      await this.tick();
      await this.notifier.waitForChangeOrTimeout({
        channel: 'workflow',
        generation,
        // Persisted changes wake this immediately. A fully waiting roadmap does not
        // need to re-evaluate an unchanged map every second.
        timeoutMs: this.storage.roadmaps
          .list()
          .some((r) => r.status === 'running' && !r.definition.crossProject)
          ? 1000
          : 5000,
        signal: this.abort.signal,
      });
    }
  }
  /** Serialized tick is also the deterministic integration-test seam. */
  async tick(): Promise<void> {
    if (this.ticking || this.abort.signal.aborted) return;
    this.ticking = true;
    try {
      for (const roadmap of this.storage.roadmaps.list()) {
        if (this.abort.signal.aborted) break;
        if (roadmap.status !== 'running' || this.controlling.has(roadmap.id)) continue;
        try {
          await this.advance(roadmap);
        } catch (error) {
          if (
            error instanceof SupersededRoadmapOperation ||
            (error instanceof PhaseGateError && error.waiting) ||
            error instanceof RepositoryMutationBusyError ||
            error instanceof WorktreeMutationBusyError ||
            error instanceof IntegrationHeldError
          )
            continue;
          const current = this.find(roadmap.workspaceId, roadmap.id);
          if (current.status === 'running')
            this.change(current, {
              status: 'needs-attention',
              reason:
                error instanceof ExecutionRequestError
                  ? error.message
                  : 'Scheduler could not advance. Inspect the current item before resuming.',
            });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private authority(roadmap: Roadmap): CommandContext {
    const user =
      roadmap.delegatedByUserId && this.storage.users.findById(roadmap.delegatedByUserId);
    if (user?.status !== 'active') conflict('The initiating user is no longer active.');
    const access = this.storage.workspaces.findAuthorized(user.id, roadmap.workspaceId);
    if (!access || !['owner', 'editor'].includes(access.membership.role))
      conflict('The initiating user no longer has permission to run this roadmap.');
    return { user };
  }
  private async advance(roadmap: Roadmap): Promise<void> {
    this.authority(roadmap);
    if (this.storage.amendments.pending(roadmap.workspaceId, roadmap.id)) return;
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
      const deferred = this.deferredEntries(roadmap);
      for (const entry of roadmap.definition.entries) {
        if (deferred.has(entry.id)) continue;
        const current = this.find(roadmap.workspaceId, roadmap.id);
        if (
          current.status !== 'running' ||
          this.controlling.has(current.id) ||
          this.abort.signal.aborted
        )
          return;
        this.authority(current);
        if (this.complete(current, entry)) {
          const attempt = current.attempts.find((a) => a.entryId === entry.id);
          if (attempt && attempt.status !== 'completed')
            this.change(current, {
              attempts: current.attempts.map((a) =>
                a.id === attempt.id
                  ? { ...a, status: 'completed' as const, completedAt: this.now().toISOString() }
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
        if (current.entryHolds?.[entry.id] && !merged) continue;
        try {
          await this.advanceEntry(current, entry);
        } catch (error) {
          if (error instanceof SupersededRoadmapOperation) throw error;
          if (
            (error instanceof PhaseGateError && error.waiting) ||
            error instanceof RepositoryMutationBusyError ||
            error instanceof WorktreeMutationBusyError ||
            error instanceof IntegrationHeldError
          )
            continue;
          const latest = this.find(roadmap.workspaceId, roadmap.id);
          if (latest.status !== 'running' || this.controlling.has(latest.id)) return;
          const reason =
            error instanceof ExecutionRequestError
              ? error.message
              : 'Could not prepare this item. Inspect it before resuming.';
          this.change(latest, {
            entryHolds: {
              ...latest.entryHolds,
              [entry.id]: { status: 'needs-attention', reason: reason.slice(0, 4000) },
            },
          });
        }
      }
      const current = this.find(roadmap.workspaceId, roadmap.id);
      if (current.status !== 'running') return;
      if (
        this.entriesComplete(current) &&
        (!current.definition.crossProject ||
          crossProjectState(this.storage, current.workspaceId, current.definition.crossProject)
            .selectedScopeComplete)
      ) {
        if (current.definition.crossProject) {
          const c = current.definition.crossProject,
            view = crossProjectState(this.storage, current.workspaceId, c);
          await this.runtimeEvidence?.assertSubjectsCurrent(
            current.workspaceId,
            c.definitionId,
            c.bindingRevision,
            view.nodes
              .filter((n) => n.included && n.kind === 'checkpoint')
              .map((n) => ({ kind: 'checkpoint' as const, sourceId: n.sourceId })),
          );
          const fresh = this.find(current.workspaceId, current.id);
          if (
            fresh.version !== current.version ||
            this.controlling.has(current.id) ||
            this.abort.signal.aborted
          )
            throw new SupersededRoadmapOperation();
          this.authority(fresh);
          if (!crossProjectState(this.storage, fresh.workspaceId, c).selectedScopeComplete) return;
        }
        this.change(current, {
          status: 'completed',
          reason: current.definition.crossProject
            ? 'Selected roadmap scope complete. Excluded obligations, finalization and publication retain their separate gates.'
            : 'All roadmap entries are completed.',
        });
      } else
        this.reason(
          current,
          'Parallel scheduling enabled. Items progress independently; integration follows each item’s merge policy.',
        );
      return;
    }
    const entry = roadmap.definition.entries.find((e) => !this.complete(roadmap, e));
    if (!entry) {
      this.change(roadmap, { status: 'completed', reason: 'All roadmap entries are completed.' });
      return;
    }
    await this.advanceEntry(roadmap, entry);
  }
  private async advanceEntry(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    recoveryAttempt?: RoadmapAttempt,
    reviewingRecovery = false,
  ): Promise<void> {
    const context = this.authority(roadmap);
    const parallel = roadmap.definition.scheduling?.mode === 'parallel';
    let attempt =
      recoveryAttempt ?? roadmap.attempts.find((a) => a.entryId === entry.id && !a.recovery);
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
          if (
            !reviewingRecovery &&
            roadmap.scopeRecovery?.enabled &&
            (await this.advanceScopeRecovery(roadmap, entry, cycle))
          )
            return;
          if (cycle.status === 'completed')
            conflict(
              'This review evidence is no longer current. Stop this roadmap and create a new selection for re-verification; prior attempts remain in history.',
            );
          if (cycle.status === 'awaiting-merge') {
            const definition = this.storage.roadmaps
              .history(roadmap.workspaceId, roadmap.id)
              .find((d) => d.revision === attempt!.definitionRevision);
            if (
              entry.executionScope.kind === 'slice-verification' ||
              definition?.crossProject?.parentAcceptance === 'automatic'
            ) {
              const check = () => {
                const latest = this.find(roadmap.workspaceId, roadmap.id);
                if (
                  latest.status !== 'running' ||
                  latest.entryHolds?.[entry.id] ||
                  this.controlling.has(latest.id) ||
                  this.abort.signal.aborted
                )
                  throw new SupersededRoadmapOperation();
                this.authority(latest);
              };
              check();
              if (
                await this.cycles.refreshIntegration(
                  cycle,
                  this.storage.execution.runs.find(roadmap.workspaceId, cycle.currentRunId),
                )
              )
                return;
              await this.execution.recordScopeReceipt(
                context,
                roadmap.workspaceId,
                worktree.id,
                worktree.version,
                { check },
              );
            }
          }
          return;
        }
      }
      if (worktree?.mergedAt) {
        this.change(roadmap, {
          attempts: roadmap.attempts.map((a) =>
            a.id === attempt?.id
              ? { ...a, status: 'completed' as const, completedAt: worktree.mergedAt }
              : a,
          ),
          reason: `${entry.sourceId} integrated.`,
          entryHolds: Object.fromEntries(
            Object.entries(roadmap.entryHolds ?? {}).filter(([id]) => id !== entry.id),
          ),
        });
        return;
      }
      if (
        this.storage.planning.workItems.find(roadmap.workspaceId, entry.workItemId)?.status ===
        'completed'
      )
        conflict(
          `${entry.sourceId}: Marked complete without merging the roadmap worktree. Merge its reviewed branch or stop this roadmap to reconcile the queue.`,
        );
      const cycle = this.storage.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
      if (cycle) {
        const boundAttempt = attempt;
        const definition = this.storage.roadmaps
          .history(roadmap.workspaceId, roadmap.id)
          .find((d) => d.revision === boundAttempt.definitionRevision);
        const bound = definition?.entries.find((e) => e.id === entry.id);
        const automation =
          bound?.automation ?? definition?.automation ?? DEFAULT_ROADMAP_AUTOMATION;
        const check = () => {
          const current = this.find(roadmap.workspaceId, roadmap.id);
          if (
            current.status !== 'running' ||
            current.entryHolds?.[entry.id] ||
            this.controlling.has(current.id) ||
            this.abort.signal.aborted
          )
            throw new SupersededRoadmapOperation();
          this.authority(current);
          if (
            boundAttempt.recovery &&
            (!current.scopeRecovery?.enabled ||
              current.entryHolds?.[boundAttempt.recovery.sourceEntryId] ||
              !current.attempts.some(
                (a) => a.id === boundAttempt.id && a.recovery?.phase === 'repair',
              ))
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
              profile: automation.resolutionProfile ?? entry.profiles.remediate,
            },
            check,
          );
          return;
        }
        const pending = this.storage.execution.merges.latest(
          roadmap.workspaceId,
          attempt.worktreeId,
        );
        if (
          automation.integrationMerge === 'automatic' &&
          (cycle.status === 'awaiting-merge' || pending?.status === 'reserved')
        ) {
          check();
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
          if (
            pending?.status !== 'reserved' &&
            (await this.cycles.refreshIntegration(
              cycle,
              this.storage.execution.runs.find(roadmap.workspaceId, cycle.currentRunId),
            ))
          )
            return;
          await this.execution.mergeWorktree(
            context,
            roadmap.workspaceId,
            attempt.worktreeId,
            {},
            undefined,
            { roadmapId: roadmap.id, definitionRevision: attempt.definitionRevision, check },
          );
          return;
        }
        if (parallel) return;
        if (['paused', 'needs-attention', 'stopped', 'completed'].includes(cycle.status))
          this.change(roadmap, {
            status: 'needs-attention',
            reason: `${entry.sourceId}: ${cycle.reason} Inspect its cycle before resuming the roadmap.`,
          });
        else
          this.reason(
            roadmap,
            `${entry.sourceId}: ${cycle.status === 'awaiting-merge' ? 'Awaiting your merge approval.' : cycle.reason}`,
          );
        return;
      }
    }
    const blocker = this.blocker(roadmap, entry, attempt);
    if (blocker) {
      if (parallel) {
        if (blocker.needsAttention) conflict(blocker.reason);
        return;
      }
      if (blocker.needsAttention)
        this.change(roadmap, { status: 'needs-attention', reason: blocker.reason });
      else this.reason(roadmap, blocker.reason);
      return;
    }
    this.cycles.validateSettings(entry);
    if (!attempt) {
      attempt = {
        id: randomUUID(),
        entryId: entry.id,
        definitionRevision: roadmap.definition.revision,
        worktreeId: asWorktreeId(randomUUID()),
        cycleId: randomUUID(),
        status: 'preparing',
        createdAt: this.now().toISOString(),
      };
      roadmap = this.change(roadmap, {
        attempts: [...roadmap.attempts, attempt],
        reason: `Preparing ${entry.sourceId}.`,
      });
    }
    const reserved = attempt;
    const check = () => {
      if (this.abort.signal.aborted) throw new SupersededRoadmapOperation();
      const current = this.find(roadmap.workspaceId, roadmap.id);
      if (current.version !== roadmap.version || current.status !== 'running')
        throw new SupersededRoadmapOperation();
      this.authority(current);
      const blocked = this.blocker(current, entry, reserved);
      if (blocked) conflict(blocked.reason);
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
        { id: reserved.worktreeId, check },
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
      );
      this.change(roadmap, {
        attempts: roadmap.attempts.map((a) =>
          a.id === reserved.id ? { ...a, status: 'active' } : a,
        ),
        reason: `Running ${entry.sourceId}.`,
      });
    });
  }
  private recoveryFor(roadmap: Roadmap, entry: RoadmapEntry) {
    return roadmap.attempts.find(
      (a) =>
        a.recovery &&
        a.recovery.phase !== 'completed' &&
        roadmap.definition.entries.some(
          (e) => e.id === a.entryId && e.workItemId === entry.workItemId,
        ),
    );
  }
  private updateRecovery(
    roadmap: Roadmap,
    attempt: RoadmapAttempt,
    changes: Partial<RoadmapAttempt>,
  ) {
    return this.change(roadmap, {
      attempts: roadmap.attempts.map((a) => (a.id === attempt.id ? { ...a, ...changes } : a)),
    });
  }
  /** Each round survives worktree replacement and returns through the original independent reviewers. */
  private async advanceScopeRecovery(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    sourceCycle: import('@craftingtable/domain').WorkCycle,
  ): Promise<boolean> {
    const ws = roadmap.workspaceId;
    let attempt = this.recoveryFor(roadmap, entry);
    if (attempt && attempt.recovery!.sourceEntryId !== entry.id) return true;
    if (!attempt) {
      if (sourceCycle.status !== 'needs-attention') return false;
      const decision = scopeRecoveryDecision(
        mapReadSnapshot(this.storage),
        roadmap,
        entry,
        sourceCycle,
      );
      if (decision.waiting) return true;
      if (!decision.owner) conflict(decision.reason!);
      const ownerAttempt = roadmap.attempts.find(
        (a) => a.entryId === decision.owner!.id && !a.recovery,
      );
      if (!ownerAttempt) conflict('The owning slice has no roadmap-bound implementation settings.');
      const blocked = this.blocker(roadmap, decision.owner);
      if (blocked) {
        if (blocked.needsAttention) conflict(blocked.reason);
        return true;
      }
      attempt = {
        id: randomUUID(),
        entryId: decision.owner.id,
        definitionRevision: ownerAttempt.definitionRevision,
        worktreeId: asWorktreeId(randomUUID()),
        cycleId: randomUUID(),
        status: 'preparing',
        createdAt: this.now().toISOString(),
        recovery: {
          sourceEntryId: entry.id,
          sourceRunId: sourceCycle.currentRunId,
          sourceSequence: decision.sourceSequence!,
          findingFingerprint: decision.fingerprint!,
          phase: 'repair',
          reviewRunIds: Object.fromEntries(
            roadmap.attempts.flatMap((a) => {
              const e = roadmap.definition.entries.find((e) => e.id === a.entryId);
              const c = this.storage.execution.cycles.find(ws, a.cycleId);
              return e?.workItemId === entry.workItemId && e.executionScope?.kind !== 'slice' && c
                ? [[e.id, c.currentRunId]]
                : [];
            }),
          ),
        },
      };
      roadmap = this.change(
        roadmap,
        { attempts: [...roadmap.attempts, attempt] },
        'reserve-scope-recovery',
      );
    }
    const reserved = attempt;
    const owner = roadmap.definition.entries.find((e) => e.id === reserved.entryId)!;
    const check = () => {
      const current = this.find(ws, roadmap.id);
      if (
        current.status !== 'running' ||
        !current.scopeRecovery?.enabled ||
        this.controlling.has(current.id) ||
        this.abort.signal.aborted ||
        current.entryHolds?.[entry.id] ||
        current.entryHolds?.[owner.id] ||
        !current.attempts.some((a) => a.id === reserved.id && a.recovery?.phase !== 'completed')
      )
        throw new SupersededRoadmapOperation();
      this.authority(current);
      if (
        bindingIssues(
          this.storage,
          ws,
          owner.executionScope!.definitionId,
          owner.executionScope!.bindingRevision,
        ).length
      )
        conflict('The recovery map binding changed. Reconcile the roadmap before continuing.');
    };
    check();
    const context = this.authority(roadmap);
    if (reserved.recovery!.phase === 'repair') {
      const tree = this.storage.execution.worktrees.find(ws, reserved.worktreeId);
      if (tree?.mergedAt) {
        this.updateRecovery(roadmap, reserved, {
          status: 'completed',
          completedAt: tree.mergedAt,
          recovery: { ...reserved.recovery!, phase: 'verification' },
        });
        return true;
      }
      if (reserved.status === 'preparing') {
        const sourceTurn = this.storage.execution.runEvents.latestOfKind(
          ws,
          sourceCycle.currentRunId,
          'turn-completed',
        );
        if (
          sourceCycle.currentRunId !== reserved.recovery!.sourceRunId ||
          sourceTurn?.sequence !== reserved.recovery!.sourceSequence
        )
          conflict(
            'The source review changed during recovery preparation. Inspect the reserved attempt.',
          );
        const blocked = this.blocker(roadmap, owner, reserved);
        if (blocked) {
          if (blocked.needsAttention) conflict(blocked.reason);
          return true;
        }
        const preview = collectScopeRepair(mapReadSnapshot(this.storage), sourceCycle);
        const frozen = this.storage.roadmaps
          .history(ws, roadmap.id)
          .find((d) => d.revision === reserved.definitionRevision)
          ?.entries.find((e) => e.id === owner.id);
        if (!frozen) conflict('Recovery settings are unavailable.');
        await this.cycles.delegateScopeRepair(
          context,
          ws,
          sourceCycle.id,
          {
            expectedVersion: sourceCycle.version,
            snapshotDigest: preview.snapshotDigest,
            sourceId: owner.executionScope!.sourceId,
            maxRemediationRounds: frozen.policy.maxRemediationRounds,
            instructions: frozen.instructions,
          },
          {
            worktreeId: reserved.worktreeId,
            cycleId: reserved.cycleId,
            profiles: frozen.profiles,
            policy: frozen.policy,
            check: () => {
              check();
              const blocker = this.blocker(this.find(ws, roadmap.id), owner, reserved);
              if (blocker) conflict(blocker.reason);
            },
            attach: () =>
              this.updateRecovery(this.find(ws, roadmap.id), reserved, { status: 'active' }),
          },
        );
        return true;
      }
      const repair = this.storage.execution.cycles.find(ws, reserved.cycleId);
      if (!repair) conflict('The reserved recovery cycle is unavailable.');
      if (
        ['needs-attention', 'paused', 'stopped'].includes(repair.status) &&
        !repair.integrationResolution
      )
        conflict(`Owning-slice recovery needs your input: ${repair.reason}`);
      await this.advanceEntry(roadmap, owner, reserved);
      return true;
    }
    const reviews = roadmap.definition.entries.filter(
      (e) =>
        e.workItemId === entry.workItemId && e.executionScope && e.executionScope.kind !== 'slice',
    );
    const verification = reviews.filter((e) => e.executionScope!.kind === 'slice-verification');
    const phase = verification.every((e) => this.complete(roadmap, e, this.storage, true))
      ? 'parent-review'
      : 'verification';
    if (phase !== reserved.recovery!.phase) {
      this.updateRecovery(roadmap, reserved, { recovery: { ...reserved.recovery!, phase } });
      return true;
    }
    const target = (
      phase === 'verification'
        ? verification
        : reviews.filter((e) => e.executionScope!.kind === 'parent-acceptance')
    ).find((e) => !this.complete(roadmap, e, this.storage, true));
    if (!target) {
      this.updateRecovery(roadmap, reserved, {
        recovery: { ...reserved.recovery!, phase: 'completed' },
      });
      return true;
    }
    if (roadmap.entryHolds?.[target.id]) return true;
    const reviewAttempt = roadmap.attempts.find((a) => a.entryId === target.id && !a.recovery);
    const cycle = reviewAttempt && this.storage.execution.cycles.find(ws, reviewAttempt.cycleId);
    if (!cycle) {
      await this.advanceEntry(roadmap, target, undefined, true);
      return true;
    }
    const blockers = scopePhaseBlockers(
      this.storage,
      ws,
      target.workItemId,
      target.executionScope!,
      phase === 'verification' ? 'verify' : 'accept',
      { ownerId: cycle.currentRunId },
    );
    if (blockers.length) throw new PhaseGateError(blockers);
    const prior = reserved.recovery!.reviewRunIds[target.id];
    if (
      cycle.status === 'completed' ||
      (cycle.currentRunId === prior && ['needs-attention', 'paused'].includes(cycle.status))
    ) {
      const restarts = reserved.recovery!.reviewRestarts?.[target.id] ?? 0;
      const settings =
        this.storage.roadmaps
          .history(ws, roadmap.id)
          .find((d) => d.revision === reviewAttempt!.definitionRevision)?.scheduling ??
        DEFAULT_ROADMAP_SCHEDULING;
      if (restarts >= settings.maxIntegrationRefreshes)
        conflict(
          'Recovery review refresh allowance exhausted. Inspect and refresh this scope manually before resuming.',
        );
      const attach = () => {
        const current = this.find(ws, roadmap.id);
        const round = current.attempts.find((a) => a.id === reserved.id)!;
        this.change(current, {
          attempts: current.attempts.map((a) =>
            a.id === reviewAttempt!.id
              ? { ...a, status: 'active', completedAt: undefined }
              : a.id === reserved.id
                ? {
                    ...a,
                    recovery: {
                      ...round.recovery!,
                      reviewRestarts: {
                        ...round.recovery!.reviewRestarts,
                        [target.id]: restarts + 1,
                      },
                    },
                  }
                : a,
          ),
        });
      };
      if (cycle.status === 'completed')
        await this.cycles.repeatScopeReview(
          context,
          ws,
          cycle.id,
          cycle.version,
          '',
          check,
          attach,
        );
      else
        await this.cycles.control(
          context,
          ws,
          cycle.id,
          'resume',
          cycle.version,
          undefined,
          check,
          attach,
        );
      return true;
    }
    if (['needs-attention', 'paused', 'stopped'].includes(cycle.status)) {
      // This round reached an independent verdict. Any further repair consumes a new round.
      this.updateRecovery(roadmap, reserved, {
        recovery: { ...reserved.recovery!, phase: 'completed' },
      });
      return true;
    }
    await this.advanceEntry(roadmap, target, undefined, true);
    return true;
  }
  private entriesComplete(roadmap: Roadmap): boolean {
    const tx = mapReadSnapshot(this.storage);
    return roadmap.definition.entries.every((entry) => this.complete(roadmap, entry, tx));
  }
  private reconcileCompletedAttempts(roadmap: Roadmap): Roadmap {
    const tx = mapReadSnapshot(this.storage);
    let changed = false;
    const entryHolds = { ...roadmap.entryHolds };
    const attempts = roadmap.attempts.map((attempt) => {
      if (attempt.recovery || attempt.status === 'completed') return attempt;
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
      if (!mergedAt && !this.complete(roadmap, entry, tx)) return attempt;
      changed = true;
      delete entryHolds[entry.id];
      return {
        ...attempt,
        status: 'completed' as const,
        completedAt: mergedAt ?? this.now().toISOString(),
      };
    });
    return changed ? this.change(roadmap, { attempts, entryHolds }) : roadmap;
  }
  private deferredEntries(roadmap: Roadmap): ReadonlySet<string> {
    const tx = mapReadSnapshot(this.storage);
    return new Set(
      roadmap.definition.entries.flatMap((entry) => {
        const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
        if (this.complete(roadmap, entry, tx))
          return !attempt || attempt.status === 'completed' ? [entry.id] : [];
        if (attempt) return [];
        const blocker = this.blocker(roadmap, entry, undefined, tx);
        return blocker && !blocker.needsAttention ? [entry.id] : [];
      }),
    );
  }
  private complete(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    tx: StorageRepositories = this.storage,
    ignoreRecovery = false,
  ): boolean {
    if (
      roadmap.scopeRecovery?.enabled &&
      !ignoreRecovery &&
      this.recoveryFor(roadmap, entry)?.recovery?.sourceEntryId === entry.id
    )
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
  private blocker(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    attempt?: RoadmapAttempt,
    tx: StorageRepositories = this.storage,
  ):
    | {
        reason: string;
        needsAttention: boolean;
        kind: 'dependency-blocked' | 'capacity-blocked' | 'exclusion-blocked';
      }
    | undefined {
    const blocked = (
      reason: string,
      needsAttention = true,
      kind: 'dependency-blocked' | 'capacity-blocked' | 'exclusion-blocked' = 'dependency-blocked',
    ) => ({ reason, needsAttention, kind });
    const item = tx.planning.workItems.find(roadmap.workspaceId, entry.workItemId);
    if (!item || item.planVersionId !== entry.planVersionId)
      return blocked(`${entry.sourceId}: Bound plan item is unavailable.`);
    if (item.status === 'completed' && attempt && !entry.executionScope)
      return blocked(
        `${entry.sourceId}: Marked complete without merging the roadmap worktree. Inspect the item; the queue will not advance.`,
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
    const required = tx.planning.dependencies
      .listPredecessors(roadmap.workspaceId, entry.workItemId)
      .filter(
        (e) =>
          e.kind === 'required' &&
          (e.status !== 'completed' ||
            roadmap.attempts.some(
              (a) =>
                a.status !== 'completed' &&
                roadmap.definition.entries.some(
                  (bound) => bound.id === a.entryId && bound.workItemId === e.workItemId,
                ),
            )),
      );
    if (
      required.length &&
      !scopeAllowsEarlyDevelopment(tx, roadmap.workspaceId, entry.workItemId, entry.executionScope)
    )
      return blocked(
        `${entry.sourceId}: Waiting for required predecessors: ${required.map((e) => `${e.sourceId}${roadmap.definition.entries.some((item) => item.workItemId === e.workItemId) ? '' : ' (outside this roadmap)'}`).join(', ')}.`,
        false,
      );
    const settings = tx.execution.branchSettings.find(roadmap.workspaceId, entry.planVersionId);
    if (
      settings?.repositoryId !== entry.repositoryId ||
      settings.integrationBranch !== entry.integrationBranch
    )
      return blocked(
        `${entry.sourceId}: Plan branch settings changed. Pause and save queued settings to adopt the new target.`,
      );
    const repo = tx.execution.sourceRepositories.find(roadmap.workspaceId, entry.repositoryId);
    if (repo?.status !== 'active') return blocked(`${entry.sourceId}: Repository is unavailable.`);
    if (!attempt && this.execution.branches.repositoryBusy(repo.rootPath))
      return blocked(
        `${entry.sourceId}: Waiting for a repository mutation to finish.`,
        false,
        'capacity-blocked',
      );
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
    if (!reviewOnly && parallel && activeAttempts.length >= policy.maxInFlight)
      return blocked(
        `${entry.sourceId}: All ${policy.maxInFlight} in-flight slots are occupied (including items awaiting merge or attention).`,
        false,
        'capacity-blocked',
      );
    const trees = tx.execution.worktrees
      .listActive()
      .filter(
        (t) =>
          !tx.amendments.retired(t.workspaceId, t.id) &&
          (!t.executionScope || t.executionScope.kind === 'slice'),
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
    if (!reviewOnly && occupied.length + reservations >= repositoryLimit)
      return blocked(
        `${entry.sourceId}: Repository has ${occupied.length + reservations} unmerged worktree(s) or reservations; capacity is ${repositoryLimit}. Finish or remove existing work before this item starts.`,
        false,
        'capacity-blocked',
      );
    return undefined;
  }
  private view(roadmap: Roadmap): RoadmapView {
    const snapshot = mapReadSnapshot(this.storage);
    const capacity = (key: string) => ({
      limit: snapshot.phaseScheduling.capacity(key),
      inUse: snapshot.phaseScheduling.active().filter((r) => r.resourceKey === key).length,
    });
    return {
      roadmap,
      hostCapacity: {
        development: capacity('local-development'),
        verification: capacity('local-verification'),
      },
      progress: roadmap.definition.entries
        .map((entry): import('@craftingtable/domain').RoadmapEntryProgress => {
          if (this.complete(roadmap, entry, snapshot))
            return { entryId: entry.id, status: 'completed', reason: 'Completed.' };
          const hold = roadmap.entryHolds?.[entry.id];
          if (hold) return { entryId: entry.id, status: hold.status, reason: hold.reason };
          const recovery = this.recoveryFor(roadmap, entry);
          if (
            roadmap.scopeRecovery?.enabled &&
            recovery &&
            entry.executionScope?.kind !== 'slice'
          ) {
            const repair = snapshot.execution.cycles.find(roadmap.workspaceId, recovery.cycleId);
            const repairNeedsYou =
              recovery.recovery!.phase === 'repair' &&
              repair &&
              ['paused', 'needs-attention', 'stopped'].includes(repair.status);
            return {
              entryId: entry.id,
              status: repairNeedsYou
                ? 'needs-attention'
                : roadmap.status === 'running'
                  ? 'running'
                  : 'paused',
              reason: repairNeedsYou
                ? `Owning-slice recovery: ${repair.reason}`
                : `Roadmap recovery: ${recovery.recovery!.phase === 'repair' ? 'repair and integration' : recovery.recovery!.phase === 'verification' ? 'fresh independent verification' : 'parent acceptance'}.`,
            };
          }
          const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
          const cycle =
            attempt && snapshot.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
          if (
            entry.executionScope &&
            (!cycle || ['running', 'awaiting-merge'].includes(cycle.status))
          ) {
            const phase =
              entry.executionScope.kind === 'parent-acceptance'
                ? 'accept'
                : entry.executionScope.kind === 'slice-verification'
                  ? 'verify'
                  : cycle?.status === 'awaiting-merge'
                    ? 'merge'
                    : 'start';
            const blockers = scopePhaseBlockers(
              snapshot,
              roadmap.workspaceId,
              entry.workItemId,
              entry.executionScope,
              phase,
              { ownerId: cycle?.currentRunId },
            );
            if (blockers.length)
              return {
                entryId: entry.id,
                status: blockers.some((b) => b.kind === 'authorization' || b.kind === 'review')
                  ? 'needs-attention'
                  : blockers.some((b) => b.kind === 'resource')
                    ? 'capacity-blocked'
                    : 'dependency-blocked',
                reason: blockers.map((b) => `${phase} · ${b.kind}: ${b.message}`).join(' '),
                phase,
                blockers,
              };
          }
          if (cycle)
            return {
              entryId: entry.id,
              status:
                cycle.status === 'running'
                  ? 'running'
                  : cycle.status === 'awaiting-merge'
                    ? 'awaiting-merge'
                    : 'needs-attention',
              reason: cycle.reason,
            };
          const reason = this.blocker(roadmap, entry, attempt, snapshot);
          return {
            entryId: entry.id,
            status: reason?.needsAttention ? 'needs-attention' : reason ? reason.kind : 'queued',
            reason: reason?.reason ?? 'Waiting for its turn in the sequence.',
          };
        })
        .map((progress) => {
          const attempt = roadmap.attempts.find((a) => a.entryId === progress.entryId);
          const definition = attempt
            ? snapshot.roadmaps
                .history(roadmap.workspaceId, roadmap.id)
                .find((d) => d.revision === attempt.definitionRevision)
            : roadmap.definition;
          return {
            ...progress,
            effectiveAutomation:
              definition?.entries.find((e) => e.id === progress.entryId)?.automation ??
              definition?.automation ??
              DEFAULT_ROADMAP_AUTOMATION,
          };
        }),
    };
  }
  private find(workspaceId: WorkspaceId, id: string): Roadmap {
    const roadmap = this.storage.roadmaps.find(workspaceId, id);
    if (!roadmap) throw new NotFoundError();
    return roadmap;
  }
  private reason(roadmap: Roadmap, reason: string): void {
    const bounded = reason.slice(0, 4000);
    if (roadmap.reason !== bounded) this.change(roadmap, { reason: bounded });
  }
  private change(
    roadmap: Roadmap,
    changes: Partial<Roadmap>,
    action = 'advance',
    context?: AuthContext,
  ): Roadmap {
    const updated = {
      ...roadmap,
      ...changes,
      reason: (changes.reason ?? roadmap.reason).slice(0, 4000),
      version: roadmap.version + 1,
      updatedAt: this.now().toISOString(),
    };
    this.storage.transaction((tx) => this.persist(tx, updated, roadmap.version, action, context));
    this.notifier.notify();
    return updated;
  }
  private persist(
    tx: StorageRepositories,
    roadmap: Roadmap,
    expectedVersion: number,
    action: string,
    context?: AuthContext,
  ): void {
    if (!tx.roadmaps.save(roadmap, expectedVersion))
      conflict('Roadmap changed during this operation.');
    const actorUserId = context?.user.id ?? roadmap.delegatedByUserId ?? roadmap.createdByUserId;
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: roadmap.updatedAt,
      workspaceId: roadmap.workspaceId,
      actorKind: context ? 'user' : 'system',
      actorUserId,
      ...(context ? { sessionId: context.session.id } : {}),
      action: 'roadmap.updated',
      targetType: 'roadmap',
      targetId: roadmap.id,
      outcome: 'succeeded',
      resultingVersion: roadmap.version,
      metadata: {
        action,
        status: roadmap.status,
        revision: roadmap.definition.revision,
        reason: roadmap.reason,
        ...(action === 'configure-scope-recovery' && roadmap.scopeRecovery
          ? {
              recoveryEnabled: roadmap.scopeRecovery.enabled,
              maxRecoveryRoundsPerParent: roadmap.scopeRecovery.maxRoundsPerParent,
            }
          : {}),
      },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt: roadmap.updatedAt,
      workspaceId: roadmap.workspaceId,
      actorUserId,
      kind: 'roadmap-changed',
      payload: { roadmapId: roadmap.id, status: roadmap.status, reason: roadmap.reason },
    });
  }
}
