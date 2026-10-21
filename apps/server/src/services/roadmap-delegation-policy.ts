import {
  DEFAULT_ROADMAP_AUTOMATION,
  ownsIntegrationResolution,
  type AgentRun,
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapEntry,
  type RoadmapDefinition,
  type WorkCycle,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';

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

/** The immutable definition revision an attempt was started under. */
export function attemptDefinition(
  tx: StorageRepositories,
  roadmap: Roadmap,
  attempt: Pick<RoadmapAttempt, 'definitionRevision'>,
): RoadmapDefinition | undefined {
  return roadmap.definition.revision === attempt.definitionRevision
    ? roadmap.definition
    : tx.roadmaps.definition(roadmap.workspaceId, roadmap.id, attempt.definitionRevision);
}

/**
 * Authority for an attempt's next automated action: its frozen revision's entry and
 * settings, with ADR-065 grants applied. The scheduler, integration refresh and conflict
 * automation all read automation through here so they never disagree.
 */
export function attemptDelegation(
  tx: StorageRepositories,
  roadmap: Roadmap,
  attempt: Pick<RoadmapAttempt, 'definitionRevision' | 'entryId'>,
  entryId = attempt.entryId,
) {
  const definition = attemptDefinition(tx, roadmap, attempt) ?? roadmap.definition;
  const entry =
    definition.entries.find((e) => e.id === entryId) ??
    roadmap.definition.entries.find((e) => e.id === entryId);
  return entry && { definition, entry, ...effectiveDelegation(roadmap, entry, definition) };
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

/**
 * What a delegation grant for these entries waits for (R-B6, decision 2): each named entry's
 * delegated action in flight, which reads the grant across an await and would finish under one
 * it did not start with. A controller review reads its reviewer roles at its start and again at
 * its acceptance, after its run ended; an integration refresh its authority; a conflict
 * resolution at work its profile and automation. A design, implementation or remediation step
 * reads no grant, nor does a stop, and a conflict only detected waits for the grant. The
 * scheduler's own merge and resolution start re-check the grant instead.
 */
export function delegationWaits(
  entries: readonly { readonly sourceId: string; readonly cycles: readonly WorkCycle[] }[],
  refreshing: (cycleId: string) => boolean,
): string[] {
  return entries.flatMap(({ sourceId, cycles }) =>
    cycles.flatMap((cycle) => {
      const review = cycle.workflow?.activeReview;
      return [
        ...(review ? [`${sourceId}'s ${review.kind} review`] : []),
        ...(refreshing(cycle.id) ? [`${sourceId}'s integration refresh`] : []),
        ...(ownsIntegrationResolution(cycle) ? [`${sourceId}'s conflict resolution`] : []),
      ];
    }),
  );
}
