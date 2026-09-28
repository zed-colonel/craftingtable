import { createHash } from 'node:crypto';
import { type FSWatcher, lstatSync, readFileSync, realpathSync, watch } from 'node:fs';
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
  readonly runDirectory: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
}

interface InFlight {
  readonly tool: CheckRequest['tool'];
  readonly controller: AbortController;
  readonly reply: CheckReply;
  readonly done: Promise<void>;
}

interface ServedRun {
  readonly context: CheckRunContext;
  readonly watcher: FSWatcher | undefined;
  readonly timer: ReturnType<typeof setInterval>;
  readonly inFlight: Map<string, InFlight>;
}

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
  private closed = false;
  /** Units are named per data directory, so a second daemon on the host never stops ours. */
  private readonly unitPrefix: string;

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly config: {
      readonly checkConfinement: CheckConfinement;
      readonly checkLogRoot: string;
    },
    private readonly log: {
      warn(message: string, fields?: Record<string, unknown>): void;
    },
    private readonly pollMs = 500,
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
    this.runs.set(context.runId, { context, watcher, timer, inFlight: new Map() });
    this.serve(context.runId);
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
    const spool = run.context.spoolDirectory;
    try {
      if (lstatSync(spool).isDirectory() && realpathSync(spool) === resolve(spool))
        for (const id of pendingCheckRequests(spool))
          if (claimCheckRequest(spool, id))
            new CheckReply(spool, id).finish(1, 'This run has ended; the check did not run.');
    } catch {
      /* the run directory is gone */
    }
    await Promise.allSettled([...run.inFlight.values()].map((c) => c.done));
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.runs.keys()].map((runId) => this.close(runId)));
  }

  private serve(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const spool = run.context.spoolDirectory;
    for (const check of run.inFlight.values())
      if (check.reply.cancelRequested()) check.controller.abort();
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
      const reply = new CheckReply(spool, id);
      if ('refused' in claimed) {
        reply.finish(2, claimed.refused);
        continue;
      }
      const refusal = this.refusal(run.context, claimed.request, run.inFlight);
      if (refusal) {
        reply.finish(2, refusal);
        continue;
      }
      const controller = new AbortController();
      const done = this.run(run, id, claimed.request, reply, controller.signal).finally(() =>
        run.inFlight.delete(id),
      );
      run.inFlight.set(id, { tool: claimed.request.tool, controller, reply, done });
    }
  }

  /** Why a request cannot run now, or undefined when it can. */
  private refusal(
    context: CheckRunContext,
    request: CheckRequest,
    inFlight: ReadonlyMap<string, InFlight>,
  ): string | undefined {
    if (request.tool !== 'ct-check' && request.tool !== 'ct-act')
      return `${request.tool} is not served by the daemon for this run.`;
    if (request.tool === 'ct-act' && [...inFlight.values()].some((c) => c.tool === 'ct-act'))
      return 'Another ct-act is already running for this run; run one workflow at a time.';
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
    reply: CheckReply,
    signal: AbortSignal,
  ): Promise<void> {
    const { context } = served;
    let manifest: PinnedCargoManifest;
    try {
      manifest = JSON.parse(readFileSync(context.manifestPath, 'utf8')) as PinnedCargoManifest;
    } catch {
      reply.finish(2, 'The run’s verification manifest is unavailable.');
      return;
    }
    const cargoHome = process.env.CARGO_HOME ?? join(process.env.HOME ?? '', '.cargo');
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
      ...allowlistedEnvironment(process.env, ['CARGO_HOME', 'RUSTUP_HOME']),
      PATH: `${join(dirname(context.manifestPath), 'bin')}:${process.env.PATH ?? '/usr/bin'}`,
      TMPDIR: join(context.runDirectory, 'scratch'),
      CARGO_TARGET_DIR: manifest.targetDirectory,
      CRAFTINGTABLE_RUN_NAMESPACE: context.runId,
    };
    try {
      const outcome = await executeCheck({
        tool: request.tool === 'ct-act' ? 'ct-act' : 'ct-check',
        privateDirectory: join(this.config.checkLogRoot, context.runId, `${id}.private`),
        holdWorkflow: (key, deadline, abort, onWait) =>
          this.workflows.hold(key, context.runId, deadline, abort, onWait),
        manifestPath: context.manifestPath,
        manifestDigest: context.manifestDigest,
        args: request.args,
        logPath: join(this.config.checkLogRoot, context.runId, `${id}.log`),
        logReference: `check-logs/${context.runId}/${id}.log`,
        confinement: this.config.checkConfinement,
        unitName: `${this.unitPrefix}${id}`,
        writablePaths: writable,
        environment,
        onOutput: (text) => reply.write(text),
        signal,
      });
      const recorded = this.record(context, outcome.receipt);
      reply.finish(
        recorded ? outcome.exitCode : 1,
        recorded
          ? outcome.diagnostic
          : 'The run ended before this check finished; nothing was recorded.',
      );
    } catch (error) {
      this.log.warn('Check failed to run', { runId: context.runId, error: String(error) });
      reply.finish(1, 'CraftingTable could not run this check.');
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
