import type { WorktreeId } from '@craftingtable/domain';
import { ExecutionRequestError } from './errors.js';

/** Keep daemon launches and cycle resumes out of an operator's in-flight merge/removal. */
export class WorktreeMutationGuard {
  private readonly busy = new Set<WorktreeId>();
  requireAvailable(id: WorktreeId): void {
    if (this.busy.has(id))
      throw new ExecutionRequestError(
        'conflict',
        'A merge or removal is already in progress for this worktree',
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
}
