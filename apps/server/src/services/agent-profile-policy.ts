import {
  type AgentProfilePurpose,
  type AgentRun,
  agentSelections,
  cycleProfilePurpose,
  matchingAgent,
  profileForPurpose,
  type Roadmap,
  type RoadmapEntry,
  selectionsForPurpose,
  type WorkCycle,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { cycleOwnership } from './cycle-ownership.js';
export function entryAgentSelections(roadmap: Roadmap, entry: RoadmapEntry) {
  const assignment = roadmap.agentAssignments?.findLast((a) => a.entryIds.includes(entry.id));
  return { selections: assignment?.selections ?? agentSelections(entry.profiles), assignment };
}
/** Resolve only future launches. A running session's selection is already persisted on its run. */
export function cycleAgentSelection(
  tx: StorageRepositories,
  cycle: WorkCycle,
  purpose = cycleProfilePurpose(cycle),
): {
  profile: ReturnType<typeof profileForPurpose>;
  provenance: NonNullable<AgentRun['profileSelection']>;
} {
  const fallback = {
    ...profileForPurpose(cycle.profiles, purpose),
    permissionMode:
      cycle.profiles[purpose === 'conflict' ? 'remediate' : cycle.step].permissionMode,
  };
  const owner = cycleOwnership(tx, cycle);
  if (owner) {
    const { roadmap, attempt } = owner;
    const assignment = roadmap.agentAssignments?.findLast((a) =>
      a.entryIds.includes(attempt.entryId),
    );
    const grant = roadmap.delegationAssignments?.findLast((a) =>
      a.entryIds.includes(attempt.entryId),
    );
    const authority = grant ? { delegationId: grant.id } : {};
    if (assignment)
      return {
        profile: {
          ...selectionsForPurpose(assignment.selections, purpose),
          permissionMode: fallback.permissionMode,
        },
        provenance: { purpose, assignmentId: assignment.id, ...authority },
      };
    return { profile: fallback, provenance: { purpose, ...authority } };
  }
  return { profile: fallback, provenance: { purpose } };
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
  const profile = assignment
    ? selectionsForPurpose(assignment.selections, purpose)
    : profileForPurpose(entry.profiles, purpose);
  return matchingAgent(run, { ...profile, permissionMode: entry.profiles.review.permissionMode });
}

export function effectiveCycleProfiles(tx: StorageRepositories, cycle: WorkCycle) {
  const owner = cycleOwnership(tx, cycle);
  const assignment = owner?.roadmap.agentAssignments?.findLast((a) =>
    a.entryIds.includes(owner.attempt.entryId),
  );
  const selections = assignment?.selections ?? agentSelections(cycle.profiles);
  return {
    ...selections,
    design: { ...selections.design, permissionMode: cycle.profiles.design.permissionMode },
    implement: { ...selections.implement, permissionMode: cycle.profiles.implement.permissionMode },
    review: { ...selections.review, permissionMode: cycle.profiles.review.permissionMode },
    remediate: { ...selections.remediate, permissionMode: cycle.profiles.remediate.permissionMode },
  };
}
