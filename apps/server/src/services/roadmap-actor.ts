/**
 * The roadmap scheduler acting on a cycle, a merge, a worktree or a launch it delegates (R-B7,
 * CTRL-13): its `check`, which the callee asks where it asked the scheduler's closure (before its
 * first write and again after each await), and its `attach`, which a cycle step's reservation runs
 * inside its own transaction. A facade the scheduler drives takes it, or `RoadmapCheck` where it
 * only asks the check; a caller that is not the scheduler passes none.
 */
export interface RoadmapActor {
  /** Throws when the roadmap no longer schedules this action: the callee then writes nothing more. */
  readonly check: () => void;
  /** The roadmap's own write, in the transaction that reserves the cycle's step. */
  readonly attach?: () => void;
}

/**
 * The actor of a facade that only asks the check (R-B7 scheduler half, the review of increment 9,
 * NIT-1): such a facade never runs an `attach`, so one written into its call is refused.
 */
export type RoadmapCheck = Pick<RoadmapActor, 'check'>;
