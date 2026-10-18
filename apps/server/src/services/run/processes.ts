import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AgentSession,
  parseProcessGroupIdentity,
  type ProcessGroupIdentity,
  type ProcessGroupReaping,
  processGroupIdentity,
  reapProcessGroup,
} from '@craftingtable/agents';
import {
  type AgentRun,
  type AgentRunId,
  isTerminalAgentRunStatus,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { ExecutionConfig } from '../../config.js';
import { AGENTS_ROOT_LOCK_FILE } from '../../instance-lock.js';
import { DRAIN_INTERRUPTED_MESSAGE, type RunLog, SHUTDOWN_GRACE_MS } from './shared.js';

import type { RunState } from './state.js';
import type { RunJournal } from './journal.js';

const RUN_TEMPORARY_NAME_BYTES = 6;

const RUN_TEMPORARY_NAME = new RegExp(`^[0-9a-f]{${RUN_TEMPORARY_NAME_BYTES * 2}}$`);

/** How many of the entries a start's sweep left it names in its one warning. */
const LEFT_ENTRIES_NAMED = 20;

/**
 * A lock socket of the agents' root (R-G5): a daemon's published `<file>.<id>`, or one still
 * being published. The start sweep leaves them unnamed.
 */
function isRootLockSocket(root: string, name: string): boolean {
  if (!name.startsWith(AGENTS_ROOT_LOCK_FILE)) return false;
  try {
    return lstatSync(join(root, name)).isSocket();
  } catch {
    return false;
  }
}

/**
 * Whether `name` beneath `root` is a directory a run made (TS-H3): its name is one
 * `processTemporaryDirectory` gives, and it is a directory itself, never through a link.
 */
function isRunTemporaryDirectory(root: string, name: string): boolean {
  if (!RUN_TEMPORARY_NAME.test(name)) return false;
  try {
    return lstatSync(join(root, name), { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

const PROCESS_IDENTITY_MAX_BYTES = 4096;

/** How long restart recovery lets a surviving group end on SIGTERM before SIGKILL. */
const RECOVERY_TERMINATION_GRACE_MS = 5000;

/**
 * What the daemon records of a run's agent process group (R-G11): who the group is, whose run
 * it is, and which installation wrote it (the database file's device and inode).
 */
interface ProcessRecord extends ProcessGroupIdentity {
  readonly workspaceId: string;
  readonly runId: string;
  readonly installation: { readonly device: string; readonly inode: string };
}

/**
 * A run's process record, or nothing. Never read through a link, never waiting on a pipe put in
 * its place, and at most 4 KiB; anything malformed reads as nothing.
 */
function readProcessRecord(path: string): ProcessRecord | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(descriptor).isFile()) return undefined;
    const buffer = Buffer.alloc(PROCESS_IDENTITY_MAX_BYTES + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length; length += read)
      read = readSync(descriptor, buffer, length, buffer.length - length, length);
    if (length > PROCESS_IDENTITY_MAX_BYTES) return undefined;
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    const identity = parseProcessGroupIdentity(value);
    if (identity === undefined || typeof value !== 'object' || value === null) return undefined;
    const { workspaceId, runId, installation } = value as Record<string, unknown>;
    if (
      typeof workspaceId !== 'string' ||
      workspaceId.length > 200 ||
      typeof runId !== 'string' ||
      typeof installation !== 'object' ||
      installation === null
    )
      return undefined;
    const { device, inode } = installation as Record<string, unknown>;
    if (
      typeof device !== 'string' ||
      !/^\d{1,20}$/.test(device) ||
      typeof inode !== 'string' ||
      !/^\d{1,20}$/.test(inode)
    )
      return undefined;
    return { ...identity, workspaceId, runId, installation: { device, inode } };
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

export class RunProcesses {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly config: ExecutionConfig,
    private readonly log: RunLog,
    private readonly now: () => Date,
    private readonly state: RunState,
    private readonly journal: RunJournal,
  ) {}

  /**
   * A short private directory for the agent process itself, its TMPDIR (LIVE-31): Claude Code's
   * command sandbox makes Unix sockets there, and a socket path holds at most 107 bytes, which
   * the run's scratch path leaves no room for. The run's scratch stays the commands' and
   * builds' place. Removed when the run ends.
   */
  processTemporaryDirectory(runId: AgentRunId): string {
    // A launch of the same run that failed before its record left one: it goes now.
    this.journal.removeProcessTemporaryDirectory(runId);
    const root = this.config.agentTemporaryRoot;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (;;) {
      const directory = join(root, randomBytes(RUN_TEMPORARY_NAME_BYTES).toString('hex'));
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      this.state.processTemporaryDirectories.set(runId, directory);
      return directory;
    }
  }

  /**
   * Records who the run's agent process group is, right after launch (R-G11, AGT-02), so the
   * next daemon can end it if this one stops without draining. The record is the daemon's own
   * (operator decision 2026-10-07): beside the database, which no sandboxed command may read or
   * write (R-G9), replaced whole and never through a link. A launch never fails for want of it.
   */
  recordProcessIdentity(workspaceId: WorkspaceId, runId: AgentRunId, session: AgentSession): void {
    const path = this.processRecordPath(runId);
    const identity = processGroupIdentity(session.pid);
    if (path === undefined || identity === undefined) return;
    // A run already ended while it launched has nothing for a restart to end (R-G11 review).
    const run = this.storage.execution.runs.find(workspaceId, runId);
    if (run === undefined || isTerminalAgentRunStatus(run.status)) return;
    const installation = this.installation();
    if (installation === undefined) return;
    const record: ProcessRecord = { ...identity, workspaceId, runId, installation };
    const temporary = `${path}.${randomBytes(8).toString('hex')}`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      this.log.warn("The agent's process identity could not be recorded", {
        runId,
        error: String(error),
      });
    }
  }

  /**
   * Which installation this daemon is: its database file's device and inode (R-G11 re-check
   * LOW-6). A daemon started on a copy of the data directory has another, so it never takes the
   * original's records for its own.
   */
  installation(): ProcessRecord['installation'] | undefined {
    try {
      // As decimal text from the exact values: a device or inode number may pass 2^53.
      const status = statSync(this.storage.databasePath, { bigint: true });
      return { device: status.dev.toString(), inode: status.ino.toString() };
    } catch {
      return undefined;
    }
  }

  /** Where a run's process record is kept; none without a daemon-private root. */
  processRecordPath(runId: AgentRunId): string | undefined {
    const root = this.config.processRecordRoot;
    return root === undefined ? undefined : join(root, `${runId}.json`);
  }

  /** Each record in the daemon-private root, by run id. */
  processRecords(): [string, string][] {
    const root = this.config.processRecordRoot;
    if (root === undefined) return [];
    try {
      return readdirSync(root).flatMap((name): [string, string][] => {
        const runId = /^([0-9a-f-]{1,64})\.json$/.exec(name)?.[1];
        return runId === undefined ? [] : [[runId, join(root, name)]];
      });
    } catch {
      return [];
    }
  }

  /** Once a run's process group has exited, its record goes: nothing of it is left to end. */
  removeProcessRecord(runId: AgentRunId): void {
    const path = this.processRecordPath(runId);
    if (path === undefined) return;
    try {
      rmSync(path, { force: true });
    } catch (error) {
      this.log.warn("A run's process record could not be removed", {
        runId,
        error: String(error),
      });
    }
  }

  /**
   * Ends what a live run's agent left running when the daemon stopped without draining
   * (R-G11, AGT-02), when its recorded identity proves the group is the run's, and journals it.
   */
  async reapRecordedGroup(
    run: AgentRun,
    record: ProcessRecord,
    graceMs: number,
    installation: ProcessRecord['installation'] | undefined,
  ): Promise<void> {
    const identity: ProcessGroupIdentity = {
      pid: record.pid,
      startTime: record.startTime,
      bootId: record.bootId,
    };
    // Written by another installation, such as the one whose data directory this is a copy of:
    // its agents are not this daemon's to end (R-G11 re-check LOW-6).
    if (
      installation === undefined ||
      record.installation.device !== installation.device ||
      record.installation.inode !== installation.inode
    ) {
      this.journal.appendEvent(run.workspaceId, run.id, {
        kind: 'notice',
        payload: {
          category: 'other',
          message: `On restart, CraftingTable left process group ${identity.pid} alone: its record was written by another installation (a copy of this data directory, or the one it was copied from).`,
        },
      });
      return;
    }
    let reaping: ProcessGroupReaping;
    try {
      reaping = await reapProcessGroup(identity, {
        graceMs,
        notStartedBefore: Date.parse(run.createdAt),
        runId: run.id,
      });
    } catch (error) {
      this.log.warn("A run's surviving process group could not be ended", {
        runId: run.id,
        error: String(error),
      });
      return;
    }
    if (reaping.outcome !== 'terminated' && reaping.outcome !== 'surviving') return;
    this.journal.appendEvent(run.workspaceId, run.id, {
      kind: 'notice',
      payload: {
        category: 'other',
        message:
          reaping.outcome === 'terminated'
            ? `The daemon stopped without ending this run's agent. On restart, CraftingTable ended its process group ${identity.pid}, still running, with ${reaping.signal}.`
            : `The daemon stopped without ending this run's agent. On restart, CraftingTable could not end its process group ${identity.pid}: it still runs after SIGTERM and SIGKILL.`,
      },
    });
    if (reaping.outcome === 'surviving')
      this.log.warn("A run's surviving process group could not be ended", {
        runId: run.id,
        pid: identity.pid,
      });
  }

  /**
   * Marks runs that were live when the daemon last stopped. A process group one of them left
   * running, proved the run's by its recorded identity, is ended first (R-G11, AGT-02).
   */
  async recoverInterrupted(
    options: { readonly terminationGraceMs?: number } = {},
  ): Promise<number> {
    // First what is still running, so nothing writes into what is removed below (R-G11): the
    // group behind every record, whether its run is still live or already ended while its killed
    // agent outlived it (R-G11 re-check LOW-4). Only the daemon's own records: a `process.json`
    // an agent left in its run directory is never read (operator decision 2026-10-07).
    const stale = this.storage.execution.runs.listLive();
    const live = new Map(stale.map((run) => [run.id as string, run]));
    const installation = this.installation();
    const reaping: Promise<void>[] = [];
    for (const [runId, path] of this.processRecords()) {
      const record = readProcessRecord(path);
      if (record === undefined || record.runId !== runId) continue;
      const run =
        live.get(runId) ??
        this.storage.execution.runs.find(record.workspaceId as WorkspaceId, runId as AgentRunId);
      if (run === undefined) continue;
      reaping.push(
        this.reapRecordedGroup(
          run,
          record,
          options.terminationGraceMs ?? RECOVERY_TERMINATION_GRACE_MS,
          installation,
        ),
      );
    }
    await Promise.all(reaping);
    // Their agents' temporary directories went with them (LIVE-31). One that cannot be removed
    // is logged; it never keeps the daemon from starting (LIVE-31 review).
    const root = this.config.agentTemporaryRoot;
    let leftovers: string[] = [];
    try {
      leftovers = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.log.warn("Agents' temporary directories could not be listed", {
          error: String(error),
        });
    }
    // Only what a run made goes: a directory, not a link, named as `processTemporaryDirectory`
    // names one. Anything else stays, so a root set where other files live loses none of them
    // (TS-H3); it is named once.
    const left: string[] = [];
    for (const name of leftovers) {
      if (isRunTemporaryDirectory(root, name)) this.journal.removeAgentDirectory(join(root, name));
      // The root's lock sockets (R-G5), a daemon's own; never a file or directory so named.
      else if (!isRootLockSocket(root, name)) left.push(name);
    }
    if (left.length > 0)
      this.log.warn(
        "Entries in the agents' temporary root that are not run directories were left in place",
        { root, count: left.length, entries: left.sort().slice(0, LEFT_ENTRIES_NAMED) },
      );
    this.storage.transaction((tx) =>
      tx.phaseScheduling.releaseOperations(this.now().toISOString()),
    );
    for (const run of stale) {
      this.journal.finalize(run.workspaceId, run.id, 'interrupted', {
        message: 'The daemon restarted while this run was live',
      });
    }
    // No run is live now: records a stop left behind (a write cut short, say) go too.
    const records = this.config.processRecordRoot;
    if (records !== undefined)
      try {
        for (const name of readdirSync(records))
          if (/^[0-9a-f-]{1,64}\.json(?:\.[0-9a-f]{16})?$/.test(name))
            rmSync(join(records, name), { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          this.log.warn('Process records could not be cleared', { error: String(error) });
      }
    return stale.length;
  }

  /**
   * Ends every live session for a restart and returns how many were interrupted. A
   * controller step waiting between turns has finished its work and ends normally, so
   * the controller classifies its result after the restart; everything else is
   * terminated and recorded as `interrupted` with reason `daemon-drain`.
   */
  async interruptForRestart(): Promise<number> {
    this.state.draining = true;
    this.state.interrupting = true;
    for (const cancel of this.state.pendingCycleLaunches.values()) cancel();
    const checking = [...this.state.checkingLaunches.values()];
    for (const launch of checking) launch.cancel();
    const starting = [...this.state.startingLaunches];
    const liveAtStart = new Set(this.state.live.keys());
    const pending = [...this.state.live.values(), ...this.state.orphaned];
    let interrupted = 0;
    for (const liveRun of this.state.live.values()) {
      const run = this.storage.execution.runs.find(liveRun.workspaceId, liveRun.runId);
      const cycleTurnDone =
        run?.status === 'waiting' &&
        !liveRun.session.backgroundWorkPending &&
        this.storage.execution.cycles.activeForWorktree(run.workspaceId, run.worktreeId)
          ?.currentRunId === run.id;
      if (cycleTurnDone) {
        liveRun.session.end();
        continue;
      }
      liveRun.drainInterrupted = true;
      liveRun.session.kill();
      interrupted++;
    }
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      timer.unref();
    });
    await Promise.race([
      Promise.allSettled([
        ...pending.map((liveRun) => liveRun.done),
        // A review stopped in its checks records its interruption before storage closes.
        ...checking.map((launch) => launch.done),
        // A launch past its drain check reaches its checks (stopped at once) or its session
        // (ended at once).
        ...starting.map((launch) => launch.done),
      ]),
      timeout,
    ]);
    // Every launch the drain found (none can begin a run after it). A review whose checks
    // outlast the grace (a slow clone ignores the abort), or a launch whose session has not
    // come, is recorded as the drain's now, before storage closes; it then starts nothing.
    const launches = new Map<string, { workspaceId: WorkspaceId; runId: AgentRunId }>();
    for (const launch of checking) launches.set(launch.runId, launch);
    for (const { workspaceId, runId } of starting)
      if (workspaceId && runId) launches.set(runId, { workspaceId, runId });
    const status = (launch: { workspaceId: WorkspaceId; runId: AgentRunId }) =>
      this.storage.execution.runs.find(launch.workspaceId, launch.runId)?.status;
    for (const launch of launches.values()) {
      const current = status(launch);
      if (current && !isTerminalAgentRunStatus(current) && !this.state.live.has(launch.runId))
        this.journal.finalize(launch.workspaceId, launch.runId, 'interrupted', {
          reason: 'daemon-drain',
          message: DRAIN_INTERRUPTED_MESSAGE,
        });
    }
    // Only the launches the drain itself stopped, each once: a session already counted above,
    // or a review whose checks failed or that something else ended, is not.
    return (
      interrupted +
      [...launches.values()].filter(
        (launch) => !liveAtStart.has(launch.runId) && status(launch) === 'interrupted',
      ).length
    );
  }
}
