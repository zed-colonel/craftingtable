/**
 * A roadmap's settings commands (R-B7; R-B6): its agents (ADR-064), delegation (ADR-065),
 * capacity, the three standing grants, and its saved definition, the form's or a map's, each
 * behind the one editable precondition with its own refusal (operator decision 2 A).
 */
import type { RoadmapViews } from '../views.js';
import type { RoadmapWriter } from '../writer.js';
import type { RoadmapState } from '../state.js';
import { type RoadmapDefinitionInput, conflict } from '../shared.js';
import { retiredOrRetiring } from '../../retired-versions.js';
import { delegationWaits } from '../../roadmap-delegation-policy.js';
import { randomUUID } from 'node:crypto';
import type {
  ApplyRoadmapAgents,
  ApplyRoadmapDelegation,
  RoadmapAgentSettings,
  RoadmapCapacities,
  SaveRoadmapCapacity,
  SaveRoadmapRequest,
  DecisionPreparationGrantRequest,
  ReverificationGrantRequest,
  ScopeRecoveryPolicyRequest,
} from '@craftingtable/contracts';
import { roadmapEntryFieldsSchema } from '@craftingtable/contracts';
import {
  type AgentSelection,
  asAgentAssignmentId,
  asDelegationAssignmentId,
  DEFAULT_ROADMAP_SCHEDULING,
  required,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapEntryId,
  type RoadmapId,
  type RoadmapView,
  startedAttempts,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { entryAgentSelections, withPermissions } from '../../agent-profile-policy.js';
import type { AuthContext } from '../../auth-service.js';
import { NotFoundError, windDownRefused } from '../../errors.js';
import { resolveScope } from '../../execution-scope.js';
import { carryPlanAcceptance } from '../../generated-plan-evidence.js';
import type { WorkCycleService } from '../../work-cycle-service.js';
import type { WorkspaceEventNotifier } from '../../workspace-event-notifier.js';
import type { WorkspaceService } from '../../workspace-service.js';

export class RoadmapSettings {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly cycles: WorkCycleService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
    private readonly views: RoadmapViews,
  ) {}

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
    return this.views.agentSettings(context, workspaceId, id);
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
        ...required(
          this.views.agentSettings(context, workspaceId, id).entries[0],
          "the cross-project roadmap's settings",
        ).selections,
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
    return this.views.view(
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
      return this.views.capacities(context, workspaceId);
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
    return this.views.capacities(context, workspaceId);
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
    return this.views.view(
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
    return this.views.view(
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
    return this.views.view(
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
    return this.views.view(roadmap);
  }

  /**
   * A settings command writes at any status but ended, and not while the roadmap's wind-down
   * settles (R-B6, decisions 1 and 3 to 5): what it changes is read at the next launch, admission
   * or use, and nothing launched is reconfigured.
   */
  private assertSettingsOpen(workspaceId: WorkspaceId, roadmap: Roadmap): void {
    const held = this.views.settingsHeld(workspaceId, roadmap);
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
      this.views.settingsHeld(workspaceId, roadmap).running
    )
      conflict(changed);
  }

  /** Its second step: no pending planning amendment, refused with the site's own text. */
  private requireNoPendingAmendment(workspaceId: WorkspaceId, roadmap: Roadmap, message: string) {
    if (this.views.settingsHeld(workspaceId, roadmap).amendment) conflict(message);
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
}
