/**
 * The scheduler's answer to a cycle it owns (R-B7, CTRL-13): what the owning roadmap decides for
 * the cycle, read from the roadmap record by the roadmap's side only. The cycle side asks this,
 * never the record (`check:scope` rule 14). Built per call over the storage or read snapshot the
 * reader passes, memoized only inside a snapshot (as `cycleOwnership` is); every fact that reads
 * more than the record is a lazy function, and no fact throws, so a reader reads, and refuses, only
 * what it asked for.
 */
import type {
  Roadmap,
  RoadmapAttempt,
  RoadmapEntry,
  RoadmapEntryId,
  RoadmapId,
  WorkCycle,
  WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { activeEditor } from '../authority-policy.js';
import { cycleOwnership } from '../cycle-ownership.js';
import { snapshotCalculation } from '../map-read-snapshot.js';
import {
  attemptDefinition,
  attemptDelegation,
  effectiveDelegation,
} from '../roadmap-delegation-policy.js';
import { roadmapCarriesRound } from '../scope-recovery-policy.js';

type EntryHold = NonNullable<Roadmap['entryHolds']>[string];

/** Remembers a fact's first answer. */
function once<T>(read: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = read();
      done = true;
    }
    return value;
  };
}

export interface OwnerPolicy {
  readonly roadmapId: RoadmapId;
  readonly workspaceId: WorkspaceId;
  readonly attemptId: RoadmapAttempt['id'];
  readonly entryId: RoadmapEntryId;
  readonly definitionRevision: number;
  readonly attemptStatus: RoadmapAttempt['status'];
  /** The roadmap's status, and whether it is running. */
  readonly status: Roadmap['status'];
  readonly running: boolean;
  readonly crossProject: boolean;
  /** The hold on the attempt's entry, if any. */
  readonly entryHold: EntryHold | undefined;
  /** A recovery round's attempt, and the hold on its source entry, if any. */
  readonly isRound: boolean;
  readonly roundSourceHold: EntryHold | undefined;
  /** Whether the roadmap carries this round (scope recovery on, or the operator asked for it). */
  readonly roundCarried: boolean;
  /** The pass's priority: a parallel roadmap, and the entry's place in its current order. */
  readonly parallel: boolean;
  readonly entryIndex: number;
  /** The current definition's entry's integration branch and repository, if it is still there. */
  readonly binding: Pick<RoadmapEntry, 'integrationBranch' | 'repositoryId'> | undefined;
  /** The attempt's delegation: its frozen revision's entry and settings, with ADR-065 grants. */
  readonly delegation: () => ReturnType<typeof attemptDelegation>;
  /** A cross-project roadmap's reviewers for the attempt's saved entry, and whether they may run. */
  readonly reviewers: () =>
    | {
        readonly entry: NonNullable<ReturnType<typeof attemptDefinition>>['entries'][number];
        readonly roles: readonly string[];
        readonly runnable: boolean;
      }
    | undefined;
  /** The delegating user, while active and an owner or editor. */
  readonly delegator: () => ReturnType<typeof activeEditor>;
}

/** The policy of `roadmap` for its `attempt`; `ownerPolicy` finds them for a cycle. */
export function ownerPolicyOf(
  tx: StorageRepositories,
  roadmap: Roadmap,
  attempt: RoadmapAttempt,
): OwnerPolicy {
  const entry = roadmap.definition.entries.find((e) => e.id === attempt.entryId);
  return {
    roadmapId: roadmap.id,
    workspaceId: roadmap.workspaceId,
    attemptId: attempt.id,
    entryId: attempt.entryId,
    definitionRevision: attempt.definitionRevision,
    attemptStatus: attempt.status,
    status: roadmap.status,
    running: roadmap.status === 'running',
    crossProject: !!roadmap.definition.crossProject,
    entryHold: roadmap.entryHolds?.[attempt.entryId],
    isRound: !!attempt.recovery,
    roundSourceHold: attempt.recovery
      ? roadmap.entryHolds?.[attempt.recovery.sourceEntryId]
      : undefined,
    roundCarried: roadmapCarriesRound(roadmap, attempt),
    parallel: roadmap.definition.scheduling?.mode === 'parallel',
    entryIndex: roadmap.definition.entries.findIndex((e) => e.id === attempt.entryId),
    binding: entry && {
      integrationBranch: entry.integrationBranch,
      repositoryId: entry.repositoryId,
    },
    delegation: once(() => attemptDelegation(tx, roadmap, attempt)),
    reviewers: once(() => {
      if (!roadmap.definition.crossProject) return undefined;
      const saved = attemptDefinition(tx, roadmap, attempt);
      const savedEntry = saved?.entries.find((e) => e.id === attempt.entryId);
      return saved && savedEntry
        ? {
            entry: savedEntry,
            roles: effectiveDelegation(roadmap, savedEntry, saved).reviewerRoles,
            runnable: roadmap.status === 'running' && !roadmap.entryHolds?.[savedEntry.id],
          }
        : undefined;
    }),
    delegator: once(() => activeEditor(tx, roadmap.delegatedByUserId, roadmap.workspaceId)),
  };
}

/** The owning roadmap's policy for this cycle, or nothing for a cycle no roadmap owns. */
export function ownerPolicy(
  tx: StorageRepositories,
  cycle: Pick<WorkCycle, 'id' | 'workspaceId' | 'owner'>,
): OwnerPolicy | undefined {
  return snapshotCalculation(tx, `owner-policy:${cycle.id}`, () => {
    const owner = cycleOwnership(tx, cycle);
    return owner && ownerPolicyOf(tx, owner.roadmap, owner.attempt);
  });
}
