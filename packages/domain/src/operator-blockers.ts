import { PHASE_BLOCKERS } from './attention.js';
import type { PhaseBlocker } from './phase-scheduling.js';

/**
 * Whether only the operator can move work these blockers hold, by setup or a stop of their own
 * (R-C14, R-E3b): every blocker is the operator's and none waits on a checkpoint, whose own item
 * carries it. The status list calls such an entry the operator's, and the roadmap's setup item
 * lists it, by this one rule, so the two agree.
 */
export function operatorOwnsAll(blockers: readonly PhaseBlocker[] | undefined): boolean {
  return (
    !!blockers?.length &&
    blockers.every((b) => PHASE_BLOCKERS[b.code].owner === 'operator' && !b.refs?.checkpointId)
  );
}

/**
 * Whether these blockers are all operator setup, which the roadmap's setup item lists (R-E3b
 * review M2): the setup the controller waits for (environments, unsupported resources, dependency
 * environments, upstream pins, external qualification) and reviewer assignments, none waiting on
 * a checkpoint. The operator's stops (amendments, bindings, plan, repository, adoption) have
 * items of their own and are not setup.
 */
export function operatorSetupOnly(blockers: readonly PhaseBlocker[] | undefined): boolean {
  return (
    !!blockers?.length &&
    blockers.every((b) => {
      const { code } = b;
      const { owner, waits } = PHASE_BLOCKERS[code];
      return (
        owner === 'operator' && (waits || code === 'reviewer-assignment') && !b.refs?.checkpointId
      );
    })
  );
}
