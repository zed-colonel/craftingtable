import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Process authority shared by every agent backend.
 *
 * The only place in the agents package that spawns. The executable is an
 * absolute path resolved by the daemon; arguments are an array; the child is
 * detached so the whole process group can be terminated; stdin stays open for
 * follow-up messages until `end()`.
 */

export interface SupervisedProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly terminationGraceMs: number;
  /** Longest single stdout line accepted before it is dropped with a marker. */
  readonly maxLineBytes: number;
  /**
   * When the step's time runs out, in epoch milliseconds: the session stays reserved while its
   * process group drains after the agent exits, until then. A launch refuses one that is not a
   * finite time, which would never expire (AGT-16).
   */
  readonly backgroundWorkDeadlineAt?: number;
  /** Standalone drain allowance measured from the agent exit, not launch. */
  readonly backgroundWorkTimeoutMs?: number;
  /** After this long without stderr, a `stderr-quiet` item says a partial batch may go out. */
  readonly stderrQuietMs?: number;
}

export type SupervisedProcessItem =
  | { readonly type: 'stdout-line'; readonly line: string }
  | { readonly type: 'stdout-overflow'; readonly bytes: number }
  | { readonly type: 'stderr'; readonly text: string }
  | { readonly type: 'stderr-quiet' }
  | { readonly type: 'background-work-waiting' }
  | {
      readonly type: 'exited';
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly backgroundWorkIncomplete?: boolean;
      readonly backgroundWorkTimedOut?: boolean;
    };

export interface SupervisedProcess {
  readonly pid: number | undefined;
  readonly items: AsyncIterable<SupervisedProcessItem>;
  write(data: string): boolean;
  endInput(): void;
  terminate(): void;
}

/**
 * Buffered items, or bytes, above which the child's output (stdout and stderr) is paused until
 * the consumer has taken them all: lines may be megabytes long, so the count alone does not
 * bound memory (R-G11 independent review).
 */
export const OUTPUT_HIGH_WATER_ITEMS = 1000;
export const OUTPUT_HIGH_WATER_BYTES = 16 * 1024 * 1024;

/**
 * Minimal async queue: producers push, one consumer iterates. Closing the
 * queue after the final item lets `for await` complete naturally. `onDrained`
 * runs whenever the consumer takes the last buffered item, so a producer that
 * paused at a high-water mark can resume.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: { readonly item: T; readonly weight: number }[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | undefined;
  private closed = false;
  private weight = 0;

  constructor(private readonly onDrained?: () => void) {}

  /** Items pushed and not yet taken by the consumer. */
  get size(): number {
    return this.buffered.length;
  }

  /** Whether what waits for the consumer has reached either high-water mark. */
  get full(): boolean {
    return (
      this.buffered.length >= OUTPUT_HIGH_WATER_ITEMS || this.weight >= OUTPUT_HIGH_WATER_BYTES
    );
  }

  /** `weight` is the item's size in bytes, as near as the producer knows it. */
  push(item: T, weight = 0): void {
    if (this.closed) return;
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: item, done: false });
      return;
    }
    this.buffered.push({ item, weight });
    this.weight += weight;
  }

  close(): void {
    this.closed = true;
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const entry = this.buffered.shift();
        if (entry !== undefined) {
          this.weight -= entry.weight;
          if (this.buffered.length === 0) this.onDrained?.();
          return Promise.resolve({ value: entry.item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** What `/proc/<pid>/stat` says of a process: its state, parent, group and start time. */
function procStat(
  pid: number | string,
): { state: string; ppid: number; pgrp: number; session: number; startTime: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is in parentheses and may hold spaces; fields resume after the last one.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = fields[19] ?? '';
    if (!/^\d+$/.test(startTime)) return undefined;
    return {
      state: fields[0] ?? '',
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      session: Number(fields[3]),
      // Field 22: clock ticks after boot. With the boot id, it names one process for good.
      startTime,
    };
  } catch (error) {
    // A process may exit between enumeration and read. Other errors fail closed.
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

/**
 * Linux zombies no longer execute work, but still make kill(-pgid, 0) succeed. The leader is
 * left out unless asked for: a session's own leader is known to have exited by then.
 */
function hasGroupWork(pid: number | undefined, includeLeader = false): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (process.platform !== 'linux') return true;
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || (!includeLeader && Number(entry) === pid)) continue;
      const stat = procStat(entry);
      if (stat?.pgrp === pid && !['Z', 'X'].includes(stat.state)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** The running (not zombie) members of a process group, with their sessions and start times. */
function groupMembers(
  pgid: number,
): { readonly pid: number; readonly session: number; readonly startTime: string }[] {
  const members: { pid: number; session: number; startTime: string }[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = procStat(entry);
    if (stat?.pgrp === pgid && !['Z', 'X'].includes(stat.state))
      members.push({ pid: Number(entry), session: stat.session, startTime: stat.startTime });
  }
  return members;
}

/**
 * The variable that marks every process of a run with its id (operator decision 2026-10-07):
 * the launch environment carries it, and whatever the agent starts inherits it.
 */
export const RUN_ID_VARIABLE = 'CRAFTINGTABLE_RUN_ID';

/** Whether a process's environment carries the run's marker; undefined when unreadable. */
function carriesRunMarker(pid: number, runId: string): boolean | undefined {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'latin1')
      .split('\0')
      .includes(`${RUN_ID_VARIABLE}=${runId}`);
  } catch {
    return undefined;
  }
}

function currentBootId(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who an agent's process group is, recorded so a later daemon can tell it from whatever
 * reuses its pid (R-G11, AGT-02): the group leader's pid, its start time (`/proc/<pid>/stat`
 * field 22) and the boot it started in.
 */
export interface ProcessGroupIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly bootId: string;
}

/**
 * The identity of a process group this daemon started: `pid` must be its own child and lead
 * its own group. Anything else, or a host without `/proc`, has none, so a stand-in pid can
 * never be recorded for a later daemon to signal.
 */
export function processGroupIdentity(pid: number | undefined): ProcessGroupIdentity | undefined {
  if (pid === undefined || process.platform !== 'linux') return undefined;
  try {
    const stat = procStat(pid);
    const bootId = currentBootId();
    if (!stat || !bootId || stat.ppid !== process.pid || stat.pgrp !== pid) return undefined;
    return { pid, startTime: stat.startTime, bootId };
  } catch {
    return undefined;
  }
}

/** A recorded identity read back from disk, where anything may have been written. */
export function parseProcessGroupIdentity(value: unknown): ProcessGroupIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { pid, startTime, bootId } = value as Record<string, unknown>;
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    typeof startTime !== 'string' ||
    !/^\d{1,20}$/.test(startTime) ||
    typeof bootId !== 'string' ||
    !/^[0-9a-f-]{1,64}$/.test(bootId)
  )
    return undefined;
  return { pid, startTime, bootId };
}

/** What restart recovery did with a recorded process group. */
export type ProcessGroupReaping =
  /** No process has the recorded pid any longer. */
  | { readonly outcome: 'gone' }
  /** The pid now names another process (another start time, boot or group): left alone. */
  | { readonly outcome: 'other-process' }
  /** Nothing here can prove whose the pid is (no `/proc`): left alone. */
  | { readonly outcome: 'unverifiable' }
  /** The recorded group was still running and was ended by this signal. */
  | { readonly outcome: 'terminated'; readonly signal: 'SIGTERM' | 'SIGKILL' }
  /** The recorded group was still running and still is, after SIGTERM and SIGKILL. */
  | { readonly outcome: 'surviving' };

const REAP_POLL_MS = 50;
/** Linux reports start times to user space in USER_HZ ticks, 100 a second. */
const USER_HZ = 100;
/** Boot time is whole seconds and start times are ticks: allow for both, and clock drift. */
const START_TIME_SLACK_MS = 3000;

/** When a process started, in epoch milliseconds, from its start time and the boot time. */
function startedAtMs(startTime: string): number | undefined {
  try {
    const boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1];
    return boot === undefined
      ? undefined
      : Number(boot) * 1000 + (Number(startTime) * 1000) / USER_HZ;
  } catch {
    return undefined;
  }
}

/**
 * Ends a process group an earlier daemon started (R-G11, AGT-02): SIGTERM, then SIGKILL once
 * the grace period has passed with members still running. Only a group proved the run's is
 * signalled, never this daemon's own: its leader still the recorded process (same boot, same
 * start time, still leading its group), or, once the leader has exited, every member in the
 * leader's session, started after the run and the leader on the same boot, and carrying the
 * run's marker in its environment.
 */
export async function reapProcessGroup(
  identity: ProcessGroupIdentity,
  options: {
    readonly graceMs: number;
    /**
     * When the group's run began, in epoch milliseconds: a leader or member that started
     * before its run cannot be the run's and is left alone.
     */
    readonly notStartedBefore?: number;
    /** The run's id, which each member of a leaderless group must carry (`RUN_ID_VARIABLE`). */
    readonly runId?: string;
  },
): Promise<ProcessGroupReaping> {
  if (process.platform !== 'linux') return { outcome: 'unverifiable' };
  // Never 0 or 1: kill(-1) signals every process the daemon may signal, kill(-0) its own group.
  if (parseProcessGroupIdentity(identity) === undefined) return { outcome: 'other-process' };
  /** Whether a process that started then cannot be the run's; undefined if unknowable. */
  const beforeRun = (startTime: string): boolean | undefined => {
    if (options.notStartedBefore === undefined) return false;
    const startedAt = startedAtMs(startTime);
    return startedAt === undefined
      ? undefined
      : startedAt < options.notStartedBefore - START_TIME_SLACK_MS;
  };
  const recorded = (): ProcessGroupReaping | undefined => {
    const bootId = currentBootId();
    if (!bootId) return { outcome: 'unverifiable' };
    if (identity.pid === process.pid || identity.pid === procStat(process.pid)?.pgrp)
      return { outcome: 'other-process' };
    const stat = procStat(identity.pid);
    if (!stat) {
      // The leader has exited (operator decisions 2026-10-07). Linux does not reuse a pgid while
      // any member lives, but the pid may have come round after the run's group ended: the
      // group is the run's only if, on the same boot, every member is in the session the run's
      // leader made, started after the run (and after the leader), and carries the run's marker.
      const members = groupMembers(identity.pid);
      if (members.length === 0) return { outcome: 'gone' };
      if (bootId !== identity.bootId) return { outcome: 'other-process' };
      if (members.some((member) => member.session !== identity.pid))
        return { outcome: 'other-process' };
      if (options.notStartedBefore === undefined || options.runId === undefined)
        return { outcome: 'unverifiable' };
      for (const member of members) {
        const early = beforeRun(member.startTime);
        if (early === undefined) return { outcome: 'unverifiable' };
        if (early || Number(member.startTime) < Number(identity.startTime))
          return { outcome: 'other-process' };
      }
      // A member without the marker, or whose environment cannot be read, is not proved.
      if (members.some((member) => carriesRunMarker(member.pid, options.runId ?? '') !== true))
        return { outcome: 'unverifiable' };
      return undefined;
    }
    if (
      bootId !== identity.bootId ||
      stat.startTime !== identity.startTime ||
      stat.pgrp !== identity.pid
    )
      return { outcome: 'other-process' };
    const early = beforeRun(stat.startTime);
    if (early === undefined) return { outcome: 'unverifiable' };
    if (early) return { outcome: 'other-process' };
    return undefined;
  };
  let refused: ProcessGroupReaping | undefined;
  try {
    refused = recorded();
  } catch {
    return { outcome: 'unverifiable' };
  }
  if (refused) return refused;
  const ended = async (ms: number) => {
    for (const until = Date.now() + ms; Date.now() < until; ) {
      if (!hasGroupWork(identity.pid, true)) return true;
      await new Promise((resolve) => setTimeout(resolve, REAP_POLL_MS));
    }
    return !hasGroupWork(identity.pid, true);
  };
  /** Whether the group could be signalled: gone meanwhile counts, refused does not. */
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-identity.pid, name);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
  // Not the daemon's to signal (another user's group): never its run's.
  if (!signal('SIGTERM')) return { outcome: 'other-process' };
  if (await ended(options.graceMs)) return { outcome: 'terminated', signal: 'SIGTERM' };
  // The pid cannot have been reused while its group had members, unless the leader alone was
  // replaced; it is checked again before the group is killed.
  try {
    const leader = procStat(identity.pid);
    if (leader && leader.startTime !== identity.startTime)
      return { outcome: 'terminated', signal: 'SIGTERM' };
  } catch {
    // Unreadable: the group is still the one signalled above.
  }
  signal('SIGKILL');
  return (await ended(options.graceMs))
    ? { outcome: 'terminated', signal: 'SIGKILL' }
    : { outcome: 'surviving' };
}

/**
 * How long a session's process group may drain after the agent exits: until the step's
 * deadline when it has one, else a standalone allowance. `undefined` for a deadline that is
 * not a time, which an adapter refuses at launch.
 */
export function backgroundWorkAllowance(
  deadlineAt: string | undefined,
  standaloneMs: number,
):
  | Pick<SupervisedProcessOptions, 'backgroundWorkDeadlineAt' | 'backgroundWorkTimeoutMs'>
  | undefined {
  if (!deadlineAt) return { backgroundWorkTimeoutMs: standaloneMs };
  const at = Date.parse(deadlineAt);
  return Number.isFinite(at) ? { backgroundWorkDeadlineAt: at } : undefined;
}

export function spawnSupervisedProcess(options: SupervisedProcessOptions): SupervisedProcess {
  if (
    options.backgroundWorkDeadlineAt !== undefined &&
    !Number.isFinite(options.backgroundWorkDeadlineAt)
  )
    throw new Error('The background-work deadline is not a finite time');
  // A consumer that lags holds the child's output back instead of buffering without bound
  // (AGT-16): the child blocks on a full pipe until the consumer catches up.
  let paused = false;
  const queue = new AsyncQueue<SupervisedProcessItem>(() => {
    if (!paused) return;
    paused = false;
    child.stdout?.resume();
    child.stderr?.resume();
  });
  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let lineBuffer = '';
  /** The partial line's bytes, counted as its pieces arrive (AGT-16). */
  let lineBytes = 0;
  let dropping = false;
  let droppedBytes = 0;
  const pushOutput = (item: SupervisedProcessItem, bytes: number) => {
    queue.push(item, bytes);
    if (!paused && queue.full) {
      paused = true;
      child.stdout?.pause();
      child.stderr?.pause();
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    let data = chunk;
    while (data.length > 0) {
      const newline = data.indexOf('\n');
      if (newline === -1) {
        const bytes = Buffer.byteLength(data, 'utf8');
        if (dropping) {
          droppedBytes += bytes;
        } else {
          lineBuffer += data;
          lineBytes += bytes;
          if (lineBytes > options.maxLineBytes) {
            dropping = true;
            droppedBytes = lineBytes;
            lineBuffer = '';
            lineBytes = 0;
          }
        }
        return;
      }
      const segment = data.slice(0, newline);
      data = data.slice(newline + 1);
      const segmentBytes = Buffer.byteLength(segment, 'utf8');
      if (dropping) {
        droppedBytes += segmentBytes;
        pushOutput({ type: 'stdout-overflow', bytes: droppedBytes }, 0);
        dropping = false;
        droppedBytes = 0;
        continue;
      }
      const line = lineBuffer + segment;
      const bytes = lineBytes + segmentBytes;
      lineBuffer = '';
      lineBytes = 0;
      if (bytes > options.maxLineBytes) {
        pushOutput({ type: 'stdout-overflow', bytes }, 0);
        continue;
      }
      pushOutput({ type: 'stdout-line', line }, bytes);
    }
  });
  child.stderr?.setEncoding('utf8');
  let quietTimer: NodeJS.Timeout | undefined;
  child.stderr?.on('data', (chunk: string) => {
    pushOutput({ type: 'stderr', text: chunk }, Buffer.byteLength(chunk, 'utf8'));
    if (options.stderrQuietMs === undefined) return;
    if (quietTimer !== undefined) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = undefined;
      if (!finished) queue.push({ type: 'stderr-quiet' });
    }, options.stderrQuietMs);
    quietTimer.unref();
  });
  child.stdin?.on('error', () => {
    // EPIPE after the agent exits is expected; the close event reports the outcome.
  });

  let killTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let closed: { exitCode: number | null; signal: string | null } | undefined;
  let leaderExited = false;
  let terminating = false;
  let finished = false;
  let backgroundWorkIncomplete = false;
  let backgroundWorkTimedOut = false;
  let drainDeadline = options.backgroundWorkDeadlineAt;

  const terminate = () => {
    if (finished || terminating) return;
    terminating = true;
    killGroup(child, 'SIGTERM');
    // A leader's exit must not cancel escalation while descendants still run.
    killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), options.terminationGraceMs);
    killTimer.unref();
  };
  const settle = () => {
    if (finished || !leaderExited) return;
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    if (drainDeadline === undefined && options.backgroundWorkTimeoutMs !== undefined)
      drainDeadline = Date.now() + options.backgroundWorkTimeoutMs;
    if ((drainDeadline !== undefined || terminating) && hasGroupWork(child.pid)) {
      if (!backgroundWorkIncomplete && !terminating) {
        backgroundWorkIncomplete = true;
        queue.push({ type: 'background-work-waiting' });
      }
      if (!terminating && Date.now() >= (drainDeadline ?? Infinity)) {
        backgroundWorkTimedOut = true;
        terminate();
      }
      drainTimer = setTimeout(settle, 500);
      return;
    }
    if (!closed) return;
    finished = true;
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (quietTimer !== undefined) clearTimeout(quietTimer);
    if (lineBuffer.length > 0) {
      queue.push({ type: 'stdout-line', line: lineBuffer });
      lineBuffer = '';
      lineBytes = 0;
    }
    queue.push({
      type: 'exited',
      ...closed,
      ...(backgroundWorkIncomplete ? { backgroundWorkIncomplete: true } : {}),
      ...(backgroundWorkTimedOut ? { backgroundWorkTimedOut: true } : {}),
    });
    queue.close();
  };
  child.on('error', (error) => {
    queue.push({ type: 'stderr', text: `spawn error: ${error.message}\n` });
  });
  // exit precedes close; descendants can retain the stdio pipes after the leader exits.
  child.on('exit', () => {
    leaderExited = true;
    settle();
  });
  child.on('close', (exitCode, signal) => {
    leaderExited = true;
    closed = { exitCode, signal };
    settle();
  });

  return {
    pid: child.pid,
    items: queue,
    write(data: string): boolean {
      if (child.stdin === null || child.stdin.destroyed || child.stdin.writableEnded) {
        return false;
      }
      child.stdin.write(data);
      return true;
    },
    endInput(): void {
      if (child.stdin !== null && !child.stdin.writableEnded) {
        child.stdin.end();
      }
    },
    terminate,
  };
}
