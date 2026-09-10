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
  /** Local branches, and the one the primary checkout has checked out. */
  listBranches(repositoryPath: string): Promise<GitResult<BranchListing>>;
  /**
   * Merges `branchName` into `targetBranch` with a merge commit.
   *
   * When the primary checkout has the target checked out the merge happens
   * there and the checkout must be clean. Otherwise the merge happens in a
   * temporary worktree at `scratchPath`, so the primary checkout is never
   * touched; a missing target is created from `createTargetFrom` first. A
   * conflicting merge is aborted and reported, leaving everything as it was.
   */
  mergeBranch(input: {
    /** Pin an operator-approved review to this source commit even if its branch moves. */
    readonly sourceCommitSha?: string;
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly targetBranch: string;
    /** A branch name or object name to start a missing target from. */
    readonly createTargetFrom?: string;
    readonly scratchPath: string;
    readonly message: string;
  }): Promise<GitResult<{ readonly mergeSha: string; readonly createdTarget: boolean }>>;
  /** Deletes a branch already merged into `mergedInto`; a missing branch is not an error. */
  deleteBranch(input: {
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly mergedInto: string;
  }): Promise<GitResult<undefined>>;
}

export interface BranchListing {
  readonly branches: readonly string[];
  readonly checkedOut?: string;
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

  interface WorktreeEntry {
    readonly path: string;
    readonly branch?: string;
  }

  /** `git worktree list --porcelain`: the first entry is the primary checkout. */
  async function listWorktrees(cwd: string): Promise<GitResult<readonly WorktreeEntry[]>> {
    const listed = await runOk(['worktree', 'list', '--porcelain'], cwd);
    if (!listed.ok) return listed;
    const entries: WorktreeEntry[] = [];
    let current: { path?: string; branch?: string } = {};
    for (const line of listed.value.stdout.toString('utf8').split('\n')) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length) };
      } else if (line.startsWith('branch refs/heads/')) {
        current.branch = line.slice('branch refs/heads/'.length);
      } else if (line.length === 0 && current.path !== undefined) {
        entries.push({
          path: current.path,
          ...(current.branch === undefined ? {} : { branch: current.branch }),
        });
        current = {};
      }
    }
    if (current.path !== undefined) {
      entries.push({
        path: current.path,
        ...(current.branch === undefined ? {} : { branch: current.branch }),
      });
    }
    return { ok: true, value: entries };
  }

  async function branchExists(cwd: string, branchName: string): Promise<GitResult<boolean>> {
    const result = await run(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], cwd);
    if (!result.ok) return result;
    return { ok: true, value: result.value.exitCode === 0 };
  }

  async function listBranches(repositoryPath: string): Promise<GitResult<BranchListing>> {
    const repository = await canonicalDirectory(repositoryPath);
    if (!repository.ok) return repository;
    const listed = await runOk(
      ['for-each-ref', '--format=%(refname:short)', '--sort=refname', 'refs/heads/'],
      repository.value,
    );
    if (!listed.ok) return listed;
    const worktrees = await listWorktrees(repository.value);
    if (!worktrees.ok) return worktrees;
    const branches = listed.value.stdout
      .toString('utf8')
      .split('\n')
      .filter((name) => name.length > 0);
    const primary = worktrees.value[0];
    return {
      ok: true,
      value: {
        branches,
        ...(primary?.branch === undefined ? {} : { checkedOut: primary.branch }),
      },
    };
  }

  /** Runs the merge in `cwd`; on any failure the merge is aborted so `cwd` is left as it was. */
  async function mergeInto(
    cwd: string,
    input: {
      readonly branchName: string;
      readonly message: string;
      readonly sourceCommitSha?: string;
    },
  ): Promise<GitResult<{ readonly mergeSha: string }>> {
    const merged = await run(
      [
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        input.message,
        '--',
        input.sourceCommitSha ?? input.branchName,
      ],
      cwd,
    );
    if (!merged.ok) return merged;
    if (merged.value.exitCode !== 0) {
      const stderr = merged.value.stderr.toString('utf8');
      const stdout = merged.value.stdout.toString('utf8');
      await run(['merge', '--abort'], cwd);
      const conflict = /CONFLICT|Automatic merge failed/.test(`${stdout}\n${stderr}`);
      return fail(
        conflict ? 'merge-conflict' : 'git-failed',
        conflict
          ? `Merging ${input.branchName} conflicts; resolve it by hand`
          : `git merge failed: ${stderr.trim().split('\n').at(-1) ?? 'unknown error'}`,
        { ...(merged.value.exitCode === null ? {} : { exitCode: merged.value.exitCode }), stderr },
      );
    }
    const head = await runOk(['rev-parse', '--verify', 'HEAD'], cwd);
    if (!head.ok) return head;
    return { ok: true, value: { mergeSha: head.value.stdout.toString('utf8').trim() } };
  }

  async function mergeBranch(input: {
    readonly sourceCommitSha?: string;
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly targetBranch: string;
    readonly createTargetFrom?: string;
    readonly scratchPath: string;
    readonly message: string;
  }): Promise<GitResult<{ readonly mergeSha: string; readonly createdTarget: boolean }>> {
    const repository = await canonicalDirectory(input.repositoryPath);
    if (!repository.ok) return repository;
    if (!isSafeBranchName(input.branchName) || !isSafeBranchName(input.targetBranch)) {
      return fail('invalid-path', 'Branch names must be well formed');
    }
    if (input.sourceCommitSha !== undefined && !SHA_PATTERN.test(input.sourceCommitSha))
      return fail('invalid-path', 'Source commit must be a Git object name');
    if (input.branchName === input.targetBranch) {
      return fail('invalid-path', 'A branch cannot be merged into itself');
    }
    if (!isAbsolute(input.scratchPath) || input.scratchPath.includes('\0')) {
      return fail('invalid-path', 'Scratch path must be absolute');
    }
    const cwd = repository.value;
    const exists = await branchExists(cwd, input.targetBranch);
    if (!exists.ok) return exists;
    const createdTarget = !exists.value;
    if (createdTarget) {
      const from = input.createTargetFrom;
      if (from === undefined || !(SHA_PATTERN.test(from) || isSafeBranchName(from))) {
        return fail('git-failed', `Branch ${input.targetBranch} does not exist`);
      }
      const fromExists = SHA_PATTERN.test(from)
        ? { ok: true as const, value: true }
        : await branchExists(cwd, from);
      if (!fromExists.ok) return fromExists;
      if (!fromExists.value) {
        return fail(
          'git-failed',
          `Branch ${from} does not exist to start ${input.targetBranch} from`,
        );
      }
    }
    const worktrees = await listWorktrees(cwd);
    if (!worktrees.ok) return worktrees;
    const primary = worktrees.value[0];
    const holder = worktrees.value.find((entry) => entry.branch === input.targetBranch);

    if (!createdTarget && holder !== undefined && primary !== undefined && holder === primary) {
      // The target is what the primary checkout has checked out: merge there,
      // which needs it clean so the operator's working tree is never mixed in.
      const status = await runOk(['status', '--porcelain', '-z'], cwd);
      if (!status.ok) return status;
      if (status.value.stdout.byteLength > 0) {
        return fail(
          'git-failed',
          `The primary checkout is on ${input.targetBranch} with uncommitted changes; commit or stash them before merging`,
        );
      }
      const merged = await mergeInto(cwd, input);
      if (!merged.ok) return merged;
      return { ok: true, value: { mergeSha: merged.value.mergeSha, createdTarget } };
    }
    if (holder !== undefined) {
      return fail(
        'git-failed',
        `Branch ${input.targetBranch} is checked out in another worktree (${holder.path})`,
      );
    }

    // Otherwise merge in a scratch worktree so the primary checkout is untouched
    // whatever branch it is on and whatever state it is in.
    try {
      await mkdir(dirname(input.scratchPath), { recursive: true, mode: 0o700 });
    } catch (error) {
      return fail('invalid-path', error instanceof Error ? error.message : 'mkdir failed');
    }
    const added = await runOk(
      createdTarget
        ? [
            'worktree',
            'add',
            '-b',
            input.targetBranch,
            '--',
            input.scratchPath,
            input.createTargetFrom as string,
          ]
        : ['worktree', 'add', '--', input.scratchPath, input.targetBranch],
      cwd,
    );
    if (!added.ok) return added;
    const merged = await mergeInto(input.scratchPath, input);
    // The scratch worktree is temporary either way; the branch keeps the commit.
    const removed = await runOk(['worktree', 'remove', '--force', '--', input.scratchPath], cwd);
    if (!merged.ok) {
      if (createdTarget) {
        await run(['branch', '-D', '--', input.targetBranch], cwd);
      }
      return merged;
    }
    if (!removed.ok) return removed;
    return { ok: true, value: { mergeSha: merged.value.mergeSha, createdTarget } };
  }

  /**
   * Deletes a branch that has been merged into `mergedInto`. Checked with
   * merge-base rather than `branch -d`, whose notion of "merged" is relative
   * to whatever the primary checkout happens to have checked out.
   */
  async function deleteBranch(input: {
    readonly repositoryPath: string;
    readonly branchName: string;
    readonly mergedInto: string;
  }): Promise<GitResult<undefined>> {
    const repository = await canonicalDirectory(input.repositoryPath);
    if (!repository.ok) return repository;
    if (!isSafeBranchName(input.branchName) || !isSafeBranchName(input.mergedInto)) {
      return fail('invalid-path', 'Branch names must be well formed');
    }
    const exists = await branchExists(repository.value, input.branchName);
    if (!exists.ok) return exists;
    if (!exists.value) {
      return { ok: true, value: undefined };
    }
    const ancestor = await run(
      ['merge-base', '--is-ancestor', input.branchName, input.mergedInto],
      repository.value,
    );
    if (!ancestor.ok) return ancestor;
    if (ancestor.value.exitCode !== 0) {
      return fail(
        'git-failed',
        `Branch ${input.branchName} is not merged into ${input.mergedInto}`,
      );
    }
    const deleted = await runOk(['branch', '-D', '--', input.branchName], repository.value);
    if (!deleted.ok) return deleted;
    return { ok: true, value: undefined };
  }

  return {
    inspectRepository,
    createWorktree,
    removeWorktree,
    worktreeDiff,
    listBranches,
    mergeBranch,
    deleteBranch,
  };
}
