import {
  type AttentionItem,
  ENTRY_WAIT,
  operatorOwnsAll,
  PHASE_BLOCKERS,
  type PhaseBlocker,
  phaseBlockerCode,
  type WorkCycle,
} from '@craftingtable/domain';
import { checkpointSubjectKey } from './checkpoint-subject.js';
import { cycleStep } from './entry-waits.js';

type Phase = 'start' | 'merge' | 'verify' | 'accept';
type Status = 'not-started' | 'prepared' | 'started' | 'merged' | 'verified' | 'accepted';

/** Who acts next on a slice or parent acceptance, and on what (R-E4 review M1). */
export interface ScopeNext {
  readonly actor: 'operator' | 'agent' | 'controller';
  readonly reason: string;
  readonly attentionItemId?: string;
  readonly cycleId?: string;
}

/** The phase that moves a scope on from its status, or none once it is done. */
function nextPhase(kind: 'slice' | 'parent-acceptance', status: Status): Phase | undefined {
  if (kind === 'parent-acceptance') return status === 'accepted' ? undefined : 'accept';
  if (status === 'not-started' || status === 'prepared') return 'start';
  if (status === 'started') return 'merge';
  if (status === 'merged') return 'verify';
  return undefined;
}

/**
 * Who acts next on a scope, by the roadmap status list's rule, so a work item's slice strip and
 * the roadmap's board agree (R-E4 review M1): an open inbox item on the scope's live cycle, or on a
 * checkpoint it needs, is the operator's, linked; a running cycle is the agent's; a stopped cycle is whoever its own wait
 * names (`cycleStep`); otherwise the next phase's blockers are the operator's only when every one
 * is theirs and none is a checkpoint's (`operatorOwnsAll`), as the status list and the setup item
 * decide. Ended cycles say nothing. Nothing is next once the scope is done.
 */
export function scopeNext(input: {
  readonly kind: 'slice' | 'parent-acceptance';
  readonly status: Status;
  readonly phases: readonly { readonly phase: Phase; readonly blockers: readonly PhaseBlocker[] }[];
  /** The cycles on the scope's worktrees, newest first. */
  readonly cycles: readonly WorkCycle[];
  /** The workspace's open inbox items. */
  readonly items: readonly AttentionItem[];
}): ScopeNext | undefined {
  const phase = nextPhase(input.kind, input.status);
  if (phase === undefined) return undefined;
  const live = input.cycles.find((c) => c.status !== 'stopped' && c.status !== 'completed');
  const cycleItem =
    live &&
    input.items.find((i) => i.refs.cycleId === live.id || i.subjectKey === `cycle:${live.id}`);
  if (live && cycleItem)
    return {
      actor: 'operator',
      reason: cycleItem.message,
      attentionItemId: cycleItem.id,
      cycleId: live.id,
    };
  // A checkpoint the scope needs that the operator is asked to settle, by its item's typed
  // subject (a decision hold, R-C3b), as the status list's checkpoint item.
  const checkpoints = new Set(
    input.phases.flatMap((p) => p.blockers.flatMap((b) => b.refs?.checkpointId ?? [])),
  );
  const checkpointItem = input.items.find(
    (i) =>
      i.refs.roadmapId !== undefined &&
      [...checkpoints].some((id) => i.subjectKey === checkpointSubjectKey(i.refs.roadmapId!, id)),
  );
  if (checkpointItem)
    return {
      actor: 'operator',
      reason: checkpointItem.message,
      attentionItemId: checkpointItem.id,
    };
  if (live) {
    const step = cycleStep(live);
    return {
      actor: 'wait' in step ? ENTRY_WAIT[step.wait.code] : 'agent',
      reason: live.reason,
      cycleId: live.id,
    };
  }
  const blockers = input.phases.find((p) => p.phase === phase)?.blockers ?? [];
  if (blockers.length === 0) return { actor: 'controller', reason: 'No requirement waiting.' };
  const operator = operatorOwnsAll(blockers);
  // The headline names the operator's own blocker first, as the requirements list groups them.
  const first =
    blockers.find((b) => PHASE_BLOCKERS[phaseBlockerCode(b)].owner === 'operator') ?? blockers[0]!;
  return { actor: operator ? 'operator' : 'controller', reason: first.message };
}
