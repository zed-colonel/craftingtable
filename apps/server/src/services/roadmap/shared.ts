/**
 * What the roadmap scheduler's modules share (R-B7): its errors and their typed causes, the
 * roadmap's write shape, the observer the replays use, and the small helpers several modules ask.
 */
import type { ItemRefusal } from '../transition-gate.js';
import type { SaveRoadmapRequest, RoadmapEntryFields } from '@craftingtable/contracts';
import {
  type AttentionRefs,
  type JsonValue,
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapEntry,
  type RoadmapId,
  roadmapAttention,
  type RoadmapAttention,
  type RoadmapEntryId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import type { DecisionBrief } from '../architecture-decision-inbox.js';
import { IntegrationHeldError, RepositoryMutationBusyError } from '../branch-service.js';
import type { ReleaseCheck } from '../entry-holds.js';
import type { EntryBlocker, EntryStep } from '../entry-waits.js';
import {
  ConcurrentModificationError,
  ExecutionRequestError,
  TypedRefusalError,
} from '../errors.js';
import { PhaseGateError } from '../phase-resources.js';
import { WorktreeMutationBusyError } from '../worktree-mutation-guard.js';

/** A definition's save with each entry's profiles, as the daemon writes it (R-E5b). */
export type RoadmapDefinitionInput = Omit<SaveRoadmapRequest, 'entries'> & {
  readonly entries: readonly RoadmapEntryFields[];
};

export class SupersededRoadmapOperation extends Error {}

/**
 * A delegated merge refused because its destination moved (`target-moved`), left for a later
 * pass (R-G10, operator decision 2026-10-07): that pass refreshes the worktree if integration
 * advanced, then merges again. Three retries a second apart (each refresh counts toward the
 * cycle's own refresh limit, which bounds a target that keeps moving: R-B5 decision 17, asked
 * again), then the refusal holds as any other.
 */
export class MergeTargetMovedRetry extends Error {}

export const TARGET_MOVED_RETRY_MS = [1000, 1000, 1000] as const;

/** A definition's shared-decision inbox as the R-C3b hold reads it, and when it was built. */
export interface HoldInbox {
  readonly generation: number;
  /** The checkpoints read: the merge decisions of the roadmaps' slices not yet started (R-D7). */
  readonly checkpoints: ReadonlySet<string>;
  readonly briefs: ReadonlyMap<string, DecisionBrief>;
  /** Each decision record's source run, to tie a rejection to the brief it answered. */
  readonly sources: ReadonlyMap<string, string | undefined>;
}

/** Errors a pass leaves for the next one: a lost race, busy Git, or a gate that clears itself. */
export function retried(error: unknown): boolean {
  return (
    error instanceof ConcurrentModificationError ||
    (error instanceof PhaseGateError && error.waiting) ||
    error instanceof RepositoryMutationBusyError ||
    error instanceof WorktreeMutationBusyError ||
    error instanceof IntegrationHeldError ||
    error instanceof MergeTargetMovedRetry
  );
}

export const ended = (roadmap: Roadmap) => ['stopped', 'completed'].includes(roadmap.status);

/**
 * Each work item's open recovery round: the first attempt, in the roadmap's order, with an
 * unfinished recovery on an entry of that work item. Kept per attempts and entries lists (both
 * immutable), since a page read asks for every entry (R-D8).
 */
const recoveryIndexes = new WeakMap<
  readonly RoadmapAttempt[],
  { entries: readonly RoadmapEntry[]; byWorkItem: Map<string, RoadmapAttempt> }
>();

export function openRecoveries(roadmap: Roadmap): ReadonlyMap<string, RoadmapAttempt> {
  const entries = roadmap.definition.entries;
  const cached = recoveryIndexes.get(roadmap.attempts);
  if (cached?.entries === entries) return cached.byWorkItem;
  const workItems = new Map<string, Set<string>>();
  for (const e of entries)
    workItems.set(e.id, (workItems.get(e.id) ?? new Set()).add(e.workItemId));
  const byWorkItem = new Map<string, RoadmapAttempt>();
  for (const a of roadmap.attempts) {
    if (!a.recovery || a.recovery.phase === 'completed') continue;
    for (const workItemId of workItems.get(a.entryId) ?? [])
      if (!byWorkItem.has(workItemId)) byWorkItem.set(workItemId, a);
  }
  recoveryIndexes.set(roadmap.attempts, { entries, byWorkItem });
  return byWorkItem;
}

/** How long a standing preparation that could not be reserved waits before a retry (R-C3b). */
export const PREPARATION_RETRY_MS = 10 * 60_000;

/**
 * The typed cause a hold or stop keeps from the refusal behind it (R-B4, decision 3): a typed
 * refusal's code, a blocker's item-gate code, or a phase gate that does not wait, with its
 * blockers (R-C10's follow-up, decision 2).
 */
export function holdCause(error: unknown): AttentionRefs | undefined {
  if (error instanceof TypedRefusalError) return { cause: error.stop };
  if (error instanceof EntryHoldError && error.stopCause) return { cause: error.stopCause };
  if (error instanceof PhaseGateError && !error.waiting)
    return {
      cause: 'phase-gate',
      blockers: [...new Set(error.blockers.map((b) => b.code))],
    };
  return undefined;
}

/**
 * The entry whose evaluation raised a refusal (R-C10's follow-up, decision 2). A recovery round's
 * hold sits on the round's source entry, but the gate that refused is the round owner's or the
 * target review's: the innermost evaluation names it, so a release can ask that gate again.
 */
const gatedEntries = new WeakMap<object, RoadmapEntryId>();

export function gated<E>(error: E, entryId: RoadmapEntryId): E {
  if (typeof error === 'object' && error !== null && !gatedEntries.has(error))
    gatedEntries.set(error, entryId);
  return error;
}

export const gatedEntry = (error: unknown): RoadmapEntryId | undefined =>
  typeof error === 'object' && error !== null ? gatedEntries.get(error) : undefined;

/**
 * A parallel entry's hold's refs: its typed cause, and the entry whose gate refused when that is
 * another entry (a round's owner or target). A hold of its own entry's gate names no entry, since
 * its key does; holds stored before R-C10's follow-up name their own entry, which says nothing of
 * which gate refused.
 */
export function holdRefs(entryId: RoadmapEntryId, error: unknown): AttentionRefs | undefined {
  const by = gatedEntry(error);
  const refs = { ...(by && by !== entryId ? { entryId: by } : {}), ...holdCause(error) };
  return Object.keys(refs).length ? refs : undefined;
}

/**
 * A sequential roadmap's stop for a refusal met while evaluating its entry (decision 3): the
 * hold's own code where it has one, and the entry whose gate refused, so it holds no entry. A
 * refusal met outside an entry's evaluation (the delegating user, the map binding) names none.
 */
export function stopAttention(error: unknown) {
  const by = gatedEntry(error);
  const refs = { ...(by ? { entryId: by } : {}), ...holdCause(error) };
  return roadmapAttention(
    error instanceof EntryHoldError ? error.attentionCode : 'scheduler-error',
    Object.keys(refs).length ? refs : undefined,
  );
}

/** What a release records in its audit row: the entry, the stop's code and cause, the fact. */
export function releaseRecord(
  entryId: RoadmapEntryId,
  attention: RoadmapAttention,
  check: ReleaseCheck,
): Readonly<Record<string, JsonValue>> {
  return {
    entryId,
    code: attention.code,
    ...(attention.refs?.cause ? { cause: attention.refs.cause } : {}),
    ...(check.entryId !== entryId ? { gatedEntryId: check.entryId } : {}),
    fact: check.fact,
  };
}

/** A blocker that holds the entry, `entry-blocked`, with its typed cause when it has one. */
export function refuseBlocked(blocker: EntryBlocker, entryId?: RoadmapEntryId): never {
  const error = new EntryHoldError('entry-blocked', blocker.reason, blocker.cause);
  throw entryId ? gated(error, entryId) : error;
}

export class EntryHoldError extends ExecutionRequestError {
  constructor(
    readonly attentionCode: 'evidence-not-current' | 'entry-blocked' | 'recovery-not-converging',
    message: string,
    /** A blocker's item-gate code, kept as the hold's cause. */
    readonly stopCause?: ItemRefusal,
  ) {
    super('conflict', message);
  }
}

/**
 * Why Re-verify is refused for an entry, typed (R-C10's follow-up), with the message commands
 * answer with. The automatic re-verification of decision 4 reads the code.
 */
export interface ReverificationRefusal {
  readonly code:
    | 'roadmap-inactive'
    | 'not-a-review'
    | 'recovery-owns-entry'
    | 'entry-paused'
    | 'not-started'
    | 'review-queued'
    | 'preparing'
    | 'review-open'
    | 'evidence-current'
    | 'other-worktree';
  readonly message: string;
}

/** The reason a resumed roadmap shows: the operator's Resume, or the scheduler's own. */
export const RESUMED_REASON =
  'Scheduling enabled. Integration follows each item’s delegated merge policy.';

/** A decision a preparation may prepare: the exact map binding and its bound owner (R-C3b). */
export interface PreparationTarget {
  readonly d: import('@craftingtable/domain').ConcurrencyDefinition;
  readonly binding: NonNullable<ReturnType<StorageRepositories['imports']['bindings']>[number]>;
  readonly checkpoint: import('@craftingtable/domain').ConcurrencyDefinition['source']['checkpoints'][number];
  readonly entry: RoadmapEntry;
  readonly owner: {
    readonly repositoryId: import('@craftingtable/domain').SourceRepositoryId;
    readonly projectId: import('@craftingtable/domain').ProjectId;
    readonly planVersionId: import('@craftingtable/domain').PlanVersionId;
    readonly integrationBranch: string;
  };
}

/**
 * The holds left once the operator answered a stopped review with a repair round: its
 * needs-attention hold is answered, an explicit item pause stays.
 */
export function answeredHolds(roadmap: Roadmap, entryId: RoadmapEntryId): Roadmap['entryHolds'] {
  const { [entryId]: hold, ...others } = roadmap.entryHolds ?? {};
  return hold?.status === 'needs-attention' ? others : roadmap.entryHolds;
}

export function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}

/**
 * A sequential roadmap's reason follows its single current entry. A parallel roadmap keeps
 * its scheduling reason: per-entry progress carries each entry's state, and rewriting the
 * shared reason per entry only to restore it after the pass wastes a write and an event.
 */
export function entryReason(parallel: boolean, reason: string): { reason?: string } {
  return parallel ? {} : { reason };
}

/**
 * How one parallel scheduler pass left one entry. The pass skips an entry that is complete,
 * held, or deferred by a blocker; it evaluates the rest, and an evaluation either returns,
 * throws an error the pass retries next time, or holds the entry.
 */
export type EntryPassOutcome =
  | { readonly kind: 'complete' }
  | { readonly kind: 'deferred'; readonly blocker: EntryBlocker }
  | { readonly kind: 'held' }
  | { readonly kind: 'evaluated'; readonly step: EntryStep }
  | { readonly kind: 'retry'; readonly error: unknown }
  | { readonly kind: 'hold-recorded'; readonly error: unknown }
  // A sequential roadmap's entry whose error stops the roadmap.
  | { readonly kind: 'failed'; readonly error: unknown };

/** Sees how each pass leaves each entry and each roadmap (the R-I10 replay). */
export interface SchedulerObserver {
  /** An entry the pass reached, with the roadmap as the pass found it. */
  entry(roadmap: Roadmap, entry: RoadmapEntry, outcome: EntryPassOutcome): void;
  /** The pass over this roadmap ended, with the error it retries or stops on, if any. */
  passEnded(roadmapId: RoadmapId, error?: unknown): void;
}

/** One delegated roadmap per workspace. The cycle controller owns every agent step. */
/** A roadmap write: entering `needs-attention` must declare its typed stop (R-A3). */
export type RoadmapChanges = Omit<Partial<Roadmap>, 'status' | 'attention'> &
  (
    | { readonly status: 'needs-attention'; readonly attention: RoadmapAttention }
    | {
        readonly status?: Exclude<Roadmap['status'], 'needs-attention'>;
        readonly attention?: undefined;
      }
  );

/** A look due this soon (a retry) keeps the scheduler from counting as idle (R-B5). */
export const RETRY_SOON_MS = 5_000;
