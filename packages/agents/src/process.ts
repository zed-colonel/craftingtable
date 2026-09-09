import { type ChildProcess, spawn } from 'node:child_process';

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
}

export type SupervisedProcessItem =
  | { readonly type: 'stdout-line'; readonly line: string }
  | { readonly type: 'stdout-overflow'; readonly bytes: number }
  | { readonly type: 'stderr'; readonly text: string }
  | { readonly type: 'exited'; readonly exitCode: number | null; readonly signal: string | null };

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
  child.on('error', (error) => {
    queue.push({ type: 'stderr', text: `spawn error: ${error.message}\n` });
  });
  child.on('close', (exitCode, signal) => {
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (lineBuffer.length > 0) {
      queue.push({ type: 'stdout-line', line: lineBuffer });
      lineBuffer = '';
    }
    queue.push({ type: 'exited', exitCode, signal });
    queue.close();
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
    terminate(): void {
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), options.terminationGraceMs);
      killTimer.unref();
    },
  };
}
