import { createHash, randomUUID } from 'node:crypto';
import { type FSWatcher, lstatSync, readdirSync, realpathSync, rmSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  allowlistedEnvironment,
  type CheckConfinement,
  CheckReply,
  type CheckRequest,
  claimCheckRequest,
  executeCheck,
  type PinnedCargoManifest,
  pendingCheckRequests,
  stopCheckUnits,
} from '@craftingtable/agents';
import { isTerminalAgentRunStatus, type WorkspaceId } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { CrateChecksumAuthority } from './crate-checksums.js';

/**
 * One act run per workflow and Docker host at a time (LIVE-03). act names its containers after
 * the workflow, so two runs of one workflow remove each other's. Waiters are served in order;
 * one that gives up (its deadline passed, or it was cancelled) keeps its place in the chain, so
 * no one behind it starts before the holder ahead of it has finished.
 */
export class WorkflowQueue {
  private readonly tails = new Map<string, { readonly done: Promise<void>; holder: string }>();

  async hold(
    key: string,
    holder: string,
    deadline: number,
    signal: AbortSignal,
    onWait: (holder: string) => void,
  ): Promise<() => void> {
    const previous = this.tails.get(key);
    let release!: () => void;
    const mine = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const done = (previous?.done ?? Promise.resolve()).then(() => mine);
    const tail = { done, holder };
    this.tails.set(key, tail);
    void done.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    if (previous) {
      onWait(previous.holder);
      try {
        await new Promise<void>((resolveWait, reject) => {
          const giveUp = (reason: string) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', aborted);
            reject(new Error(reason));
          };
          const aborted = () => giveUp("Interrupted while waiting for this workflow's local CI.");
          const timer = setTimeout(
            () =>
              giveUp(
                `Another run (${previous.holder}) held this workflow's local CI past the check time limit.`,
              ),
            Math.max(0, deadline - Date.now()),
          );
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
          void previous.done.then(() => {
            clearTimeout(timer);
            signal.removeEventListener('abort', aborted);
            resolveWait();
          });
        });
      } catch (error) {
        release();
        throw error;
      }
    }
    return release;
  }
}

/** One run whose check launchers the daemon serves. */
export interface CheckRunContext {
  readonly workspaceId: WorkspaceId;
  readonly runId: string;
  readonly spoolDirectory: string;
  /** The daemon's own directory for answers, outside every writable root of the run. */
  readonly replyDirectory: string;
  readonly runDirectory: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  /** The manifest as the daemon wrote it; the published copy is never read back. */
  readonly manifest: string;
}

/** Where a check's answer goes: the run's spool, or the daemon itself for checks it starts. */
type Reply = Pick<CheckReply, 'write' | 'finish' | 'cancelRequested'>;

/** Who asked for a check, recorded on its receipt (R-G13 increment 3). */
export type CheckOrigin = 'agent' | 'daemon';

/** A check the daemon ran for a review before the reviewer started (R-G13 increment 3). */
export interface DeclaredCheckResult {
  readonly checkId: string;
  readonly exitCode: number;
  readonly diagnostic: string;
  /** The check's log, where the daemon keeps it. */
  readonly logPath: string;
}

interface InFlight {
  readonly tool: CheckRequest['tool'];
  readonly controller: AbortController;
  readonly reply: Reply;
  readonly done: Promise<void>;
}

interface Waiting {
  readonly id: string;
  readonly request: CheckRequest;
  readonly reply: Reply;
  readonly origin: CheckOrigin;
}

interface ServedRun {
  readonly context: CheckRunContext;
  readonly watcher: FSWatcher | undefined;
  readonly timer: ReturnType<typeof setInterval>;
  readonly inFlight: Map<string, InFlight>;
  /** Claimed requests waiting for a slot, oldest first. */
  readonly waiting: Waiting[];
  /** Bytes of check log this run may still keep. */
  logBudget: number;
  /** Cargo home slots in use: one stable path per concurrent check (R-G13 review). */
  readonly cargoSlots: Set<number>;
}

/**
 * Every root agents write, of any run (R-G13 review): the data directory, the run and worktree
 * roots (which may lie elsewhere), and the shared Cargo home. A declared check's unit sees none of
 * them; its own paths are bound back.
 */
export function checkHiddenRoots(config: {
  readonly checkLogRoot: string;
  readonly runsRoot: string;
  readonly worktreeRoot: string;
  readonly cargoHome: string;
}): string[] {
  return [
    ...new Set([
      dirname(config.checkLogRoot),
      config.runsRoot,
      config.worktreeRoot,
      config.cargoHome,
    ]),
  ];
}

/**
 * Bounds on the checks the daemon runs for agents (R-G4 review): running at once per run and
 * in the daemon, waiting per run, and retained log per run and per check.
 */
export const CHECK_LIMITS = {
  runningPerRun: 4,
  runningInDaemon: 8,
  waitingPerRun: 32,
  logBytesPerRun: 256 * 1024 * 1024,
  logBytesPerCheck: 2 * 1024 * 1024,
} as const;

/**
 * Runs the checks agents ask for and records their receipts (R-G4, SEC-01, ADR-053).
 *
 * A run's `ct-check` leaves a request in its spool. The daemon runs the command itself, confined
 * to the run's worktree and directories, observes the commit and cleanliness before and after,
 * keeps the log where the agent cannot write, and records the receipt in the database while the
 * run is live. The run's build record is frozen from those rows, so a line an agent appends to
 * a file can no longer satisfy a gate.
 */
export class CheckRequestService {
  private readonly runs = new Map<string, ServedRun>();
  private readonly workflows = new WorkflowQueue();
  /** Runs still stopping their checks (`close`), which `closeAll` waits for. */
  private readonly closing = new Set<Promise<unknown>>();
  private closed = false;
  /** Units are named per data directory, so a second daemon on the host never stops ours. */
  private readonly unitPrefix: string;

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly config: {
      readonly checkConfinement: CheckConfinement;
      readonly checkLogRoot: string;
      readonly cargoHome: string;
      readonly runsRoot: string;
      readonly worktreeRoot: string;
    },
    private readonly log: {
      warn(message: string, fields?: Record<string, unknown>): void;
    },
    private readonly pollMs = 500,
    private readonly limits: typeof CHECK_LIMITS = CHECK_LIMITS,
    /** Published crate checksums; without it no registry crate reaches a check (R-G13 review). */
    private readonly checksums?: CrateChecksumAuthority,
  ) {
    const instance = createHash('sha256').update(config.checkLogRoot).digest('hex').slice(0, 12);
    this.unitPrefix = `craftingtable-check-${instance}-`;
  }

  /**
   * Stops check units a previous daemon left running. Their runs ended with that daemon, so
   * nothing records their results.
   */
  stopLeftoverUnits(): void {
    if (this.config.checkConfinement === 'systemd') stopCheckUnits(this.unitPrefix);
    // Their clones and build outputs too, which only a clean close removes.
    try {
      for (const runId of readdirSync(this.config.checkLogRoot)) this.removeScratch(runId);
    } catch {
      /* no checks have run */
    }
  }

  /** Removes a run's declared-check clones and build outputs; its logs stay. */
  private removeScratch(runId: string): void {
    const logs = join(this.config.checkLogRoot, runId);
    try {
      for (const name of readdirSync(logs))
        if (
          name === 'declared-target' ||
          name.endsWith('.private') ||
          name.startsWith('cargo-home-')
        )
          rmSync(join(logs, name), { recursive: true, force: true });
    } catch {
      /* not a directory, or no checks ran */
    }
  }

  /** Starts serving a run's spool. Call before the agent can run its launchers. */
  open(context: CheckRunContext): void {
    if (this.closed || this.runs.has(context.runId)) return;
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(context.spoolDirectory, () => this.serve(context.runId));
      watcher.on('error', () => undefined);
    } catch {
      // Polling below still serves the spool.
    }
    const timer = setInterval(() => this.serve(context.runId), this.pollMs);
    timer.unref();
    this.runs.set(context.runId, {
      context,
      watcher,
      timer,
      inFlight: new Map(),
      waiting: [],
      logBudget: this.limits.logBytesPerRun,
      cargoSlots: new Set(),
    });
    this.serve(context.runId);
  }

  /**
   * Runs each adopted check of a review itself, on the reviewed commit, before the reviewer
   * starts (R-G13 increment 3, LIVE-23), within the run's and the daemon's bounds. Their
   * receipts are the run's, marked `origin: 'daemon'`. Resolves when every check has finished.
   */
  async runDeclared(runId: string, checkIds: readonly string[]): Promise<DeclaredCheckResult[]> {
    const served = this.runs.get(runId);
    if (!served) return [];
    const results = checkIds.map(
      (checkId) =>
        new Promise<DeclaredCheckResult>((resolveResult) => {
          const id = `daemon-${randomUUID()}`;
          const request: CheckRequest = {
            version: 1,
            tool: 'ct-check',
            args: ['--declared', checkId],
          };
          const logPath = join(this.config.checkLogRoot, runId, `${id}.log`);
          const reply: Reply = {
            write: () => undefined,
            cancelRequested: () => false,
            finish: (exitCode: number, diagnostic: string) =>
              resolveResult({ checkId, exitCode, diagnostic, logPath }),
          };
          const refusal = this.refusal(served, request);
          if (refusal) reply.finish(2, refusal);
          else served.waiting.push({ id, request, reply, origin: 'daemon' });
        }),
    );
    this.pump();
    return Promise.all(results);
  }

  /** Checks still running for a run. */
  inFlight(runId: string): readonly CheckRequest['tool'][] {
    return [...(this.runs.get(runId)?.inFlight.values() ?? [])].map((c) => c.tool);
  }

  /**
   * Stops serving a run: its running checks are stopped and record nothing, because the run's
   * build record was frozen when it ended.
   */
  async close(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    clearInterval(run.timer);
    run.watcher?.close();
    for (const check of run.inFlight.values()) check.controller.abort();
    // Requests left after the run ended get an answer, so their launchers do not wait.
    for (const waiting of run.waiting.splice(0))
      waiting.reply.finish(1, 'This run has ended; the check did not run.');
    const spool = run.context.spoolDirectory;
    try {
      if (lstatSync(spool).isDirectory() && realpathSync(spool) === resolve(spool))
        for (const id of pendingCheckRequests(spool))
          if (claimCheckRequest(spool, id))
            new CheckReply(spool, run.context.replyDirectory, id).finish(
              1,
              'This run has ended; the check did not run.',
            );
    } catch {
      /* the run directory is gone */
    }
    const stopped = Promise.allSettled([...run.inFlight.values()].map((c) => c.done));
    this.closing.add(stopped);
    try {
      await stopped;
    } finally {
      this.closing.delete(stopped);
    }
    // Declared checks' clones and build outputs are the daemon's scratch; only logs are kept.
    this.removeScratch(runId);
    this.pump();
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.runs.keys()].map((runId) => this.close(runId)));
    // Runs that ended just before are still stopping their checks, which write their logs as
    // they stop: the daemon is closed only once they have.
    await Promise.allSettled([...this.closing]);
  }

  private serve(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const spool = run.context.spoolDirectory;
    for (const check of run.inFlight.values())
      if (check.reply.cancelRequested()) check.controller.abort();
    for (const waiting of [...run.waiting])
      if (waiting.reply.cancelRequested()) {
        run.waiting.splice(run.waiting.indexOf(waiting), 1);
        waiting.reply.finish(1, 'The check was cancelled before it started.');
      }
    // The agent owns the directory above the spool; refuse a spool it replaced with a link.
    try {
      if (!lstatSync(spool).isDirectory() || realpathSync(spool) !== resolve(spool)) return;
    } catch {
      return;
    }
    for (const id of pendingCheckRequests(spool)) {
      if (!this.runs.has(runId)) return;
      const claimed = claimCheckRequest(spool, id);
      if (!claimed) continue;
      const reply = new CheckReply(spool, run.context.replyDirectory, id);
      if ('refused' in claimed) {
        reply.finish(2, claimed.refused);
        continue;
      }
      const refusal = this.refusal(run, claimed.request);
      if (refusal) {
        reply.finish(2, refusal);
        continue;
      }
      run.waiting.push({ id, request: claimed.request, reply, origin: 'agent' });
      // Start what may run now, so only checks that truly wait count against the bound.
      this.pump();
    }
  }

  /** Starts waiting checks, oldest first, within the per-run and daemon bounds. */
  private pump(): void {
    let running = [...this.runs.values()].reduce((n, r) => n + r.inFlight.size, 0);
    for (const run of this.runs.values())
      while (
        run.waiting.length &&
        run.inFlight.size < this.limits.runningPerRun &&
        running < this.limits.runningInDaemon
      ) {
        const { id, request, reply, origin } = run.waiting.shift()!;
        const controller = new AbortController();
        const done = this.run(run, id, request, reply, controller.signal, origin).finally(() => {
          run.inFlight.delete(id);
          this.pump();
        });
        run.inFlight.set(id, { tool: request.tool, controller, reply, done });
        running += 1;
      }
  }

  /** Why a request cannot run now, or undefined when it can. */
  private refusal(run: ServedRun, request: CheckRequest): string | undefined {
    const { context } = run;
    const tools = [...run.inFlight.values(), ...run.waiting].map((c) =>
      'tool' in c ? c.tool : c.request.tool,
    );
    // One act and one native unit per run, as the per-run leases allowed before.
    if ((request.tool === 'ct-act' || request.tool === 'ct-native') && tools.includes(request.tool))
      return `Another ${request.tool} is already running for this run; run one at a time.`;
    if (run.waiting.length >= this.limits.waitingPerRun)
      return 'Too many checks are waiting for this run; wait for some to finish.';
    const agentRun = this.storage.execution.runs.find(
      context.workspaceId,
      context.runId as import('@craftingtable/domain').AgentRunId,
    );
    if (!agentRun || isTerminalAgentRunStatus(agentRun.status))
      return 'This run has ended; its checks are no longer recorded.';
    const environment = this.storage.runtimeEvidence.run(context.workspaceId, context.runId);
    if (
      environment?.receiptAuthority !== 'daemon' ||
      environment.manifestDigest !== context.manifestDigest
    )
      return 'This run has no daemon-recorded verification environment.';
    return undefined;
  }

  private async run(
    served: ServedRun,
    id: string,
    request: CheckRequest,
    reply: Reply,
    signal: AbortSignal,
    origin: CheckOrigin,
  ): Promise<void> {
    const { context } = served;
    const manifest = JSON.parse(context.manifest) as PinnedCargoManifest;
    // The daemon's Cargo home, never the operator's (R-G5 review): the unit may write its
    // download caches, and whatever a check plants there stays out of the operator's builds.
    const cargoHome = this.config.cargoHome;
    const writable = [
      manifest.workspacePath,
      context.runDirectory,
      join(cargoHome, 'registry'),
      join(cargoHome, 'git'),
    ].map((p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    });
    const environment = {
      ...allowlistedEnvironment(process.env, ['RUSTUP_HOME']),
      CARGO_HOME: cargoHome,
      PATH: `${join(dirname(context.manifestPath), 'bin')}:${process.env.PATH ?? '/usr/bin'}`,
      TMPDIR: join(context.runDirectory, 'scratch'),
      CARGO_TARGET_DIR: manifest.targetDirectory,
      CRAFTINGTABLE_RUN_NAMESPACE: context.runId,
    };
    let slot = 0;
    while (served.cargoSlots.has(slot)) slot++;
    served.cargoSlots.add(slot);
    try {
      const outcome = await executeCheck({
        tool: request.tool,
        // Named by the daemon, not by the request: two requests with one id never share it.
        privateDirectory: join(this.config.checkLogRoot, context.runId, `${randomUUID()}.private`),
        holdWorkflow: (key, deadline, abort, onWait) =>
          this.workflows.hold(key, context.runId, deadline, abort, onWait),
        manifestPath: context.manifestPath,
        manifestDigest: context.manifestDigest,
        manifest: context.manifest,
        args: request.args,
        logPath: join(this.config.checkLogRoot, context.runId, `${id}.log`),
        logReference: `check-logs/${context.runId}/${id}.log`,
        confinement: this.config.checkConfinement,
        unitName: `${this.unitPrefix}${id}`,
        writablePaths: writable,
        environment,
        onOutput: (text) => reply.write(text),
        signal,
        logLimitBytes: Math.min(this.limits.logBytesPerCheck, served.logBudget),
        declaredTargetDirectory: join(this.config.checkLogRoot, context.runId, 'declared-target'),
        ...(this.checksums ? { crateRegistry: this.checksums } : {}),
        cargoHomeDirectory: join(this.config.checkLogRoot, context.runId, `cargo-home-${slot}`),
        hiddenRoots: checkHiddenRoots(this.config),
      });
      served.logBudget = Math.max(0, served.logBudget - outcome.logBytes);
      const recorded = this.record(context, { ...outcome.receipt, origin });
      reply.finish(
        recorded ? outcome.exitCode : 1,
        recorded
          ? outcome.diagnostic
          : 'The run ended before this check finished; nothing was recorded.',
      );
    } catch (error) {
      this.log.warn('Check failed to run', { runId: context.runId, error: String(error) });
      reply.finish(1, 'CraftingTable could not run this check.');
    } finally {
      served.cargoSlots.delete(slot);
    }
  }

  /** Records a finished check's receipt while its run is still live and unfrozen. */
  private record(context: CheckRunContext, receipt: Record<string, unknown>): boolean {
    return this.storage.transaction((tx) => {
      const agentRun = tx.execution.runs.find(
        context.workspaceId,
        context.runId as import('@craftingtable/domain').AgentRunId,
      );
      if (
        !agentRun ||
        isTerminalAgentRunStatus(agentRun.status) ||
        tx.runtimeEvidence.build(context.workspaceId, context.runId)
      )
        return false;
      tx.runtimeEvidence.addCheckReceipt({
        runId: context.runId,
        workspaceId: context.workspaceId,
        sequence: tx.runtimeEvidence.checkReceipts(context.workspaceId, context.runId).length + 1,
        receipt: JSON.stringify(receipt),
        recordedAt: new Date().toISOString(),
      });
      return true;
    });
  }
}
