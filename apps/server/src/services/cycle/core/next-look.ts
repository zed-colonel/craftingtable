import type { WorkCycle } from '@craftingtable/domain';
import { CYCLE_GUARDS, type CycleDecision } from './machine.js';

/** How often an open worktree change is compared with its record again (R-C16). */
export const RESTORED_CHECK_MS = 60_000;

/** How long past its deadline an unfinished investigation run is closed (R-C16 review M3). */
export const STUCK_INVESTIGATION_MS = 2 * 60_000;

/**
 * When a cycle next needs the controller's look by itself, with nothing written meanwhile (R-B5):
 * the time at which a guard would act, given the decision the controller has just carried out, if
 * that time is still ahead. The kernel arms one timer for the earliest such time over every cycle.
 *
 * Only a time strictly after `now` is returned (design review H-3): a time an earlier guard
 * pre-empts (a phase wait whose step deadline is behind it, a reserved merge, a cycle the kernel
 * holds, a settling roadmap, a held retry already past due) is left to that guard's own release,
 * which writes or marks, and to the kernel's sweep; arming it would fire at once, every round.
 */
export function nextLook(
  cycle: WorkCycle,
  decision: CycleDecision,
  memory: {
    /** When this process last compared an open worktree change with its record (R-C16). */
    readonly restoredCheckedAt: (investigationId: string) => number | undefined;
  },
  now: Date,
): number | undefined {
  const at = now.getTime();
  const ahead = (time: number | undefined) => (time !== undefined && time > at ? time : undefined);
  // A provider retry not yet due says when (the core's own `dueAt`).
  if (decision.kind === 'idle' && decision.dueAt !== undefined)
    return ahead(Date.parse(decision.dueAt));
  switch (decision.guard) {
    case 'investigation-live': {
      // A live investigation whose run outlives its deadline is closed two minutes past it.
      const deadline = cycle.investigation?.deadlineAt;
      return deadline === undefined
        ? undefined
        : ahead(Date.parse(deadline) + STUCK_INVESTIGATION_MS);
    }
    case 'worktree-change-open': {
      // An open worktree change is compared again a minute after its last comparison.
      const id = cycle.investigation?.id;
      const last = id === undefined ? undefined : memory.restoredCheckedAt(id);
      return last === undefined ? undefined : ahead(last + RESTORED_CHECK_MS);
    }
    default:
      break;
  }
  // A guard after the step deadline decided: the deadline was asked and has not passed, so it is
  // the next thing to find by itself while the cycle runs (its run or its launch).
  if (
    cycle.status === 'running' &&
    CYCLE_GUARDS.indexOf(decision.guard) > CYCLE_GUARDS.indexOf('step-deadline')
  )
    return ahead(Date.parse(cycle.runDeadlineAt));
  return undefined;
}
