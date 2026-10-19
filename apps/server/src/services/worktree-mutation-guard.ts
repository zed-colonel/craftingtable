import type { WorktreeId } from '@craftingtable/domain';
import { ExecutionRequestError } from './errors.js';

export class WorktreeMutationBusyError extends ExecutionRequestError {
  // The guard always names its holder; the default is for callers that have none to name.
  constructor(message = 'Another operation holds this worktree; try again once it has finished.') {
    super('conflict', message);
  }
}

/**
 * What holds a worktree's guard (R-B7 decision 3, AGT-12): each `during` names its operation, so
 * a refusal says what is in the way. One error class and status for all of them, so a retry and
 * the cycle's contention rule read the class, never the text.
 */
export type WorktreeOperation =
  | 'run-launch'
  | 'merge'
  | 'removal'
  | 'update'
  | 'scope-receipt'
  | 'decision-release'
  | 'cache-cleaning'
  | 'baseline-preparation'
  | 'review-again'
  | 'scope-review-repeat'
  | 'implementation-checkpoint'
  | 'integration-resolution';

/** The refusal an operation holding the worktree gives. */
export const WORKTREE_HELD_BY: Readonly<Record<WorktreeOperation, string>> = {
  'run-launch': 'A run is being prepared in this worktree; try again once it has started.',
  merge: 'This worktree is being merged; try again once the merge has finished.',
  removal: 'This worktree is being removed.',
  update: 'This worktree is being updated; try again once the update has finished.',
  'scope-receipt':
    "This worktree's scope receipt is being recorded; try again once it is recorded.",
  'decision-release': 'This decision worktree is being released.',
  'cache-cleaning':
    "This worktree's build cache is being cleaned; try again once the cleaning has finished.",
  'baseline-preparation':
    'A historical baseline is being prepared in this worktree; try again once it is ready.',
  'review-again':
    'A fresh review is being prepared in this worktree; try again once it has started.',
  'scope-review-repeat':
    'The scope review is being repeated in this worktree; try again once it has started.',
  'implementation-checkpoint':
    "This worktree's implementation checkpoint is being recorded; try again once it is recorded.",
  'integration-resolution':
    'An integration conflict resolution is changing this worktree; try again once its step has finished.',
};

/** Keep daemon launches and cycle resumes out of an operator's in-flight merge/removal. */
export class WorktreeMutationGuard {
  /** The worktrees `during` holds, each with the operation holding it. */
  private readonly busy = new Map<WorktreeId, WorktreeOperation>();
  /** Worktrees a launch still holds after `during` returned: a review's checks (R-G13). */
  private readonly held = new Map<WorktreeId, number>();
  /** Worktrees where an agent process that lost supervision has not yet exited. */
  private readonly terminating = new Map<WorktreeId, number>();
  /**
   * Told when a worktree is released, so a controller that found it held looks again (R-B5): a
   * cycle idles on a held worktree, and nothing else would wake it.
   */
  onRelease: (() => void) | undefined;
  requireAvailable(id: WorktreeId): void {
    const holder = this.busy.get(id);
    if (holder !== undefined) throw new WorktreeMutationBusyError(WORKTREE_HELD_BY[holder]);
    if (this.held.has(id))
      throw new WorktreeMutationBusyError(
        'A review is starting in this worktree; its adopted checks are running. Wait for the review to start.',
      );
    this.requireNoTerminatingAgent(id);
  }
  /** An agent process that lost supervision may still be editing the worktree. */
  agentTerminating(id: WorktreeId): boolean {
    return this.terminating.has(id);
  }
  /** Refuse while an agent process that lost supervision may still be editing the worktree. */
  requireNoTerminatingAgent(id: WorktreeId): void {
    if (this.terminating.has(id))
      throw new WorktreeMutationBusyError(
        'An agent that lost supervision is still being terminated in this worktree; wait for its process to exit',
      );
  }
  async during<T>(
    id: WorktreeId,
    holder: WorktreeOperation,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.requireAvailable(id);
    this.busy.set(id, holder);
    try {
      return await operation();
    } finally {
      this.busy.delete(id);
      this.onRelease?.();
    }
  }
  /**
   * Keeps merges, removals and other launches out of the worktree until `until` settles: a
   * launch that continues after `during` returned, such as a review whose adopted checks run
   * before its agent starts (R-G13 increment 3).
   */
  hold(id: WorktreeId, until: Promise<unknown>): void {
    this.held.set(id, (this.held.get(id) ?? 0) + 1);
    const release = () => {
      const remaining = (this.held.get(id) ?? 1) - 1;
      if (remaining > 0) this.held.set(id, remaining);
      else this.held.delete(id);
      this.onRelease?.();
    };
    // Released either way; a rejection is the launch's to report, never an unhandled one here.
    until.then(release, release);
  }
  /**
   * Hold the worktree until `exited` settles. Unlike `during`, this never
   * refuses: the process is already running and must be waited out whatever
   * else holds the worktree.
   */
  async untilExited(id: WorktreeId, exited: Promise<void>): Promise<void> {
    this.terminating.set(id, (this.terminating.get(id) ?? 0) + 1);
    try {
      await exited;
    } finally {
      const remaining = (this.terminating.get(id) ?? 1) - 1;
      if (remaining > 0) this.terminating.set(id, remaining);
      else this.terminating.delete(id);
      this.onRelease?.();
    }
  }
}
