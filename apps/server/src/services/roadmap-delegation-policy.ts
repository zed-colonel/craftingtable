import {
  DEFAULT_ROADMAP_AUTOMATION,
  type AgentRun,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapDefinition,
} from '@craftingtable/domain';

/** Resolve authority for the next action. Existing runs retain their own grant identity. */
export function effectiveDelegation(
  roadmap: Roadmap,
  entry: RoadmapEntry,
  definition: RoadmapDefinition,
) {
  const assignment = roadmap.delegationAssignments?.findLast((a) => a.entryIds.includes(entry.id));
  return {
    automation:
      assignment?.automation ??
      entry.automation ??
      definition.automation ??
      DEFAULT_ROADMAP_AUTOMATION,
    reviewerRoles: assignment?.reviewerRoles ?? entry.reviewerRoles ?? [],
    assignment,
  };
}

/** A new grant cannot authorize an older run, even when timestamps coincide. */
export function historicalReviewerRoles(
  roadmap: Roadmap,
  entry: RoadmapEntry,
  run: AgentRun,
): readonly string[] {
  const id = run.profileSelection?.delegationId;
  if (!id) return entry.reviewerRoles ?? [];
  const grant = roadmap.delegationAssignments?.find(
    (a) => a.id === id && a.entryIds.includes(entry.id) && a.appliedAt <= run.createdAt,
  );
  return grant?.reviewerRoles ?? [];
}
