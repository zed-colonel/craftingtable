import { AWAITING_MERGE_GATES, type CycleAttention, type CycleAttentionCode } from './attention.js';
import type { CycleEndCode, CycleStop, WorkCycle } from './work-cycle.js';

/**
 * Reads of a cycle's stop record (R-B4b). The projector, the controller and the browser read the
 * stop through these, never the record's `kind` and `since`, so a stop compares and is audited as
 * the attention it declares.
 */

/**
 * The stop the cycle is at: its operator stop or gate while `needs-attention` or `awaiting-merge`
 * (none for a cycle that is not there, or not found).
 */
export function cycleStop(
  cycle: Pick<WorkCycle, 'status' | 'stop'> | undefined,
): CycleAttention | undefined {
  if (cycle?.status !== 'needs-attention' && cycle?.status !== 'awaiting-merge') return undefined;
  return heldStop(cycle);
}

/** The stop the cycle holds, at it or paused at it (R-A7): what a resume returns to. */
export function heldStop(cycle: Pick<WorkCycle, 'stop'> | undefined): CycleAttention | undefined {
  const stop = cycle?.stop;
  if (stop === undefined || stop.kind === 'ended') return undefined;
  const { kind: _kind, since: _since, ...attention } = stop;
  return attention;
}

/** How a stopped or completed cycle ended. */
export function cycleEnd(cycle: Pick<WorkCycle, 'stop'>): CycleEndCode | undefined {
  return cycle.stop?.kind === 'ended' ? cycle.stop.code : undefined;
}

const GATES: ReadonlySet<CycleAttentionCode> = new Set<CycleAttentionCode>(AWAITING_MERGE_GATES);

/** The record of a stop that began at `since`: a gate exactly when its code is one of the six. */
export function stopRecord(attention: CycleAttention, since: string): CycleStop {
  return { kind: GATES.has(attention.code) ? 'gate' : 'attention', ...attention, since };
}
