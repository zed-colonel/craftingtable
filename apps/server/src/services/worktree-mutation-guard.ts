import type { WorktreeId } from '@craftingtable/domain';
import { ExecutionRequestError } from './errors.js';

export class WorktreeMutationBusyError extends ExecutionRequestError {
  constructor(message = 'A merge or removal is already in progress for this worktree') {
    super('conflict', message);
  }
}

/** Keep daemon launches and cycle resumes out of an operator's in-flight merge/removal. */
export class WorktreeMutationGuard {
  private readonly busy = new Set<WorktreeId>();
  /** Worktrees a launch still holds after `during` returned: a review's checks (R-G13). */
  private readonly held = new Map<WorktreeId, number>();
  /** Worktrees where an agent process that lost supervision has not yet exited. */
  private readonly terminating = new Map<WorktreeId, number>();
  requireAvailable(id: WorktreeId): void {
    if (this.busy.has(id)) throw new WorktreeMutationBusyError();
    if (this.held.has(id))
      throw new WorktreeMutationBusyError(
        'A review is starting in this worktree; its adopted checks are running. Wait for the review to start.',
      );
    this.requireNoTerminatingAgent(id);
  }
  /** Refuse while an agent process that lost supervision may still be editing the worktree. */
  requireNoTerminatingAgent(id: WorktreeId): void {
    if (this.terminating.has(id))
      throw new WorktreeMutationBusyError(
        'An agent that lost supervision is still being terminated in this worktree; wait for its process to exit',
      );
  }
  async during<T>(id: WorktreeId, operation: () => Promise<T>): Promise<T> {
    this.requireAvailable(id);
    this.busy.add(id);
    try {
      return await operation();
    } finally {
      this.busy.delete(id);
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
    }
  }
}
