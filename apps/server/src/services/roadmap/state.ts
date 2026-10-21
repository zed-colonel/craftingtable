/**
 * The roadmap scheduler's process-local state (R-B7): the hold its commands take (`controlling`),
 * the drain's kernel, round and lock waits, the decision preparations' and delegated merges' retry
 * times, the reads' caches, the worker's stop signal, the clock, and the attach points composition
 * sets after construction. One object, shared by the facade and every module, so none holds a copy
 * of a flag, the clock or an attach point taken before it was set.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ControllerKernel } from '../kernel/controller-kernel.js';
import type { HoldInbox, SchedulerObserver } from './shared.js';
import type { CrossProjectView, RoadmapGraph } from '@craftingtable/contracts';
import type { ControllerPasses } from '../attention-gates.js';
import type { AttentionProjector } from '../attention-projector.js';
import { RepositoryMutationBusyError } from '../branch-service.js';
import { ConcurrentModificationError } from '../errors.js';
import { WorktreeMutationBusyError } from '../worktree-mutation-guard.js';

export class RoadmapState {
  readonly abort = new AbortController();
  task: Promise<void> | undefined;
  ticking = false;
  admissionsHeld = false;
  readonly controlling = new Set<string>();
  /** Operator-requested rounds whose Delegate source fixes request is still preparing them. */
  readonly preparingRounds = new Set<string>();
  attention: AttentionProjector | undefined;
  passes: ControllerPasses | undefined;
  observer: SchedulerObserver | undefined;
  /** When a standing preparation that could not be reserved is tried again, per decision. */
  readonly preparationRetryAt = new Map<string, number>();
  /** `target-moved` refusals of each worktree's delegated merge since its last merge, in memory. */
  readonly targetMovedRefusals = new Map<string, number>();
  /** When each worktree's refused delegated merge may be tried again (R-B5 part 2). */
  readonly targetMovedNotBefore = new Map<string, number>();
  /**
   * Map evaluations reads have made, by roadmap, with the commit count they read at (R-E3b): the
   * feed counts its items' slices from the page read's evaluation, or its own, until a write.
   * Reads only: a write path evaluates the map itself.
   */
  readonly readMaps = new Map<
    string,
    { readonly commits: number; readonly revision: number; readonly view: CrossProjectView }
  >();
  /** Graphs by roadmap and revision, built once each: a revision never changes. */
  readonly graphs = new Map<string, RoadmapGraph>();
  rounds = 0;
  /** The round in flight, the loop's or a tick's; the loop waits for it before taking marks. */
  rounding: Promise<void> | undefined;
  /** Open while the drain's own round runs: its own lock releases mark nothing. */
  readonly ownRound = new AsyncLocalStorage<object>();
  /** The round in flight's token: a context carried past its round's end is not its own. */
  roundToken: object | undefined;
  /**
   * Roadmaps whose decision preparations met a lock busy, by the lock's key: none is tried
   * again until it is released, since each try writes a reservation and removes it, waking
   * every roadmap (increment 9 review HIGH-2).
   */
  readonly preparationsHeld = new Map<string, { readonly key: string; readonly at: number }>();
  /** When a roadmap's decision preparations may be tried after a transient refusal. */
  readonly preparationsNotBefore = new Map<string, number>();
  /** Roadmaps that met a lock busy, by the lock's key, marked at its release. */
  readonly lockWaiters = new Map<string, Set<string>>();
  /** Locks released by something else during the round in flight. */
  readonly releasedMeanwhile = new Set<string>();
  /** The due times this round asked for, per roadmap. */
  readonly looks = new Map<string, number>();
  /** Shared-decision inboxes built once per scheduler pass (R-C3b review). */
  passInboxes: Map<string, HoldInbox> | undefined;
  /** And once per read snapshot, for views. */
  readonly viewInboxes = new WeakMap<object, Map<string, HoldInbox>>();
  attentionSynced = { generation: -1, at: 0 };

  constructor(
    /** The scheduler's clock; a test may move it (`server-execution-roadmap-auto-reverify.test.ts`). */
    public now: () => Date,
    /** The drain's kernel: marks, due times and the shared sweep (R-B5 part 2). */
    readonly kernel: ControllerKernel,
  ) {}

  /** The roadmap met the lock `key` busy: its release marks it (part 2 review HIGH-1). */
  waitOnLock(roadmapId: string, key: string): void {
    // Only a round's look waits; a read (the board's blockers) records nothing (review LOW-4).
    if (this.ownRound.getStore() === undefined) return;
    const waiting = this.lockWaiters.get(key) ?? new Set<string>();
    waiting.add(roadmapId);
    this.lockWaiters.set(key, waiting);
  }

  /**
   * The roadmap needs a look of its own at `at` (the earliest asked in a round wins); a time not
   * ahead of now is no due time (increment 9 review HIGH-1: it would mark every round).
   */
  lookAgain(roadmapId: string, at: number): void {
    if (at <= this.now().getTime()) return;
    const earlier = this.looks.get(roadmapId);
    if (earlier === undefined || at < earlier) this.looks.set(roadmapId, at);
  }

  /**
   * What a `retried()` error leaves the roadmap waiting on (part 2 review HIGH-2): a lost race
   * looks again a second on, as the next pass did; the merge lane and the worktree guard by their
   * release; a held integration, a waiting phase gate and a drain by the write that clears them,
   * which marks every roadmap; a `target-moved` merge by its own not-before time.
   */
  metRetried(roadmapId: string, error: unknown): void {
    if (error instanceof ConcurrentModificationError)
      this.lookAgain(roadmapId, this.now().getTime() + 1000);
    else if (error instanceof RepositoryMutationBusyError) this.waitOnLock(roadmapId, 'lane');
    else if (error instanceof WorktreeMutationBusyError) this.waitOnLock(roadmapId, 'guard');
  }

  /** A roadmap command's hold ends: its roadmap is looked at again (R-B5 part 2). */
  endControl(id: string): void {
    this.controlling.delete(id);
    this.kernel.mark('release', [id]);
  }
}
