import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    return this.begin(timeoutMs, false, log);
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

  /** Watches for a deploy's drain request; stale files from an earlier daemon are removed. */
  startWatching(intervalMs = 1000): void {
    if (this.watcher) return;
    rmSync(join(this.dataDir, DRAIN_REQUEST_FILE), { force: true });
    rmSync(join(this.dataDir, DRAIN_STATUS_FILE), { force: true });
    this.watcher = setInterval(() => this.poll(), intervalMs);
    this.watcher.unref();
  }

  stopWatching(): void {
    clearInterval(this.watcher);
    this.watcher = undefined;
  }

  /** One watcher pass; exposed so tests step it deterministically. */
  poll(): void {
    const path = join(this.dataDir, DRAIN_REQUEST_FILE);
    const request = existsSync(path) ? parseRequest(readFileSync(path, 'utf8')) : undefined;
    if (this.request === undefined) {
      if (request === undefined || this.completion !== undefined) return;
      this.request = request;
      this.writeStatus('draining');
      this.begin(
        request.mode === 'when-idle'
          ? 'until-idle'
          : request.timeoutSeconds === undefined
            ? this.defaultTimeoutMs
            : request.timeoutSeconds * 1000,
        true,
      ).then(
        (interrupted) => this.writeStatus('drained', interrupted),
        (error: unknown) =>
          this.writeStatus('failed', undefined, error instanceof Error ? error.message : 'failed'),
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
    writeFileSync(partial, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    renameSync(partial, path);
  }
}
