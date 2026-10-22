/**
 * The roadmap scheduler's drain (R-B5 part 2; R-B7): its loop over the kernel's marks, each round
 * (a settling wind-down's resume, a stopped roadmap's adoption and cleared stop, a running
 * roadmap's pass, then the derived attention), the due times and lock waits it keeps, and its
 * start, stop and figures.
 */

import type { RoadmapAttention } from './attention.js';
import type { RoadmapRecoveryRounds } from './recovery.js';
import type { RoadmapHolds } from './holds.js';
import type { RoadmapWriter } from './writer.js';
import type { RoadmapState } from './state.js';
import { SupersededRoadmapOperation, retried, stopAttention, RETRY_SOON_MS } from './shared.js';
import { type RoadmapSettlement, SESSION_WAIT_LIMIT_MS } from '../roadmap-settlement.js';
import type { Marked, MarkCause } from '../kernel/controller-kernel.js';
import { type DrainSummary, drainSummary } from '../kernel/figures.js';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { ExecutionRequestError } from '../errors.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { RoadmapAdmission } from './admission.js';

export class RoadmapDrain {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly settlement: RoadmapSettlement,
    private readonly state: RoadmapState,
    private readonly writer: RoadmapWriter,
    private readonly holds: RoadmapHolds,
    private readonly derivedAttention: RoadmapAttention,
    private readonly recovery: RoadmapRecoveryRounds,
    private readonly admission: RoadmapAdmission,
  ) {}

  startWorker(): void {
    if (this.state.task !== undefined) return;
    // Idle when nothing is marked, no round runs and admissions are not held: a drain holds
    // first pushes back, as its skipped ticks did (part 2 review MEDIUM-5).
    this.state.passes?.register(
      'roadmaps',
      () =>
        !this.state.kernel.pending() &&
        this.state.rounding === undefined &&
        !this.state.admissionsHeld &&
        !this.state.kernel.dueWithin(RETRY_SOON_MS),
    );
    this.state.kernel.start();
    this.state.task = this.loop();
  }

  async shutdown(): Promise<void> {
    this.state.abort.abort();
    this.state.kernel.stop();
    this.state.passes?.unregister('roadmaps');
    await this.state.task;
  }

  /**
   * The scheduler (R-B5 part 2): a round over the roadmaps marked since the last, then a wait for
   * the next mark (a write, a notification, a release, a due time, the sweep). The first round
   * looks at every roadmap, as the loop's first tick did. While admissions are held the marks
   * are taken and dropped, as the ticks were skipped; their release marks every roadmap.
   */
  private async loop(): Promise<void> {
    this.state.kernel.mark('start');
    while (!this.state.abort.signal.aborted) {
      // A tick in flight (a test's) ends first, so its marks are not lost (review LOW-2).
      while (this.state.rounding) await this.state.rounding;
      const marked = this.state.kernel.take();
      if (marked === undefined) {
        await this.state.kernel.marked(this.state.abort.signal);
        continue;
      }
      if (this.state.admissionsHeld) continue;
      await this.round(marked);
      // A macrotask between rounds, as the cycles' (increment 3 review HIGH-1).
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** A restart drain holds admissions: running roadmaps start no new work (R-B9). */
  holdAdmissions(held: boolean): void {
    this.state.admissionsHeld = held;
    if (!held) this.notifier.notify();
  }

  /** Marks every roadmap for the drain's next round (a committed write, a lock's release). */
  wake(cause: MarkCause): void {
    this.state.kernel.mark(cause);
  }

  /**
   * A lock was released, by its key: `lane` (a repository's merge lane), `guard` (the worktree
   * guard), `cycle:<id>` (a cycle's transition, command or investigation), `refresh:<id>` (a
   * cycle's integration refresh). The roadmaps that met that lock busy are marked, once. A
   * release inside the drain's own round marks nothing (part 2 review HIGH-1): a unit that takes
   * and releases a lock and writes nothing would otherwise run again at once, and again; and a
   * release of another lock marks nothing, or two drains could wake each other without end.
   */
  lockReleased(key: string): void {
    // The round in flight's own release; one from a timer or callback that outlived its round is
    // not (increment 9 review LOW-1).
    const own = this.state.ownRound.getStore();
    if (own !== undefined && own === this.state.roundToken) return;
    if (this.state.rounding) this.state.releasedMeanwhile.add(key);
    this.markWaiters(key);
  }

  private markWaiters(key: string): void {
    // A decision preparation held back by this lock may be tried again (review HIGH-2), on this
    // path or the round end's (increment 10 review LOW-1).
    for (const [roadmapId, held] of this.state.preparationsHeld)
      if (held.key === key) this.state.preparationsHeld.delete(roadmapId);
    const waiting = this.state.lockWaiters.get(key);
    if (!waiting) return;
    this.state.lockWaiters.delete(key);
    this.state.kernel.mark('release', [...waiting]);
  }

  /** Serialized tick is also the deterministic integration-test seam: one round over all. */
  async tick(): Promise<void> {
    if (this.state.ticking || this.state.abort.signal.aborted || this.state.admissionsHeld) return;
    await this.round('all');
  }

  private async round(marked: Marked): Promise<void> {
    if (this.state.ticking) return;
    this.state.ticking = true;
    let done: () => void = () => undefined;
    this.state.rounding = new Promise((resolve) => {
      done = resolve;
    });
    try {
      const token = {};
      this.state.roundToken = token;
      await this.state.ownRound.run(token, () => this.roundBody(marked));
    } finally {
      this.state.ticking = false;
      this.state.rounding = undefined;
      this.state.roundToken = undefined;
      done();
    }
  }

  /** The scheduler drain's figures for the owner-only diagnostics (R-B5 part 2). */
  figures(): DrainSummary {
    return drainSummary(
      'roadmaps',
      this.state.rounds,
      this.state.kernel,
      this.state.now().getTime(),
    );
  }

  async roundBody(marked: Marked): Promise<void> {
    this.state.rounds += 1;
    const pass = this.state.passes?.started();
    this.state.passInboxes = new Map();
    this.state.looks.clear();
    this.state.releasedMeanwhile.clear();
    const includes = (id: string) => marked === 'all' || marked.has(id);
    const looked = new Set<string>();
    try {
      // A record still settling is the hold: its settle resumes here, on every pass, and the
      // scheduler does not advance its roadmap (R-B11, ADR-073).
      for (const record of this.storage.windDowns.settling()) {
        if (this.state.abort.signal.aborted || this.state.controlling.has(record.roadmapId))
          continue;
        if (!includes(record.roadmapId)) continue;
        looked.add(record.roadmapId);
        await this.settlement.resume(record).catch(() => undefined);
        // Still settling before its session limit: looked at again when the limit comes (a step
        // waiting for a cancelled session fails then). Past it nothing is asked (`lookAgain`
        // keeps only times ahead): a failed step waits for a mark (increment 9 review HIGH-1).
        if (
          this.storage.windDowns.find(record.workspaceId, record.roadmapId)?.status === 'settling'
        )
          this.state.lookAgain(
            record.roadmapId,
            Date.parse(record.requestedAt) + SESSION_WAIT_LIMIT_MS + 1,
          );
      }
      const held = this.settlement.held();
      const roadmaps = this.storage.roadmaps.list();
      // Due times of roadmaps no longer listed are forgotten.
      if (marked === 'all') this.state.kernel.keepDue(new Set(roadmaps.map((r) => r.id)));
      for (const roadmap of roadmaps) {
        if (this.state.abort.signal.aborted) break;
        if (!includes(roadmap.id)) continue;
        looked.add(roadmap.id);
        if (this.state.controlling.has(roadmap.id) || held.has(roadmap.id)) continue;
        // A paused roadmap adopts open repairs too; its pause holds their controller reviews.
        if (['paused', 'needs-attention'].includes(roadmap.status)) {
          try {
            this.recovery.adoptManualRepairs(roadmap);
          } catch {
            // Adoption is retried on the next pass.
          }
          // A stop whose typed fact cleared resumes by itself; a pause never does (decision 2).
          await this.holds
            .resumeCleared(this.writer.find(roadmap.workspaceId, roadmap.id))
            .catch(() => undefined);
          continue;
        }
        if (roadmap.status !== 'running') continue;
        try {
          await this.admission.advance(this.recovery.adoptManualRepairs(roadmap));
          this.state.observer?.passEnded(roadmap.id);
        } catch (error) {
          this.state.observer?.passEnded(roadmap.id, error);
          if (retried(error)) this.state.metRetried(roadmap.id, error);
          if (error instanceof SupersededRoadmapOperation || retried(error)) continue;
          const current = this.writer.find(roadmap.workspaceId, roadmap.id);
          if (current.status === 'running')
            this.writer.change(current, {
              status: 'needs-attention',
              attention: stopAttention(error),
              reason:
                error instanceof ExecutionRequestError
                  ? error.message
                  : 'Scheduler could not advance. Inspect the current item before resuming.',
            });
        }
      }
      try {
        this.derivedAttention.syncAttention();
      } catch {
        /* The next pass re-derives the set; delivery reads whatever is stored meanwhile. */
      }
    } finally {
      this.state.passInboxes = undefined;
      // Each roadmap looked at keeps only the due time this round asked for, strictly ahead of
      // now (part 1's rule, review MEDIUM-4); one already come marks it once more.
      const now = this.state.now().getTime();
      for (const id of looked) {
        const at = this.state.looks.get(id);
        if (at !== undefined && at <= now) {
          this.state.kernel.dueAt(id, undefined);
          this.state.kernel.mark('due', [id]);
        } else this.state.kernel.dueAt(id, at);
      }
      // A lock released by something else while this round ran: a roadmap that met it busy after
      // that release is looked at again (review LOW-2).
      for (const key of this.state.releasedMeanwhile) this.markWaiters(key);
      if (pass !== undefined) this.state.passes?.completed('roadmaps', pass);
    }
  }
}
