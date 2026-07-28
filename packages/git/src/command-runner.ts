import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { REPOSITORY_RISK_SCAN_PATTERN, createInspectionError } from './types.js';
import type { RepositoryInspectionError, RepositoryInspectionOperation } from './types.js';
import { environmentFor } from './environment.js';
import type { FixedGitCommand } from './environment.js';

export const INSPECTION_TIMEOUT_REASON = 'craftingtable-inspection-timeout';
export const CREATION_TIMEOUT_REASON = 'craftingtable-creation-timeout';

export interface GitExecutableEvidence {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNanoseconds: string;
}

export interface CommandRunnerOptions {
  readonly commandTimeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly terminationGraceMs: number;
}

export interface FixedGitProcessOutcome {
  readonly commandKind: FixedGitCommand['kind'];
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

export type FixedGitProcessResult =
  | { readonly ok: true; readonly outcome: FixedGitProcessOutcome }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

export interface BoundedCommandRunner {
  run(
    command: FixedGitCommand,
    signal?: AbortSignal,
    operation?: RepositoryInspectionOperation,
  ): Promise<FixedGitProcessResult>;
}

export async function readExecutableEvidence(
  canonicalPath: string,
): Promise<GitExecutableEvidence | undefined> {
  try {
    const resolved = await realpath(canonicalPath);
    if (resolved !== canonicalPath) {
      return undefined;
    }
    const metadata = await stat(canonicalPath, { bigint: true });
    if (!metadata.isFile()) {
      return undefined;
    }
    await access(canonicalPath, constants.X_OK);
    return {
      canonicalPath,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      size: metadata.size.toString(),
      mtimeNanoseconds: metadata.mtimeNs.toString(),
    };
  } catch {
    return undefined;
  }
}

function executableMatches(
  expected: GitExecutableEvidence,
  actual: GitExecutableEvidence | undefined,
): boolean {
  return (
    actual !== undefined &&
    actual.canonicalPath === expected.canonicalPath &&
    actual.inode === expected.inode &&
    actual.size === expected.size &&
    actual.mtimeNanoseconds === expected.mtimeNanoseconds
  );
}

export function argumentsFor(command: FixedGitCommand): readonly string[] {
  switch (command.kind) {
    case 'version':
      return ['--version'];
    case 'identity':
      return [
        '-c',
        'core.fsmonitor=false',
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--absolute-git-dir',
        '--git-common-dir',
        '--is-bare-repository',
        '--is-inside-work-tree',
        '--show-object-format=storage',
      ];
    case 'local-risk-signal-names':
      return [
        '-c',
        'core.fsmonitor=false',
        'config',
        '--local',
        '--no-includes',
        '--null',
        '--name-only',
        '--get-regexp',
        REPOSITORY_RISK_SCAN_PATTERN,
      ];
  }
}

function abortCode(signal: AbortSignal | undefined): 'aborted' | 'timed-out' {
  return signal?.reason === INSPECTION_TIMEOUT_REASON || signal?.reason === CREATION_TIMEOUT_REASON
    ? 'timed-out'
    : 'aborted';
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH means the group has already exited. Other kill failures are
    // reflected by the eventual close/signal outcome without leaking details.
  }
}

function collectBounded(
  stream: Readable,
  limit: number,
  onOverflow: () => void,
): { readonly chunks: Buffer[]; readonly byteLength: () => number } {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  stream.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteLength += chunk.byteLength;
    if (byteLength > limit) {
      onOverflow();
      return;
    }
    chunks.push(chunk);
  });
  return { chunks, byteLength: () => byteLength };
}

export function createBoundedCommandRunner(
  executable: GitExecutableEvidence,
  options: CommandRunnerOptions,
): BoundedCommandRunner {
  return {
    async run(
      command,
      signal,
      operation = command.kind === 'version' ? 'create-inspector' : 'inspect-path',
    ) {
      if (signal?.aborted) {
        return { ok: false, error: createInspectionError(abortCode(signal), operation) };
      }

      const currentExecutable = await readExecutableEvidence(executable.canonicalPath);
      if (!executableMatches(executable, currentExecutable)) {
        return {
          ok: false,
          error: createInspectionError('git-executable-changed', operation),
        };
      }
      if (signal?.aborted) {
        return { ok: false, error: createInspectionError(abortCode(signal), operation) };
      }

      return await new Promise<FixedGitProcessResult>((resolve) => {
        let primaryError: RepositoryInspectionError | undefined;
        let settled = false;
        let terminationTimer: NodeJS.Timeout | undefined;

        const child = spawn(executable.canonicalPath, [...argumentsFor(command)], {
          cwd: command.cwd,
          env: environmentFor(command),
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        const beginTermination = (error: RepositoryInspectionError): void => {
          if (primaryError !== undefined) {
            return;
          }
          primaryError = error;
          terminateProcessGroup(child.pid, 'SIGTERM');
          terminationTimer = setTimeout(() => {
            terminateProcessGroup(child.pid, 'SIGKILL');
          }, options.terminationGraceMs);
          terminationTimer.unref();
        };

        const stdout = collectBounded(child.stdout, options.stdoutLimitBytes, () => {
          beginTermination(createInspectionError('stdout-overflow', operation));
        });
        const stderr = collectBounded(child.stderr, options.stderrLimitBytes, () => {
          beginTermination(createInspectionError('stderr-overflow', operation));
        });

        const commandTimer = setTimeout(() => {
          beginTermination(createInspectionError('timed-out', operation));
        }, options.commandTimeoutMs);
        commandTimer.unref();

        const onAbort = (): void => {
          beginTermination(createInspectionError(abortCode(signal), operation));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (result: FixedGitProcessResult): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(commandTimer);
          if (terminationTimer !== undefined) {
            clearTimeout(terminationTimer);
          }
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };

        child.once('error', () => {
          if (primaryError === undefined) {
            primaryError = createInspectionError('spawn-failed', operation);
          }
        });

        child.once('close', (exitCode, closeSignal) => {
          if (primaryError !== undefined) {
            finish({ ok: false, error: primaryError });
            return;
          }
          if (closeSignal !== null) {
            finish({
              ok: false,
              error: createInspectionError('signal-terminated', operation, {
                commandKind: command.kind,
                signal: closeSignal,
              }),
            });
            return;
          }
          if (exitCode === null) {
            finish({
              ok: false,
              error: createInspectionError('git-command-failed', operation, {
                commandKind: command.kind,
              }),
            });
            return;
          }
          finish({
            ok: true,
            outcome: {
              commandKind: command.kind,
              stdout: Buffer.concat(stdout.chunks, stdout.byteLength()),
              stderr: Buffer.concat(stderr.chunks, stderr.byteLength()),
              exitCode,
            },
          });
        });
      });
    },
  };
}
