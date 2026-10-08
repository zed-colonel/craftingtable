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
  ownsIntegrationResolution,
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
/** An entry's effective selections: its latest assignment, else its saved definition (E5-1). */
export function entryAgents(roadmap: Roadmap, entry: RoadmapEntry) {
  return resolveAgents({
    ...assignmentLayer(latestAssignment(roadmap, entry.id)),
    profiles: { layer: 'saved-definition', value: entry.profiles },
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
 * profiles, which for a roadmap's cycle are its saved entry's.
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

/** Resolve only future launches. A running session's selection is already persisted on its run. */
export function cycleAgentSelection(
  tx: StorageRepositories,
  cycle: WorkCycle,
  purpose = cycleProfilePurpose(cycle),
): {
  profile: AgentProfile;
  provenance: NonNullable<AgentRun['profileSelection']>;
} {
  const resolved = resolveAgent({
    purpose,
    permissionMode: stepPermission(cycle, purpose),
    ...cycleLayers(tx, cycle),
  });
  const owner = cycleOwnership(tx, cycle);
  const grant = owner?.roadmap.delegationAssignments?.findLast((a) =>
    a.entryIds.includes(owner.attempt.entryId),
  );
  return {
    profile: launchProfile(resolved),
    provenance: {
      purpose,
      ...(resolved.source.assignmentId ? { assignmentId: resolved.source.assignmentId } : {}),
      ...(grant ? { delegationId: grant.id } : {}),
    },
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
 * A cycle's next launch, every layer considered: a resumed session keeps its run's agent; a
 * design-question recovery, a finalization step and an integration resolution run what they
 * recorded; then the roadmap's assignment, a service retry's profile and the cycle's profiles.
 */
export function cycleLaunchAgent(
  tx: StorageRepositories,
  cycle: WorkCycle,
  recorded: { readonly resumed?: AgentRun; readonly finalization?: Finalization },
): EffectiveAgent {
  const purpose = cycleProfilePurpose(cycle);
  const { resumed, finalization } = recorded;
  const recovery =
    cycle.step === 'design' && cycle.designRecovery?.runId === cycle.currentRunId
      ? cycle.designRecovery
      : undefined;
  const resolution = ownsIntegrationResolution(cycle) ? cycle.integrationResolution : undefined;
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

/** A cycle's future agents for every purpose: its assignment, else its own profiles. */
export function cycleAgents(tx: StorageRepositories, cycle: WorkCycle) {
  return resolveAgents(cycleLayers(tx, cycle));
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
 * resolution recorded, else the cycle's remediation profile. Today's rule, kept as characterized:
 * the assignment and a conflict specialist are not consulted here (the browser sends the
 * cycle's conflict selection as the choice).
 */
export function operatorResolutionProfile(
  tx: StorageRepositories,
  cycle: WorkCycle,
  chosen: AgentProfile | undefined,
  recorded?: AgentProfile,
): AgentProfile {
  return launchProfile(
    resolveAgent({
      purpose: 'remediate',
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
      profiles: cycleLayers(tx, cycle).profiles,
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

/** Workspace defaults for every purpose (`run-profiles`): saved, inherited, or the daemon's. */
export function workspaceAgents(
  saved: readonly WorkspaceAgentProfile[],
  fallback: AgentSelection['backend'],
) {
  return resolveAgents({
    workspace: { profiles: saved, fallback: { backend: fallback, permissionMode: 'auto' } },
  });
}
