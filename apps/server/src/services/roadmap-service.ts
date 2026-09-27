import {
  decisionBindingDigest,
  supportsArchitectureDecision,
} from './architecture-decision-policy.js';
import { cycleOwnership, ownerOf } from './cycle-ownership.js';
import { predecessorGate } from './transition-gate.js';
import { currentDecisionPreparation } from './decision-preparation-policy.js';
import {
  attemptDefinition,
  attemptDelegation,
  effectiveDelegation,
} from './roadmap-delegation-policy.js';
import { randomUUID } from 'node:crypto';
import type {
  PrepareRoadmapDecision,
  ApplyRoadmapAgents,
  ApplyRoadmapDelegation,
  RoadmapAgents,
  RoadmapCapacities,
  SaveRoadmapCapacity,
  SaveRoadmapRequest,
  ScopeRecoveryPolicyRequest,
  ScopeRepairRequest,
} from '@craftingtable/contracts';
import {
  selectionsForPurpose,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  asWorktreeId,
  type AgentRunId,
  DEFAULT_ROADMAP_SCHEDULING,
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapEntry,
  type RoadmapView,
  roadmapAttention,
  type RoadmapAttention,
  effectiveHoldAttention,
  PHASE_BLOCKERS,
  phaseBlockerCode,
  SETUP_BLOCKER_CODES,
  resumeRedirect,
  sameExecutionScope,
  type WorkCycle,
  type WorkspaceId,
  startedAttempts,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { cycleAgentSelection, entryAgentSelections } from './agent-profile-policy.js';
import type { AuthContext, CommandContext } from './auth-service.js';
import { IntegrationHeldError, RepositoryMutationBusyError } from './branch-service.js';
import { bindingIssues, crossProjectState, milestoneSatisfied } from './cross-project-service.js';
import { ConcurrentModificationError, ExecutionRequestError, NotFoundError } from './errors.js';
import {
  requireScopeOwnership,
  resolveScope,
  scopeBlockers,
  scopePhaseBlockers,
  unsupportedScopeCapabilities,
} from './execution-scope.js';
import type { ExecutionService } from './execution-service.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { PhaseGateError } from './phase-resources.js';
import { PLAN_CHECKPOINT } from './plan-acceptance-policy.js';
import { acceptedEvidence } from './runtime-evidence-policy.js';
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
import type { ControllerPasses } from './attention-gates.js';
import type { AttentionProjector, ProjectedItem } from './attention-projector.js';

class SupersededRoadmapOperation extends Error {}

const ended = (roadmap: Roadmap) => ['stopped', 'completed'].includes(roadmap.status);
/** An entry the scheduler holds for a typed reason the operator resolves (R-A5). */
class EntryHoldError extends ExecutionRequestError {
  constructor(
    readonly attentionCode: 'evidence-not-current',
    message: string,
  ) {
    super('conflict', message);
  }
}
/**
 * The holds left once the operator answered a stopped review with a repair round: its
 * needs-attention hold is answered, an explicit item pause stays.
 */
function answeredHolds(roadmap: Roadmap, entryId: string): Roadmap['entryHolds'] {
  const { [entryId]: hold, ...others } = roadmap.entryHolds ?? {};
  return hold?.status === 'needs-attention' ? others : roadmap.entryHolds;
}
function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}
/**
 * A sequential roadmap's reason follows its single current entry. A parallel roadmap keeps
 * its scheduling reason: per-entry progress carries each entry's state, and rewriting the
 * shared reason per entry only to restore it after the pass wastes a write and an event.
 */
function entryReason(parallel: boolean, reason: string): { reason?: string } {
  return parallel ? {} : { reason };
}

/** One delegated roadmap per workspace. The cycle controller owns every agent step. */
/** A roadmap write: entering `needs-attention` must declare its typed stop (R-A3). */
type RoadmapChanges = Omit<Partial<Roadmap>, 'status' | 'attention'> &
  (
    | { readonly status: 'needs-attention'; readonly attention: RoadmapAttention }
    | {
        readonly status?: Exclude<Roadmap['status'], 'needs-attention'>;
        readonly attention?: undefined;
      }
  );

export class RoadmapService {
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;
  private ticking = false;
  private admissionsHeld = false;
  private readonly controlling = new Set<string>();
  /** Operator-requested rounds whose Delegate source fixes request is still preparing them. */
  private readonly preparingRounds = new Set<string>();
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly items: WorkItemService,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
    private readonly runtimeEvidence?: import('./runtime-evidence-service.js').RuntimeEvidenceService,
    private readonly agents?: import('./agent-run-service.js').AgentRunService,
    private readonly git?: import('@craftingtable/git').GitOperations,
  ) {}
  private attention: AttentionProjector | undefined;
  private passes: ControllerPasses | undefined;
  /** Attention projection and controller quiescence (R-A4); the daemon always attaches them. */
  attachAttention(attention: AttentionProjector, passes: ControllerPasses): void {
    this.attention = attention;
    this.passes = passes;
  }

  list(context: AuthContext, workspaceId: WorkspaceId): readonly RoadmapView[] {
    this.workspaces.requireAuthorized(context, workspaceId);
    // One read snapshot for the whole list: roadmaps share definitions, evidence
    // and scheduling reads, so a per-roadmap snapshot re-decoded them (PERF-08a).
    const snapshot = mapReadSnapshot(this.storage);
    return this.storage.roadmaps.list(workspaceId).map((roadmap) => this.view(roadmap, snapshot));
  }
  agentSettings(context: AuthContext, workspaceId: WorkspaceId): RoadmapAgents {
    this.workspaces.requireAuthorized(context, workspaceId);
    return {
      roadmaps: this.storage.roadmaps
        .list(workspaceId)
        .filter((r) => !ended(r))
        .map((r) => ({
          id: r.id,
          name: r.definition.name,
          version: r.version,
          status: r.status,
          editBlocker: this.controlling.has(r.id)
            ? 'A roadmap command is in progress.'
            : r.status === 'running'
              ? 'Pause scheduling before applying agent profiles. Running agents may finish normally.'
              : this.storage.amendments.pending(workspaceId, r.id)
                ? 'Decide the pending planning amendment first.'
                : null,
          entries: r.definition.entries.map((e) => {
            const { selections, assignment } = entryAgentSelections(r, e);
            return {
              id: e.id,
              label: e.sourceId + (e.executionScope ? ` · ${e.executionScope.kind}` : ''),
              projectId: e.projectId,
              projectName:
                this.storage.planning.projects.find(workspaceId, e.projectId)?.name ?? e.projectId,
              selections,
              ...(assignment ? { appliedAt: assignment.appliedAt } : {}),
              started: startedAttempts(r).some((a) => a.entryId === e.id),
            };
          }),
        })),
    };
  }
  applyAgentSettings(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    input: ApplyRoadmapAgents,
  ): RoadmapAgents {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const old = this.find(workspaceId, id);
    if (old.version !== input.expectedVersion || this.controlling.has(id))
      conflict(
        'Roadmap changed. Refresh agent settings and review the current selection before applying.',
      );
    if (!['draft', 'paused', 'needs-attention'].includes(old.status))
      conflict('Pause roadmap scheduling before applying agent profiles.');
    if (this.storage.amendments.pending(workspaceId, id))
      conflict('Decide the pending planning amendment first.');
    if (
      new Set(input.entryIds).size !== input.entryIds.length ||
      input.entryIds.some((id) => !old.definition.entries.some((e) => e.id === id))
    )
      conflict('Select current entries from this roadmap.');
    this.cycles.validateAgentSelections(input.selections);
    const assignment = {
      id: randomUUID(),
      entryIds: input.entryIds,
      selections: input.selections,
      appliedAt: this.now().toISOString(),
      appliedByUserId: context.user.id,
    };
    this.change(
      old,
      { agentAssignments: [...(old.agentAssignments ?? []), assignment] },
      'apply-agent-profiles',
      context,
    );
    return this.agentSettings(context, workspaceId);
  }
  decisionSettings(context: AuthContext, ws: WorkspaceId, id: string) {
    this.workspaces.requireAuthorized(context, ws);
    const roadmap = this.find(ws, id),
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
              profile: selectionsForPurpose(
                entryAgentSelections(roadmap, entry).selections,
                'investigation',
              ),
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
    id: string,
    input: PrepareRoadmapDecision,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const old = this.find(ws, id),
      cp = old.definition.crossProject;
    if (!this.agents || !this.git)
      conflict('Decision preparation is unavailable on this controller.');
    if (old.version !== input.expectedVersion || this.controlling.has(id))
      conflict('Roadmap changed. Refresh before preparing a decision.');
    if (!cp || !['paused', 'draft', 'needs-attention'].includes(old.status))
      conflict('Pause this cross-project roadmap before preparing a decision.');
    if (this.storage.amendments.pending(ws, id))
      conflict('Resolve the pending planning amendment first.');
    const d = this.storage.imports.definition(ws, cp.definitionId);
    const binding = this.storage.imports.bindings(ws, cp.definitionId)[0];
    if (
      !d ||
      binding?.revision !== cp.bindingRevision ||
      !supportsArchitectureDecision(d, input.checkpointId)
    )
      conflict('Choose an architecture decision from the exact current map binding.');
    const checkpoint = d.source.checkpoints.find((c) => c.id === input.checkpointId)!;
    const owner = binding.bindings.find((b) => b.alias === checkpoint.owner);
    if (
      !owner?.repositoryId ||
      !owner.projectId ||
      !owner.planVersionId ||
      !owner.integrationBranch
    )
      conflict('Bind this decision owner to an exact plan and integration branch first.');
    if (
      old.decisionPreparations?.some(
        (p) =>
          p.checkpointId === checkpoint.id &&
          !p.failure &&
          (!this.storage.execution.runs.find(ws, p.runId) ||
            ['starting', 'running', 'waiting'].includes(
              this.storage.execution.runs.find(ws, p.runId)!.status,
            )),
      )
    )
      conflict(
        'This decision already has a preparation in flight. Open its run or wait for completion.',
      );
    const entry = old.definition.entries.find((e) => e.planVersionId === owner.planVersionId);
    if (!entry) conflict('This decision owner is outside the selected roadmap.');
    this.cycles.validateAgentSelections({
      ...entryAgentSelections(old, entry).selections,
      investigation: input.profile,
    });
    const repo = this.storage.execution.sourceRepositories.find(ws, owner.repositoryId);
    if (!repo) throw new NotFoundError();
    this.controlling.add(id);
    let reserved: import('@craftingtable/domain').DecisionPreparation | undefined;
    try {
      const result = await this.git.resolveBranch(repo.rootPath, owner.integrationBranch);
      if (!result.ok) conflict(result.failure.message);
      if (this.find(ws, id).version !== old.version)
        conflict('Roadmap changed during preparation. Refresh and try again.');
      const at = this.now();
      const p: import('@craftingtable/domain').DecisionPreparation = {
        id: randomUUID(),
        definitionId: d.id,
        bindingRevision: binding.revision,
        bindingDigest: decisionBindingDigest(this.storage, d, binding.revision),
        checkpointId: checkpoint.id,
        workspaceId: ws,
        repositoryId: owner.repositoryId,
        projectId: owner.projectId,
        planVersionId: owner.planVersionId,
        integrationBranch: owner.integrationBranch,
        integrationSha: result.value,
        worktreeId: asWorktreeId(randomUUID()),
        runId: asAgentRunId(randomUUID()),
        profile: input.profile,
        deadlineAt: new Date(at.getTime() + input.minutes * 60000).toISOString(),
        instructions: input.instructions,
        createdAt: at.toISOString(),
        createdByUserId: context.user.id,
      };
      const saved = this.change(
        old,
        { decisionPreparations: [...(old.decisionPreparations ?? []), p] },
        'prepare-decision',
        context,
      );
      reserved = p;
      const check = () => {
        this.workspaces.requireRole(context, ws, ['owner', 'editor']);
        if (
          this.find(ws, id).version !== saved.version ||
          !currentDecisionPreparation(this.storage, p) ||
          this.now().getTime() >= Date.parse(p.deadlineAt)
        )
          conflict('Decision preparation authority or binding changed. Start a fresh preparation.');
      };
      check();
      await this.execution.createDecisionWorktree(context, p, check);
      check();
      await this.agents.startDecisionPreparation(context, p, check);
    } catch (e) {
      if (reserved) {
        const current = this.find(ws, id);
        this.change(
          current,
          {
            decisionPreparations: current.decisionPreparations!.map((p) =>
              p.id === reserved!.id
                ? { ...p, failure: e instanceof Error ? e.message : 'Preparation failed' }
                : p,
            ),
          },
          'decision-preparation-failed',
          context,
        );
      }
      throw e;
    } finally {
      this.controlling.delete(id);
    }
    return this.view(this.find(ws, id));
  }
  applyDelegation(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    input: ApplyRoadmapDelegation,
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const old = this.find(workspaceId, id);
    if (old.version !== input.expectedVersion || this.controlling.has(id))
      conflict('Roadmap changed. Refresh before applying delegation.');
    if (!['draft', 'paused', 'needs-attention'].includes(old.status))
      conflict('Pause scheduling before changing delegation.');
    if (this.storage.amendments.pending(workspaceId, id))
      conflict('Decide the pending planning amendment first.');
    if (
      this.storage.execution.runs.listLive().some((r) => r.workspaceId === workspaceId) ||
      this.storage.execution.cycles
        .listForWorkspace(workspaceId)
        .some((c) => c.status === 'running')
    )
      conflict('Wait for running agents and cycles to finish before changing delegation.');
    if (
      new Set(input.entryIds).size !== input.entryIds.length ||
      input.entryIds.some((id) => !old.definition.entries.some((e) => e.id === id))
    )
      conflict('Select current roadmap entries.');
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
    if (input.automation.resolutionProfile)
      this.cycles.validateAgentSelections({
        ...this.agentSettings(context, workspaceId).roadmaps.find((r) => r.id === id)!.entries[0]!
          .selections,
        conflict: input.automation.resolutionProfile,
      });
    const { expectedVersion: _version, ...grant } = input;
    return this.view(
      this.change(
        old,
        {
          delegationAssignments: [
            ...(old.delegationAssignments ?? []),
            {
              ...grant,
              id: randomUUID(),
              appliedAt: this.now().toISOString(),
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
        .map((r) => ({
          id: r.id,
          version: r.version,
          name: r.definition.name,
          status: r.status,
          crossProject: !!r.definition.crossProject,
          revision: r.definition.revision,
          scheduling: r.definition.scheduling ?? DEFAULT_ROADMAP_SCHEDULING,
          editBlocker: this.controlling.has(r.id)
            ? 'A roadmap command is in progress.'
            : r.status === 'running'
              ? 'Pause this roadmap before changing its limits.'
              : this.storage.amendments.pending(workspaceId, r.id)
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
    id: string,
    input: SaveRoadmapCapacity,
  ): RoadmapCapacities {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const old = this.find(workspaceId, id);
    if (this.controlling.has(id) || old.version !== input.expectedVersion)
      conflict('Roadmap changed; refresh before saving capacity.');
    if (!['draft', 'paused', 'needs-attention'].includes(old.status))
      conflict('Pause the roadmap before changing capacity. Ended roadmaps retain their history.');
    if (this.storage.amendments.pending(workspaceId, id))
      conflict('Decide the pending planning amendment first.');
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
    const at = this.now().toISOString();
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
      this.persist(tx, updated, input.expectedVersion, 'configure-capacity', context);
      tx.roadmaps.addDefinition(definition);
    });
    this.notifier.notify();
    return this.capacities(context, workspaceId);
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
        'Finish the in-flight attempts before changing scheduling mode. Capacity limits can be edited while paused.',
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
        if (attempt.dependencyRefresh || attempt.reverification) continue;
        if (roadmap.entryHolds?.[attempt.entryId]?.status === 'paused') continue;
        const cycle = this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
        // Recovery, not another review of unchanged source, owns these stopped checkpoints.
        if (
          cycle?.executionScope &&
          cycle.executionScope.kind !== 'slice' &&
          ((roadmap.scopeRecovery?.enabled && cycle.status === 'needs-attention') ||
            !!this.roundFor(
              roadmap,
              roadmap.definition.entries.find((e) => e.id === attempt.entryId)!,
            ))
        )
          continue;
        if (
          cycle &&
          ['paused', 'needs-attention'].includes(cycle.status) &&
          this.resumable(cycle)
        ) {
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

  /**
   * A stop that a plain resume would only reproduce keeps its attention when the roadmap
   * or its item resumes; the operator resolves it with the control it names (R-A7).
   */
  private resumable(cycle: WorkCycle): boolean {
    return (
      cycle.status !== 'needs-attention' ||
      resumeRedirect(
        cycle,
        this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId)[0]?.id,
      ) === undefined
    );
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
          this.resumable(cycle) &&
          !(
            cycle.executionScope &&
            cycle.executionScope.kind !== 'slice' &&
            ((roadmap.scopeRecovery?.enabled && cycle.status === 'needs-attention') ||
              !!this.roundFor(roadmap, entry))
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
    id: string,
    entryId: string,
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.controlling.has(id)) conflict('A roadmap command is already in progress.');
    this.controlling.add(id);
    try {
      const roadmap = this.find(workspaceId, id);
      if (roadmap.version !== expectedVersion)
        conflict('Roadmap changed; refresh before issuing this command.');
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry) conflict('This entry is unavailable.');
      const plan = this.reverification(roadmap, entry);
      if ('refused' in plan) conflict(plan.refused);
      const at = this.now().toISOString();
      const { [entry.id]: _released, ...entryHolds } = roadmap.entryHolds ?? {};
      const attempt = plan.attempt;
      this.change(
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
      return this.view(this.find(workspaceId, id));
    } finally {
      this.controlling.delete(id);
      this.notifier.notify();
    }
  }
  /** Whether an entry may be re-verified, and how; the view and the command share it. */
  private reverification(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    tx: StorageRepositories = this.storage,
  ):
    | { refused: string }
    | { attempt: RoadmapAttempt; inPlace: true; sourceRunId: AgentRunId }
    | { attempt: RoadmapAttempt; inPlace: false } {
    if (['draft', 'stopped', 'completed'].includes(roadmap.status))
      return { refused: 'Re-verification needs an active roadmap.' };
    if (!entry.executionScope || entry.executionScope.kind === 'slice')
      return { refused: 'Only verification and parent acceptance entries can be re-verified.' };
    if (this.recoveryFor(roadmap, entry))
      return { refused: 'Scope recovery owns this entry; finish its recovery first.' };
    const hold = roadmap.entryHolds?.[entry.id];
    if (hold?.status === 'paused')
      return { refused: 'This item is paused. Resume the item before re-verifying it.' };
    const attempt = roadmap.attempts.find((a) => a.entryId === entry.id && !a.recovery);
    if (!attempt) return { refused: 'This entry has not run yet; resume the roadmap.' };
    // A queued review that failed holds the item; re-verifying replaces it with a fresh route.
    if (attempt.dependencyRefresh || (attempt.reverification && !hold))
      return { refused: 'A fresh review is already queued for this entry.' };
    const cycle = tx.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
    if (!cycle && !hold)
      return { refused: 'This entry is still being prepared; wait for its review cycle.' };
    if (cycle && !['completed', 'stopped'].includes(cycle.status))
      return { refused: 'Its review cycle is still open; finish or stop it first.' };
    if (this.complete(roadmap, entry, tx))
      return { refused: 'This evidence is current; there is nothing to re-verify.' };
    const tree = tx.execution.worktrees.find(roadmap.workspaceId, attempt.worktreeId);
    if (
      cycle?.status === 'completed' &&
      tree?.status === 'active' &&
      !tx.amendments.retired(roadmap.workspaceId, tree.id) &&
      sameExecutionScope(tree.executionScope, entry.executionScope)
    )
      return { attempt, inPlace: true, sourceRunId: cycle.currentRunId };
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
      return {
        refused: `Remove the unused worktree ${other.branchName} first; a verification scope has one active worktree.`,
      };
    return { attempt, inPlace: false };
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
        this.change(
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
    for (const roadmap of this.storage.roadmaps.list())
      if (roadmap.status === 'running') {
        this.change(roadmap, {
          status: 'needs-attention',
          attention: roadmapAttention('restart-resume'),
          reason: 'Daemon restarted. Inspect the current item and explicitly resume the roadmap.',
        });
        stopped.push(roadmap.id);
      }
    return stopped;
  }
  startWorker(): void {
    this.passes?.register('roadmaps');
    this.task ??= this.loop();
  }
  async shutdown(): Promise<void> {
    this.abort.abort();
    this.passes?.unregister('roadmaps');
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
  /** A restart drain holds admissions: running roadmaps start no new work (R-B9). */
  holdAdmissions(held: boolean): void {
    this.admissionsHeld = held;
    if (!held) this.notifier.notify();
  }
  /** Serialized tick is also the deterministic integration-test seam. */
  async tick(): Promise<void> {
    if (this.ticking || this.abort.signal.aborted || this.admissionsHeld) return;
    this.ticking = true;
    const pass = this.passes?.started();
    try {
      for (const roadmap of this.storage.roadmaps.list()) {
        if (this.abort.signal.aborted) break;
        if (this.controlling.has(roadmap.id)) continue;
        // A paused roadmap adopts open repairs too; its pause holds their controller reviews.
        if (['paused', 'needs-attention'].includes(roadmap.status)) {
          try {
            this.adoptManualRepairs(roadmap);
          } catch {
            // Adoption is retried on the next pass.
          }
          continue;
        }
        if (roadmap.status !== 'running') continue;
        try {
          await this.advance(this.adoptManualRepairs(roadmap));
        } catch (error) {
          if (
            error instanceof SupersededRoadmapOperation ||
            error instanceof ConcurrentModificationError ||
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
              attention: roadmapAttention('scheduler-error'),
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
      this.ticking = false;
      if (pass !== undefined) this.passes?.completed('roadmaps', pass);
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
          // Evidence that became current again also ends a queued re-verification.
          if (attempt && (attempt.status !== 'completed' || attempt.reverification))
            this.change(current, {
              attempts: current.attempts.map((a) =>
                a.id === attempt.id
                  ? {
                      ...a,
                      status: 'completed' as const,
                      completedAt: a.completedAt ?? this.now().toISOString(),
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
        if (current.entryHolds?.[entry.id] && !merged) continue;
        try {
          await this.advanceEntry(current, entry);
        } catch (error) {
          if (error instanceof SupersededRoadmapOperation) throw error;
          if (
            error instanceof ConcurrentModificationError ||
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
              [entry.id]: {
                status: 'needs-attention',
                reason: reason.slice(0, 4000),
                attention: roadmapAttention(
                  error instanceof EntryHoldError
                    ? error.attentionCode
                    : 'entry-preparation-failed',
                  { entryId: entry.id },
                ),
              },
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
    if (attempt && this.cycles.isTransitioning(attempt.cycleId)) return;
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
              const current = this.find(roadmap.workspaceId, roadmap.id);
              this.authority(current);
              const queued = current.attempts.find((a) => a.id === attempt!.id);
              if (
                current.status !== 'running' ||
                current.entryHolds?.[entry.id] ||
                this.controlling.has(current.id) ||
                this.abort.signal.aborted ||
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
                const current = this.find(roadmap.workspaceId, roadmap.id);
                this.change(current, {
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
            return;
          }
          if (
            !reviewingRecovery &&
            (roadmap.scopeRecovery?.enabled || this.roundFor(roadmap, entry)) &&
            (await this.advanceScopeRecovery(roadmap, entry, cycle))
          )
            return;
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
          ...entryReason(parallel, `${entry.sourceId} integrated.`),
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
        const automation = (
          attemptDelegation(this.storage, roadmap, boundAttempt, entry.id) ??
          effectiveDelegation(roadmap, entry, roadmap.definition)
        ).automation;
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
              profile: (() => {
                const selected = cycleAgentSelection(this.storage, cycle, 'conflict');
                return selected.provenance.assignmentId || cycle.profiles.conflict
                  ? selected.profile
                  : (automation.resolutionProfile ?? selected.profile);
              })(),
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
              return;
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
            attention: roadmapAttention('cycle-needs-attention', {
              cycleId: cycle.id,
              entryId: entry.id,
            }),
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
        this.change(roadmap, {
          status: 'needs-attention',
          attention: roadmapAttention('entry-blocked', { entryId: entry.id }),
          reason: blocker.reason,
        });
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
        ...entryReason(parallel, `Preparing ${entry.sourceId}.`),
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
        ownerOf(roadmap, reserved),
      );
      this.change(roadmap, {
        attempts: roadmap.attempts.map((a) =>
          a.id === reserved.id ? { ...a, status: 'active' } : a,
        ),
        ...entryReason(parallel, `Running ${entry.sourceId}.`),
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
  /** The review each of the work item's verification and parent entries last ran. */
  private reviewRunIds(roadmap: Roadmap, entry: RoadmapEntry): Record<string, string> {
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
    cycleId: string,
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
    const open = this.recoveryFor(roadmap, sourceEntry);
    // A round this command prepared earlier and that created nothing is retried in place.
    const retry =
      open?.status === 'preparing' &&
      open.recovery!.requestedByUserId &&
      !this.preparingRounds.has(open.id) &&
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
        id: randomUUID(),
        entryId: owner.id,
        definitionRevision: ownerAttempt.definitionRevision,
        worktreeId: existing ?? asWorktreeId(randomUUID()),
        cycleId: randomUUID(),
        status: 'preparing',
        createdAt: this.now().toISOString(),
        recovery: {
          sourceEntryId: sourceEntry.id,
          sourceRunId: source!.currentRunId,
          sourceSequence: turn.sequence,
          findingFingerprint: findingFingerprint(report.report.findings),
          phase: 'repair',
          reviewRunIds: this.reviewRunIds(roadmap, sourceEntry),
          requestedByUserId: context.user.id,
        },
      };
      roadmap = this.change(
        roadmap,
        { attempts: [...roadmap.attempts, reserved] },
        'reserve-scope-recovery',
        context,
      );
    }
    const round = reserved;
    const id = roadmap.id;
    // No other request may take this reservation over, or remove it, while this one prepares it.
    this.preparingRounds.add(round.id);
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
            const current = this.find(ws, id);
            if (
              ended(current) ||
              !current.attempts.some((a) => a.id === round.id && a.status === 'preparing')
            )
              conflict('The roadmap changed while this repair was being prepared. Refresh.');
          },
          // The stop is answered once the repair exists, in the transaction that creates it;
          // a refused request leaves it as it was.
          attach: () => {
            const current = this.find(ws, id);
            this.change(current, {
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
      const current = this.find(ws, id);
      if (
        !this.storage.execution.worktrees.find(ws, round.worktreeId) &&
        !this.storage.execution.cycles.find(ws, round.cycleId) &&
        current.attempts.some((a) => a.id === round.id && a.status === 'preparing')
      )
        this.change(current, { attempts: current.attempts.filter((a) => a.id !== round.id) });
      throw error;
    } finally {
      this.preparingRounds.delete(round.id);
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
      )
        continue;
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
      if (!sourceEntry || !owner || !ownerAttempt || this.recoveryFor(roadmap, sourceEntry))
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
        id: randomUUID(),
        entryId: owner.id,
        definitionRevision: ownerAttempt.definitionRevision,
        worktreeId: cycle.worktreeId,
        cycleId: cycle.id,
        status: 'active',
        createdAt: this.now().toISOString(),
        recovery: {
          sourceEntryId: sourceEntry.id,
          sourceRunId: asAgentRunId(pinned.runId),
          sourceSequence: pinned.sequence,
          findingFingerprint: findingFingerprint(
            report?.status === 'complete' ? report.report.findings : [],
          ),
          phase: 'repair',
          reviewRunIds: this.reviewRunIds(roadmap, sourceEntry),
          requestedByUserId: cycle.createdByUserId,
        },
      };
      const adopted = roadmap;
      roadmap = this.storage.transaction(() => {
        const next = this.change(
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
    }
    return roadmap;
  }
  /** The live recovery round for this work item that the roadmap carries through. */
  private roundFor(roadmap: Roadmap, entry: RoadmapEntry) {
    const round = this.recoveryFor(roadmap, entry);
    return round && roadmapCarriesRound(roadmap, round) ? round : undefined;
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
      if (sourceCycle.status !== 'needs-attention' || !roadmap.scopeRecovery?.enabled) return false;
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
          reviewRunIds: this.reviewRunIds(roadmap, entry),
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
        !current.attempts.some((a) => a.id === reserved.id && roadmapCarriesRound(current, a)) ||
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
      // The operator's command prepares its own round; a failed one is retried from there. One
      // that no request is preparing (it failed, or the daemon stopped) waits on the operator.
      if (reserved.status === 'preparing' && reserved.recovery!.requestedByUserId) {
        if (this.preparingRounds.has(reserved.id)) return true;
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
        const blocked = this.blocker(roadmap, owner, reserved);
        if (blocked) {
          if (blocked.needsAttention) conflict(blocked.reason);
          return true;
        }
        const preview = collectScopeRepair(mapReadSnapshot(this.storage), sourceCycle);
        const frozen = attemptDefinition(this.storage, roadmap, reserved)?.entries.find(
          (e) => e.id === owner.id,
        );
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
            owner: ownerOf(roadmap, reserved),
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
        attemptDefinition(this.storage, roadmap, reviewAttempt!)?.scheduling ??
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
  private view(roadmap: Roadmap, snapshot = mapReadSnapshot(this.storage)): RoadmapView {
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
          const recovery = this.roundFor(roadmap, entry);
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
                // Classified by who resolves each blocker (R-A3, UI-09): operator-owned
                // evidence such as plan acceptance is the operator's, not other work.
                status: blockers.some(
                  (b) => PHASE_BLOCKERS[phaseBlockerCode(b)].owner === 'operator',
                )
                  ? 'needs-attention'
                  : blockers.some((b) => phaseBlockerCode(b) === 'resource-busy')
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
            ? attemptDefinition(snapshot, roadmap, attempt)
            : roadmap.definition;
          const entry = roadmap.definition.entries.find((e) => e.id === progress.entryId)!;
          return {
            ...progress,
            ...(progress.status !== 'completed' &&
            !('refused' in this.reverification(roadmap, entry, snapshot))
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
    };
  }
  private find(workspaceId: WorkspaceId, id: string): Roadmap {
    const roadmap = this.storage.roadmaps.find(workspaceId, id);
    if (!roadmap) throw new NotFoundError();
    return roadmap;
  }
  /**
   * Brings the scheduler's derived attention up to date (R-A4): verification setup for
   * slice verifications it cannot start, checkpoints ready for independent evidence, and
   * entries held for the operator. They need the map, so the scheduler evaluates them after
   * its pass, from a read snapshot, and writes only the difference. A stopped or paused
   * roadmap's items are resolved with the roadmap's own write.
   */
  syncAttention(force = false): void {
    const attention = this.attention;
    if (!attention) return;
    const generation = this.notifier.generation;
    const now = this.now().getTime();
    if (
      !force &&
      generation === this.attentionSynced.generation &&
      now - this.attentionSynced.at < 30_000
    )
      return;
    this.attentionSynced = { generation, at: now };
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
  private attentionSynced = { generation: -1, at: 0 };

  private attentionItems(tx: StorageRepositories, roadmap: Roadmap): ProjectedItem[] {
    const workspaceId = roadmap.workspaceId;
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/roadmaps`;
    const name = roadmap.definition.name;
    const items: ProjectedItem[] = [];
    // Entries whose only blockers are setup the operator does outside the work item:
    // reviewer roles and verification environments (what the roadmap page listed as setup).
    const setup = new Map<string, string[]>();
    const add = (entry: RoadmapEntry, messages: readonly string[]) =>
      setup.set(entry.id, [
        ...(setup.get(entry.id) ?? []),
        ...messages.map(
          (message) => `${entry.executionScope?.sourceId ?? entry.sourceId}: ${message}`,
        ),
      ]);
    for (const entry of roadmap.definition.entries) {
      if (entry.executionScope?.kind !== 'slice-verification') continue;
      if (roadmap.attempts.some((a) => a.entryId === entry.id)) continue;
      const blockers = scopePhaseBlockers(
        tx,
        workspaceId,
        entry.workItemId,
        entry.executionScope,
        'verify',
      );
      const only = blockers.filter((b) => SETUP_BLOCKER_CODES.has(phaseBlockerCode(b)));
      if (only.length && only.length === blockers.length)
        add(
          entry,
          only.map((b) => b.message),
        );
    }
    for (const progress of this.view(roadmap, tx).progress) {
      const entry = roadmap.definition.entries.find((e) => e.id === progress.entryId);
      if (!entry || setup.has(entry.id) || !progress.blockers?.length) continue;
      if (progress.blockers.every((b) => SETUP_BLOCKER_CODES.has(phaseBlockerCode(b))))
        add(entry, [...new Set(progress.blockers.map((b) => b.message))]);
    }
    const environmentEntries = [...setup.keys()].sort();
    const environmentLines = [...setup.values()].flat();
    if (environmentLines.length)
      items.push({
        subjectKey: `roadmap:${roadmap.id}:environments`,
        code: 'verification-setup',
        kind: 'attention',
        title: `${name} · Setup needed: reviewers or verification environments`,
        message: environmentLines.sort().join('\n'),
        path,
        refs: { roadmapId: roadmap.id },
        members: environmentEntries,
      });
    if (roadmap.definition.crossProject) {
      // Each checkpoint ready for the operator's acceptance is its own item, named by its kind
      // and counting the map milestones that wait on it (R-A5).
      const selection = roadmap.definition.crossProject;
      const nodes = crossProjectState(tx, workspaceId, selection).nodes;
      const source = tx.imports.definition(workspaceId, selection.definitionId)?.source;
      const dependents = new Map<string, string[]>();
      for (const node of nodes)
        for (const key of node.requirements)
          dependents.set(key, [...(dependents.get(key) ?? []), node.key]);
      const waiting = (key: string) => {
        const seen = new Set<string>();
        const queue = [...(dependents.get(key) ?? [])];
        while (queue.length) {
          const next = queue.pop()!;
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(...(dependents.get(next) ?? []));
        }
        return nodes.filter((n) => seen.has(n.key) && n.included && !n.satisfied).length;
      };
      for (const node of nodes) {
        if (!node.included || node.satisfied || node.kind !== 'checkpoint' || node.blockers.length)
          continue;
        const kind = source?.checkpoints.find((c) => c.id === node.sourceId)?.kind;
        const code =
          kind === 'architecture_decision'
            ? ('architecture-decision' as const)
            : kind === 'plan_approval'
              ? ('plan-acceptance' as const)
              : ('checkpoint-evidence' as const);
        items.push({
          subjectKey: `roadmap:${roadmap.id}:checkpoint:${node.sourceId}`,
          code,
          kind: 'attention',
          title: `${name} · ${node.sourceId} · ${
            code === 'architecture-decision'
              ? 'Decision to accept'
              : code === 'plan-acceptance'
                ? 'Plan to accept'
                : 'Evidence to review'
          }`,
          message: `${node.title}\nReady for independent evidence review and your acceptance.`,
          path,
          refs: { roadmapId: roadmap.id },
          blocks: waiting(node.key),
        });
      }
    }
    for (const [entryId, hold] of Object.entries(roadmap.entryHolds ?? {})) {
      const held = effectiveHoldAttention(hold);
      if (!held) continue;
      const entry = roadmap.definition.entries.find((e) => e.id === entryId);
      if (!entry) continue;
      const attempt = roadmap.attempts.find((a) => a.entryId === entryId);
      const cycle = attempt && tx.execution.cycles.find(workspaceId, attempt.cycleId);
      // A manual recovery has taken over this checkpoint. The saved hold remains
      // historical until reconciliation; it is not a second task.
      if (cycle?.status === 'running') continue;
      if (entry.executionScope && this.scopeComplete(tx, roadmap, entry)) continue;
      // The cycle's own item already carries this stop, with its findings and branch.
      if (
        cycle &&
        tx.attention
          .openInScope(workspaceId, `worktree:${cycle.worktreeId}`)
          .some((item) => item.subjectKey === `cycle:${cycle.id}`)
      )
        continue;
      const reverifiable = !('refused' in this.reverification(roadmap, entry, tx));
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
    return items;
  }

  /** The entry's own milestone is already satisfied, so its old hold needs nobody. */
  private scopeComplete(tx: StorageRepositories, roadmap: Roadmap, entry: RoadmapEntry): boolean {
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

  private reason(roadmap: Roadmap, reason: string): void {
    const bounded = reason.slice(0, 4000);
    if (roadmap.reason !== bounded) this.change(roadmap, { reason: bounded });
  }
  private change(
    roadmap: Roadmap,
    changes: RoadmapChanges,
    action = 'advance',
    context?: AuthContext,
  ): Roadmap {
    const merged: Roadmap = {
      ...roadmap,
      ...changes,
      reason: (changes.reason ?? roadmap.reason).slice(0, 4000),
      version: roadmap.version + 1,
      updatedAt: this.now().toISOString(),
    };
    // Attention describes a needs-attention roadmap only; any other status clears it (R-A3).
    const { attention: _cleared, ...unattended } = merged;
    const updated: Roadmap = merged.status === 'needs-attention' ? merged : unattended;
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
      throw new ConcurrentModificationError('Roadmap changed during this operation.');
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
        ...(action === 'prepare-decision'
          ? {
              preparationId: roadmap.decisionPreparations?.at(-1)?.id,
              checkpointId: roadmap.decisionPreparations?.at(-1)?.checkpointId,
              runId: roadmap.decisionPreparations?.at(-1)?.runId,
            }
          : {}),
        ...(action === 'apply-delegation'
          ? {
              delegationId: roadmap.delegationAssignments?.at(-1)?.id,
              entryCount: roadmap.delegationAssignments?.at(-1)?.entryIds.length,
              rationale: roadmap.delegationAssignments?.at(-1)?.rationale,
            }
          : {}),
        ...(action === 'apply-agent-profiles'
          ? {
              assignmentId: roadmap.agentAssignments?.at(-1)?.id,
              entryCount: roadmap.agentAssignments?.at(-1)?.entryIds.length,
            }
          : {}),
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
