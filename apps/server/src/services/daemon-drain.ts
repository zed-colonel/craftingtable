import { randomUUID } from 'node:crypto';
import {
  existsSync,
  type FSWatcher,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { RoadmapService } from './roadmap-service.js';
import type { WorkCycleService } from './work-cycle-service.js';

/**
 * Low-disruption restarts (R-B9). Agents are children of the daemon connected by pipes, so
 * a restarted daemon cannot re-attach to a live run. A drain therefore:
 *
 * 1. stops admissions: roadmaps start no new work and no agent run launches;
 * 2. waits, up to a bound or until idle, for live turns to finish while the controller
 *    keeps supervising and classifying them;
 * 3. stops the controller loops, interrupts what is still live (recorded as
 *    `daemon-drain`), and records a clean stop in the database.
 *
 * The next start consumes that record: running cycles and roadmaps continue and each
 * interrupted step resumes its vendor session. Without it (a crash, or a stop that
 * never finished draining) the operator resumes explicitly, as before.
 *
 * A drain starts on SIGTERM/SIGINT with the configured bound, or when a local deploy
 * writes a request file into the data directory (`pnpm deploy:daemon`). The file channel
 * carries the same authority as a signal: only the daemon's OS user can write there.
 */

export const DRAIN_REQUEST_FILE = 'drain-request.json';
export const DRAIN_STATUS_FILE = 'drain-status.json';

export interface DrainRequest {
  readonly id: string;
  /** `bounded` interrupts after the timeout; `when-idle` waits until nothing is live. */
  readonly mode: 'bounded' | 'when-idle';
  readonly timeoutSeconds?: number;
}

export interface DrainStatus {
  readonly requestId: string;
  readonly state: 'draining' | 'drained' | 'failed';
  readonly busyRuns: number;
  readonly interruptedRuns?: number;
  readonly message?: string;
  readonly updatedAt: string;
}

interface DrainLog {
  info(detail: Readonly<Record<string, unknown>>, message: string): void;
}

const POLL_MS = 250;
/**
 * The watch's fallback poll: inside the deploy's wait for an answer (`DRAIN_ACK_TIMEOUT_MS`,
 * `scripts/deploy-daemon.mjs`), which its test holds.
 */
export const DRAIN_WATCH_FALLBACK_MS = 10_000;

function parseRequest(text: string): DrainRequest | undefined {
  try {
    const value = JSON.parse(text) as Partial<DrainRequest>;
    if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 100)
      return undefined;
    if (value.mode !== 'bounded' && value.mode !== 'when-idle') return undefined;
    if (
      value.timeoutSeconds !== undefined &&
      (!Number.isInteger(value.timeoutSeconds) ||
        value.timeoutSeconds < 0 ||
        value.timeoutSeconds > 3600)
    )
      return undefined;
    return {
      id: value.id,
      mode: value.mode,
      ...(value.timeoutSeconds === undefined ? {} : { timeoutSeconds: value.timeoutSeconds }),
    };
  } catch {
    return undefined;
  }
}

export class DaemonDrain {
  private completion: Promise<number> | undefined;
  /** Epoch ms after which live runs are interrupted; undefined waits until idle. */
  private deadline: number | undefined;
  private cancelled = false;
  /** Only a drain that nothing but a deploy request asked for can be withdrawn. */
  private withdrawable = false;
  private interrupting = false;
  private request: DrainRequest | undefined;
  private watcher: ReturnType<typeof setInterval> | undefined;
  private fileWatch: FSWatcher | undefined;
  /** The data directory watched, by device and inode: one replaced is not the one watched. */
  private watchedDirectory: string | undefined;
  /** When the drain's own loop last looked at the request (monotonic ms). */
  private lookedAt = 0;
  private stranded: { readonly listener: () => void; readonly afterMs: number } | undefined;

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly agentRuns: AgentRunService,
    private readonly workCycles: WorkCycleService,
    private readonly roadmaps: RoadmapService,
    private readonly dataDir: string,
    private readonly defaultTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Drains and records a clean stop; resolves to the number of runs interrupted. Calling
   * it again while a drain runs tightens the bound to the earlier deadline.
   */
  drain(timeoutMs: number | 'until-idle', log?: DrainLog): Promise<number> {
    this.agentRuns.noteServiceStop();
    return this.begin(timeoutMs, false, log);
  }

  /**
   * Called when a deploy's drain finished but no restart followed within `afterMs`: the
   * deploy was interrupted after the drain (Ctrl-C, a closed terminal, a failed switch).
   * The daemon has stopped its loops and admits nothing, so it must restart to resume.
   */
  whenStranded(listener: () => void, afterMs = 120_000): void {
    this.stranded = { listener, afterMs };
  }

  private begin(
    timeoutMs: number | 'until-idle',
    withdrawable: boolean,
    log?: DrainLog,
  ): Promise<number> {
    const deadline = timeoutMs === 'until-idle' ? undefined : this.now().getTime() + timeoutMs;
    if (deadline !== undefined && (this.deadline === undefined || deadline < this.deadline))
      this.deadline = deadline;
    this.withdrawable = withdrawable && (this.completion === undefined || this.withdrawable);
    this.completion ??= this.run(log);
    return this.completion;
  }

  /** A second stop signal: interrupt what is live now instead of waiting. */
  expedite(): void {
    this.deadline = this.now().getTime();
  }

  isDraining(): boolean {
    return this.completion !== undefined;
  }

  /**
   * Watches for a deploy's drain request; stale files from an earlier daemon are removed. The
   * data directory is watched (not its subdirectories, where the database writes), so a request
   * written or withdrawn is seen at once, and polled every `fallbackMs` should a watch event be
   * missed, inside the deploy's 15 s wait for an answer (`deploy-daemon.mjs`), which takes
   * silence for a daemon without drains; a directory that cannot be watched is polled every
   * second, as before (R-B5 decision 22: the poll woke an idle daemon every second).
   */
  startWatching(fallbackMs = DRAIN_WATCH_FALLBACK_MS): void {
    if (this.watcher) return;
    rmSync(join(this.dataDir, DRAIN_REQUEST_FILE), { force: true });
    rmSync(join(this.dataDir, DRAIN_STATUS_FILE), { force: true });
    let interval = fallbackMs;
    try {
      this.watchedDirectory = this.directoryIdentity();
      this.fileWatch = watch(this.dataDir, { persistent: false }, (_event, name) => {
        try {
          // The data directory itself removed or replaced: the watch is lost (Linux reports it
          // as an event, not an error), so the second's poll takes over (increment 13 review
          // LOW-2).
          if (!existsSync(this.dataDir) || this.directoryIdentity() !== this.watchedDirectory)
            this.watchLost();
          else if (name === null || name === DRAIN_REQUEST_FILE) this.poll();
        } catch {
          // The directory could not be looked at, or the look failed: the second's poll repeats
          // it (increment 17 review).
          this.watchLost();
        }
      });
      this.fileWatch.on('error', () => this.watchLost());
    } catch {
      interval = 1000;
    }
    this.watcher = setInterval(() => this.safePoll(), interval);
    this.watcher.unref();
  }

  private directoryIdentity(): string {
    const { dev, ino } = statSync(this.dataDir, { bigint: true });
    return `${dev}:${ino}`;
  }

  /** A look that fails (a status write that could not land) is the next one's to repeat. */
  private safePoll(): void {
    try {
      this.poll();
    } catch {
      // The next look repeats it.
    }
  }

  stopWatching(): void {
    this.fileWatch?.close();
    this.fileWatch = undefined;
    clearInterval(this.watcher);
    this.watcher = undefined;
  }

  /** The watch is gone: polled every second, as before the watch. */
  private watchLost(): void {
    this.fileWatch?.close();
    this.fileWatch = undefined;
    clearInterval(this.watcher);
    this.watcher = setInterval(() => this.safePoll(), 1000);
    this.watcher.unref();
  }

  /** One watcher pass; exposed so tests step it deterministically. */
  poll(): void {
    const path = join(this.dataDir, DRAIN_REQUEST_FILE);
    let text: string | undefined;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      // Absent, or withdrawn between a look and its read: no request. Any other failure is not
      // a withdrawal: the look fails, and the next repeats it (increment 16 review LOW-2).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const request = text === undefined ? undefined : parseRequest(text);
    if (this.request === undefined) {
      if (request === undefined || this.completion !== undefined) return;
      this.request = request;
      try {
        this.writeStatus('draining');
      } catch (error) {
        // Not started: the next look starts it (increment 16 review LOW-3).
        this.request = undefined;
        throw error;
      }
      this.begin(
        request.mode === 'when-idle'
          ? 'until-idle'
          : request.timeoutSeconds === undefined
            ? this.defaultTimeoutMs
            : request.timeoutSeconds * 1000,
        true,
      ).then(
        (interrupted) => {
          // A withdrawn request's drain resolves too, having drained nothing: no restart is due
          // (R-B9 review M-3, 2026-10-13).
          if (this.request !== request) return;
          // A status that cannot be written (a full disk) leaves the deploy without its answer,
          // never the daemon without its process (increment 17 review LOW-6).
          this.tryWriteStatus('drained', interrupted);
          if (this.stranded) setTimeout(this.stranded.listener, this.stranded.afterMs).unref();
        },
        (error: unknown) =>
          this.tryWriteStatus(
            'failed',
            undefined,
            error instanceof Error ? error.message : 'failed',
          ),
      );
      return;
    }
    // Withdrawing the request before anything was interrupted cancels the drain.
    if (request?.id !== this.request.id && !this.interrupting) this.cancelled = true;
    else if (!this.interrupting) this.writeStatus('draining');
  }

  private async run(log?: DrainLog): Promise<number> {
    this.roadmaps.holdAdmissions(true);
    this.agentRuns.beginDrain();
    let reported = -1;
    for (;;) {
      const busy = this.agentRuns.busyRunCount();
      if (busy !== reported) {
        log?.info({ busyRuns: busy }, 'draining: waiting for live agent turns');
        reported = busy;
      }
      if (busy === 0 || (this.deadline !== undefined && this.now().getTime() >= this.deadline))
        break;
      if (this.cancelled && this.withdrawable) {
        this.cancelled = false;
        this.request = undefined;
        this.completion = undefined;
        this.deadline = undefined;
        this.agentRuns.cancelDrain();
        this.roadmaps.holdAdmissions(false);
        rmSync(join(this.dataDir, DRAIN_STATUS_FILE), { force: true });
        log?.info({}, 'drain cancelled; admissions resumed');
        return 0;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      // A deploy's request is looked at again each second while it drains, as the poll did: its
      // status (the live turns) kept current, and a withdrawal seen (increment 13 review LOW-1);
      // a look that fails is the next one's to repeat, never the drain's end (increment 15 review
      // LOW-1).
      if (this.request !== undefined && performance.now() - this.lookedAt >= 1000) {
        this.lookedAt = performance.now();
        this.safePoll();
      }
    }
    this.interrupting = true;
    await this.roadmaps.shutdown();
    await this.workCycles.shutdown();
    const interrupted = await this.agentRuns.interruptForRestart();
    this.storage.transaction((tx) =>
      tx.maintenance.recordCleanStop({
        stoppedAt: this.now().toISOString(),
        interruptedRunCount: interrupted,
      }),
    );
    log?.info({ interruptedRuns: interrupted }, 'drained; the next start resumes automation');
    return interrupted;
  }

  private writeStatus(state: DrainStatus['state'], interrupted?: number, message?: string): void {
    if (this.request === undefined) return;
    const status: DrainStatus = {
      requestId: this.request.id,
      state,
      busyRuns: state === 'draining' ? this.agentRuns.busyRunCount() : 0,
      ...(interrupted === undefined ? {} : { interruptedRuns: interrupted }),
      ...(message === undefined ? {} : { message }),
      updatedAt: this.now().toISOString(),
    };
    const path = join(this.dataDir, DRAIN_STATUS_FILE);
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      writeFileSync(partial, `${JSON.stringify(status)}\n`, { mode: 0o600 });
      renameSync(partial, path);
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
  }

  private tryWriteStatus(
    state: DrainStatus['state'],
    interrupted?: number,
    message?: string,
  ): void {
    try {
      this.writeStatus(state, interrupted, message);
    } catch {
      // The deploy's wait reports it.
    }
  }
}
