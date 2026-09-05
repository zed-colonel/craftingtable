import { spawn } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

/**
 * Mutating and inspecting Git operations for controlled worktrees.
 *
 * This module is a process authority: it is one of the few places allowed to
 * spawn a child process (see scripts/check-forbidden-scope.mjs). Every command
 * is an argument array with `shell: false`, runs with a bounded lifetime and
 * bounded output, and never lets a caller supply raw argv. Paths reach Git only
 * as `cwd` or as positional operands after `--`.
 */

export interface GitOperationsOptions {
  readonly gitExecutable: string;
  /** Per-command lifetime; worktree creation on a large repository can take a while. */
  readonly commandTimeoutMs?: number;
  /** Per-stream output ceiling for a single command. */
  readonly outputLimitBytes?: number;
}

export type GitFailureKind =
  | 'invalid-path'
  | 'not-a-repository'
  | 'not-top-level'
  | 'git-failed'
  | 'merge-conflict'
  | 'timed-out'
  | 'spawn-failed'
  | 'output-overflow';

export interface GitFailure {
  readonly kind: GitFailureKind;
  readonly message: string;
  readonly exitCode?: number;
  readonly stderr?: string;
}

export type GitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: GitFailure };

export interface RepositoryIdentity {
  readonly topLevel: string;
  readonly headSha: string;
  /** Current branch, or `HEAD` when detached. */
  readonly branch: string;
  readonly clean: boolean;
}

export type DiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'unmerged'
  | 'unknown';

export interface DiffFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

export interface DiffCommit {
  readonly sha: string;
  readonly subject: string;
  readonly authoredAt: string;
}

export interface WorktreeDiff {
  readonly baseSha: string;
  readonly headSha: string;
  readonly commits: readonly DiffCommit[];
  readonly files: readonly DiffFile[];
  readonly patch: string;
  readonly patchTruncated: boolean;
}

export interface GitOperations {
  inspectRepository(path: string): Promise<GitResult<RepositoryIdentity>>;
  createWorktree(input: {
    readonly repositoryPath: string;
    readonly worktreePath: string;
    readonly branchName: string;
    readonly baseRef: string;
  }): Promise<GitResult<{ readonly headSha: string }>>;
  removeWorktree(input: {
    readonly repositoryPath: string;
    readonly worktreePath: string;
  }): Promise<GitResult<undefined>>;
  worktreeDiff(input: {
    readonly worktreePath: string;
    readonly baseSha: string;
    readonly maxPatchBytes: number;
  }): Promise<GitResult<WorktreeDiff>>;
  /**
   * Merges `branchName` into `targetBranch` in the primary checkout with a
   * merge commit. Requires the checkout to be on `targetBranch` and clean; a
   * conflicting merge is aborted and reported, leaving the checkout as it was.
   */
  mergeBranch(input: {
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly targetBranch: string;
    readonly message: string;
  }): Promise<GitResult<{ readonly mergeSha: string }>>;
  /** Deletes a fully merged local branch; a missing branch is not an error. */
  deleteBranch(input: {
    readonly repositoryPath: string;
    readonly branchName: string;
  }): Promise<GitResult<undefined>>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_PATCH_FILES = 100;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

function isSafeBranchName(value: string): boolean {
  return (
    BRANCH_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.lock') &&
    !value.endsWith('/')
  );
}

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

type CommandResult = GitResult<CommandOutcome>;

function failure(
  kind: GitFailureKind,
  message: string,
  extra: Partial<GitFailure> = {},
): GitFailure {
  return { kind, message, ...extra };
}

function fail<T>(
  kind: GitFailureKind,
  message: string,
  extra: Partial<GitFailure> = {},
): GitResult<T> {
  return { ok: false, failure: failure(kind, message, extra) };
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) {
    delete environment[key];
  }
  return {
    ...environment,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function splitNul(buffer: Buffer): string[] {
  const text = buffer.toString('utf8');
  const parts = text.split('\0');
  if (parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
}

function statusFromLetter(letter: string): DiffFileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type-changed';
    case 'U':
      return 'unmerged';
    default:
      return 'unknown';
  }
}

export function createGitOperations(options: GitOperationsOptions): GitOperations {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;

  function run(args: readonly string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      let settled = false;
      let primary: GitFailure | undefined;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.gitExecutable, [...args], {
          cwd,
          env: childEnvironment(),
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        resolve(fail('spawn-failed', error instanceof Error ? error.message : 'spawn failed'));
        return;
      }

      const terminate = (reason: GitFailure): void => {
        primary ??= reason;
        if (child.pid !== undefined) {
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
        }
      };

      const timer = setTimeout(() => {
        terminate(failure('timed-out', `git ${args[0] ?? ''} exceeded ${commandTimeoutMs} ms`));
      }, commandTimeoutMs);
      timer.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > outputLimitBytes) {
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
          },
        });
      });
    });
  }

  /** Runs a command and requires exit code 0 (or one of `acceptedExitCodes`). */
  async function runOk(
    args: readonly string[],
    cwd: string,
    acceptedExitCodes: readonly number[] = [0],
  ): Promise<GitResult<CommandOutcome>> {
    const result = await run(args, cwd);
    if (!result.ok) {
      return result;
    }
    if (result.value.exitCode === null || !acceptedExitCodes.includes(result.value.exitCode)) {
      const stderr = result.value.stderr.toString('utf8').slice(0, 4000);
      return fail('git-failed', `git ${args.join(' ')} failed`, {
        ...(result.value.exitCode === null ? {} : { exitCode: result.value.exitCode }),
        stderr,
      });
    }
    return result;
  }

  async function canonicalDirectory(path: string): Promise<GitResult<string>> {
    if (!isAbsolute(path) || path.includes('\0')) {
      return fail('invalid-path', 'Repository path must be absolute');
    }
    try {
      const resolved = await realpath(path);
      const info = await stat(resolved);
      if (!info.isDirectory()) {
        return fail('invalid-path', 'Repository path is not a directory');
      }
      return { ok: true, value: resolved };
    } catch {
      return fail('invalid-path', 'Repository path does not exist');
    }
  }

  async function inspectRepository(path: string): Promise<GitResult<RepositoryIdentity>> {
    const canonical = await canonicalDirectory(path);
    if (!canonical.ok) {
      return canonical;
    }
    const topLevelResult = await run(
      ['rev-parse', '--path-format=absolute', '--show-toplevel'],
      canonical.value,
    );
    if (!topLevelResult.ok) {
      return topLevelResult;
    }
    if (topLevelResult.value.exitCode !== 0) {
      return fail('not-a-repository', 'Path is not inside a Git working tree', {
        stderr: topLevelResult.value.stderr.toString('utf8').slice(0, 2000),
      });
    }
    const topLevel = topLevelResult.value.stdout.toString('utf8').trim();
    let canonicalTopLevel: string;
    try {
      canonicalTopLevel = await realpath(topLevel);
    } catch {
      return fail('not-a-repository', 'Git top level could not be resolved');
    }
    if (canonicalTopLevel !== canonical.value) {
      return fail('not-top-level', 'Path must be the top level of a Git working tree');
    }

    const head = await run(['rev-parse', '--verify', 'HEAD'], canonical.value);
    if (!head.ok) return head;
    if (head.value.exitCode !== 0) {
      return fail('not-a-repository', 'Repository has no commits yet');
    }
    const branch = await runOk(['rev-parse', '--abbrev-ref', 'HEAD'], canonical.value);
    if (!branch.ok) return branch;
    const status = await runOk(['status', '--porcelain', '-z'], canonical.value);
    if (!status.ok) return status;

    return {
      ok: true,
      value: {
        topLevel: canonical.value,
        headSha: head.value.stdout.toString('utf8').trim(),
        branch: branch.value.stdout.toString('utf8').trim(),
        clean: status.value.stdout.byteLength === 0,
      },
    };
  }

  async function createWorktree(input: {
    readonly repositoryPath: string;
    readonly worktreePath: string;
    readonly branchName: string;
    readonly baseRef: string;
  }): Promise<GitResult<{ readonly headSha: string }>> {
    const repository = await canonicalDirectory(input.repositoryPath);
    if (!repository.ok) return repository;
    if (!isAbsolute(input.worktreePath) || input.worktreePath.includes('\0')) {
      return fail('invalid-path', 'Worktree path must be absolute');
    }
    if (
      input.branchName.startsWith('-') ||
      input.baseRef.startsWith('-') ||
      !SHA_PATTERN.test(input.baseRef)
    ) {
      return fail('invalid-path', 'Branch name and base revision must be well formed');
    }
    try {
      await mkdir(dirname(input.worktreePath), { recursive: true, mode: 0o700 });
    } catch (error) {
      return fail('invalid-path', error instanceof Error ? error.message : 'mkdir failed');
    }
    const added = await runOk(
      ['worktree', 'add', '-b', input.branchName, '--', input.worktreePath, input.baseRef],
      repository.value,
    );
    if (!added.ok) return added;
    const head = await runOk(['rev-parse', '--verify', 'HEAD'], input.worktreePath);
    if (!head.ok) return head;
    return { ok: true, value: { headSha: head.value.stdout.toString('utf8').trim() } };
  }

  async function removeWorktree(input: {
    readonly repositoryPath: string;
    readonly worktreePath: string;
  }): Promise<GitResult<undefined>> {
    const repository = await canonicalDirectory(input.repositoryPath);
    if (!repository.ok) return repository;
    if (!isAbsolute(input.worktreePath) || input.worktreePath.includes('\0')) {
      return fail('invalid-path', 'Worktree path must be absolute');
    }
    const removed = await runOk(
      ['worktree', 'remove', '--force', '--', input.worktreePath],
      repository.value,
    );
    if (!removed.ok) {
      // A worktree whose directory is already gone still needs its metadata pruned.
      const prune = await runOk(['worktree', 'prune'], repository.value);
      if (!prune.ok) return prune;
      try {
        await stat(input.worktreePath);
        return removed;
      } catch {
        return { ok: true, value: undefined };
      }
    }
    return { ok: true, value: undefined };
  }

  async function worktreeDiff(input: {
    readonly worktreePath: string;
    readonly baseSha: string;
    readonly maxPatchBytes: number;
  }): Promise<GitResult<WorktreeDiff>> {
    const worktree = await canonicalDirectory(input.worktreePath);
    if (!worktree.ok) return worktree;
    if (!SHA_PATTERN.test(input.baseSha)) {
      return fail('invalid-path', 'Base revision must be a hex object name');
    }
    const cwd = worktree.value;

    const head = await runOk(['rev-parse', '--verify', 'HEAD'], cwd);
    if (!head.ok) return head;
    const headSha = head.value.stdout.toString('utf8').trim();

    const log = await runOk(
      ['log', '--format=%H%x1f%s%x1f%aI', '--max-count=200', `${input.baseSha}..HEAD`, '--'],
      cwd,
    );
    if (!log.ok) return log;
    const commits: DiffCommit[] = log.value.stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha = '', subject = '', authored = ''] = line.split('\x1f');
        // Git prints the author's local offset; the wire contract wants UTC.
        const parsed = new Date(authored);
        const authoredAt = Number.isNaN(parsed.getTime())
          ? new Date(0).toISOString()
          : parsed.toISOString();
        return { sha, subject, authoredAt };
      });

    const nameStatus = await runOk(
      ['diff', '--name-status', '-z', '--find-renames', input.baseSha, '--'],
      cwd,
    );
    if (!nameStatus.ok) return nameStatus;
    const numstat = await runOk(
      ['diff', '--numstat', '-z', '--find-renames', input.baseSha, '--'],
      cwd,
    );
    if (!numstat.ok) return numstat;
    const untracked = await runOk(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
    if (!untracked.ok) return untracked;

    const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    const numstatParts = splitNul(numstat.value.stdout);
    for (let index = 0; index < numstatParts.length; ) {
      const entry = numstatParts[index] ?? '';
      const tab = entry.split('\t');
      if (tab.length < 3) {
        index += 1;
        continue;
      }
      const [added = '-', deleted = '-', inlinePath = ''] = tab;
      const binary = added === '-' || deleted === '-';
      const record = {
        additions: binary ? 0 : Number(added),
        deletions: binary ? 0 : Number(deleted),
        binary,
      };
      if (inlinePath.length > 0) {
        counts.set(inlinePath, record);
        index += 1;
      } else {
        // Rename form: "added\tdeleted\t\0old\0new\0".
        const newPath = numstatParts[index + 2] ?? '';
        counts.set(newPath, record);
        index += 3;
      }
    }

    const files: DiffFile[] = [];
    const statusParts = splitNul(nameStatus.value.stdout);
    for (let index = 0; index < statusParts.length; ) {
      const code = statusParts[index] ?? '';
      const letter = code.charAt(0);
      if (letter === 'R' || letter === 'C') {
        const previousPath = statusParts[index + 1] ?? '';
        const path = statusParts[index + 2] ?? '';
        const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
        files.push({ path, previousPath, status: statusFromLetter(letter), ...count });
        index += 3;
      } else {
        const path = statusParts[index + 1] ?? '';
        const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
        files.push({ path, status: statusFromLetter(letter), ...count });
        index += 2;
      }
    }

    const untrackedPaths = splitNul(untracked.value.stdout);
    const patchParts: string[] = [];
    let patchBytes = 0;
    let patchTruncated = false;
    const appendPatch = (text: string): void => {
      if (patchTruncated) return;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (patchBytes + bytes > input.maxPatchBytes) {
        const remaining = Math.max(0, input.maxPatchBytes - patchBytes);
        patchParts.push(Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8'));
        patchTruncated = true;
        return;
      }
      patchParts.push(text);
      patchBytes += bytes;
    };

    const tracked = await runOk(['diff', '--find-renames', input.baseSha, '--'], cwd);
    if (!tracked.ok) return tracked;
    appendPatch(tracked.value.stdout.toString('utf8'));

    for (const [position, path] of untrackedPaths.entries()) {
      const fileNumstat = await runOk(
        ['diff', '--no-index', '--numstat', '--', '/dev/null', path],
        cwd,
        [0, 1],
      );
      let additions = 0;
      let binary = false;
      if (fileNumstat.ok) {
        const [added = '-'] = fileNumstat.value.stdout.toString('utf8').split('\t');
        binary = added === '-';
        additions = binary ? 0 : Number(added);
      }
      files.push({ path, status: 'untracked', additions, deletions: 0, binary });
      if (position < MAX_UNTRACKED_PATCH_FILES && !patchTruncated) {
        const filePatch = await runOk(['diff', '--no-index', '--', '/dev/null', path], cwd, [0, 1]);
        if (filePatch.ok) {
          appendPatch(filePatch.value.stdout.toString('utf8'));
        }
      }
    }
    if (untrackedPaths.length > MAX_UNTRACKED_PATCH_FILES) {
      patchTruncated = true;
    }

    return {
      ok: true,
      value: {
        baseSha: input.baseSha,
        headSha,
        commits,
        files,
        patch: patchParts.join(''),
        patchTruncated,
      },
    };
  }

  async function mergeBranch(input: {
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly targetBranch: string;
    readonly message: string;
  }): Promise<GitResult<{ readonly mergeSha: string }>> {
    const repository = await canonicalDirectory(input.repositoryPath);
    if (!repository.ok) return repository;
    if (!isSafeBranchName(input.branchName) || !isSafeBranchName(input.targetBranch)) {
      return fail('invalid-path', 'Branch names must be well formed');
    }
    const cwd = repository.value;
    const current = await runOk(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (!current.ok) return current;
    const checkedOut = current.value.stdout.toString('utf8').trim();
    if (checkedOut !== input.targetBranch) {
      return fail(
        'git-failed',
        `The primary checkout is on ${checkedOut}, not ${input.targetBranch}; check out ${input.targetBranch} first`,
      );
    }
    const status = await runOk(['status', '--porcelain', '-z'], cwd);
    if (!status.ok) return status;
    if (status.value.stdout.byteLength > 0) {
      return fail(
        'git-failed',
        'The primary checkout has uncommitted changes; commit or stash them before merging',
      );
    }
    const merged = await run(
      ['merge', '--no-ff', '--no-edit', '-m', input.message, '--', input.branchName],
      cwd,
    );
    if (!merged.ok) return merged;
    if (merged.value.exitCode !== 0) {
      const stderr = merged.value.stderr.toString('utf8');
      const stdout = merged.value.stdout.toString('utf8');
      // Leave the checkout exactly as it was; a half-merged tree is worse than a refusal.
      await run(['merge', '--abort'], cwd);
      const conflict = /CONFLICT|Automatic merge failed/.test(`${stdout}\n${stderr}`);
      return fail(
        conflict ? 'merge-conflict' : 'git-failed',
        conflict
          ? `Merging ${input.branchName} into ${input.targetBranch} conflicts; resolve it by hand`
          : `git merge failed: ${stderr.trim().split('\n').at(-1) ?? 'unknown error'}`,
        { ...(merged.value.exitCode === null ? {} : { exitCode: merged.value.exitCode }), stderr },
      );
    }
    const head = await runOk(['rev-parse', '--verify', 'HEAD'], cwd);
    if (!head.ok) return head;
    return { ok: true, value: { mergeSha: head.value.stdout.toString('utf8').trim() } };
  }

  async function deleteBranch(input: {
    readonly repositoryPath: string;
    readonly branchName: string;
  }): Promise<GitResult<undefined>> {
    const repository = await canonicalDirectory(input.repositoryPath);
    if (!repository.ok) return repository;
    if (!isSafeBranchName(input.branchName)) {
      return fail('invalid-path', 'Branch name must be well formed');
    }
    const exists = await run(
      ['show-ref', '--verify', '--quiet', `refs/heads/${input.branchName}`],
      repository.value,
    );
    if (!exists.ok) return exists;
    if (exists.value.exitCode !== 0) {
      return { ok: true, value: undefined };
    }
    const deleted = await runOk(['branch', '-d', '--', input.branchName], repository.value);
    if (!deleted.ok) return deleted;
    return { ok: true, value: undefined };
  }

  return {
    inspectRepository,
    createWorktree,
    removeWorktree,
    worktreeDiff,
    mergeBranch,
    deleteBranch,
  };
}
