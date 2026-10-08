import {
  type AgentProfile,
  type AgentProfilePurpose,
  type AgentRun,
  type AgentSelection,
  type CycleProfiles,
  cycleProfilePurpose,
  type EffectiveAgent,
  type Finalization,
  matchingAgent,
  type Roadmap,
  type RoadmapEntry,
  type WorkCycle,
  type WorkspaceAgentProfile,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import {
  type AgentContext,
  launchProfile,
  resolveAgent,
  resolveAgents,
  selectionSet,
} from './agent-resolution.js';
import { cycleOwnership } from './cycle-ownership.js';
import { attemptDelegation, effectiveDelegation } from './roadmap-delegation-policy.js';

/**
 * Where each daemon place gathers the layers of its agent selection (R-E5a, E5-2). Every
 * selection is then `resolveAgent`'s answer; nothing here decides precedence.
 */

/** The roadmap's latest ADR-064 assignment covering an entry: it applies whole. */
export function latestAssignment(roadmap: Roadmap, entryId: string) {
  return roadmap.agentAssignments?.findLast((a) => a.entryIds.includes(entryId));
}
/** The latest assignment as a resolution layer. */
function assignmentLayer(
  assignment: ReturnType<typeof latestAssignment>,
): Pick<AgentContext, 'assignment'> {
  return assignment ? { assignment: { id: assignment.id, selections: assignment.selections } } : {};
}
/** An entry's layers: its latest assignment and its saved definition, the lowest (E5-1). */
function entryLayers(
  roadmap: Roadmap,
  entry: RoadmapEntry,
): Pick<AgentContext, 'assignment' | 'profiles'> {
  return {
    ...assignmentLayer(latestAssignment(roadmap, entry.id)),
    profiles: { layer: 'saved-definition', value: entry.profiles },
  };
}
/**
 * The delegated integration resolution's profile as a layer (conflict only), when the entry's
 * effective automation resolves conflicts automatically: what `delegatedResolutionProfile`
 * would launch, so the reported conflict agent is the one that runs (R-E5a review MEDIUM-2).
 */
function delegationLayer(
  delegation: Pick<ReturnType<typeof effectiveDelegation>, 'automation' | 'assignment'>,
): Pick<AgentContext, 'delegation'> {
  const { automation, assignment } = delegation;
  return automation.integrationConflicts === 'automatic' && automation.resolutionProfile
    ? {
        delegation: {
          ...(assignment ? { id: assignment.id } : {}),
          profile: automation.resolutionProfile,
        },
      }
    : {};
}
/** An entry's effective selections, each with its step's permissions. */
export function entryAgents(roadmap: Roadmap, entry: RoadmapEntry) {
  return resolveAgents(
    {
      ...entryLayers(roadmap, entry),
      ...delegationLayer(effectiveDelegation(roadmap, entry, roadmap.definition)),
    },
    entry.profiles,
  );
}
/**
 * What a decision preparation for the entry runs, read-only: the operator's choice, else (under
 * the standing grant, and as the settings offer it) the entry's investigation selection.
 */
export function preparationAgent(
  roadmap: Roadmap,
  entry: RoadmapEntry,
  chosen?: AgentSelection,
): EffectiveAgent {
  return resolveAgent({
    purpose: 'investigation',
    permissionMode: 'edit-only',
    ...(chosen ? { action: { layer: 'decision-preparation', selection: chosen } } : {}),
    ...entryLayers(roadmap, entry),
  });
}
export function entryAgentSelections(roadmap: Roadmap, entry: RoadmapEntry) {
  return {
    selections: selectionSet(entryAgents(roadmap, entry)),
    assignment: latestAssignment(roadmap, entry.id),
  };
}

/**
 * The layers every choice for a cycle shares: its roadmap's latest assignment and its own
 * profiles. A roadmap's cycle starts with its entry's saved profiles, as the definition revision
 * it started under held them (a repair the roadmap delegates takes the same), so they are the
 * `saved-definition` layer; a cycle started on its own, a repair the operator delegates among
 * them, has the profiles it was started with (`cycle-start`).
 */
export function cycleLayers(
  tx: StorageRepositories,
  cycle: WorkCycle,
): Pick<AgentContext, 'assignment' | 'profiles'> {
  const owner = cycleOwnership(tx, cycle);
  return {
    ...assignmentLayer(owner && latestAssignment(owner.roadmap, owner.attempt.entryId)),
    profiles: { layer: owner ? 'saved-definition' : 'cycle-start', value: cycle.profiles },
  };
}
/** The permissions a cycle's launch for `purpose` runs with: its step's, remediation's for conflict. */
function stepPermission(cycle: WorkCycle, purpose: AgentProfilePurpose) {
  return cycle.profiles[purpose === 'conflict' ? 'remediate' : cycle.step].permissionMode;
}

/**
 * What a cycle's launch records beside its agent: its purpose, the delegation grant covering its
 * entry, and the entry's latest assignment, which `launchProvenance` names only when the launch
 * is attributed to it (R-E5a review LOW-2: nothing here names an assignment by itself).
 */
export function cycleLaunchRecord(
  tx: StorageRepositories,
  cycle: WorkCycle,
): {
  readonly purpose: AgentProfilePurpose;
  readonly delegationId?: string;
  readonly latestAssignmentId?: string;
} {
  const owner = cycleOwnership(tx, cycle);
  const grant = owner?.roadmap.delegationAssignments?.findLast((a) =>
    a.entryIds.includes(owner.attempt.entryId),
  );
  const assignment = owner && latestAssignment(owner.roadmap, owner.attempt.entryId);
  return {
    purpose: cycleProfilePurpose(cycle),
    ...(grant ? { delegationId: grant.id } : {}),
    ...(assignment ? { latestAssignmentId: assignment.id } : {}),
  };
}

/**
 * What a cycle's launch records about its selection: the purpose, the delegation grant, and the
 * assignment only when the resolver attributes the launched agent to it (operator decisions
 * 2026-10-07). A resumed session (an output repair, a restart resume) keeps the assignment the
 * run it continues named, while that is still the entry's latest; once a newer assignment
 * replaced it, the resume names none. An equal selection any other layer chose (a recovery, a
 * finalization stage or recovery, an integration resolution) does not name it, so
 * `assignedReviewMatches` holds such a run to the saved definition.
 */
export function launchProvenance(
  record: ReturnType<typeof cycleLaunchRecord>,
  launch: EffectiveAgent,
  continued?: AgentRun['profileSelection'],
): NonNullable<AgentRun['profileSelection']> {
  const assignmentId =
    launch.source.layer === 'resumed-session'
      ? continued?.assignmentId !== undefined &&
        continued.assignmentId === record.latestAssignmentId
        ? continued.assignmentId
        : undefined
      : launch.source.layer === 'roadmap-assignment'
        ? launch.source.assignmentId
        : undefined;
  return {
    purpose: record.purpose,
    ...(record.delegationId ? { delegationId: record.delegationId } : {}),
    ...(assignmentId ? { assignmentId } : {}),
  };
}

/** A finalization step's layer: its stage's profile for the step and the recovery's agent. */
export function finalizationLayer(
  value: Pick<Finalization, 'finalReview' | 'stages'>,
  cycle: Pick<WorkCycle, 'step' | 'finalizationAgentOverride' | 'finalizationProgress'>,
): NonNullable<AgentContext['finalization']> {
  const stageIndex = cycle.finalizationProgress?.stageIndex ?? 0;
  const stage = value.stages?.[stageIndex];
  const slot = cycle.step === 'review' ? 'review' : 'implement';
  return {
    stage: stage ? stage[slot] : value.finalReview,
    slot: stage ? slot : 'review',
    ...(stage ? { stageIndex } : {}),
    ...(cycle.finalizationAgentOverride ? { recovery: cycle.finalizationAgentOverride } : {}),
  };
}
/** The agent a finalization step runs (R-B10, ADR-040). */
export function finalizationAgent(
  value: Pick<Finalization, 'finalReview' | 'stages'>,
  cycle: Pick<WorkCycle, 'step' | 'finalizationAgentOverride' | 'finalizationProgress'>,
): EffectiveAgent {
  const finalization = finalizationLayer(value, cycle);
  return resolveAgent({ purpose: finalization.slot, finalization });
}

/**
 * A finalization's agents (E5-3): the current step's (the legacy final reviewer without a
 * cycle) and each stage's review and implementation profile, a per-action override over the
 * workspace default it replaced.
 */
export function finalizationAgents(
  value: Finalization,
  cycle: WorkCycle | undefined,
  workspace: NonNullable<AgentContext['workspace']>,
) {
  const finalization = cycle
    ? finalizationLayer(value, cycle)
    : { stage: value.finalReview, slot: 'review' as const };
  const stageAgent = (index: number, slot: 'review' | 'implement', stage: AgentProfile) =>
    resolveAgent({ purpose: slot, finalization: { stage, slot, stageIndex: index }, workspace });
  return {
    current: resolveAgent({ purpose: finalization.slot, finalization, workspace }),
    stages: (value.stages ?? []).map((stage, index) => ({
      id: stage.id,
      review: stageAgent(index, 'review', stage.review),
      implement: stageAgent(index, 'implement', stage.implement),
    })),
  };
}

/**
 * A cycle's next launch, every layer considered: a resumed session keeps its run's agent; a
 * design-question recovery, a finalization step and an integration resolution run what they
 * recorded; then the roadmap's assignment, a service retry's profile and the cycle's profiles.
 */
export function cycleLaunchAgent(
  tx: StorageRepositories,
  cycle: WorkCycle,
  recorded: {
    /** The run a resumed session continues. */
    readonly resumed?: AgentRun;
    /** The design-question recovery this launch runs. */
    readonly recovery?: NonNullable<WorkCycle['designRecovery']>;
    readonly finalization?: Finalization;
    /** The integration resolution this cycle owns. */
    readonly resolution?: NonNullable<WorkCycle['integrationResolution']>;
  },
): EffectiveAgent {
  const purpose = cycleProfilePurpose(cycle);
  const { resumed, recovery, finalization, resolution } = recorded;
  return resolveAgent({
    purpose,
    permissionMode: stepPermission(cycle, purpose),
    ...(resumed
      ? {
          resumed: {
            backend: resumed.backend,
            permissionMode: resumed.permissionMode,
            ...(resumed.model === undefined ? {} : { model: resumed.model }),
            ...(resumed.reasoningEffort ? { reasoningEffort: resumed.reasoningEffort } : {}),
          },
        }
      : {}),
    ...(recovery
      ? {
          action: {
            layer: 'design-recovery',
            selection: recovery.profile,
            permissionMode: cycle.profiles.design.permissionMode,
          },
        }
      : {}),
    ...(finalization ? { finalization: finalizationLayer(finalization, cycle) } : {}),
    ...(resolution?.profile ? { integrationResolution: resolution.profile } : {}),
    ...cycleLayers(tx, cycle),
    ...(cycle.providerRecovery ? { serviceRetry: cycle.providerRecovery.profile } : {}),
  });
}

/**
 * A cycle's future agents for every purpose, as `nextAgentSelections` has them: its standing
 * choice (its assignment, else its own profiles), each with its base step's permissions. A step's
 * one-off agent (a pending service retry, a design-question recovery, a delegated resolution's
 * profile, finalization's) is not among them: the launch resolves those (`cycleLaunchAgent`,
 * `delegatedResolutionProfile`) and the finalization view reports its own.
 */
export function cycleAgents(tx: StorageRepositories, cycle: WorkCycle) {
  const owner = cycleOwnership(tx, cycle);
  const entry = owner && roadmapEntryOf(owner.roadmap, owner.attempt.entryId);
  const delegation =
    owner &&
    (attemptDelegation(tx, owner.roadmap, owner.attempt) ??
      (entry && effectiveDelegation(owner.roadmap, entry, owner.roadmap.definition)));
  return resolveAgents(
    { ...cycleLayers(tx, cycle), ...(delegation ? delegationLayer(delegation) : {}) },
    cycle.profiles,
  );
}
function roadmapEntryOf(roadmap: Roadmap, entryId: string) {
  return roadmap.definition.entries.find((e) => e.id === entryId);
}

/**
 * A question stop's investigation (R-C16): the operator's choice, else the cycle's effective
 * investigation selection.
 */
export function investigationAgent(
  tx: StorageRepositories,
  cycle: WorkCycle,
  chosen: AgentSelection | undefined,
): EffectiveAgent {
  return resolveAgent({
    purpose: 'investigation',
    ...(chosen ? { action: { layer: 'investigation', selection: chosen } } : {}),
    ...cycleLayers(tx, cycle),
  });
}

/** Older accepted reviews keep the selection authorized at their launch, even after another model change. */
export function assignedReviewMatches(
  roadmap: Roadmap,
  entry: RoadmapEntry,
  run: AgentRun,
): boolean {
  const purpose: AgentProfilePurpose = run.profileSelection?.purpose ?? 'review';
  if (!['review', 'security', 'checkpoint', 'acceptance', 'investigation'].includes(purpose))
    return false;
  const assignmentId = run.profileSelection?.assignmentId;
  const assignment = assignmentId
    ? roadmap.agentAssignments?.find(
        (a) =>
          a.id === assignmentId && a.entryIds.includes(entry.id) && a.appliedAt <= run.createdAt,
      )
    : undefined;
  if (assignmentId && !assignment) return false;
  const authorized = resolveAgent({
    purpose,
    permissionMode: entry.profiles.review.permissionMode,
    ...assignmentLayer(assignment),
    profiles: { layer: 'saved-definition', value: entry.profiles },
  });
  return matchingAgent(run, launchProfile(authorized));
}

/** A cycle's future profiles: its effective selections with its own steps' permissions. */
export function effectiveCycleProfiles(tx: StorageRepositories, cycle: WorkCycle): CycleProfiles {
  const selections = selectionSet(cycleAgents(tx, cycle));
  return {
    ...selections,
    design: { ...selections.design, permissionMode: cycle.profiles.design.permissionMode },
    implement: { ...selections.implement, permissionMode: cycle.profiles.implement.permissionMode },
    review: { ...selections.review, permissionMode: cycle.profiles.review.permissionMode },
    remediate: { ...selections.remediate, permissionMode: cycle.profiles.remediate.permissionMode },
  };
}

/**
 * The operator's integration resolution: the command's choice, else on resume the profile the
 * resolution recorded, else the delegated rule without a delegation (operator decision
 * 2026-10-07): the latest assignment, then the cycle's conflict specialist, then the remediation
 * conflict inherits, with remediation's permissions.
 */
export function operatorResolutionProfile(
  tx: StorageRepositories,
  cycle: WorkCycle,
  chosen: AgentProfile | undefined,
  recorded?: AgentProfile,
): AgentProfile {
  return launchProfile(
    resolveAgent({
      purpose: 'conflict',
      permissionMode: cycle.profiles.remediate.permissionMode,
      ...(chosen
        ? {
            action: {
              layer: 'integration-resolution',
              selection: chosen,
              permissionMode: chosen.permissionMode,
            },
          }
        : {}),
      ...(recorded ? { integrationResolution: recorded } : {}),
      ...cycleLayers(tx, cycle),
    }),
  );
}

/**
 * A roadmap's delegated integration resolution: the latest assignment, the entry's own conflict
 * specialist, the delegation's resolution profile, then the remediation conflict inherits.
 */
export function delegatedResolutionProfile(
  tx: StorageRepositories,
  cycle: WorkCycle,
  delegation: { readonly id?: string; readonly profile?: AgentProfile },
): AgentProfile {
  const { profile, id } = delegation;
  return launchProfile(
    resolveAgent({
      purpose: 'conflict',
      permissionMode: cycle.profiles.remediate.permissionMode,
      ...cycleLayers(tx, cycle),
      ...(profile ? { delegation: { ...(id === undefined ? {} : { id }), profile } } : {}),
    }),
  );
}

/** The workspace's defaults as a layer: its saved profiles and the daemon's default backend. */
export function workspaceLayer(
  saved: readonly WorkspaceAgentProfile[],
  fallback: AgentSelection['backend'],
): NonNullable<AgentContext['workspace']> {
  return { profiles: saved, fallback: { backend: fallback, permissionMode: 'auto' } };
}
