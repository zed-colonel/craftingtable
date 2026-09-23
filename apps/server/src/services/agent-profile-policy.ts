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
  for (const roadmap of tx.roadmaps.list(cycle.workspaceId)) {
    const attempt = roadmap.attempts.find((a) => a.cycleId === cycle.id);
    if (!attempt) continue;
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
  let selections = agentSelections(cycle.profiles);
  for (const roadmap of tx.roadmaps.list(cycle.workspaceId)) {
    const attempt = roadmap.attempts.find((a) => a.cycleId === cycle.id);
    const assignment =
      attempt && roadmap.agentAssignments?.findLast((a) => a.entryIds.includes(attempt.entryId));
    if (assignment) {
      selections = assignment.selections;
      break;
    }
  }
  return {
    ...selections,
    design: { ...selections.design, permissionMode: cycle.profiles.design.permissionMode },
    implement: { ...selections.implement, permissionMode: cycle.profiles.implement.permissionMode },
    review: { ...selections.review, permissionMode: cycle.profiles.review.permissionMode },
    remediate: { ...selections.remediate, permissionMode: cycle.profiles.remediate.permissionMode },
  };
}
