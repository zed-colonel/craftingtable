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
  /** Keep the session reserved while its process group drains after the agent exits. */
  readonly backgroundWorkDeadlineMs?: number;
  /** Standalone drain allowance measured from the agent exit, not launch. */
  readonly backgroundWorkTimeoutMs?: number;
}

export type SupervisedProcessItem =
  | { readonly type: 'stdout-line'; readonly line: string }
  | { readonly type: 'stdout-overflow'; readonly bytes: number }
  | { readonly type: 'stderr'; readonly text: string }
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
 * Minimal async queue: producers push, one consumer iterates. Closing the
 * queue after the final item lets `for await` complete naturally.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: item, done: false });
      return;
    }
    this.buffered.push(item);
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
        const item = this.buffered.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
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

/** Linux zombies no longer execute work, but still make kill(-pgid, 0) succeed. */
function hasGroupWork(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (process.platform !== 'linux') return true;
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === pid) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0] ?? '')) return true;
      } catch (error) {
        // A process may exit between enumeration and read. Other errors fail closed.
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function spawnSupervisedProcess(options: SupervisedProcessOptions): SupervisedProcess {
  const queue = new AsyncQueue<SupervisedProcessItem>();
  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let lineBuffer = '';
  let dropping = false;
  let droppedBytes = 0;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    let data = chunk;
    while (data.length > 0) {
      const newline = data.indexOf('\n');
      if (newline === -1) {
        if (dropping) {
          droppedBytes += Buffer.byteLength(data, 'utf8');
        } else {
          lineBuffer += data;
          if (Buffer.byteLength(lineBuffer, 'utf8') > options.maxLineBytes) {
            dropping = true;
            droppedBytes = Buffer.byteLength(lineBuffer, 'utf8');
            lineBuffer = '';
          }
        }
        return;
      }
      const segment = data.slice(0, newline);
      data = data.slice(newline + 1);
      if (dropping) {
        droppedBytes += Buffer.byteLength(segment, 'utf8');
        queue.push({ type: 'stdout-overflow', bytes: droppedBytes });
        dropping = false;
        droppedBytes = 0;
        continue;
      }
      const line = lineBuffer + segment;
      lineBuffer = '';
      if (Buffer.byteLength(line, 'utf8') > options.maxLineBytes) {
        queue.push({ type: 'stdout-overflow', bytes: Buffer.byteLength(line, 'utf8') });
        continue;
      }
      queue.push({ type: 'stdout-line', line });
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    queue.push({ type: 'stderr', text: chunk });
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
  let drainDeadline = options.backgroundWorkDeadlineMs;

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
    if (lineBuffer.length > 0) {
      queue.push({ type: 'stdout-line', line: lineBuffer });
      lineBuffer = '';
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
