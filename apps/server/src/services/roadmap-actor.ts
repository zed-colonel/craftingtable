/**
 * The roadmap scheduler acting on a cycle, a merge, a worktree or a launch it delegates (R-B7,
 * CTRL-13): its `check`, which the callee asks where it asked the scheduler's closure (before its
 * first write and again after each await), and its `attach`, which a cycle step's reservation runs
 * inside its own transaction. One type for every facade the scheduler drives; a caller that is not
 * the scheduler passes none.
 */
export interface RoadmapActor {
  /** Throws when the roadmap no longer schedules this action: the callee then writes nothing more. */
  readonly check: () => void;
  /** The roadmap's own write, in the transaction that reserves the cycle's step. */
  readonly attach?: () => void;
}
