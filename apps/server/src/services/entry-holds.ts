import {
  type CycleAttentionCode,
  type CycleStatus,
  type ExecutionScope,
  PHASE_BLOCKERS,
  type PhaseBlocker,
  phaseBlockerCode,
  type PlanVersionId,
  type Roadmap,
  type RoadmapAttention,
  type RoadmapAttentionCode,
  type RoadmapDefinition,
  type RoadmapEntryHold,
  type WorkCycleId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import type { RefusalStop } from './errors.js';
import { retiredOrRetiring } from './retired-versions.js';

/**
 * Roadmap holds and stops, and which of them the scheduler may clear by itself (R-C10's
 * follow-up). Beside `entry-waits.ts`: a wait is recomputed on every pass, a hold or a roadmap's
 * stop is stored and stays until something clears it.
 *
 * The rule: the scheduler clears only a stop whose cause is a typed fact it can read again
 * without acting (a cycle's status, a gate it already asks on every pass, a Git ancestry fact, a
 * receipt's currency), whose fix is not a person's, and only to go on with work the operator
 * already delegated to the roadmap. Everything else stays the operator's.
 */

/** A typed fact the scheduler reads again on a pass; once it clears, so does the hold or stop. */
export type ReleaseFact =
  /** The scheduler's blocker of the gated entry (as a round, for a round's owner) needs no one. */
  | 'blocker'
  /** The gated entry's scope phase gate names no blocker that stops. */
  | 'phase-gate'
  /** Every completed required predecessor's merge is in the integration head. */
  | 'predecessor-merge'
  /** The stop's cycle runs or is at its merge boundary again, or its entry completed. */
  | 'cycle'
  /** The scheduler re-verifies the entry itself, under the roadmap's grant (decision 4). */
  | 'reverify';

/** How one kind of stored stop or hold is cleared: by a typed fact, or by the operator. */
export type HoldRelease =
  | { readonly fact: ReleaseFact }
  /** `because` documents the classification; nothing reads it. */
  | { readonly operator: true; readonly because: string };

const fact = (name: ReleaseFact): HoldRelease => ({ fact: name });
const operator = (because: string): HoldRelease => ({ operator: true, because });

/**
 * Every roadmap stop code and every hold origin, classified (the follow-up's decisions 2 to 7).
 * `scheduler-error` and `entry-preparation-failed` say only that a refusal was met; what clears
 * them is their typed cause, in `causes`.
 */
export const HOLD_RELEASE = {
  /** The roadmap's pause, an item pause, and the pauses a refresh or an amendment leave. */
  pause: operator('A pause carries no code: the operator resumes what they paused.'),
  /** An open repair the scheduler could not adopt into the roadmap. */
  adoption: operator('A failed adoption is an event; the repair runs as the operator’s cycle.'),
  /**
   * A hold of a gate stored before R-C10's follow-up: it names its own entry, which says nothing
   * of which gate refused (LIVE-06's hold sits on a round's source, for its owner's capacity).
   */
  unattributed: operator('It names no gate it could be asked of again, but by its text (rule 4).'),
  codes: {
    'restart-resume': operator('After a crash someone should look.'),
    'scheduler-error': 'by-cause',
    'entry-preparation-failed': 'by-cause',
    'entry-blocked': fact('blocker'),
    'evidence-not-current': fact('reverify'),
    'recovery-not-converging': operator('Rounds and their allowance are the operator’s policy.'),
    'cycle-needs-attention': fact('cycle'),
    'legacy-attention': operator('Written before codes; it could be read only by its text.'),
  } as const satisfies Record<RoadmapAttentionCode, HoldRelease | 'by-cause'>,
  causes: {
    'phase-gate': fact('phase-gate'),
    'predecessor-merge-missing': fact('predecessor-merge'),
    // No command makes an item incomplete, and an unavailable item needs reconciliation.
    'item-unavailable': operator('The item needs reconciliation.'),
    'item-not-admitted': operator('The item needs admitting.'),
    'item-completed-unmerged': operator('No command makes an item incomplete again.'),
    'predecessors-incomplete': operator('A predecessor the launch found incomplete.'),
    // States whose fix is a person's.
    'worktree-state': operator('The worktree needs cleaning or its branch restoring.'),
    'roadmap-binding-changed': operator('The binding needs reconciling.'),
    'delegation-authority-lost': operator('The roadmap needs delegating again.'),
    'authority-lost': operator('The finalization’s authority needs granting again.'),
    'finalization-inactive': operator('The finalization ended.'),
    'legacy-finalization-retired': operator('The retired finalization path stopped.'),
    'worktree-inactive': operator('The worktree was removed.'),
    'resolution-not-ready': operator('The resolution’s merge needs a person.'),
    // Events, which do not pass again by themselves.
    'launch-refused': operator('The launch refused the step.'),
    'review-capture-failed': operator('The review’s continuation could not be captured.'),
    // Transient, but a retry needs a timer: R-B5's (decision 6).
    'service-unavailable': operator('A retry with a backoff is R-B5’s.'),
  } as const satisfies Record<RefusalStop, HoldRelease>,
} as const;

/** What a stored stop or hold is, as `HOLD_RELEASE` classifies it. */
export type HoldOrigin =
  | { readonly kind: 'pause' }
  | { readonly kind: 'adoption' }
  | { readonly kind: 'unattributed' }
  | {
      readonly kind: 'stop';
      readonly code: RoadmapAttentionCode;
      readonly cause?: CycleAttentionCode | undefined;
    };

/**
 * A stored entry hold's origin (`entryId` is the hold's own key): an item pause, a failed
 * adoption (the only `entry-preparation-failed` hold that names a cycle), a blocker hold stored
 * before the follow-up (it names its own entry, so not the round's owner the gate was asked of),
 * or a stop by its code and cause.
 */
export function holdOrigin(entryId: string, hold: RoadmapEntryHold): HoldOrigin {
  if (hold.status === 'paused') return { kind: 'pause' };
  const attention = hold.attention ?? { code: 'legacy-attention' as const };
  const refs = 'refs' in attention ? attention.refs : undefined;
  if (attention.code === 'entry-preparation-failed' && refs?.cycleId !== undefined)
    return { kind: 'adoption' };
  if (attention.code === 'entry-blocked' && refs?.entryId === entryId)
    return { kind: 'unattributed' };
  return { kind: 'stop', code: attention.code, cause: refs?.cause };
}

const UNKNOWN_CAUSE = operator('A cause the table does not know stays the operator’s.');
const UNCAUSED = operator(
  'A refusal without a typed cause could be read only by its text (rule 4).',
);

/**
 * How a stored stop or hold of this origin is cleared. A refusal's typed cause decides it; a code
 * that names its own fact keeps it, unless its cause is one the table leaves to the operator (an
 * `entry-blocked` hold for an item the item gate refuses: the item needs a person, increment 2
 * review L-1). A refusal without a cause, or with one the table does not know, is the operator's.
 */
export function holdRelease(origin: HoldOrigin): HoldRelease {
  if (origin.kind !== 'stop') return HOLD_RELEASE[origin.kind];
  const cause =
    origin.cause === undefined
      ? undefined
      : Object.hasOwn(HOLD_RELEASE.causes, origin.cause)
        ? HOLD_RELEASE.causes[origin.cause as RefusalStop]
        : UNKNOWN_CAUSE;
  const byCode = HOLD_RELEASE.codes[origin.code];
  if (byCode !== 'by-cause') return cause && 'operator' in cause ? cause : byCode;
  return cause ?? UNCAUSED;
}

/**
 * What the scheduler must read again to release one stored hold or stop: the fact
 * `HOLD_RELEASE` names for it, and the entry whose gate it asks (R-C10's follow-up, decision 2).
 * Undefined when the hold or stop stays the operator's.
 */
export interface ReleaseCheck {
  readonly fact: ReleaseFact;
  /** The entry whose gate is asked again: the hold's own, or the one its refs name. */
  readonly entryId: string;
  /** A round's owner is asked as a round, which may borrow one repository slot (LIVE-06). */
  readonly asRound: boolean;
  /** The cycle a `cycle` fact reads. */
  readonly cycleId?: WorkCycleId;
}

/** A stored entry hold's check; `entryId` is the hold's own key. */
export function holdCheck(entryId: string, hold: RoadmapEntryHold): ReleaseCheck | undefined {
  const origin = holdOrigin(entryId, hold);
  const release = holdRelease(origin);
  if (!('fact' in release)) return undefined;
  const gated = hold.attention?.refs?.entryId ?? entryId;
  // Stale evidence is re-verified on the entry that holds it, so a hold naming another entry
  // stays the operator's: none is written so today (increment 5 review NIT-1).
  if (release.fact === 'reverify' && gated !== entryId) return undefined;
  return { fact: release.fact, entryId: gated, asRound: gated !== entryId };
}

/**
 * A roadmap's own stop's check: a sequential stop names its entry (decision 3), and a
 * `cycle-needs-attention` stop its cycle too. A stop that names no entry stays the operator's.
 */
export function stopCheck(attention: RoadmapAttention | undefined): ReleaseCheck | undefined {
  const refs = attention?.refs;
  if (!attention || refs?.entryId === undefined) return undefined;
  const release = holdRelease({ kind: 'stop', code: attention.code, cause: refs.cause });
  if (!('fact' in release)) return undefined;
  if (release.fact === 'cycle' && refs.cycleId === undefined) return undefined;
  // A sequential roadmap holds no review entry (decision 3's finding), so a stop for stale
  // evidence has no re-verification to queue: resuming it would only stop again. The operator's.
  if (release.fact === 'reverify') return undefined;
  return {
    fact: release.fact,
    entryId: refs.entryId,
    asRound: false,
    ...(refs.cycleId ? { cycleId: refs.cycleId } : {}),
  };
}

/** How long approvals must have settled before the scheduler re-verifies by itself (decision 4). */
export const REVERIFY_SETTLE_MS = 10 * 60_000;
/** The reasons a fresh review answers and the operator caused: approved decisions, a policy. */
const ANSWERED_BY_REVIEW: ReadonlySet<string> = new Set(['decisions', 'repository-policy']);

/** Whether the scheduler re-verifies a stale entry itself, or the first condition that fails. */
export type SelfReverification =
  | 'reverifies'
  | 'not-granted'
  | 'not-in-place'
  | 'not-automatic'
  | 'no-reason'
  | 'reason-not-answered'
  | 'settling'
  | 'already-reverified';

/**
 * The scheduler's own Re-verify of an entry whose evidence went stale (R-C10's follow-up,
 * decision 4), under the roadmap's grant. Every condition must hold: the grant is on; Re-verify
 * takes its in-place route (the fresh route retires an attempt and stays the operator's); the
 * roadmap verifies the entry automatically; the evidence has at least one typed reason it is not
 * current, and each is one a fresh review answers and the operator caused (the approved
 * decisions, the repository policy); approvals settled (none in the last ten minutes); and no
 * re-verification was made for the stale review run (`reverification.sourceRunId`). A launched
 * re-verification clears its record, so the stale receipt must also be that run's own: the next
 * one then needs a new receipt, which only a passing review records, and a cycle that completed
 * without recording one stays the operator's rather than being reviewed on every pass.
 */
export function selfReverification(facts: {
  readonly granted: boolean;
  readonly inPlace: boolean;
  readonly automatic: boolean;
  readonly reasons: readonly string[];
  readonly receiptRunId?: string | undefined;
  readonly sourceRunId?: string | undefined;
  /** The review run a re-verification is already queued for. */
  readonly reverifiedRunId?: string | undefined;
  readonly changedAt?: string | undefined;
  readonly now: Date;
}): SelfReverification {
  if (!facts.granted) return 'not-granted';
  if (!facts.inPlace) return 'not-in-place';
  if (!facts.automatic) return 'not-automatic';
  if (!facts.reasons.length) return 'no-reason';
  if (facts.reasons.some((reason) => !ANSWERED_BY_REVIEW.has(reason))) return 'reason-not-answered';
  if (
    facts.changedAt !== undefined &&
    facts.now.getTime() - Date.parse(facts.changedAt) < REVERIFY_SETTLE_MS
  )
    return 'settling';
  if (
    facts.reverifiedRunId === facts.sourceRunId ||
    facts.receiptRunId === undefined ||
    facts.receiptRunId !== facts.sourceRunId
  )
    return 'already-reverified';
  return 'reverifies';
}

/**
 * The phase whose gate a hold's `phase-gate` cause is asked again of (increment 2 review L-2): a
 * slice's start before its cycle exists and its merge after, a slice verification's verify, a
 * parent acceptance's accept.
 */
export function gatePhase(
  scope: Pick<ExecutionScope, 'kind'>,
  hasCycle: boolean,
): 'start' | 'merge' | 'verify' | 'accept' {
  if (scope.kind === 'slice') return hasCycle ? 'merge' : 'start';
  return scope.kind === 'slice-verification' ? 'verify' : 'accept';
}

/**
 * A stored `cycle-needs-attention` stop clears once its cycle runs or is at its merge again, or its
 * entry completed (decision 2).
 */
export function cycleCarriesOn(status: CycleStatus | undefined, entryComplete: boolean): boolean {
  return entryComplete || status === 'running' || status === 'awaiting-merge';
}

/** A phase gate clears a hold once it names nothing that stops: every blocker left waits. */
export function phaseGateClears(blockers: readonly PhaseBlocker[]): boolean {
  return blockers.every((b) => PHASE_BLOCKERS[phaseBlockerCode(b)].waits);
}

/**
 * The hold on a roadmap entry: its stored hold, or a sequential roadmap's own stop on it. A
 * sequential roadmap holds no entry; the fact that would hold one stops the roadmap with its
 * code and the entry in `refs.entryId` (decision 3), so the items that carry a hold read that
 * stop the same way. A stop for the entry's cycle (`cycle-needs-attention`) is the cycle's, not a
 * hold.
 */
export function heldEntry(
  roadmap: Pick<Roadmap, 'entryHolds'> &
    Partial<Pick<Roadmap, 'status' | 'reason' | 'attention'>> & {
      readonly definition?: Pick<RoadmapDefinition, 'scheduling'>;
    },
  entryId: string,
): RoadmapEntryHold | undefined {
  const stored = roadmap.entryHolds?.[entryId];
  if (stored) return stored;
  const stop = roadmap.attention;
  if (
    roadmap.definition?.scheduling?.mode === 'parallel' ||
    roadmap.status !== 'needs-attention' ||
    !stop ||
    stop.refs?.entryId !== entryId ||
    stop.code === 'cycle-needs-attention'
  )
    return undefined;
  return { status: 'needs-attention', reason: roadmap.reason ?? '', attention: stop };
}

/** Why a roadmap does not go on by itself, whatever its status says. */
export type RoadmapHeld = 'ended' | 'settling' | 'amendment-pending' | 'version-retired';

/**
 * One predicate for what holds a whole roadmap (R-B11's handoff): it ended, a wind-down is
 * settling it, a planning amendment awaits a decision, or the plan version of `entry` (of any
 * entry, without one) is retired or being retired. Nothing the scheduler releases by itself is
 * released while it holds (decision 2's guards).
 */
export function roadmapHeld(
  tx: StorageRepositories,
  roadmap: Pick<Roadmap, 'id' | 'workspaceId' | 'status'> & {
    readonly definition: { readonly entries: readonly { readonly planVersionId: PlanVersionId }[] };
  },
  entry?: { readonly planVersionId: PlanVersionId },
): RoadmapHeld | undefined {
  if (roadmap.status === 'stopped' || roadmap.status === 'completed') return 'ended';
  if (tx.windDowns.find(roadmap.workspaceId, roadmap.id)?.status === 'settling') return 'settling';
  if (tx.amendments.pending(roadmap.workspaceId, roadmap.id)) return 'amendment-pending';
  const versions = entry ? [entry] : roadmap.definition.entries;
  if (versions.some((e) => retiredOrRetiring(tx, roadmap.workspaceId, e.planVersionId)))
    return 'version-retired';
  return undefined;
}
