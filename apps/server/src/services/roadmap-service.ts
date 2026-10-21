import { RoadmapSelection } from './roadmap/selection.js';
import { RoadmapHolds } from './roadmap/holds.js';
import { RoadmapWriter } from './roadmap/writer.js';
import { RoadmapState } from './roadmap/state.js';
import {
  type RoadmapDefinitionInput,
  SupersededRoadmapOperation,
  MergeTargetMovedRetry,
  TARGET_MOVED_RETRY_MS,
  retried,
  ended,
  PREPARATION_RETRY_MS,
  holdCause,
  gated,
  holdRefs,
  stopAttention,
  refuseBlocked,
  EntryHoldError,
  RESUMED_REASON,
  type PreparationTarget,
  answeredHolds,
  conflict,
  entryReason,
  type SchedulerObserver,
  RETRY_SOON_MS,
} from './roadmap/shared.js';
import { investigationHolds, investigationLive, worktreeChangeOpen } from './investigation.js';
import {
  decisionBindingDigest,
  supportsArchitectureDecision,
} from './architecture-decision-policy.js';
import { roadmapPath } from './roadmap-paths.js';
import {
  RoadmapSettlement,
  SESSION_WAIT_LIMIT_MS,
  type SettlementObserver,
} from './roadmap-settlement.js';
import {
  ControllerKernel,
  type KernelClock,
  type Marked,
  type MarkCause,
  SWEEP_MS,
  systemClock,
} from './kernel/controller-kernel.js';
import { type DrainSummary, drainSummary } from './kernel/figures.js';
import { retiredOrRetiring } from './retired-versions.js';
import { cycleOwnership, ownerOf } from './cycle-ownership.js';
import { itemGate } from './transition-gate.js';
import {
  currentDecisionPreparation,
  preparedDecisionAccepted,
} from './decision-preparation-policy.js';
import {
  attemptDefinition,
  attemptDelegation,
  delegationWaits,
  effectiveDelegation,
} from './roadmap-delegation-policy.js';
import { randomUUID } from 'node:crypto';
import { activeEditor } from './authority-policy.js';
import type {
  PrepareRoadmapDecision,
  ApplyRoadmapAgents,
  ApplyRoadmapDelegation,
  RoadmapAgentSettings,
  RoadmapCapacities,
  SaveRoadmapCapacity,
  SaveRoadmapRequest,
  DecisionPreparationGrantRequest,
  ReverificationGrantRequest,
  ScopeRecoveryPolicyRequest,
  ScopeRepairRequest,
  CrossProjectView,
  RoadmapBoard,
  RoadmapGraph,
} from '@craftingtable/contracts';
import { roadmapEntryFieldsSchema } from '@craftingtable/contracts';
import {
  asAgentAssignmentId,
  asAgentRunId,
  asCheckpointId,
  asDecisionPreparationId,
  asDelegationAssignmentId,
  asRoadmapAttemptId,
  asWorkCycleId,
  asWorktreeId,
  type AttentionItem,
  DEFAULT_ROADMAP_SCHEDULING,
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapDefinition,
  type RoadmapEntry,
  type RoadmapId,
  type RoadmapStatusEntry,
  type RoadmapStatusList,
  type RoadmapView,
  ENTRY_WAIT,
  mergeAdoptsChecks,
  roadmapAttention,
  PHASE_BLOCKERS,
  operatorOwnsAll,
  sameExecutionScope,
  type WorkCycle,
  type WorkspaceId,
  startedAttempts,
  type AgentSelection,
  type RoadmapEntryId,
  type WorkCycleId,
  type ConcurrencyDefinitionId,
  cycleStop,
  roadmapStop,
  holdStop,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';

import {
  delegatedResolutionProfile,
  entryAgentSelections,
  entryAgents,
  latestAssignment,
  preparationAgent,
  stepPermissions,
  withPermissions,
} from './agent-profile-policy.js';
import { selectionSet } from './agent-resolution.js';
import type { ControllerPasses } from './attention-gates.js';
import type { AttentionProjector, ProjectedItem } from './attention-projector.js';
import type { AuthContext, CommandContext } from './auth-service.js';
import { IntegrationHeldError, RepositoryMutationBusyError } from './branch-service.js';
import { checkpointSubjectKey } from './checkpoint-subject.js';
import { bindingIssues } from './map-binding-policy.js';
import { crossProjectState, effectiveMapLevel, mapActivity } from './map-state.js';
import { neededDecisions, slicesHeldBy, slicesWaitingOn } from './decision-demand.js';
import { decisionSettlement, settlementLines } from './decision-settlement.js';
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
} from './entry-waits.js';
import {
  CheckAdoptionRequiredError,
  ConcurrentModificationError,
  DaemonDrainingError,
  DeclaredChecksMissingError,
  ExecutionRequestError,
  NotFoundError,
  TypedRefusalError,
  windDownRefused,
} from './errors.js';
import { resolveScope, scopePhaseBlockers } from './execution-scope.js';
import type { ExecutionService } from './execution-service.js';
import { carryPlanAcceptance } from './generated-plan-evidence.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { operatorSetupItem } from './operator-setup-item.js';
import { PhaseGateError } from './phase-resources.js';
import {
  buildBoard,
  type ItemSubject,
  itemNodeKeys,
  itemSubjectOf,
  mapGraph,
  type NodeEvaluation,
  sequenceGraph,
} from './roadmap-board.js';
import {
  findingFingerprint,
  roadmapCarriesRound,
  scopeRecoveryDecision,
} from './scope-recovery-policy.js';
import { collectScopeRepair } from './scope-repair.js';
import type { WorkCycleService } from './work-cycle-service.js';
import type { WorkItemService } from './work-item-service.js';
import { securityReviewCurrent, workflowContext } from './workflow-policy.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationBusyError } from './worktree-mutation-guard.js';

/**
 * What a shared decision's item says of the work it serves (LIVE-22): the roadmap's selected
 * slices an accepted clause-level decision settles it for, and the selected slices and work
 * items that still need it. Nothing to add when nothing is settled and nothing selected needs
 * it directly (it is needed through another milestone): the plain line says it all.
 */
function decisionNeeds(
  tx: StorageRepositories,
  ws: WorkspaceId,
  selection: { readonly definitionId: ConcurrencyDefinitionId; readonly bindingRevision: number },
  nodes: readonly {
    readonly kind: string;
    readonly sourceId: string;
    readonly included: boolean;
  }[],
  checkpointId: string,
): string | undefined {
  const d = tx.imports.definition(ws, selection.definitionId);
  if (!d) return undefined;
  const selected = new Set(
    nodes
      .filter((n) => (n.kind === 'slice' || n.kind === 'work_item') && n.included)
      .map((n) => n.sourceId),
  );
  return settlementLines(
    decisionSettlement(tx, ws, d, selection.bindingRevision, checkpointId),
    selected,
  );
}

type CheckpointNode = {
  readonly key: string;
  readonly kind: string;
  readonly sourceId: string;
  readonly included: boolean;
  readonly satisfied: boolean;
  readonly blockers: readonly string[];
  readonly requirements: readonly string[];
};

/**
 * What the operator is needed for now (R-C14, LIVE-10): per entry, the checkpoint IDs only the
 * operator settles that stand between the entry and progress; and all of them together.
 *
 * - The operator settles a decision, a plan acceptance, and evidence no slice review produces
 *   (a checkpoint no slice requires at merge). A slice's merge checkpoint is produced by that
 *   slice's own delegated review, or its cycle stops for the operator itself.
 * - An entry is on the frontier when every blocker is the operator's or a checkpoint. From
 *   its checkpoints, the walk follows unmet checkpoint prerequisites (a decision behind a
 *   delegated review), and keeps those the operator settles and can answer now.
 * - Once every entry is complete, every checkpoint the selected scope still needs.
 */
function operatorNeeds(
  nodes: readonly CheckpointNode[],
  mergeRequired: ReadonlySet<string>,
  decisionKinds: ReadonlyMap<string, string>,
  progress: RoadmapView['progress'],
): { readonly all: ReadonlySet<string>; readonly byEntry: ReadonlyMap<string, readonly string[]> } {
  const bySource = new Map(
    nodes.filter((n) => n.kind === 'checkpoint').map((n) => [n.sourceId, n]),
  );
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const settledByOperator = (node: CheckpointNode) =>
    ['architecture_decision', 'plan_approval'].includes(decisionKinds.get(node.sourceId) ?? '') ||
    !mergeRequired.has(node.sourceId);
  const all = new Set<string>();
  const byEntry = new Map<string, readonly string[]>();
  for (const p of progress) {
    if (
      p.status === 'completed' ||
      !p.blockers?.length ||
      !p.blockers.every(
        (b) => PHASE_BLOCKERS[b.code].owner === 'operator' || !!b.refs?.checkpointId,
      )
    )
      continue;
    const seen = new Set<string>();
    const queue = p.blockers.flatMap((b) => {
      const node = b.refs?.checkpointId ? bySource.get(b.refs.checkpointId) : undefined;
      return node && !node.satisfied ? [node.key] : [];
    });
    const needed: CheckpointNode[] = [];
    while (queue.length) {
      const key = queue.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const node = byKey.get(key);
      if (node?.kind !== 'checkpoint' || node.satisfied) continue;
      if (settledByOperator(node) && node.included && !node.blockers.length) needed.push(node);
      queue.push(...node.requirements);
    }
    if (needed.length)
      byEntry.set(
        p.entryId,
        needed.map((n) => n.sourceId),
      );
    for (const node of needed) all.add(node.key);
  }
  if (progress.every((p) => p.status === 'completed'))
    for (const node of bySource.values())
      if (node.included && !node.satisfied && !node.blockers.length) all.add(node.key);
  return { all, byEntry };
}

/**
 * Whether only the operator can move this entry now: the checkpoints it waits on need the
 * operator, or every blocker is the operator's own setup. The inbox, the entries' state and
 * the status list use this one rule (R-C14).
 */
function operatorActsNext(
  progress: Pick<RoadmapView['progress'][number], 'entryId' | 'blockers'>,
  needs: { readonly byEntry: ReadonlyMap<string, readonly string[]> } | undefined,
): boolean {
  return !!needs?.byEntry.has(progress.entryId) || operatorOwnsAll(progress.blockers);
}

/** What callers import from the facade (the scheduler replay, the tests). */
export {
  type EntryPassOutcome,
  openRecoveries,
  type RoadmapDefinitionInput,
  type SchedulerObserver,
} from './roadmap/shared.js';

export class RoadmapService {
  private readonly state: RoadmapState;
  private readonly writer: RoadmapWriter;
  private readonly selection: RoadmapSelection;
  private readonly holds: RoadmapHolds;
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly items: WorkItemService,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly notifier: WorkspaceEventNotifier,
    now: () => Date,
    private readonly runtimeEvidence: import('./runtime-evidence-service.js').RuntimeEvidenceService,
    private readonly agents: import('./agent-run-service.js').AgentRunService,
    private readonly git: import('@craftingtable/git').GitOperations | undefined,
    clock: KernelClock = systemClock(now),
  ) {
    // The roadmap drain (R-B5 part 2): marked by every workflow notification and waking write
    // (coarse, decision 2), by a command's release, by the release of a lock a roadmap waited
    // on, by its own due times, and by the cycle kernel's sweep.
    this.state = new RoadmapState(now, new ControllerKernel(clock, SWEEP_MS, false));
    this.writer = new RoadmapWriter(storage, notifier, this.state);
    this.selection = new RoadmapSelection(storage, execution, notifier, this.state);
    this.holds = new RoadmapHolds(
      storage,
      execution,
      cycles,
      this.state,
      this.writer,
      this.selection,
    );
    cycles.followSweep(this.state.kernel);
    notifier.onWorkflow(() => this.state.kernel.mark('workflow'));
    cycles.onLockRelease((key) => this.lockReleased(key));
    this.settlement = new RoadmapSettlement(
      storage,
      workspaces,
      cycles,
      agents,
      notifier,
      now,
      (tx, roadmap, expectedVersion, action, context) =>
        this.writer.persist(tx, roadmap, expectedVersion, action, context),
    );
  }
  /** Stop and wind-down's one path (R-B11, ADR-073). */
  private readonly settlement: RoadmapSettlement;
  /** Test seam: told after each settle step; a test injects a crash by throwing. */
  observeSettlement(observer: SettlementObserver | undefined): void {
    this.settlement.observe(observer);
  }
  /** A roadmap's settlement record and what winding it down would do now (R-B11). */
  windDownView(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId) {
    return this.settlement.view(context, workspaceId, id);
  }
  /** Winds a roadmap down: settles it and retires the chosen plan versions (R-B11, ADR-073). */
  async windDown(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: Parameters<RoadmapSettlement['windDown']>[3],
  ) {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.state.controlling.has(id))
      windDownRefused('wind-down-in-progress', 'A roadmap command is already in progress.');
    this.state.controlling.add(id);
    try {
      await this.settlement.windDown(context, workspaceId, id, input);
    } finally {
      this.state.endControl(id);
      this.notifier.notify();
    }
    return this.settlement.view(context, workspaceId, id);
  }

  /**
   * The stored roadmap, for the access guard's step-up check (R-G9): read only after the caller's
   * role was checked, and only to see whether its settings grant an unrestricted agent.
   */
  storedWork(workspaceId: WorkspaceId, roadmapId: RoadmapId): unknown {
    return this.storage.roadmaps.find(workspaceId, roadmapId);
  }
  /** Replay seam: observe how each pass leaves each entry it reaches. */
  observeScheduling(observer: SchedulerObserver | undefined): void {
    this.state.observer = observer;
  }
  /** Attention projection and controller quiescence (R-A4); the daemon always attaches them. */
  attachAttention(attention: AttentionProjector, passes: ControllerPasses): void {
    this.state.attention = attention;
    this.state.passes = passes;
  }

  list(context: AuthContext, workspaceId: WorkspaceId): readonly RoadmapView[] {
    this.workspaces.requireAuthorized(context, workspaceId);
    // One read snapshot for the whole list: roadmaps share definitions, evidence
    // and scheduling reads, so a per-roadmap snapshot re-decoded them (PERF-08a).
    const snapshot = mapReadSnapshot(this.storage);
    return this.storage.roadmaps.list(workspaceId).map((roadmap) => this.view(roadmap, snapshot));
  }
  /**
   * A roadmap's agents as its setup edits them (R-E5b): each entry's effective agents with their
   * sources, its step permissions, and on a map roadmap its activity and settings level.
   */
  agentSettings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
  ): RoadmapAgentSettings {
    this.workspaces.requireAuthorized(context, workspaceId);
    const r = this.writer.find(workspaceId, id);
    const held = this.settingsHeld(workspaceId, r);
    const cp = r.definition.crossProject;
    const binding =
      cp &&
      this.storage.imports
        .bindings(workspaceId, cp.definitionId)
        .find((b) => b.revision === cp.bindingRevision);
    return {
      id: r.id,
      name: r.definition.name,
      version: r.version,
      status: r.status,
      editBlocker: held.running
        ? 'A roadmap command is in progress.'
        : held.ended
          ? 'This roadmap has ended. Its agents can no longer change.'
          : held.settling
            ? 'This roadmap is being stopped.'
            : held.amendment
              ? 'Decide the pending planning amendment first.'
              : null,
      entries: r.definition.entries.map((e) => {
        const agents = entryAgents(r, e);
        const assignment = latestAssignment(r, e.id);
        const activity = cp ? mapActivity(e) : undefined;
        const alias = binding?.bindings.find((b) => b.planVersionId === e.planVersionId)?.alias;
        const level =
          cp && alias !== undefined && e.executionScope
            ? effectiveMapLevel(cp, alias, mapActivity(e), e.executionScope.sourceId)
            : undefined;
        return {
          id: e.id,
          label: e.sourceId + (e.executionScope ? ` · ${e.executionScope.kind}` : ''),
          projectId: e.projectId,
          projectName:
            this.storage.planning.projects.find(workspaceId, e.projectId)?.name ?? e.projectId,
          selections: selectionSet(agents),
          agents,
          permissions: stepPermissions(e.profiles),
          ...(activity ? { activity } : {}),
          ...(cp
            ? { settingsLevel: level ? { level: level.level, key: level.key } : 'defaults' }
            : {}),
          ...(assignment ? { appliedAt: assignment.appliedAt } : {}),
          started: startedAttempts(r).some((a) => a.entryId === e.id),
        };
      }),
    };
  }
  applyAgentSettings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: ApplyRoadmapAgents,
  ): RoadmapAgentSettings {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const old = this.writer.find(workspaceId, id);
    this.requireSettingsOpen(
      workspaceId,
      old,
      input,
      'grant',
      'Roadmap changed. Refresh agent settings and review the current selection before applying.',
    );
    this.requireNoPendingAmendment(
      workspaceId,
      old,
      'Decide the pending planning amendment first.',
    );
    if (
      new Set(input.entryIds).size !== input.entryIds.length ||
      input.entryIds.some((id) => !old.definition.entries.some((e) => e.id === id))
    )
      conflict('Select current entries from this roadmap.');
    this.cycles.validateAgentSelections(input.selections);
    this.cycles.requireModelIds(
      Object.entries(input.selections),
      old.definition.entries
        .filter((entry) => input.entryIds.includes(entry.id))
        .flatMap((entry) => Object.entries(entryAgentSelections(old, entry).selections)),
    );
    const assignment = {
      id: asAgentAssignmentId(randomUUID()),
      entryIds: input.entryIds,
      selections: input.selections,
      appliedAt: this.state.now().toISOString(),
      appliedByUserId: context.user.id,
    };
    this.writer.change(
      old,
      { agentAssignments: [...(old.agentAssignments ?? []), assignment] },
      'apply-agent-profiles',
      context,
    );
    return this.agentSettings(context, workspaceId, id);
  }
  /**
   * A stopped cycle's agents, as an ADR-064 assignment for its own entry (R-C17 part 4, decision
   * 5; ADR-064 amended): appended from the cycle's settings change at any roadmap status, since the
   * entry's cycle is paused or stopped for the operator and launches nothing until resumed. The
   * cycle's command has checked the selections; the roadmap's own conditions hold here (no roadmap
   * command running, no pending amendment, the entry still in the roadmap). Later assignments
   * displace it, as ADR-064 has them.
   */
  assignCycleEntryAgents(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    entryId: RoadmapEntryId,
    selections: import('@craftingtable/domain').AgentSelections,
  ): void {
    const old = this.writer.find(workspaceId, id);
    if (this.state.controlling.has(id))
      conflict('A roadmap command is running. Change this cycle’s agents once it ends.');
    this.requireNoPendingAmendment(
      workspaceId,
      old,
      'Decide the pending planning amendment first.',
    );
    if (!old.definition.entries.some((entry) => entry.id === entryId))
      conflict('This cycle’s roadmap entry is no longer in its roadmap.');
    const assignment = {
      id: asAgentAssignmentId(randomUUID()),
      entryIds: [entryId],
      selections,
      appliedAt: this.state.now().toISOString(),
      appliedByUserId: context.user.id,
    };
    this.writer.change(
      old,
      { agentAssignments: [...(old.agentAssignments ?? []), assignment] },
      'apply-agent-profiles',
      context,
    );
  }
  decisionSettings(context: AuthContext, ws: WorkspaceId, id: RoadmapId) {
    this.workspaces.requireAuthorized(context, ws);
    const roadmap = this.writer.find(ws, id),
      cp = roadmap.definition.crossProject;
    const d = cp && this.storage.imports.definition(ws, cp.definitionId);
    const binding = cp && this.storage.imports.bindings(ws, cp.definitionId)[0];
    return {
      version: roadmap.version,
      status: roadmap.status,
      decisions: (d?.source.checkpoints ?? [])
        .filter((c) => supportsArchitectureDecision(d!, c.id))
        .flatMap((c) => {
          const owner = binding?.bindings.find((b) => b.alias === c.owner);
          const entry = roadmap.definition.entries.find(
            (e) => e.planVersionId === owner?.planVersionId,
          );
          if (!entry) return [];
          const latest = roadmap.decisionPreparations?.findLast((p) => p.checkpointId === c.id);
          const run = latest && this.storage.execution.runs.find(ws, latest.runId);
          return [
            {
              id: c.id,
              title: c.title,
              ...(() => {
                const agent = preparationAgent(roadmap, entry);
                return { profile: agent.selection, agent };
              })(),
              ...(latest
                ? {
                    latest: {
                      runId: latest.runId,
                      status: latest.failure ? 'failed' : (run?.status ?? 'preparing'),
                      summary: latest.failure ?? run?.outcomeSummary ?? '',
                      createdAt: latest.createdAt,
                    },
                  }
                : {}),
            },
          ];
        }),
    };
  }
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
    return this.view(this.writer.find(ws, id));
  }
  /** The exact map checkpoint a preparation would prepare, and its bound owner, or why not. */
  private preparationTarget(
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
    const checkpoint = d.source.checkpoints.find((c) => c.id === checkpointId)!;
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
  private async releaseSettledPreparations(roadmap: Roadmap): Promise<void> {
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
  private preparationInFlight(p: import('@craftingtable/domain').DecisionPreparation): boolean {
    const run = this.storage.execution.runs.find(p.workspaceId, p.runId);
    return !p.failure && (!run || ['starting', 'running', 'waiting'].includes(run.status));
  }
  /**
   * Reserves, prepares the worktree for, and launches one read-only preparation. Its record binds
   * the exact map binding and digest; `authorize` re-checks who may still prepare it. A failure
   * after the reservation is recorded on the preparation.
   */
  private async launchPreparation(
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
      const result = await this.git!.resolveBranch(repo.rootPath, owner.integrationBranch);
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
      await this.execution.createDecisionWorktree(context, p, check);
      check();
      await this.agents.startDecisionPreparation(context, p, check);
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
              ? current.decisionPreparations!.filter((p) => p.id !== reserved!.id)
              : current.decisionPreparations!.map((p) =>
                  p.id === reserved!.id
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
  private async prepareNeededDecisions(roadmap: Roadmap): Promise<void> {
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
  private grantor(roadmap: Roadmap) {
    return activeEditor(
      this.storage,
      roadmap.decisionPreparationGrant?.grantedByUserId,
      roadmap.workspaceId,
    );
  }
  /**
   * What holds a roadmap's settings (R-B7, CTRL-14; decision 2 A): it ended, its wind-down
   * settles, a roadmap command holds it, or a planning amendment is pending. The commands refuse
   * on these and the views explain them, each site in its own order and words.
   */
  private settingsHeld(workspaceId: WorkspaceId, roadmap: Roadmap) {
    return {
      ended: ended(roadmap),
      settling: this.storage.windDowns.find(workspaceId, roadmap.id)?.status === 'settling',
      running: this.state.controlling.has(roadmap.id),
      amendment: !!this.storage.amendments.pending(workspaceId, roadmap.id),
    };
  }
  /**
   * A settings command writes at any status but ended, and not while the roadmap's wind-down
   * settles (R-B6, decisions 1 and 3 to 5): what it changes is read at the next launch, admission
   * or use, and nothing launched is reconfigured.
   */
  private assertSettingsOpen(workspaceId: WorkspaceId, roadmap: Roadmap): void {
    const held = this.settingsHeld(workspaceId, roadmap);
    if (held.ended) conflict('This roadmap has ended. Ended roadmaps retain their history.');
    if (held.settling) windDownRefused('wind-down-in-progress', 'This roadmap is being stopped.');
  }
  /**
   * The editable precondition's first step (R-B7, CTRL-14): open (`assertSettingsOpen`), then
   * neither a stale form nor a roadmap command holding it, refused with the site's own text.
   */
  private requireSettingsOpen(
    workspaceId: WorkspaceId,
    roadmap: Roadmap,
    form: { readonly expectedVersion: number; readonly expectedRevision?: number | undefined },
    writes: 'grant' | 'definition',
    changed: string,
  ): void {
    this.assertSettingsOpen(workspaceId, roadmap);
    if (
      this.settingsStale(roadmap, form, writes) ||
      this.settingsHeld(workspaceId, roadmap).running
    )
      conflict(changed);
  }
  /** Its second step: no pending planning amendment, refused with the site's own text. */
  private requireNoPendingAmendment(workspaceId: WorkspaceId, roadmap: Roadmap, message: string) {
    if (this.settingsHeld(workspaceId, roadmap).amendment) conflict(message);
  }
  /**
   * Whether the operator's form is out of date (R-B6, decision 10). A stopped roadmap is held to
   * its version, as before. A running one writes itself as its entries move, so an assignment or
   * a grant is taken as sent (last writer wins, each audited, as a decision preparation is), and
   * a definition write is held to the revision its form showed, or to the version when the form
   * sent none.
   */
  private settingsStale(
    roadmap: Roadmap,
    view: { readonly expectedVersion: number; readonly expectedRevision?: number | undefined },
    writes: 'grant' | 'definition',
  ): boolean {
    if (roadmap.status !== 'running') return roadmap.version !== view.expectedVersion;
    if (writes === 'grant') return false;
    return view.expectedRevision === undefined
      ? roadmap.version !== view.expectedVersion
      : roadmap.definition.revision !== view.expectedRevision;
  }
  applyDelegation(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: ApplyRoadmapDelegation,
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const old = this.writer.find(workspaceId, id);
    this.requireSettingsOpen(
      workspaceId,
      old,
      input,
      'grant',
      'Roadmap changed. Refresh before applying delegation.',
    );
    this.requireNoPendingAmendment(
      workspaceId,
      old,
      'Decide the pending planning amendment first.',
    );
    if (
      new Set(input.entryIds).size !== input.entryIds.length ||
      input.entryIds.some((id) => !old.definition.entries.some((e) => e.id === id))
    )
      conflict('Select current roadmap entries.');
    // Only the named entries' delegated actions in flight hold a grant (R-B6, decision 2).
    const waits = delegationWaits(
      old.definition.entries
        .filter((entry) => input.entryIds.includes(entry.id))
        .map((entry) => ({
          sourceId: entry.sourceId,
          cycles: old.attempts.flatMap((attempt) => {
            const cycle =
              attempt.entryId === entry.id && attempt.status !== 'completed'
                ? this.storage.execution.cycles.find(workspaceId, attempt.cycleId)
                : undefined;
            return cycle ? [cycle] : [];
          }),
        })),
      {
        refreshing: (cycleId) => this.cycles.isRefreshing(cycleId),
        live: (cycle) =>
          this.storage.execution.runs.liveForWorktree(workspaceId, cycle.worktreeId).length > 0,
      },
    );
    if (waits.length) conflict(`Wait for ${waits.join(', ')} to finish.`);
    const map =
      old.definition.crossProject &&
      this.storage.imports.definition(workspaceId, old.definition.crossProject.definitionId);
    const allowedRoles = new Set(
      map?.source.evidence_profiles.flatMap((p) => p.reviewer_roles) ?? [],
    );
    if (
      input.reviewerRoles.some((r) => !allowedRoles.has(r)) ||
      new Set(input.reviewerRoles).size !== input.reviewerRoles.length
    )
      conflict('Choose reviewer responsibilities declared by this map.');
    if (input.automation.resolutionProfile) {
      this.cycles.validateAgentSelections({
        ...this.agentSettings(context, workspaceId, id).entries[0]!.selections,
        conflict: input.automation.resolutionProfile,
      });
      this.cycles.requireModelIds(
        [['conflict', input.automation.resolutionProfile]],
        old.delegationAssignments?.map(
          (grant) => ['conflict', grant.automation.resolutionProfile] as const,
        ) ?? [],
      );
    }
    const { expectedVersion: _version, ...grant } = input;
    return this.view(
      this.writer.change(
        old,
        {
          delegationAssignments: [
            ...(old.delegationAssignments ?? []),
            {
              ...grant,
              id: asDelegationAssignmentId(randomUUID()),
              appliedAt: this.state.now().toISOString(),
              appliedByUserId: context.user.id,
            },
          ],
        },
        'apply-delegation',
        context,
      ),
    );
  }
  /** Capacity settings need no Git inspection or dependency-graph evaluation. */
  capacities(context: AuthContext, workspaceId: WorkspaceId): RoadmapCapacities {
    this.workspaces.requireAuthorized(context, workspaceId);
    return {
      roadmaps: this.storage.roadmaps
        .list(workspaceId)
        .filter((r) => !ended(r))
        .map((r) => [r, this.settingsHeld(workspaceId, r)] as const)
        .map(([r, held]) => ({
          id: r.id,
          version: r.version,
          name: r.definition.name,
          status: r.status,
          crossProject: !!r.definition.crossProject,
          revision: r.definition.revision,
          scheduling: r.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING,
          editBlocker: held.running
            ? 'A roadmap command is in progress.'
            : held.settling
              ? 'This roadmap is being stopped.'
              : held.amendment
                ? 'Decide the pending planning amendment first.'
                : (r.definition.scheduling?.mode ?? 'sequential') !== 'parallel'
                  ? 'This roadmap is sequential: one item at a time. Change scheduling mode on the roadmap before configuring parallel limits.'
                  : null,
          inFlight: r.attempts.flatMap((a) => {
            const entry = r.definition.entries.find((e) => e.id === a.entryId);
            return a.status !== 'completed' &&
              entry &&
              (!entry.executionScope || entry.executionScope.kind === 'slice')
              ? [{ workItemId: entry.workItemId, label: entry.sourceId, attemptId: a.id }]
              : [];
          }),
        })),
    };
  }
  saveCapacity(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: SaveRoadmapCapacity,
  ): RoadmapCapacities {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const old = this.writer.find(workspaceId, id);
    this.requireSettingsOpen(
      workspaceId,
      old,
      input,
      'definition',
      'Roadmap changed; refresh before saving capacity.',
    );
    this.requireNoPendingAmendment(
      workspaceId,
      old,
      'Decide the pending planning amendment first.',
    );
    const scheduling = old.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING;
    if (scheduling.mode !== 'parallel')
      conflict(
        'Sequential roadmaps run one item at a time. Change scheduling mode on the roadmap first.',
      );
    if (
      scheduling.maxInFlight === input.maxInFlight &&
      scheduling.maxPerRepository === input.maxPerRepository
    )
      return this.capacities(context, workspaceId);
    const at = this.state.now().toISOString();
    // Only admission ceilings change. Scope, adoption, profiles, attempts and authority remain frozen.
    const definition = {
      ...old.definition,
      revision: old.definition.revision + 1,
      scheduling: {
        ...scheduling,
        maxInFlight: input.maxInFlight,
        maxPerRepository: input.maxPerRepository,
      },
      createdAt: at,
      createdByUserId: context.user.id,
    };
    const updated = { ...old, definition, version: old.version + 1, updatedAt: at };
    this.storage.transaction((tx) => {
      const persist = () => {
        this.writer.persist(tx, updated, old.version, 'configure-capacity', context);
        tx.roadmaps.addDefinition(definition);
      };
      // Limits are no plan-acceptance input, but a saved-plan-v1 acceptance is bound to the
      // revision: the operator's save carries it (R-C6 D2).
      const crossProject = old.definition.crossProject;
      if (crossProject)
        carryPlanAcceptance(
          tx,
          context,
          {
            workspaceId,
            definitionId: crossProject.definitionId,
            command: 'roadmap limits save',
            at,
          },
          persist,
        );
      else persist();
    });
    this.notifier.notify();
    return this.capacities(context, workspaceId);
  }
  /** The roadmap's read-only status list (R-E3a). */
  statusList(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId): RoadmapStatusList {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.statusOf(this.writer.find(workspaceId, id));
  }
  /**
   * Every open entry's state, what it waits on and who acts next, read from what the daemon
   * recorded: an open attention item (R-A4), the entry's hold, the scheduler's recorded wait
   * (R-C12), and last the entry's progress. Nothing here decides anything again.
   */
  statusOf(
    roadmap: Roadmap,
    snapshot: StorageRepositories = mapReadSnapshot(this.storage),
    operator = this.withOperatorNeeds(snapshot, roadmap),
    progress: readonly import('@craftingtable/domain').RoadmapEntryProgress[] = this.view(
      roadmap,
      snapshot,
      operator,
    ).progress,
  ): RoadmapStatusList {
    const ws = roadmap.workspaceId;
    const needs = operator.needs(progress);
    const items = this.storage.attention.open(ws);
    const attention = roadmapStop(roadmap);
    const entries: RoadmapStatusEntry[] = [];
    for (const entry of roadmap.definition.entries) {
      const state = progress.find((p) => p.entryId === entry.id);
      if (!state || state.status === 'completed') continue;
      // The recovery round that carries this work item's review, if any: its repair cycle is
      // where the entry's work happens while the round repairs.
      const round = this.selection.roundFor(roadmap, entry);
      const repair =
        round?.recovery?.phase === 'repair'
          ? snapshot.execution.cycles.find(ws, round.cycleId)
          : undefined;
      // The entry's own cycles, and those of the rounds that carry it.
      const cycleIds = new Set(
        roadmap.attempts
          .filter((a) => a.entryId === entry.id || a.recovery?.sourceEntryId === entry.id)
          .map((a) => a.cycleId),
      );
      if (round) cycleIds.add(round.cycleId);
      const item = items
        .filter(
          (i) =>
            (i.refs.roadmapId === roadmap.id && i.refs.entryId === entry.id) ||
            (i.refs.cycleId !== undefined && cycleIds.has(i.refs.cycleId)),
        )
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt))[0];
      const hold = roadmap.entryHolds?.[entry.id];
      const wait = roadmap.entryWaits?.[entry.id];
      const attempt = roadmap.attempts.find((a) => a.entryId === entry.id && !a.recovery);
      const own = attempt && snapshot.execution.cycles.find(ws, attempt.cycleId);
      const base = {
        entryId: entry.id,
        sourceId: entry.executionScope?.sourceId ?? entry.sourceId,
        scope: entry.executionScope?.kind ?? ('item' as const),
        title: entry.title,
        workItemId: entry.workItemId,
        state: state.status,
      };
      const blockers = state.blockers?.length
        ? { blockers: [...new Set(state.blockers.map((b) => b.code))] }
        : {};
      // A checkpoint the operator is asked to settle for this entry (R-C14).
      const checkpointItem = needs?.byEntry
        .get(entry.id)
        ?.map((id) => items.find((i) => i.subjectKey === checkpointSubjectKey(roadmap.id, id)))
        .find((i) => i !== undefined);
      const found = item ?? (hold?.status !== 'paused' ? checkpointItem : undefined);
      if (found) {
        entries.push({
          ...base,
          actor: 'operator',
          waitsOn: {
            source: 'attention-item',
            code: found.code,
            // The item's message says why; its title only names the subject.
            reason: found.message,
            since: found.openedAt,
            attentionItemId: found.id,
            ...(found.refs.cycleId ? { cycleId: found.refs.cycleId } : {}),
            ...(found.refs.runId ? { runId: found.refs.runId } : {}),
            ...blockers,
          },
        });
      } else if (hold) {
        const held = holdStop(hold);
        entries.push({
          ...base,
          actor: 'operator',
          waitsOn: { source: 'entry-hold', code: held?.code ?? hold.status, reason: hold.reason },
        });
      } else if (wait) {
        entries.push({
          ...base,
          actor: ENTRY_WAIT[wait.code],
          waitsOn: {
            source: 'entry-wait',
            code: wait.code,
            reason: wait.reason,
            since: wait.since,
            ...(wait.refs?.cycleId ? { cycleId: wait.refs.cycleId } : {}),
            ...(wait.refs?.entryId ? { entryId: wait.refs.entryId } : {}),
            ...(wait.refs?.blockers ? { blockers: [...wait.refs.blockers] } : {}),
          },
        });
      } else if (state.status === 'running') {
        // Running only while a cycle runs: the round's repair, else the entry's own cycle.
        const working = repair ?? own;
        const run =
          working?.status === 'running'
            ? snapshot.execution.runs.find(ws, working.currentRunId)
            : undefined;
        const step = working && working.status !== 'running' ? cycleStep(working) : undefined;
        entries.push({
          ...base,
          actor:
            working?.status === 'running'
              ? 'agent'
              : step && 'wait' in step
                ? ENTRY_WAIT[step.wait.code]
                : 'controller',
          waitsOn: {
            source: 'progress',
            code: step && 'wait' in step ? step.wait.code : state.status,
            reason: step && 'wait' in step ? `${state.reason} ${step.wait.reason}` : state.reason,
            ...(run?.startedAt ? { since: run.startedAt } : {}),
            ...(working ? { cycleId: working.id } : {}),
            ...(run ? { runId: run.id } : {}),
          },
        });
      } else {
        // The operator acts next when every blocker is theirs, as the inbox decides (LIVE-10);
        // a blocker-free stop or pause is the operator's by its state.
        const operatorActs = state.blockers?.length
          ? operatorActsNext(state, needs)
          : ['needs-attention', 'paused'].includes(state.status);
        // The roadmap's setup item lists the entries held on the operator's setup (R-E3b).
        const setup =
          operatorActs &&
          items.find((i) => i.refs.roadmapId === roadmap.id && i.members?.includes(entry.id));
        entries.push({
          ...base,
          actor: operatorActs ? 'operator' : 'controller',
          waitsOn: {
            source: 'progress',
            code: state.status,
            reason: state.reason,
            ...(setup ? { attentionItemId: setup.id } : {}),
            ...(own ? { cycleId: own.id } : {}),
            ...blockers,
          },
        });
      }
    }
    return {
      roadmapId: roadmap.id,
      name: roadmap.definition.name,
      status: roadmap.status,
      reason: roadmap.reason,
      ...(attention ? { attentionCode: attention.code } : {}),
      completed: progress.filter((p) => p.status === 'completed').length,
      entries,
    };
  }
  /**
   * A roadmap page's region (R-D5, PERF-06/14): the roadmap's view without its definition, the
   * revision to read that by, and its status list, in one transaction over one map snapshot. The
   * status list reads the view's progress, and both read one evaluation of the map (R-E3b).
   */
  page(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId) {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.readTransaction((tx) => {
      const snapshot = mapReadSnapshot(tx);
      const roadmap = this.writer.find(workspaceId, id);
      const operator = this.withOperatorNeeds(snapshot, roadmap);
      const view = this.view(roadmap, snapshot, operator);
      const { definition, ...withoutDefinition } = view.roadmap;
      const status = this.statusOf(roadmap, snapshot, operator, view.progress);
      const map = operator.mapState();
      if (map) this.rememberMap(roadmap, map);
      const board = this.board(snapshot, roadmap, operator, status, view.progress);
      return {
        view: { ...view, roadmap: withoutDefinition },
        definitionRevision: definition.revision,
        status,
        ...(board ? { board } : {}),
      };
    });
  }

  /**
   * The roadmap's board (R-E3b) from the read's one evaluation of the map: each milestone's
   * state, entries, run and open item, its roots and the slices it unblocks, and the gates.
   */
  private board(
    tx: StorageRepositories,
    roadmap: Roadmap,
    operator: ReturnType<RoadmapService['withOperatorNeeds']>,
    status: RoadmapStatusList,
    progress: RoadmapView['progress'],
  ): RoadmapBoard | undefined {
    const graph = this.graphAt(tx, roadmap.workspaceId, roadmap.id, roadmap.definition);
    if (!graph) return undefined;
    let state: (key: string) => NodeEvaluation | undefined;
    if (graph.model === 'map') {
      const map = operator.mapState();
      if (!map) return undefined;
      const evaluated = new Map(map.nodes.map((n) => [n.key, n]));
      state = (key) => evaluated.get(key);
    } else {
      // A work item is met when the daemon completed every entry on it, or, outside the
      // roadmap, the work item itself.
      const completed = new Set(
        progress.filter((p) => p.status === 'completed').map((p) => p.entryId),
      );
      const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
      state = (key) => {
        const node = byKey.get(key);
        if (!node?.workItemId) return undefined;
        const entries = roadmap.definition.entries.filter((e) => e.workItemId === node.workItemId);
        return {
          satisfied: entries.length
            ? entries.every((e) => completed.has(e.id))
            : tx.planning.workItems.find(roadmap.workspaceId, node.workItemId)?.status ===
              'completed',
          requirements: node.requires.map((r) => graph.nodes[r]!.key),
        };
      };
    }
    const items = new Map(
      this.storage.attention.open(roadmap.workspaceId).map((item) => [item.subjectKey, item.id]),
    );
    return buildBoard({
      graph,
      state,
      status,
      entries: roadmap.definition.entries,
      checkpointItems: new Map(
        graph.nodes.flatMap((n) => {
          const id =
            n.kind === 'checkpoint'
              ? items.get(checkpointSubjectKey(roadmap.id, n.sourceId))
              : undefined;
          return id ? [[n.sourceId, id] as const] : [];
        }),
      ),
    });
  }

  /**
   * How many slices each open item on a map roadmap holds (R-E3b decision 8), so the inbox ranks
   * them in one unit: one map evaluation per roadmap that has such an item. Items on no map
   * roadmap are left out and keep their own count.
   */
  mapItemSlices(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    items: readonly { readonly item: AttentionItem; readonly checkpointId?: string }[],
  ): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const roadmap of tx.roadmaps.list(workspaceId)) {
      const selection = roadmap.definition.crossProject;
      if (!selection || ended(roadmap)) continue;
      const graph = this.graphAt(tx, workspaceId, roadmap.id, roadmap.definition);
      if (!graph) continue;
      let nodes: CrossProjectView['nodes'] | undefined;
      for (const { item, checkpointId } of items) {
        if (counts.has(item.id)) continue;
        const subject = this.itemSubject(tx, roadmap, graph, item, checkpointId);
        if (!subject) continue;
        nodes ??= this.mapForRead(tx, roadmap).nodes;
        counts.set(
          item.id,
          slicesHeldBy(nodes, itemNodeKeys(graph, roadmap.definition.entries, subject)),
        );
      }
    }
    return counts;
  }

  private rememberMap(roadmap: Roadmap, view: CrossProjectView): void {
    this.state.readMaps.set(roadmap.id, {
      commits: this.storage.commits,
      revision: roadmap.definition.revision,
      view,
    });
  }
  private mapForRead(tx: StorageRepositories, roadmap: Roadmap): CrossProjectView {
    const known = this.state.readMaps.get(roadmap.id);
    if (known?.commits === this.storage.commits && known.revision === roadmap.definition.revision)
      return known.view;
    const view = crossProjectState(tx, roadmap.workspaceId, roadmap.definition.crossProject!);
    this.rememberMap(roadmap, view);
    return view;
  }

  /** What an item is about on this map roadmap, from its typed references; none if not on it. */
  private itemSubject(
    tx: StorageRepositories,
    roadmap: Roadmap,
    graph: RoadmapGraph,
    item: AttentionItem,
    checkpointId: string | undefined,
  ): ItemSubject | undefined {
    const cycle = item.refs.cycleId
      ? tx.execution.cycles.find(roadmap.workspaceId, item.refs.cycleId)
      : undefined;
    return itemSubjectOf({
      item,
      roadmapId: roadmap.id,
      checkpointId,
      cycle: cycle && { ...(cycle.owner ? { owner: cycle.owner } : {}) },
      bindsWorkItem: (id) => graph.nodes.some((n) => n.workItemId === id),
    });
  }

  /** A roadmap's dependency structure at one revision (R-E3b); revisions never change. */
  graph(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId, revision: number) {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.writer.find(workspaceId, id);
    const definition = this.storage.roadmaps.definition(workspaceId, id, revision);
    const graph = definition && this.graphAt(this.storage, workspaceId, id, definition);
    if (!graph) throw new NotFoundError();
    return graph;
  }

  private graphAt(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    roadmapId: RoadmapId,
    definition: RoadmapDefinition,
  ): RoadmapGraph | undefined {
    const key = `${workspaceId}:${roadmapId}:${definition.revision}`;
    const cached = this.state.graphs.get(key);
    if (cached) return cached;
    const selection = definition.crossProject;
    const map = selection && tx.imports.definition(workspaceId, selection.definitionId);
    if (selection && !map) return undefined;
    const graph = !selection
      ? sequenceGraph({
          roadmapId,
          revision: definition.revision,
          entries: definition.entries,
          workItem: (id) => tx.planning.workItems.find(workspaceId, id),
          predecessors: (id) =>
            tx.planning.dependencies
              .listPredecessors(workspaceId, id)
              .filter((p) => p.kind === 'required')
              .map((p) => p.workItemId),
          projectName: (id) =>
            tx.planning.projects.find(workspaceId, id as import('@craftingtable/domain').ProjectId)
              ?.name,
        })
      : mapGraph({
          roadmapId,
          revision: definition.revision,
          source: map!.source,
          bindings:
            tx.imports
              .bindings(workspaceId, map!.id)
              .find((b) => b.revision === selection.bindingRevision)?.bindings ?? [],
          targetId: selection.targetId,
          selection: selection.selection,
        });
    // A few roadmaps' current revisions; an old one is rebuilt if it is ever read again.
    if (this.state.graphs.size >= 32)
      this.state.graphs.delete(this.state.graphs.keys().next().value!);
    this.state.graphs.set(key, graph);
    return graph;
  }

  /** One revision of a roadmap's definition; revisions never change (R-B3, R-D5). */
  definition(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId, revision: number) {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.writer.find(workspaceId, id);
    const definition = this.storage.roadmaps.definition(workspaceId, id, revision);
    if (!definition) throw new NotFoundError();
    return definition;
  }

  /**
   * The roadmaps list page's rows (R-D5, PERF-06): each roadmap's name, status, reason and how
   * many of its entries are done, without its definition or per-entry progress.
   */
  summaries(context: AuthContext, workspaceId: WorkspaceId) {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.readTransaction((tx) => {
      const snapshot = mapReadSnapshot(tx);
      return snapshot.roadmaps.list(workspaceId).map((roadmap) => {
        const attention = roadmapStop(roadmap);
        return {
          id: roadmap.id,
          name: roadmap.definition.name,
          status: roadmap.status,
          reason: roadmap.reason,
          ...(attention ? { attentionCode: attention.code } : {}),
          completed: roadmap.definition.entries.filter((entry) =>
            this.selection.complete(roadmap, entry, snapshot),
          ).length,
          entries: roadmap.definition.entries.length,
        };
      });
    });
  }

  history(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId) {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.writer.find(workspaceId, id);
    return this.storage.roadmaps.history(workspaceId, id);
  }
  configureScopeRecovery(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: ScopeRecoveryPolicyRequest,
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const roadmap = this.writer.find(workspaceId, id);
    this.requireSettingsOpen(
      workspaceId,
      roadmap,
      input,
      'grant',
      'Roadmap changed; refresh before changing recovery delegation.',
    );
    if (!roadmap.definition.crossProject)
      conflict('Recovery delegation is set on a cross-project roadmap.');
    this.requireNoPendingAmendment(workspaceId, roadmap, 'Decide the pending amendment first.');
    return this.view(
      this.writer.change(
        roadmap,
        {
          scopeRecovery: {
            enabled: input.enabled,
            maxRoundsPerParent: input.maxRoundsPerParent,
            grantedByUserId: context.user.id,
            grantedAt: this.state.now().toISOString(),
          },
        },
        'configure-scope-recovery',
        context,
      ),
    );
  }
  /**
   * The standing, revocable grant for the scheduler to re-verify stale evidence itself (R-C10's
   * follow-up, decision 4), set as scope recovery's is: on a cross-project roadmap that is not
   * running, with no amendment pending.
   */
  configureReverification(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: ReverificationGrantRequest,
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const roadmap = this.writer.find(workspaceId, id);
    this.requireSettingsOpen(
      workspaceId,
      roadmap,
      input,
      'grant',
      'Roadmap changed; refresh before changing automatic re-verification.',
    );
    if (!roadmap.definition.crossProject)
      conflict('Automatic re-verification is set on a cross-project roadmap.');
    this.requireNoPendingAmendment(workspaceId, roadmap, 'Decide the pending amendment first.');
    return this.view(
      this.writer.change(
        roadmap,
        {
          reverificationGrant: {
            enabled: input.enabled,
            grantedByUserId: context.user.id,
            grantedAt: this.state.now().toISOString(),
          },
        },
        'configure-reverification',
        context,
      ),
    );
  }
  /** The standing grant to prepare shared decisions while the roadmap runs (R-C3b, ADR-065). */
  configureDecisionPreparation(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: DecisionPreparationGrantRequest,
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const roadmap = this.writer.find(workspaceId, id);
    this.requireSettingsOpen(
      workspaceId,
      roadmap,
      input,
      'grant',
      'Roadmap changed; refresh before changing decision preparation.',
    );
    if (!roadmap.definition.crossProject)
      conflict('Decision preparation is set on a cross-project roadmap.');
    this.requireNoPendingAmendment(workspaceId, roadmap, 'Decide the pending amendment first.');
    return this.view(
      this.writer.change(
        roadmap,
        {
          decisionPreparationGrant: {
            enabled: input.enabled,
            minutes: input.minutes,
            maxConcurrent: input.maxConcurrent,
            grantedByUserId: context.user.id,
            grantedAt: this.state.now().toISOString(),
          },
        },
        'configure-decision-preparation',
        context,
      ),
    );
  }
  /**
   * A roadmap's save as its form sends it (R-E5b, E5-1 as amended 2026-10-11): each entry's step
   * permissions. A saved entry keeps its agents; a new one stores the workspace defaults. The
   * agents are changed only by an ADR-064 assignment (`applyAgentSettings`).
   */
  save(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: SaveRoadmapRequest,
  ): RoadmapView {
    const saved = this.storage.roadmaps.find(workspaceId, id)?.definition.entries ?? [];
    return this.saveDefinition(context, workspaceId, id, {
      ...input,
      // In the stored field order, so a started entry compares equal to its resubmitted form.
      entries: input.entries.map(({ permissions, ...entry }) => {
        const prior = saved.find((e) => e.id === entry.id);
        return roadmapEntryFieldsSchema.parse({
          ...entry,
          profiles: prior
            ? withPermissions(prior.profiles, permissions)
            : this.cycles.workspaceProfiles(workspaceId, permissions),
        });
      }),
    });
  }

  /** The profiles a new entry or map settings level stores: the workspace defaults now (R-E5b). */
  workspaceProfiles(
    workspaceId: WorkspaceId,
    permissions?: import('@craftingtable/contracts').StepPermissions,
  ) {
    return this.cycles.workspaceProfiles(workspaceId, permissions);
  }

  /** Writes a definition whose entries carry their profiles: a form's save, or a map's. */
  saveDefinition(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: RoadmapDefinitionInput,
    crossProject?: import('@craftingtable/domain').CrossProjectConfiguration,
    amendment?: { readonly retainAttemptIds: readonly string[] },
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.state.controlling.has(id)) conflict('A roadmap command is in progress.');
    const old = this.storage.roadmaps.find(workspaceId, id);
    if (old && !amendment)
      this.requireNoPendingAmendment(
        workspaceId,
        old,
        'Decide the pending planning amendment before editing settings.',
      );
    // A display name is refused when it is entered; one this roadmap already saved is not (R-G15).
    const slots = (
      entries: readonly { id: string; profiles: Readonly<Record<string, AgentSelection>> }[],
    ) =>
      entries.flatMap((entry) =>
        Object.entries(entry.profiles).map(
          ([step, profile]) => [`${entry.id}:${step}`, profile] as const,
        ),
      );
    this.cycles.requireModelIds(slots(input.entries), slots(old?.definition.entries ?? []));
    if (old?.definition.crossProject && !crossProject)
      conflict('Use the imported map supervisor to edit this roadmap.');
    // Its command-running check came first, and nothing between awaits, so it holds here too.
    if (old)
      this.requireSettingsOpen(
        workspaceId,
        old,
        input,
        'definition',
        'Roadmap changed; refresh before saving.',
      );
    else if (input.expectedVersion !== 0) conflict('Roadmap changed; refresh before saving.');
    const lastStarted =
      old?.definition.entries.findLastIndex((e) =>
        startedAttempts(old).some(
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
        'Finish the in-flight attempts before changing scheduling mode. Capacity limits can be edited at any time.',
      );
    const started =
      (parallel
        ? old?.definition.entries.filter((e) =>
            startedAttempts(old).some(
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
      if (retiredOrRetiring(this.storage, workspaceId, item.planVersionId))
        windDownRefused(
          'plan-version-retired',
          `${item.sourceId} belongs to a plan version that is retired or being retired. Plan its work from a current version.`,
        );
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
          // Named, since beside a running roadmap it may have started after the form loaded (R-B6).
          conflict(
            `${frozen.sourceId} has started, so it keeps its original work item and settings. Refresh to see the current roadmap.`,
          );
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
    const at = this.state.now().toISOString();
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
                ...(old.decisionPreparationGrant
                  ? {
                      decisionPreparationGrant: {
                        ...old.decisionPreparationGrant,
                        enabled: false,
                      },
                    }
                  : {}),
                // A standing grant, revoked with the others (R-C10's follow-up, decision 4).
                ...(old.reverificationGrant
                  ? { reverificationGrant: { ...old.reverificationGrant, enabled: false } }
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
      const persist = () => {
        this.writer.persist(tx, roadmap, old?.version ?? 0, 'save', context);
        tx.roadmaps.addDefinition(definition);
      };
      // The operator's save carries a plan acceptance it re-opens (R-C6 D2); an amendment's
      // new binding never does.
      if (crossProject && !amendment)
        carryPlanAcceptance(
          tx,
          context,
          { workspaceId, definitionId: crossProject.definitionId, command: 'roadmap save', at },
          persist,
        );
      else persist();
    });
    this.notifier.notify();
    return this.view(roadmap);
  }

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
  private async controlWithin(
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
      return this.view(this.writer.find(workspaceId, id));
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
        const entry = roadmap.definition.entries.find((e) => e.id === attempt.entryId)!;
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
    return this.view(this.writer.find(workspaceId, id));
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
          if (decision.escalation) conflict(decision.reason!);
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
      return this.view(roadmap);
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
      return this.view(this.writer.find(workspaceId, id));
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
  startWorker(): void {
    if (this.state.task !== undefined) return;
    // Idle when nothing is marked, no round runs and admissions are not held: a drain holds
    // first pushes back, as its skipped ticks did (part 2 review MEDIUM-5).
    this.state.passes?.register(
      'roadmaps',
      () =>
        !this.state.kernel.pending() &&
        this.state.rounding === undefined &&
        !this.state.admissionsHeld &&
        !this.state.kernel.dueWithin(RETRY_SOON_MS),
    );
    this.state.kernel.start();
    this.state.task = this.loop();
  }
  async shutdown(): Promise<void> {
    this.state.abort.abort();
    this.state.kernel.stop();
    this.state.passes?.unregister('roadmaps');
    await this.state.task;
  }
  /**
   * The scheduler (R-B5 part 2): a round over the roadmaps marked since the last, then a wait for
   * the next mark (a write, a notification, a release, a due time, the sweep). The first round
   * looks at every roadmap, as the loop's first tick did. While admissions are held the marks
   * are taken and dropped, as the ticks were skipped; their release marks every roadmap.
   */
  private async loop(): Promise<void> {
    this.state.kernel.mark('start');
    while (!this.state.abort.signal.aborted) {
      // A tick in flight (a test's) ends first, so its marks are not lost (review LOW-2).
      while (this.state.rounding) await this.state.rounding;
      const marked = this.state.kernel.take();
      if (marked === undefined) {
        await this.state.kernel.marked(this.state.abort.signal);
        continue;
      }
      if (this.state.admissionsHeld) continue;
      await this.round(marked);
      // A macrotask between rounds, as the cycles' (increment 3 review HIGH-1).
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  /** A restart drain holds admissions: running roadmaps start no new work (R-B9). */
  holdAdmissions(held: boolean): void {
    this.state.admissionsHeld = held;
    if (!held) this.notifier.notify();
  }
  /** Marks every roadmap for the drain's next round (a committed write, a lock's release). */
  wake(cause: MarkCause): void {
    this.state.kernel.mark(cause);
  }
  /**
   * A lock was released, by its key: `lane` (a repository's merge lane), `guard` (the worktree
   * guard), `cycle:<id>` (a cycle's transition, command or investigation), `refresh:<id>` (a
   * cycle's integration refresh). The roadmaps that met that lock busy are marked, once. A
   * release inside the drain's own round marks nothing (part 2 review HIGH-1): a unit that takes
   * and releases a lock and writes nothing would otherwise run again at once, and again; and a
   * release of another lock marks nothing, or two drains could wake each other without end.
   */
  lockReleased(key: string): void {
    // The round in flight's own release; one from a timer or callback that outlived its round is
    // not (increment 9 review LOW-1).
    const own = this.state.ownRound.getStore();
    if (own !== undefined && own === this.state.roundToken) return;
    if (this.state.rounding) this.state.releasedMeanwhile.add(key);
    this.markWaiters(key);
  }
  private markWaiters(key: string): void {
    // A decision preparation held back by this lock may be tried again (review HIGH-2), on this
    // path or the round end's (increment 10 review LOW-1).
    for (const [roadmapId, held] of this.state.preparationsHeld)
      if (held.key === key) this.state.preparationsHeld.delete(roadmapId);
    const waiting = this.state.lockWaiters.get(key);
    if (!waiting) return;
    this.state.lockWaiters.delete(key);
    this.state.kernel.mark('release', [...waiting]);
  }
  /**
   * The cycle's integration refreshed before the scheduler goes on (`true` when it moved, or
   * could not tell yet). It could not tell when the cycle's own refresh was in flight, or the
   * merge lane held: the roadmap waits on that one's end, not on every release (R-B5 part 2,
   * review MEDIUM-3). One that refreshed wrote, which marks every roadmap; its extra waiter costs
   * one look at the next merge's end.
   */
  private async refreshed(roadmap: Roadmap, cycle: WorkCycle): Promise<boolean> {
    const inFlight = this.cycles.isRefreshing(cycle.id);
    const moved = await this.cycles.refreshIntegration(
      cycle,
      this.storage.execution.runs.find(roadmap.workspaceId, cycle.currentRunId),
    );
    if (moved) this.state.waitOnLock(roadmap.id, inFlight ? `refresh:${cycle.id}` : 'lane');
    return moved;
  }
  /** Serialized tick is also the deterministic integration-test seam: one round over all. */
  async tick(): Promise<void> {
    if (this.state.ticking || this.state.abort.signal.aborted || this.state.admissionsHeld) return;
    await this.round('all');
  }
  private async round(marked: Marked): Promise<void> {
    if (this.state.ticking) return;
    this.state.ticking = true;
    let done: () => void = () => undefined;
    this.state.rounding = new Promise((resolve) => {
      done = resolve;
    });
    try {
      const token = {};
      this.state.roundToken = token;
      await this.state.ownRound.run(token, () => this.roundBody(marked));
    } finally {
      this.state.ticking = false;
      this.state.rounding = undefined;
      this.state.roundToken = undefined;
      done();
    }
  }
  /** The scheduler drain's figures for the owner-only diagnostics (R-B5 part 2). */
  figures(): DrainSummary {
    return drainSummary(
      'roadmaps',
      this.state.rounds,
      this.state.kernel,
      this.state.now().getTime(),
    );
  }
  private async roundBody(marked: Marked): Promise<void> {
    this.state.rounds += 1;
    const pass = this.state.passes?.started();
    this.state.passInboxes = new Map();
    this.state.looks.clear();
    this.state.releasedMeanwhile.clear();
    const includes = (id: string) => marked === 'all' || marked.has(id);
    const looked = new Set<string>();
    try {
      // A record still settling is the hold: its settle resumes here, on every pass, and the
      // scheduler does not advance its roadmap (R-B11, ADR-073).
      for (const record of this.storage.windDowns.settling()) {
        if (this.state.abort.signal.aborted || this.state.controlling.has(record.roadmapId))
          continue;
        if (!includes(record.roadmapId)) continue;
        looked.add(record.roadmapId);
        await this.settlement.resume(record).catch(() => undefined);
        // Still settling before its session limit: looked at again when the limit comes (a step
        // waiting for a cancelled session fails then). Past it nothing is asked (`lookAgain`
        // keeps only times ahead): a failed step waits for a mark (increment 9 review HIGH-1).
        if (
          this.storage.windDowns.find(record.workspaceId, record.roadmapId)?.status === 'settling'
        )
          this.state.lookAgain(
            record.roadmapId,
            Date.parse(record.requestedAt) + SESSION_WAIT_LIMIT_MS + 1,
          );
      }
      const held = this.settlement.held();
      const roadmaps = this.storage.roadmaps.list();
      // Due times of roadmaps no longer listed are forgotten.
      if (marked === 'all') this.state.kernel.keepDue(new Set(roadmaps.map((r) => r.id)));
      for (const roadmap of roadmaps) {
        if (this.state.abort.signal.aborted) break;
        if (!includes(roadmap.id)) continue;
        looked.add(roadmap.id);
        if (this.state.controlling.has(roadmap.id) || held.has(roadmap.id)) continue;
        // A paused roadmap adopts open repairs too; its pause holds their controller reviews.
        if (['paused', 'needs-attention'].includes(roadmap.status)) {
          try {
            this.adoptManualRepairs(roadmap);
          } catch {
            // Adoption is retried on the next pass.
          }
          // A stop whose typed fact cleared resumes by itself; a pause never does (decision 2).
          await this.holds
            .resumeCleared(this.writer.find(roadmap.workspaceId, roadmap.id))
            .catch(() => undefined);
          continue;
        }
        if (roadmap.status !== 'running') continue;
        try {
          await this.advance(this.adoptManualRepairs(roadmap));
          this.state.observer?.passEnded(roadmap.id);
        } catch (error) {
          this.state.observer?.passEnded(roadmap.id, error);
          if (retried(error)) this.state.metRetried(roadmap.id, error);
          if (error instanceof SupersededRoadmapOperation || retried(error)) continue;
          const current = this.writer.find(roadmap.workspaceId, roadmap.id);
          if (current.status === 'running')
            this.writer.change(current, {
              status: 'needs-attention',
              attention: stopAttention(error),
              reason:
                error instanceof ExecutionRequestError
                  ? error.message
                  : 'Scheduler could not advance. Inspect the current item before resuming.',
            });
        }
      }
      try {
        this.syncAttention();
      } catch {
        /* The next pass re-derives the set; delivery reads whatever is stored meanwhile. */
      }
    } finally {
      this.state.passInboxes = undefined;
      // Each roadmap looked at keeps only the due time this round asked for, strictly ahead of
      // now (part 1's rule, review MEDIUM-4); one already come marks it once more.
      const now = this.state.now().getTime();
      for (const id of looked) {
        const at = this.state.looks.get(id);
        if (at !== undefined && at <= now) {
          this.state.kernel.dueAt(id, undefined);
          this.state.kernel.mark('due', [id]);
        } else this.state.kernel.dueAt(id, at);
      }
      // A lock released by something else while this round ran: a roadmap that met it busy after
      // that release is looked at again (review LOW-2).
      for (const key of this.state.releasedMeanwhile) this.markWaiters(key);
      if (pass !== undefined) this.state.passes?.completed('roadmaps', pass);
    }
  }
  private async advance(roadmap: Roadmap): Promise<void> {
    this.writer.authority(roadmap);
    if (this.storage.amendments.pending(roadmap.workspaceId, roadmap.id)) return;
    // Shared decisions are prepared beside the slices that will need them (R-C3b).
    await this.prepareNeededDecisions(roadmap).catch(() => undefined);
    await this.releaseSettledPreparations(roadmap);
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
  private async advanceEntry(
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
  private async evaluateEntry(
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
              const queued = current.attempts.find((a) => a.id === attempt!.id);
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
                  entry.executionScope!.definitionId,
                  entry.executionScope!.bindingRevision,
                )[0]?.id !== refresh.runtimeId
              )
                conflict(
                  'Dependencies changed again. Preview the current dependency refresh before resuming this review.',
                );
              if (
                this.storage.execution.cycles.find(roadmap.workspaceId, cycle.id)?.currentRunId !==
                (refresh ?? requested)!.sourceRunId
              )
                conflict('The queued review changed. Inspect its manual recovery before resuming.');
              const blockers = scopePhaseBlockers(
                this.storage,
                roadmap.workspaceId,
                entry.workItemId,
                entry.executionScope!,
                entry.executionScope!.kind === 'slice-verification' ? 'verify' : 'accept',
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
              check,
              () => {
                const current = this.writer.find(roadmap.workspaceId, roadmap.id);
                this.writer.change(current, {
                  attempts: current.attempts.map((a) =>
                    a.id === attempt!.id
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
              if (await this.refreshed(roadmap, cycle)) return MOVED;
              await this.execution.recordScopeReceipt(
                context,
                roadmap.workspaceId,
                worktree.id,
                worktree.version,
                { check },
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
        if (stopping) return this.leaveToCycle(roadmap, entry, stopping, parallel);
        throw new TypedRefusalError(
          refused,
          refused === 'item-completed-unmerged'
            ? `${entry.sourceId}: Marked complete without merging the roadmap worktree. Merge its reviewed branch or stop this roadmap to reconcile the queue.`
            : `${entry.sourceId}: Bound plan item is unavailable.`,
        );
      }
      const cycle = this.storage.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
      if (cycle) {
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
              profile: delegatedResolutionProfile(this.storage, cycle, {
                ...(delegation.assignment ? { id: delegation.assignment.id } : {}),
                ...(automation.resolutionProfile ? { profile: automation.resolutionProfile } : {}),
              }),
            },
            check,
          );
          return MOVED;
        }
        const pending = this.storage.execution.merges.latest(
          roadmap.workspaceId,
          attempt.worktreeId,
        );
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
            const review = this.storage.execution.runs.find(
              roadmap.workspaceId,
              cycle.currentRunId,
            );
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
          if (pending?.status !== 'reserved' && (await this.refreshed(roadmap, cycle)))
            return MOVED;
          try {
            await this.execution.mergeWorktree(
              context,
              roadmap.workspaceId,
              attempt.worktreeId,
              {},
              undefined,
              { roadmapId: roadmap.id, definitionRevision: attempt.definitionRevision, check },
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
              (await this.cycles.reviewForDeclaredChecks(cycle, check))
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

  /** The roadmap leaves this cycle to its own controller or to the operator. */
  private leaveToCycle(
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
  private adoptManualRepairs(roadmap: Roadmap): Roadmap {
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
  /** Each round survives worktree replacement and returns through the original independent reviewers. */
  private async advanceScopeRecovery(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    sourceCycle: import('@craftingtable/domain').WorkCycle,
  ): Promise<EntryStep | undefined> {
    const ws = roadmap.workspaceId;
    let attempt = this.selection.recoveryFor(roadmap, entry);
    if (attempt && attempt.recovery!.sourceEntryId !== entry.id)
      return waiting('recovery-round', 'A recovery round for this work item is in progress.', {
        entryId: attempt.recovery!.sourceEntryId,
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
          throw new EntryHoldError('recovery-not-converging', decision.reason!);
        // One fact, one stop (R-C10's follow-up, decision 1): the review's own stop carries a
        // round recovery declined; the entry waits on it with the reason, and recovery asks again
        // on the next pass, so the round starts once the reason clears. A stop the controller
        // claims has no item to carry it, so the decline holds the entry for the operator.
        const waited = cycleWait(sourceCycle, decision.reason!, entry.id);
        if (waited) return waited;
        conflict(decision.reason!);
      }
      const ownerAttempt = roadmap.attempts.find(
        (a) => a.entryId === decision.owner!.id && !a.recovery,
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
          sourceSequence: decision.sourceSequence!,
          findingFingerprint: decision.fingerprint!,
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
    const owner = roadmap.definition.entries.find((e) => e.id === reserved.entryId)!;
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
          owner.executionScope!.definitionId,
          owner.executionScope!.bindingRevision,
        ).length
      )
        conflict('The recovery map binding changed. Reconcile the roadmap before continuing.');
    };
    check();
    const context = this.writer.authority(roadmap);
    if (reserved.recovery!.phase === 'repair') {
      const tree = this.storage.execution.worktrees.find(ws, reserved.worktreeId);
      if (tree?.mergedAt) {
        this.writer.updateRecovery(roadmap, reserved, {
          status: 'completed',
          completedAt: tree.mergedAt,
          recovery: { ...reserved.recovery!, phase: 'verification' },
        });
        return MOVED;
      }
      // The operator's command prepares its own round; a failed one is retried from there. One
      // that no request is preparing (it failed, or the daemon stopped) waits on the operator.
      if (reserved.status === 'preparing' && reserved.recovery!.requestedByUserId) {
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
          sourceCycle.currentRunId !== reserved.recovery!.sourceRunId ||
          sourceTurn?.sequence !== reserved.recovery!.sourceSequence
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
              sourceId: owner.executionScope!.sourceId,
              maxRemediationRounds: frozen.policy.maxRemediationRounds,
              instructions: frozen.instructions,
            },
            {
              worktreeId: reserved.worktreeId,
              cycleId: reserved.cycleId,
              owner: ownerOf(roadmap, reserved),
              profiles: frozen.profiles,
              policy: frozen.policy,
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
    const verification = reviews.filter((e) => e.executionScope!.kind === 'slice-verification');
    const phase = verification.every((e) => this.selection.complete(roadmap, e, this.storage, true))
      ? 'parent-review'
      : 'verification';
    if (phase !== reserved.recovery!.phase) {
      this.writer.updateRecovery(roadmap, reserved, { recovery: { ...reserved.recovery!, phase } });
      return MOVED;
    }
    const target = (
      phase === 'verification'
        ? verification
        : reviews.filter((e) => e.executionScope!.kind === 'parent-acceptance')
    ).find((e) => !this.selection.complete(roadmap, e, this.storage, true));
    if (!target) {
      this.writer.updateRecovery(roadmap, reserved, {
        recovery: { ...reserved.recovery!, phase: 'completed' },
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
      target.executionScope!,
      phase === 'verification' ? 'verify' : 'accept',
      { ownerId: cycle.currentRunId },
    );
    if (blockers.length) throw gated(new PhaseGateError(blockers), target.id);
    const prior = reserved.recovery!.reviewRunIds[target.id];
    if (
      cycle.status === 'completed' ||
      (cycle.currentRunId === prior && ['needs-attention', 'paused'].includes(cycle.status))
    ) {
      const restarts = reserved.recovery!.reviewRestarts?.[target.id] ?? 0;
      const settings =
        attemptDefinition(this.storage, roadmap, reviewAttempt!)?.scheduling ??
        DEFAULT_ROADMAP_SCHEDULING;
      if (restarts >= settings.maxIntegrationRefreshes)
        conflict(
          'Recovery review refresh allowance exhausted. Inspect and refresh this scope manually before resuming.',
        );
      const attach = () => {
        const current = this.writer.find(ws, roadmap.id);
        const round = current.attempts.find((a) => a.id === reserved.id)!;
        this.writer.change(current, {
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
      // The target review's own gates refuse its restart: they are the target's (review M-1).
      await (cycle.status === 'completed'
        ? this.cycles.repeatScopeReview(context, ws, cycle.id, cycle.version, '', check, attach)
        : this.cycles.control(
            context,
            ws,
            cycle.id,
            'resume',
            cycle.version,
            undefined,
            check,
            attach,
          )
      ).catch((error: unknown) => {
        throw gated(error, target.id);
      });
      return MOVED;
    }
    if (['needs-attention', 'paused', 'stopped'].includes(cycle.status)) {
      // This round reached an independent verdict. Any further repair consumes a new round.
      this.writer.updateRecovery(roadmap, reserved, {
        recovery: { ...reserved.recovery!, phase: 'completed' },
      });
      return MOVED;
    }
    return roundStep(await this.advanceEntry(roadmap, target, undefined, true), next, {
      entryId: target.id,
      cycleId: cycle.id,
    });
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

  private view(
    roadmap: Roadmap,
    snapshot = mapReadSnapshot(this.storage),
    operator = this.withOperatorNeeds(snapshot, roadmap),
  ): RoadmapView {
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
      progress: operator.progress(
        roadmap.definition.entries
          .map((entry): import('@craftingtable/domain').RoadmapEntryProgress => {
            if (this.selection.complete(roadmap, entry, snapshot))
              return { entryId: entry.id, status: 'completed', reason: 'Completed.' };
            const hold = roadmap.entryHolds?.[entry.id];
            const currentAttempt = roadmap.attempts.find(
              (a) => a.entryId === entry.id && !a.recovery,
            );
            const currentCycle =
              currentAttempt &&
              snapshot.execution.cycles.find(roadmap.workspaceId, currentAttempt.cycleId);
            if (currentCycle && this.cycles.isTransitioning(currentCycle.id))
              return {
                entryId: entry.id,
                status: 'running',
                reason: 'Preparing the requested recovery.',
              };
            if (hold && currentCycle?.status !== 'running')
              return { entryId: entry.id, status: hold.status, reason: hold.reason };
            const recovery = this.selection.roundFor(roadmap, entry);
            if (recovery && entry.executionScope?.kind !== 'slice') {
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
            if (attempt?.reverification)
              return {
                entryId: entry.id,
                status: roadmap.status === 'running' ? 'queued' : 'paused',
                reason:
                  'Fresh independent review queued by Re-verify. Existing code and reviewer assignment are retained; it runs when the roadmap is running.',
              };
            if (attempt?.dependencyRefresh)
              return {
                entryId: entry.id,
                status: roadmap.status === 'running' ? 'queued' : 'paused',
                reason: `Fresh independent review queued for dependency generation ${attempt.dependencyRefresh.generation}. Existing code and reviewer assignment are retained; plan acceptance and Resume are required.`,
              };
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
              const blockers = [
                ...scopePhaseBlockers(
                  snapshot,
                  roadmap.workspaceId,
                  entry.workItemId,
                  entry.executionScope,
                  phase,
                  { ownerId: cycle?.currentRunId },
                ),
                ...(phase === 'start' && !attempt
                  ? this.selection.decisionHold(snapshot, roadmap, entry)
                  : []),
              ];
              if (blockers.length)
                return {
                  entryId: entry.id,
                  // Whether the operator is the one to move it is decided once every entry's
                  // blockers are known (`withOperatorNeeds`, R-C14).
                  status: blockers.some((b) => b.code === 'resource-busy')
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
            const reason = this.selection.blocker(roadmap, entry, attempt, snapshot);
            return {
              entryId: entry.id,
              status: reason?.needsAttention ? 'needs-attention' : reason ? reason.kind : 'queued',
              reason: reason?.reason ?? 'Waiting for its turn in the sequence.',
            };
          })
          .map((progress) => {
            const attempt = roadmap.attempts.find((a) => a.entryId === progress.entryId);
            const definition = attempt
              ? attemptDefinition(snapshot, roadmap, attempt)
              : roadmap.definition;
            const entry = roadmap.definition.entries.find((e) => e.id === progress.entryId)!;
            return {
              ...progress,
              ...(progress.status !== 'completed' &&
              !('refused' in this.selection.reverification(roadmap, entry, snapshot))
                ? { reverifiable: true as const }
                : {}),
              effectiveAutomation: effectiveDelegation(
                roadmap,
                definition?.entries.find((e) => e.id === progress.entryId) ??
                  roadmap.definition.entries.find((e) => e.id === progress.entryId)!,
                definition ?? roadmap.definition,
              ).automation,
            };
          }),
      ),
    };
  }
  /**
   * What the operator is needed for on this roadmap (R-C14), and a pass over computed progress
   * that marks an entry `needs-attention` exactly when only the operator can move it.
   */
  private withOperatorNeeds(tx: StorageRepositories, roadmap: Roadmap) {
    let needs: ReturnType<typeof operatorNeeds> | undefined;
    // The map's evaluation, once per read: the view, the status list and the attention items
    // all read this one (R-E3b).
    let map: CrossProjectView | undefined;
    const selection = roadmap.definition.crossProject;
    const mapState = () => {
      if (selection && !map) map = crossProjectState(tx, roadmap.workspaceId, selection);
      return map;
    };
    const needsOf = (progress: RoadmapView['progress']) => {
      const source =
        selection && tx.imports.definition(roadmap.workspaceId, selection.definitionId)?.source;
      if (!selection || !source) return undefined;
      needs ??= operatorNeeds(
        mapState()!.nodes,
        new Set(
          source.slices.flatMap((slice) =>
            slice.merge_requires.flatMap((r) => (r.kind === 'checkpoint' ? [r.id] : [])),
          ),
        ),
        new Map(source.checkpoints.map((c) => [c.id, c.kind])),
        progress,
      );
      return needs;
    };
    return {
      mapState,
      needs: (progress: RoadmapView['progress']) => needsOf(progress),
      progress: (progress: RoadmapView['progress']): RoadmapView['progress'] => {
        const found = needsOf(progress);
        return progress.map((p) =>
          p.phase && p.blockers?.length && operatorActsNext(p, found)
            ? { ...p, status: 'needs-attention' as const }
            : p,
        );
      },
    };
  }
  /**
   * Brings the scheduler's derived attention up to date (R-A4): verification setup for
   * slice verifications it cannot start, checkpoints ready for independent evidence, and
   * entries held for the operator. They need the map, so the scheduler evaluates them after
   * its pass, from a read snapshot, and writes only the difference. A stopped or paused
   * roadmap's items are resolved with the roadmap's own write.
   */
  syncAttention(force = false): void {
    const attention = this.state.attention;
    if (!attention) return;
    const generation = this.notifier.generation;
    const now = this.state.now().getTime();
    if (
      !force &&
      generation === this.state.attentionSynced.generation &&
      now - this.state.attentionSynced.at < 30_000
    )
      return;
    this.state.attentionSynced = { generation, at: now };
    const snapshot = mapReadSnapshot(this.storage);
    for (const roadmap of this.storage.roadmaps.list()) {
      if (roadmap.status !== 'running') continue;
      const items = this.attentionItems(snapshot, roadmap);
      this.storage.transaction((tx) => {
        const current = tx.roadmaps.find(roadmap.workspaceId, roadmap.id);
        // Checkpoints were one set item before they became one item each (R-A5): the set
        // hands its push schedule to them and is superseded, not resolved as a false alarm.
        const set = `roadmap:${roadmap.id}:checkpoints`;
        attention.sync(
          tx,
          roadmap.workspaceId,
          `roadmap-pass:${roadmap.id}`,
          current?.status === 'running' ? items : [],
          { superseded: new Set([set]), carryFrom: set },
        );
      });
    }
  }
  /** Replay seam (R-I10): the items this roadmap's pass would project if it were running. */
  passAttention(roadmap: Roadmap): readonly ProjectedItem[] {
    return this.attentionItems(mapReadSnapshot(this.storage), roadmap);
  }

  private attentionItems(tx: StorageRepositories, roadmap: Roadmap): ProjectedItem[] {
    const workspaceId = roadmap.workspaceId;
    // The roadmap's board (R-E2); setup items open its setup at their section.
    const ws = encodeURIComponent(workspaceId);
    const path = roadmapPath(ws, roadmap.id);
    const setupPath = (section: string) =>
      roadmapPath(ws, roadmap.id, 'setup', `runtime-evidence-roadmap-${roadmap.id}${section}`);
    const name = roadmap.definition.name;
    const items: ProjectedItem[] = [];
    // Entries only the operator can move by setup or a stop of their own (R-E3b): a slice
    // verification not yet started, by its verify gate; the rest by their computed progress.
    const operator = this.withOperatorNeeds(tx, roadmap);
    const entryProgress = this.view(roadmap, tx, operator).progress;
    const setup = operatorSetupItem({
      roadmapId: roadmap.id,
      name,
      setupPath,
      entries: roadmap.definition.entries.map((entry) => ({
        entry,
        blockers:
          entry.executionScope?.kind === 'slice-verification' &&
          !roadmap.attempts.some((a) => a.entryId === entry.id)
            ? scopePhaseBlockers(tx, workspaceId, entry.workItemId, entry.executionScope, 'verify')
            : entryProgress.find((p) => p.entryId === entry.id)?.blockers,
      })),
    });
    if (setup) items.push(setup);
    if (roadmap.definition.crossProject) {
      // Each checkpoint ready for the operator's acceptance is its own item, named by its kind
      // and counting the unfinished selected slices that wait on it (R-A5, R-C3b).
      const selection = roadmap.definition.crossProject;
      const nodes = operator.mapState()!.nodes;
      const source = tx.imports.definition(workspaceId, selection.definitionId)?.source;
      const needed = operator.needs(entryProgress)?.all ?? new Set();
      for (const node of nodes) {
        if (
          !node.included ||
          node.satisfied ||
          node.kind !== 'checkpoint' ||
          node.blockers.length ||
          !needed.has(node.key)
        )
          continue;
        const kind = source?.checkpoints.find((c) => c.id === node.sourceId)?.kind;
        const code =
          kind === 'architecture_decision'
            ? ('architecture-decision' as const)
            : kind === 'plan_approval'
              ? ('plan-acceptance' as const)
              : ('checkpoint-evidence' as const);
        items.push({
          subjectKey: checkpointSubjectKey(roadmap.id, node.sourceId),
          code,
          kind: 'attention',
          title: `${name} · ${node.sourceId} · ${
            code === 'architecture-decision'
              ? 'Decision to accept'
              : code === 'plan-acceptance'
                ? 'Plan to accept'
                : 'Evidence to review'
          }`,
          message: `${node.title}\n${
            (code === 'architecture-decision' &&
              decisionNeeds(tx, workspaceId, selection, nodes, node.sourceId)) ||
            'Ready for independent evidence review and your acceptance.'
          }`,
          path: setupPath(
            code === 'architecture-decision'
              ? '-decisions'
              : code === 'plan-acceptance'
                ? '-plan-acceptance'
                : '-evidence',
          ),
          refs: { roadmapId: roadmap.id },
          blocks: slicesWaitingOn(nodes, node.key),
        });
      }
    }
    for (const [entryId, hold] of Object.entries(roadmap.entryHolds ?? {})) {
      const held = holdStop(hold);
      if (!held) continue;
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry) continue;
      const attempt = roadmap.attempts.find((a) => a.entryId === entryId);
      const cycle = attempt && tx.execution.cycles.find(workspaceId, attempt.cycleId);
      // The recovery round started from this entry's review, whose repair is where its work
      // happens (LIVE-13). A round for another entry of the work item carries other stops.
      const round = this.selection.roundFor(roadmap, entry);
      const repair =
        round?.recovery?.sourceEntryId === entry.id
          ? tx.execution.cycles.find(workspaceId, round.cycleId)
          : undefined;
      // A manual recovery, or the round's repair, has taken over this checkpoint. The saved
      // hold remains historical until reconciliation; it is not a second task.
      if (cycle?.status === 'running' || repair?.status === 'running') continue;
      if (entry.executionScope && this.selection.scopeComplete(tx, roadmap, entry)) continue;
      // The cycle's own item already carries this stop, with its findings and branch.
      if (
        [cycle, repair].some(
          (carrier) =>
            carrier &&
            tx.attention
              .openInScope(workspaceId, `worktree:${carrier.worktreeId}`)
              .some((item) => item.subjectKey === `cycle:${carrier.id}`),
        )
      )
        continue;
      const reverifiable = !('refused' in this.selection.reverification(roadmap, entry, tx));
      items.push({
        subjectKey: `roadmap:${roadmap.id}:entry:${entry.id}`,
        code: held.code,
        kind: 'attention',
        title: `${entry.sourceId} · Roadmap item needs attention`,
        message: `${entry.title}\n${hold.reason}`,
        path,
        refs: {
          roadmapId: roadmap.id,
          entryId: entry.id,
          workItemId: entry.workItemId,
          ...(cycle ? { cycleId: cycle.id } : {}),
        },
        ...(reverifiable ? { actions: ['reverify' as const] } : {}),
      });
    }
    // An entry held back for a predecessor's missing merge (R-B4, decision 1): its merge is
    // recorded, or merged, in Plan branch settings of the entry's plan.
    for (const [entryId, wait] of Object.entries(roadmap.entryWaits ?? {})) {
      if (wait.code !== 'predecessor-merge-missing') continue;
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      const item = entry && tx.planning.workItems.find(workspaceId, entry.workItemId);
      if (!entry || !item) continue;
      items.push({
        subjectKey: `roadmap:${roadmap.id}:entry:${entry.id}:predecessor-merge`,
        code: 'predecessor-merge-missing',
        kind: 'attention',
        title: `${entry.sourceId} · Predecessor merge missing`,
        message: `${entry.title}\n${wait.reason}`,
        path: `/workspaces/${ws}/projects/${encodeURIComponent(item.projectId)}/plans/${encodeURIComponent(entry.planVersionId)}#branches`,
        refs: { roadmapId: roadmap.id, entryId: entry.id, workItemId: entry.workItemId },
      });
    }
    // An entry whose cycle ended (stopped, or completed without completing the entry) waits on
    // the operator, and the cycle's own item closed with it (R-C10's follow-up, decision 7). A
    // review entry offers Re-verify where it applies; otherwise its item opens the board, whose
    // controls are today's.
    for (const [entryId, wait] of Object.entries(roadmap.entryWaits ?? {})) {
      if (wait.code !== 'cycle-ended') continue;
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry) continue;
      const reverifiable =
        !!entry.executionScope &&
        entry.executionScope.kind !== 'slice' &&
        !('refused' in this.selection.reverification(roadmap, entry, tx));
      items.push({
        subjectKey: `roadmap:${roadmap.id}:entry:${entry.id}:cycle-ended`,
        code: 'cycle-needs-attention',
        kind: 'attention',
        title: `${entry.sourceId} · Cycle ended`,
        message: `${entry.title}\n${wait.reason}`,
        path,
        refs: {
          roadmapId: roadmap.id,
          entryId: entry.id,
          workItemId: entry.workItemId,
          ...(wait.refs?.cycleId ? { cycleId: wait.refs.cycleId } : {}),
        },
        ...(reverifiable ? { actions: ['reverify' as const] } : {}),
      });
    }
    return items;
  }
}
