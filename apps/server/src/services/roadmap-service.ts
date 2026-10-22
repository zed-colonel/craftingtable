import { RoadmapIntegration } from './roadmap/integration.js';
import { RoadmapAdmission } from './roadmap/admission.js';
import { RoadmapControl } from './roadmap/commands/control.js';
import { RoadmapSettings } from './roadmap/commands/settings.js';
import { RoadmapDrain } from './roadmap/drain.js';
import { RoadmapViews } from './roadmap/views.js';
import { RoadmapAttention } from './roadmap/attention.js';
import { RoadmapPreparations } from './roadmap/preparations.js';
import { RoadmapRecoveryRounds } from './roadmap/recovery.js';
import { RoadmapSelection } from './roadmap/selection.js';
import { RoadmapHolds } from './roadmap/holds.js';
import { RoadmapWriter } from './roadmap/writer.js';
import { RoadmapState } from './roadmap/state.js';
import type { RoadmapDefinitionInput, SchedulerObserver } from './roadmap/shared.js';
import { RoadmapSettlement, type SettlementObserver } from './roadmap-settlement.js';
import {
  ControllerKernel,
  type KernelClock,
  type MarkCause,
  SWEEP_MS,
  systemClock,
} from './kernel/controller-kernel.js';
import type { DrainSummary } from './kernel/figures.js';
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
} from '@craftingtable/contracts';
import type {
  AttentionItem,
  Roadmap,
  RoadmapId,
  RoadmapStatusList,
  RoadmapView,
  WorkCycle,
  WorkspaceId,
  RoadmapEntryId,
  WorkCycleId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';

import type { ControllerPasses } from './attention-gates.js';
import type { AttentionProjector, ProjectedItem } from './attention-projector.js';
import type { AuthContext } from './auth-service.js';
import { windDownRefused } from './errors.js';
import type { ExecutionService } from './execution-service.js';
import type { WorkCycleService } from './work-cycle-service.js';
import type { WorkItemService } from './work-item-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

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
  private readonly views: RoadmapViews;
  private readonly roadmapAttention: RoadmapAttention;
  private readonly preparations: RoadmapPreparations;
  private readonly recovery: RoadmapRecoveryRounds;
  private readonly integration: RoadmapIntegration;
  private readonly admission: RoadmapAdmission;
  private readonly controls: RoadmapControl;
  private readonly settings: RoadmapSettings;
  private readonly drain: RoadmapDrain;
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    items: WorkItemService,
    execution: ExecutionService,
    cycles: WorkCycleService,
    private readonly notifier: WorkspaceEventNotifier,
    now: () => Date,
    runtimeEvidence: import('./runtime-evidence-service.js').RuntimeEvidenceService,
    agents: import('./agent-run-service.js').AgentRunService,
    git: import('@craftingtable/git').GitOperations | undefined,
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
    this.views = new RoadmapViews(
      storage,
      workspaces,
      cycles,
      this.state,
      this.writer,
      this.selection,
    );
    this.roadmapAttention = new RoadmapAttention(
      storage,
      notifier,
      this.state,
      this.selection,
      this.views,
    );
    this.preparations = new RoadmapPreparations(
      storage,
      workspaces,
      execution,
      cycles,
      agents,
      git,
      this.state,
      this.writer,
      this.views,
    );
    this.recovery = new RoadmapRecoveryRounds(
      storage,
      workspaces,
      cycles,
      this.state,
      this.writer,
      this.selection,
    );
    cycles.followSweep(this.state.kernel);
    notifier.onWorkflow(() => this.state.kernel.mark('workflow'));
    cycles.onLockRelease((key) => this.drain.lockReleased(key));
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
    this.integration = new RoadmapIntegration(storage, execution, cycles, this.state, this.writer);
    this.admission = new RoadmapAdmission(
      storage,
      items,
      execution,
      cycles,
      runtimeEvidence,
      this.state,
      this.writer,
      this.selection,
      this.holds,
      this.preparations,
      this.integration,
    );
    this.controls = new RoadmapControl(
      storage,
      workspaces,
      cycles,
      notifier,
      this.settlement,
      this.state,
      this.writer,
      this.selection,
      this.holds,
      this.views,
    );
    this.settings = new RoadmapSettings(
      storage,
      workspaces,
      cycles,
      notifier,
      this.state,
      this.writer,
      this.views,
    );
    this.drain = new RoadmapDrain(
      storage,
      notifier,
      this.settlement,
      this.state,
      this.writer,
      this.holds,
      this.roadmapAttention,
      this.recovery,
      this.admission,
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

  control(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    action: 'start' | 'pause' | 'resume' | 'stop',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    return this.controls.control(context, workspaceId, id, action, expectedVersion);
  }
  controlEntry(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    entryId: RoadmapEntryId,
    action: 'pause' | 'resume',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    return this.controls.controlEntry(context, workspaceId, id, entryId, action, expectedVersion);
  }
  reverifyEntry(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    entryId: RoadmapEntryId,
    expectedVersion: number,
  ): Promise<RoadmapView> {
    return this.controls.reverifyEntry(context, workspaceId, id, entryId, expectedVersion);
  }
  recoverInterrupted(options: { readonly cleanStop?: boolean } = {}): string[] {
    return this.controls.recoverInterrupted(options);
  }
  applyAgentSettings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: ApplyRoadmapAgents,
  ): RoadmapAgentSettings {
    return this.settings.applyAgentSettings(context, workspaceId, id, input);
  }
  assignCycleEntryAgents(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    entryId: RoadmapEntryId,
    selections: import('@craftingtable/domain').AgentSelections,
  ): void {
    this.settings.assignCycleEntryAgents(context, workspaceId, id, entryId, selections);
  }
  applyDelegation(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: ApplyRoadmapDelegation,
  ): RoadmapView {
    return this.settings.applyDelegation(context, workspaceId, id, input);
  }
  saveCapacity(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: SaveRoadmapCapacity,
  ): RoadmapCapacities {
    return this.settings.saveCapacity(context, workspaceId, id, input);
  }
  configureScopeRecovery(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: ScopeRecoveryPolicyRequest,
  ): RoadmapView {
    return this.settings.configureScopeRecovery(context, workspaceId, id, input);
  }
  configureReverification(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: ReverificationGrantRequest,
  ): RoadmapView {
    return this.settings.configureReverification(context, workspaceId, id, input);
  }
  configureDecisionPreparation(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: DecisionPreparationGrantRequest,
  ): RoadmapView {
    return this.settings.configureDecisionPreparation(context, workspaceId, id, input);
  }
  save(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: SaveRoadmapRequest,
  ): RoadmapView {
    return this.settings.save(context, workspaceId, id, input);
  }
  workspaceProfiles(
    workspaceId: WorkspaceId,
    permissions?: import('@craftingtable/contracts').StepPermissions,
  ) {
    return this.settings.workspaceProfiles(workspaceId, permissions);
  }
  saveDefinition(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
    input: RoadmapDefinitionInput,
    crossProject?: import('@craftingtable/domain').CrossProjectConfiguration,
    amendment?: { readonly retainAttemptIds: readonly string[] },
  ): RoadmapView {
    return this.settings.saveDefinition(context, workspaceId, id, input, crossProject, amendment);
  }
  startWorker(): void {
    this.drain.startWorker();
  }
  shutdown(): Promise<void> {
    return this.drain.shutdown();
  }
  holdAdmissions(held: boolean): void {
    this.drain.holdAdmissions(held);
  }
  wake(cause: MarkCause): void {
    this.drain.wake(cause);
  }
  lockReleased(key: string): void {
    this.drain.lockReleased(key);
  }
  tick(): Promise<void> {
    return this.drain.tick();
  }
  figures(): DrainSummary {
    return this.drain.figures();
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
    return this.views.list(context, workspaceId);
  }
  agentSettings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: RoadmapId,
  ): RoadmapAgentSettings {
    return this.views.agentSettings(context, workspaceId, id);
  }
  decisionSettings(context: AuthContext, ws: WorkspaceId, id: RoadmapId) {
    return this.views.decisionSettings(context, ws, id);
  }
  capacities(context: AuthContext, workspaceId: WorkspaceId): RoadmapCapacities {
    return this.views.capacities(context, workspaceId);
  }
  statusList(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId): RoadmapStatusList {
    return this.views.statusList(context, workspaceId, id);
  }
  /** The arguments left out are the views' own defaults, read there. */
  statusOf(
    roadmap: Roadmap,
    snapshot?: StorageRepositories,
    operator?: ReturnType<RoadmapViews['withOperatorNeeds']>,
    progress?: readonly import('@craftingtable/domain').RoadmapEntryProgress[],
  ): RoadmapStatusList {
    return this.views.statusOf(roadmap, snapshot, operator, progress);
  }
  page(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId) {
    return this.views.page(context, workspaceId, id);
  }
  mapItemSlices(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    items: readonly { readonly item: AttentionItem; readonly checkpointId?: string }[],
  ): ReadonlyMap<string, number> {
    return this.views.mapItemSlices(tx, workspaceId, items);
  }
  graph(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId, revision: number) {
    return this.views.graph(context, workspaceId, id, revision);
  }
  definition(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId, revision: number) {
    return this.views.definition(context, workspaceId, id, revision);
  }
  summaries(context: AuthContext, workspaceId: WorkspaceId) {
    return this.views.summaries(context, workspaceId);
  }
  history(context: AuthContext, workspaceId: WorkspaceId, id: RoadmapId) {
    return this.views.history(context, workspaceId, id);
  }
  syncAttention(force = false): void {
    this.roadmapAttention.syncAttention(force);
  }
  passAttention(roadmap: Roadmap): readonly ProjectedItem[] {
    return this.roadmapAttention.passAttention(roadmap);
  }
  prepareDecision(
    context: AuthContext,
    ws: WorkspaceId,
    id: RoadmapId,
    input: PrepareRoadmapDecision,
  ): Promise<RoadmapView> {
    return this.preparations.prepareDecision(context, ws, id, input);
  }
  delegateScopeRepair(
    context: AuthContext,
    ws: WorkspaceId,
    cycleId: WorkCycleId,
    input: ScopeRepairRequest,
  ): Promise<WorkCycle> {
    return this.recovery.delegateScopeRepair(context, ws, cycleId, input);
  }
}
