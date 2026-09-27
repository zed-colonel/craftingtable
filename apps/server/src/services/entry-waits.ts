import {
  type EntryWaitCode,
  effectiveCycleAttention,
  phaseBlockerCode,
  type RoadmapEntryWait,
  type WorkCycle,
} from '@craftingtable/domain';
import type { PhaseGateError } from './phase-resources.js';

/**
 * Typed entry waits (R-C12). Every path through the scheduler's evaluation of an entry ends
 * in an `EntryStep`: it moved the entry on (issued a command, reserved or advanced a round,
 * or the entry's agent is at work), or it left the entry waiting for a typed reason. The pass
 * records the waits on the roadmap, so no evaluation leaves a stopped review unexplained.
 */

/** Why the scheduler would not start an entry now; `needsAttention` blockers hold it. */
export interface EntryBlocker {
  readonly reason: string;
  readonly needsAttention: boolean;
  readonly kind: 'dependency-blocked' | 'capacity-blocked' | 'exclusion-blocked';
}
export type EntryWaitInput = Omit<RoadmapEntryWait, 'since'>;
export type EntryStep = { readonly moved: true } | { readonly wait: EntryWaitInput };

export const MOVED: EntryStep = { moved: true };

export function waiting(
  code: EntryWaitCode,
  reason: string,
  refs?: RoadmapEntryWait['refs'],
): EntryStep {
  return { wait: { code, reason: reason.slice(0, 4000), ...(refs ? { refs } : {}) } };
}

export function blockerWait(blocker: EntryBlocker, entryId?: string): EntryStep {
  return waiting(blocker.kind, blocker.reason, entryId ? { entryId } : undefined);
}

export function phaseWait(error: PhaseGateError): EntryWaitInput {
  return {
    code: 'phase-blocked',
    reason: error.message.slice(0, 4000),
    refs: { blockers: [...new Set(error.blockers.map((b) => phaseBlockerCode(b)))] },
  };
}

/**
 * What an entry waits on when the scheduler leaves its cycle to run or stop by itself: nothing
 * while the cycle runs; otherwise the cycle's own stop, owned as the cycle declares it, or the
 * operator's pause.
 */
export function cycleStep(cycle: WorkCycle): EntryStep {
  if (cycle.status === 'running') return MOVED;
  const refs = { cycleId: cycle.id };
  if (cycle.status === 'paused') return waiting('cycle-paused', cycle.reason, refs);
  const attention = effectiveCycleAttention(cycle);
  return waiting(
    attention?.owner === 'controller' ? 'cycle-waiting' : 'cycle-attention',
    cycle.reason,
    refs,
  );
}

/**
 * The stopped review a recovery round carries waits on the round: on whatever holds the round
 * up, or on the round itself while its repair or review is at work.
 */
export function roundStep(
  inner: EntryStep,
  reason: string,
  refs: { readonly entryId?: string; readonly cycleId?: string },
): EntryStep {
  return 'wait' in inner ? inner : waiting('recovery-round', reason, refs);
}

/**
 * The waits a pass leaves recorded. Only entries the pass evaluated keep one: an entry that
 * moved, completed, was deferred by a blocker or is held loses its wait, because those states
 * are carried by the attempt, the entry's progress or its hold. `keep` keeps an entry's wait
 * through a transient retry. A wait keeps its `since` while its code and subject are unchanged.
 */
export function nextEntryWaits(
  previous: Readonly<Record<string, RoadmapEntryWait>> | undefined,
  evaluated: ReadonlyMap<string, EntryStep | 'keep'>,
  now: string,
): Readonly<Record<string, RoadmapEntryWait>> | undefined {
  const next: Record<string, RoadmapEntryWait> = {};
  for (const [entryId, step] of evaluated) {
    const prior = previous?.[entryId];
    if (step === 'keep') {
      if (prior) next[entryId] = prior;
      continue;
    }
    if (!('wait' in step)) continue;
    const same =
      prior?.code === step.wait.code &&
      prior.refs?.cycleId === step.wait.refs?.cycleId &&
      prior.refs?.entryId === step.wait.refs?.entryId;
    next[entryId] = { ...step.wait, since: same ? prior.since : now };
  }
  return Object.keys(next).length ? next : undefined;
}

export function sameEntryWaits(
  a: Readonly<Record<string, RoadmapEntryWait>> | undefined,
  b: Readonly<Record<string, RoadmapEntryWait>> | undefined,
): boolean {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) if (JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])) return false;
  return true;
}
