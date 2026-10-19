/**
 * The cycle side's process-local state (R-B7): the controller's in-memory sets and maps, the
 * transition lock and the worker's stop signal, as one object every cycle module shares, so none
 * holds a copy of its own. R-B5's per-aggregate mutex replaces them here.
 */
import type { WorkCycleId } from '@craftingtable/domain';
import { ExecutionRequestError } from '../errors.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';

export class CycleLocks {
  readonly ending = new Set<string>();
  /** Investigations whose launch is in flight (R-C16): settling waits for them. */
  readonly launchingInvestigations = new Set<string>();
  /** Investigations whose worktree is being compared, so one pass settles each (R-C16). */
  readonly settlingInvestigations = new Set<string>();
  /** When each open worktree change was last compared with its record (R-C16). */
  readonly restoredChecks = new Map<string, number>();
  readonly repairing = new Set<string>();
  /**
   * A controller-started reassessment that cannot be prepared is shown to the operator
   * once. It is retried only after the cycle changes (an operator command, a new run),
   * never silently on every loop pass. Transient contention is retried normally.
   */
  readonly failedReassessments = new Map<string, number>();
  readonly refreshing = new Set<string>();
  /** Cycles and commits already sent back for their adopted checks (LIVE-24). */
  readonly declaredReviews = new Set<string>();
  private readonly transitioning = new Set<string>();
  /**
   * The cycles a command holds now (R-B5, decision 15): a recovery's preparation or an
   * investigation's launch. The controller's rounds leave such a cycle alone until the command
   * releases it, which marks it; a second command is refused as before.
   */
  private readonly commandHolds = new Map<string, number>();
  /** The controller worker's stop: once given, every module stops at its next check. */
  private readonly abort = new AbortController();

  constructor(
    private readonly notifier: WorkspaceEventNotifier,
    /** Tells the controller a cycle it may have left alone is free again (R-B5). */
    private readonly onRelease: (id: string) => void = () => undefined,
  ) {}

  /** A hold on the cycle ended: its integration refresh, transition or investigation (R-B5). */
  released(id: string): void {
    this.onRelease(id);
  }

  /** Whether a command holds the cycle, so the controller leaves it (decision 15). */
  heldByCommand(id: string): boolean {
    return this.commandHolds.has(id);
  }
  /** A command takes the cycle; `releaseCommand` gives it back and marks it. */
  holdForCommand(id: string): void {
    this.commandHolds.set(id, (this.commandHolds.get(id) ?? 0) + 1);
  }
  releaseCommand(id: string): void {
    const left = (this.commandHolds.get(id) ?? 1) - 1;
    if (left > 0) this.commandHolds.set(id, left);
    else this.commandHolds.delete(id);
    this.released(id);
  }

  /** Stops the controller (`WorkCycleService.shutdown`). */
  stop(): void {
    this.abort.abort();
  }
  /** Whether the controller is stopping. */
  stopping(): boolean {
    return this.abort.signal.aborted;
  }
  /** The stop as a signal, for the worker's wait. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  isTransitioning(id: WorkCycleId): boolean {
    return this.transitioning.has(id);
  }

  /** A command already owns this recovery. No scheduler takeover or stale alert
   * may race its asynchronous Git preparation. Restart releases the guard and
   * leaves the durable checkpoint available for explicit recovery. */
  async duringTransition<T>(id: WorkCycleId, operation: () => Promise<T>): Promise<T> {
    if (this.transitioning.has(id))
      throw new ExecutionRequestError('conflict', 'Recovery is already being prepared.');
    this.transitioning.add(id);
    this.holdForCommand(id);
    this.notifier.notify('activity');
    try {
      return await operation();
    } finally {
      this.transitioning.delete(id);
      // Real state mutations already wake workflow workers. A transient resource
      // failure must not wake its own retry loop without a durable state change.
      this.notifier.notify('activity');
      // The controller looks at the cycle once more, as the next loop pass did (R-B5).
      this.releaseCommand(id);
    }
  }
}
