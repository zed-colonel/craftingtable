import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GitFailure, GitOperationsOptions, GitResult } from './operations.js';
import { fail, failure } from './support.js';

/**
 * The Git package's only process authority (scripts/check-forbidden-scope.mjs). Every command
 * is an argument array with `shell: false`, in a process group of its own that is ended as a
 * group, with a bounded lifetime and bounded output, and never with caller-supplied argv. Paths
 * reach Git only as `cwd` or as positional operands after `--`.
 */

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type CommandResult = GitResult<CommandOutcome>;

export interface RunOptions {
  /** Written to the command's stdin. */
  readonly input?: string | Buffer;
  /** This command's stdout ceiling; the runner's output limit by default. */
  readonly limit?: number;
  /** A daemon-owned index file for this command alone (`GIT_INDEX_FILE`, R-G10). */
  readonly indexFile?: string;
}

/** A streamed command's stdout, chunk by chunk: `'stop'` once the consumer has what it needs. */
export type StreamConsumer = (chunk: Buffer) => 'stop' | undefined;

/**
 * The daemon's Git environment (R-G5, SEC-03): named variables only, no system configuration,
 * and as global configuration only the daemon's identity file. A repository cannot reach it
 * through the operator's aliases, rerere or diff settings.
 */
function childEnvironment(identityConfigPath?: string, indexFile?: string): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: identityConfigPath ?? '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    // Replace refs would let anyone who writes refs change what an object reads as (R-G13).
    GIT_NO_REPLACE_OBJECTS: '1',
    // Only an index file the daemon made for one command (R-G10), never one inherited.
    ...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }),
  };
}

/**
 * Options before every daemon Git command (R-G5, SEC-03, GIT-08): repository hooks and an
 * fsmonitor command never run in the daemon's context, and the operator's own ignore and
 * attributes files do not apply.
 */
const DAEMON_GIT_OPTIONS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  // Nor the operator's ignore and attributes files under HOME (R-G5 review).
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'core.attributesFile=/dev/null',
];

/**
 * Writes the daemon's identity file from the operator's global `user.name` and `user.email`,
 * and nothing else of that configuration. A repository's own identity still takes precedence.
 */
export function writeDaemonGitIdentity(gitExecutable: string, path: string): string {
  const read = (key: string) =>
    spawnSync(gitExecutable, ['config', '--global', '--get', key], {
      encoding: 'utf8',
      timeout: 10000,
    }).stdout?.trim() ?? '';
  const value = (text: string) => JSON.stringify(text.replace(/[\r\n]/g, ' '));
  const name = read('user.name');
  const email = read('user.email');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    name || email
      ? `[user]\n${name ? `\tname = ${value(name)}\n` : ''}${email ? `\temail = ${value(email)}\n` : ''}`
      : '',
    { mode: 0o600 },
  );
  return path;
}

/** One runner's commands: what every Git module receives as its context. */
export interface GitRunner {
  /** Runs a command, its stdout buffered up to the output limit (or `limit`). */
  run(args: readonly string[], cwd: string, command?: RunOptions): Promise<CommandResult>;
  /** Runs a command and requires exit code 0 (or one of `acceptedExitCodes`). */
  runOk(
    args: readonly string[],
    cwd: string,
    acceptedExitCodes?: readonly number[],
    command?: RunOptions,
  ): Promise<CommandResult>;
  /** Streams a command's stdout to `consume`; a consumer that stops ends it successfully. */
  stream(
    args: readonly string[],
    cwd: string,
    consume: StreamConsumer,
    acceptedExitCodes?: readonly number[],
    command?: RunOptions,
  ): Promise<GitResult<{ readonly stopped: boolean }>>;
  /** The SHA-256 of a command's whole stdout, hashed as it streams. */
  hashDiff(args: readonly string[], cwd: string): Promise<GitResult<string>>;
}

/** The runner every Git module of one `createGitOperations` shares. */
export function createRunner(options: GitOperationsOptions): GitRunner {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;

  /**
   * Runs one Git command. Buffered (no `consume`), stdout is collected up to `limit`; streamed,
   * each stdout chunk goes to `consume` instead, unbounded, and a consumer that returns `'stop'`
   * ends the process group: a stop is a success, reported as `stopped`.
   */
  function execute(
    args: readonly string[],
    cwd: string,
    command: RunOptions,
    consume?: StreamConsumer,
  ): Promise<GitResult<CommandOutcome & { readonly stopped: boolean }>> {
    const limit = command.limit ?? outputLimitBytes;
    return new Promise((resolve) => {
      let settled = false;
      let stopped = false;
      let primary: GitFailure | undefined;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.gitExecutable, [...DAEMON_GIT_OPTIONS, ...args], {
          cwd,
          env: childEnvironment(options.identityConfigPath, command.indexFile),
          shell: false,
          detached: true,
          stdio: [command.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        resolve(fail('spawn-failed', error instanceof Error ? error.message : 'spawn failed'));
        return;
      }

      if (command.input !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(command.input);
      }
      const endGroup = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Already exited.
        }
        const killTimer = setTimeout(() => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Already exited.
          }
        }, 1000);
        killTimer.unref();
      };
      const terminate = (reason: GitFailure): void => {
        if (stopped) return;
        primary ??= reason;
        endGroup();
      };

      const timer = setTimeout(() => {
        terminate(failure('timed-out', `git ${args[0] ?? ''} exceeded ${commandTimeoutMs} ms`));
      }, commandTimeoutMs);
      timer.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stopped || primary !== undefined) return;
        if (consume !== undefined) {
          if (consume(chunk) === 'stop') {
            stopped = true;
            endGroup();
          }
          return;
        }
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > limit) {
          terminate(failure('output-overflow', 'git stdout exceeded the output limit'));
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > outputLimitBytes) {
          terminate(failure('output-overflow', 'git stderr exceeded the output limit'));
          return;
        }
        stderrChunks.push(chunk);
      });
      child.on('error', (error) => {
        primary ??= failure('spawn-failed', error.message);
      });
      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (primary !== undefined) {
          resolve({ ok: false, failure: primary });
          return;
        }
        resolve({
          ok: true,
          value: {
            exitCode,
            signal,
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            stopped,
          },
        });
      });
    });
  }

  function run(
    args: readonly string[],
    cwd: string,
    command: RunOptions = {},
  ): Promise<CommandResult> {
    return execute(args, cwd, command);
  }

  /** Requires exit code 0 (or one of `acceptedExitCodes`) of a finished command. */
  function exited<T extends CommandOutcome>(
    result: GitResult<T>,
    args: readonly string[],
    acceptedExitCodes: readonly number[] = [0],
  ): GitResult<T> {
    if (!result.ok) return result;
    if (result.value.exitCode === null || !acceptedExitCodes.includes(result.value.exitCode)) {
      const stderr = result.value.stderr.toString('utf8').slice(0, 4000);
      return fail('git-failed', `git ${args.join(' ')} failed`, {
        ...(result.value.exitCode === null ? {} : { exitCode: result.value.exitCode }),
        stderr,
      });
    }
    return result;
  }

  /** Runs a command and requires exit code 0 (or one of `acceptedExitCodes`). */
  async function runOk(
    args: readonly string[],
    cwd: string,
    acceptedExitCodes: readonly number[] = [0],
    command: RunOptions = {},
  ): Promise<GitResult<CommandOutcome>> {
    return exited(await run(args, cwd, command), args, acceptedExitCodes);
  }

  /**
   * Streams a command's stdout to `consume` (R-G10, GIT-03): no output limit applies, and a
   * consumer that stops early ends the command successfully. A command that runs to its end
   * must exit 0 (or one of `acceptedExitCodes`).
   */
  async function stream(
    args: readonly string[],
    cwd: string,
    consume: StreamConsumer,
    acceptedExitCodes: readonly number[] = [0],
    command: RunOptions = {},
  ): Promise<GitResult<{ readonly stopped: boolean }>> {
    const result = await execute(args, cwd, command, consume);
    if (result.ok && result.value.stopped) return { ok: true, value: { stopped: true } };
    const finished = exited(result, args, acceptedExitCodes);
    return finished.ok ? { ok: true, value: { stopped: false } } : finished;
  }

  /**
   * The SHA-256 of a command's whole stdout, hashed as it streams: the digest the buffered
   * reading gave, for output of any size (investigations and checkpoint reservations store it).
   */
  async function hashDiff(args: readonly string[], cwd: string): Promise<GitResult<string>> {
    const hash = createHash('sha256');
    const streamed = await stream(args, cwd, (chunk) => {
      hash.update(chunk);
    });
    if (!streamed.ok) return streamed;
    return { ok: true, value: hash.digest('hex') };
  }

  return { run, runOk, stream, hashDiff };
}
