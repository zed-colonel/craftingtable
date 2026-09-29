import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  /**
   * The only global Git configuration the daemon reads (R-G5): a file holding the operator's
   * identity, from `writeDaemonGitIdentity`. Without it no global configuration is read.
   */
  readonly identityConfigPath?: string;
}

export type GitFailureKind =
  | 'invalid-path'
  | 'not-a-repository'
  | 'not-top-level'
  | 'git-failed'
  | 'merge-conflict'
  /** A merge is pending (MERGE_HEAD) in the checkout the operation needs. */
  | 'merge-in-progress'
  /** A non-forced worktree removal found uncommitted or untracked paths. */
  | 'worktree-dirty'
  | 'timed-out'
  | 'spawn-failed'
  | 'output-overflow';

export interface GitFailure {
  readonly kind: GitFailureKind;
  readonly message: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly conflictPaths?: readonly string[];
  /** For `worktree-dirty`: up to CHANGED_PATH_LIMIT changed paths, and how many there are. */
  readonly changedPaths?: readonly string[];
  readonly changedPathCount?: number;
  readonly diagnostics?: string;
}

/** How many uncommitted paths a refused removal reports. */
export const CHANGED_PATH_LIMIT = 50;

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

export interface WorktreeChanges {
  readonly clean: boolean;
  /** Includes index-only edits hidden by a working copy restored to HEAD. */
  readonly trackedClean: boolean;
  readonly headSha: string;
  readonly branch: string;
  readonly paths: readonly string[];
  readonly untracked: readonly string[];
  readonly fingerprint: string;
  readonly conflicted: boolean;
}
export interface IntegrationMergeContext {
  worktreePath: string;
  branchName: string;
  headSha: string;
  targetSha: string;
}
export interface IntegrationMergeState {
  headSha: string;
  mergeHeadSha?: string;
  conflicts: readonly string[];
  untracked: readonly string[];
  unstaged: boolean;
  treeSha?: string;
}
/** A file as a commit stores it (`readCommitFiles`). */
export type CommitFile =
  | { readonly kind: 'file'; readonly content: Uint8Array; readonly executable: boolean }
  | { readonly kind: 'link' };
export interface GitOperations {
  listBaselineTags(repositoryPath: string): Promise<GitResult<readonly string[]>>;
  ensureBaselineTag(
    repositoryPath: string,
    tag: string,
    commitSha: string,
  ): Promise<GitResult<void>>;
  resolveCommit(
    repositoryPath: string,
    ref: string,
  ): Promise<GitResult<{ commitSha: string; treeSha: string }>>;
  exportCommit(
    repositoryPath: string,
    commitSha: string,
  ): Promise<GitResult<readonly { path: string; content: Uint8Array; executable: boolean }[]>>;
  /**
   * The named files of a commit, as stored (no filters or line-ending conversion): a regular
   * file's contents, `link` for a symbolic link, or absent. At most 32 files of 16 MiB each.
   */
  readCommitFiles(
    repositoryPath: string,
    commitSha: string,
    paths: readonly string[],
  ): Promise<GitResult<ReadonlyMap<string, CommitFile>>>;
  previewIntegration(
    input: IntegrationMergeContext,
  ): Promise<GitResult<{ paths: readonly string[]; diagnostics: string }>>;
  prepareIntegrationResolution(
    input: IntegrationMergeContext,
  ): Promise<GitResult<IntegrationMergeState>>;
  inspectIntegrationResolution(
    input: IntegrationMergeContext,
  ): Promise<GitResult<IntegrationMergeState>>;
  finishIntegrationResolution(
    input: IntegrationMergeContext & { treeSha: string; resolutionId: string },
  ): Promise<GitResult<{ commitSha: string }>>;
  abortIntegrationResolution(input: IntegrationMergeContext): Promise<GitResult<void>>;
  inspectWorktreeChanges(path: string): Promise<GitResult<WorktreeChanges>>;
  checkpointWorktree(input: {
    worktreePath: string;
    branchName: string;
    expectedHeadSha: string;
    fingerprint: string;
    paths: readonly string[];
    sourceRunId: string;
  }): Promise<GitResult<{ commitSha: string }>>;
  commonAncestor(
    repositoryPath: string,
    leftSha: string,
    rightSha: string,
  ): Promise<GitResult<string>>;
  resolveBranch(repositoryPath: string, branchName: string): Promise<GitResult<string>>;
  createBranch(
    repositoryPath: string,
    branchName: string,
    fromBranch: string,
  ): Promise<GitResult<string>>;
  isAncestor(
    repositoryPath: string,
    ancestorSha: string,
    descendantSha: string,
  ): Promise<GitResult<boolean>>;
  updateWorktree(input: {
    readonly fastForwardOnly?: boolean;
    worktreePath: string;
    branchName: string;
    expectedHeadSha: string;
    targetSha: string;
  }): Promise<GitResult<{ mergeSha: string }>>;
  inspectRepository(path: string): Promise<GitResult<RepositoryIdentity>>;
  createWorktree(input: {
    readonly recoverExisting?: boolean;
    readonly repositoryPath: string;
    readonly worktreePath: string;
    readonly branchName: string;
    readonly baseRef: string;
  }): Promise<GitResult<{ readonly headSha: string }>>;
  removeWorktree(input: {
    readonly force?: boolean;
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
   * The repository (its common git directory) and every branch and tag with the commit it
   * points at, by full ref name (R-G5: protected-ref snapshots).
   */
  branchHeads(
    repositoryPath: string,
  ): Promise<GitResult<{ repository: string; heads: Record<string, string> }>>;
  /**
   * Merges `branchName` into `targetBranch` with a merge commit.
   *
   * When the primary checkout has the target checked out the merge happens
   * there and the checkout must be clean. Otherwise the merge happens in a
   * temporary worktree at `scratchPath`, so the primary checkout is never
   * touched; a missing target is created from `createTargetFrom` first. A
   * conflicting merge is aborted and reported, leaving everything as it was.
   */
  inspectMergeOperation(input: {
    repositoryPath: string;
    targetBranch: string;
    sourceSha: string;
    targetSha: string;
    id: string;
  }): Promise<GitResult<string | undefined>>;
  mergeBranch(input: {
    /** Pin an operator-approved review to this source commit even if its branch moves. */
    readonly sourceCommitSha?: string;
    readonly expectedTargetSha?: string;
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
    readonly expectedHeadSha?: string;
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

/**
 * The daemon's Git environment (R-G5, SEC-03): named variables only, no system configuration,
 * and as global configuration only the daemon's identity file. A repository cannot reach it
 * through the operator's aliases, rerere or diff settings.
 */
function childEnvironment(identityConfigPath?: string): NodeJS.ProcessEnv {
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

  function run(
    args: readonly string[],
    cwd: string,
    input?: string,
    limit = outputLimitBytes,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let settled = false;
      let primary: GitFailure | undefined;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.gitExecutable, [...DAEMON_GIT_OPTIONS, ...args], {
          cwd,
          env: childEnvironment(options.identityConfigPath),
          shell: false,
          detached: true,
          stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        resolve(fail('spawn-failed', error instanceof Error ? error.message : 'spawn failed'));
        return;
      }

      if (input !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(input);
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
    readonly recoverExisting?: boolean;
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
    if (input.recoverExisting) {
      const listed = await listWorktrees(repository.value);
      if (!listed.ok) return listed;
      const existing = listed.value.find((tree) => tree.path === input.worktreePath);
      if (existing) {
        const identity = await inspectRepository(input.worktreePath);
        if (!identity.ok) return identity;
        if (
          existing.branch !== input.branchName ||
          identity.value.headSha !== input.baseRef ||
          !identity.value.clean
        )
          return fail(
            'git-failed',
            'Reserved worktree changed during preparation; preserve and inspect it before resuming',
          );
        return { ok: true, value: { headSha: identity.value.headSha } };
      }
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
    readonly force?: boolean;
    readonly repositoryPath: string;
    readonly worktreePath: string;
  }): Promise<GitResult<undefined>> {
    const repository = await canonicalDirectory(input.repositoryPath);
    if (!repository.ok) return repository;
    if (!isAbsolute(input.worktreePath) || input.worktreePath.includes('\0')) {
      return fail('invalid-path', 'Worktree path must be absolute');
    }
    if (input.force !== true) {
      // Git itself refuses a dirty non-forced removal; checking first names the
      // paths at risk so the operator can decide whether to discard them.
      const status = await run(
        ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'],
        input.worktreePath,
      );
      const overflowed = !status.ok && status.failure.kind === 'output-overflow';
      const changed =
        status.ok && status.value.exitCode === 0
          ? splitNul(status.value.stdout).map((entry) => entry.slice(3))
          : [];
      if (overflowed || changed.length > 0)
        return fail(
          'worktree-dirty',
          overflowed
            ? 'The worktree has too many uncommitted or untracked paths to list'
            : `The worktree has ${changed.length} uncommitted or untracked path${changed.length === 1 ? '' : 's'}`,
          {
            changedPaths: changed.slice(0, CHANGED_PATH_LIMIT),
            ...(overflowed ? {} : { changedPathCount: changed.length }),
          },
        );
    }
    const removed = await runOk(
      [
        'worktree',
        'remove',
        ...(input.force === true ? ['--force'] : []),
        '--',
        input.worktreePath,
      ],
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
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-status',
        '-z',
        '--find-renames',
        input.baseSha,
        '--',
      ],
      cwd,
    );
    if (!nameStatus.ok) return nameStatus;
    const numstat = await runOk(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        '--find-renames',
        input.baseSha,
        '--',
      ],
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

    const tracked = await runOk(
      ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', input.baseSha, '--'],
      cwd,
    );
    if (!tracked.ok) return tracked;
    appendPatch(tracked.value.stdout.toString('utf8'));

    for (const [position, path] of untrackedPaths.entries()) {
      const fileNumstat = await runOk(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-index',
          '--numstat',
          '--',
          '/dev/null',
          path,
        ],
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
        const filePatch = await runOk(
          ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path],
          cwd,
          [0, 1],
        );
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

  async function branchHeads(
    repositoryPath: string,
  ): Promise<GitResult<{ repository: string; heads: Record<string, string> }>> {
    const directory = await canonicalDirectory(repositoryPath);
    if (!directory.ok) return directory;
    const common = await runOk(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      directory.value,
    );
    if (!common.ok) return common;
    const listed = await runOk(
      ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/', 'refs/tags/'],
      directory.value,
    );
    if (!listed.ok) return listed;
    const heads: Record<string, string> = {};
    for (const line of listed.value.stdout.toString('utf8').split('\n')) {
      const [name, sha] = line.split('\0');
      if (name && sha) heads[name] = sha;
    }
    return {
      ok: true,
      value: { repository: common.value.stdout.toString('utf8').trim(), heads },
    };
  }

  async function mergeInProgress(cwd: string): Promise<boolean> {
    const pending = await run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd);
    return pending.ok && pending.value.exitCode === 0;
  }

  /**
   * Returns a checkout whose merge process was killed (timeout, output
   * overflow) to its pre-merge commit. Depending on where Git was stopped it
   * leaves MERGE_HEAD (abort it) or only a staged merge result (reset it).
   * Callers only merge into a checkout they verified clean, so everything
   * staged here belongs to the interrupted merge; `--merge` still keeps any
   * unstaged edit instead of discarding it.
   */
  async function recoverInterruptedMerge(cwd: string): Promise<boolean> {
    if (await mergeInProgress(cwd)) {
      const aborted = await run(['merge', '--abort'], cwd);
      return aborted.ok && aborted.value.exitCode === 0 && !(await mergeInProgress(cwd));
    }
    const staged = await run(
      ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--quiet', 'HEAD', '--'],
      cwd,
    );
    if (!staged.ok) return false;
    if (staged.value.exitCode === 0) return true;
    const reset = await run(['reset', '-q', '--merge', 'HEAD'], cwd);
    return reset.ok && reset.value.exitCode === 0;
  }

  /**
   * Runs the merge in `cwd`, which the caller has verified is clean; on any
   * failure the merge is aborted so `cwd` is left as it was.
   */
  async function mergeInto(
    cwd: string,
    input: {
      readonly branchName: string;
      readonly message: string;
      readonly sourceCommitSha?: string;
      readonly expectedTargetSha?: string;
    },
  ): Promise<GitResult<{ readonly mergeSha: string }>> {
    if (input.expectedTargetSha !== undefined) {
      if (!SHA_PATTERN.test(input.expectedTargetSha))
        return fail('invalid-path', 'Expected target must be a Git object name');
      const head = await runOk(['rev-parse', '--verify', 'HEAD'], cwd);
      if (!head.ok) return head;
      if (head.value.stdout.toString('utf8').trim() !== input.expectedTargetSha)
        return fail(
          'git-failed',
          'Integration branch advanced; update the worktree and review again',
        );
    }
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
    if (!merged.ok) {
      // The process was killed or never ran: it may have stopped mid-merge.
      if (!(await recoverInterruptedMerge(cwd)))
        return fail(
          'merge-in-progress',
          `${merged.failure.message}; the interrupted merge could not be undone. Inspect the checkout (git merge --abort) before retrying.`,
        );
      return merged;
    }
    if (merged.value.exitCode !== 0) {
      const stderr = merged.value.stderr.toString('utf8');
      const stdout = merged.value.stdout.toString('utf8');
      const unmerged = await runOk(
        ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U', '-z'],
        cwd,
      );
      const aborted = await run(['merge', '--abort'], cwd);
      if (!aborted.ok || aborted.value.exitCode !== 0)
        return fail(
          'git-failed',
          'Integration merge failed and could not be aborted; inspect the pending merge.',
        );
      const conflict = /CONFLICT|Automatic merge failed/.test(`${stdout}\n${stderr}`);
      return fail(
        conflict ? 'merge-conflict' : 'git-failed',
        conflict
          ? `Merging ${input.branchName} conflicts; resolve it by hand`
          : `git merge failed: ${stderr.trim().split('\n').at(-1) ?? 'unknown error'}`,
        {
          ...(merged.value.exitCode === null ? {} : { exitCode: merged.value.exitCode }),
          stderr,
          conflictPaths: unmerged.ok ? splitNul(unmerged.value.stdout) : [],
          diagnostics: `${stdout}\n${stderr}`.slice(0, 12000),
        },
      );
    }
    const head = await runOk(['rev-parse', '--verify', 'HEAD'], cwd);
    if (!head.ok) return head;
    return { ok: true, value: { mergeSha: head.value.stdout.toString('utf8').trim() } };
  }

  async function inspectMergeOperation(input: {
    repositoryPath: string;
    targetBranch: string;
    sourceSha: string;
    targetSha: string;
    id: string;
  }): Promise<GitResult<string | undefined>> {
    if (
      !isSafeBranchName(input.targetBranch) ||
      !SHA_PATTERN.test(input.sourceSha) ||
      !SHA_PATTERN.test(input.targetSha) ||
      !/^[0-9a-f-]{36}$/.test(input.id)
    )
      return fail('invalid-path', 'Invalid merge reservation');
    const result = await runOk(
      [
        'log',
        '--first-parent',
        '--max-count=1000',
        '--format=%H%x00%P%x00%s',
        `refs/heads/${input.targetBranch}`,
        '--',
      ],
      input.repositoryPath,
    );
    if (!result.ok) return result;
    for (const line of result.value.stdout.toString('utf8').trim().split('\n')) {
      const [sha, parents, subject] = line.split('\0');
      if (subject === `CraftingTable integration merge ${input.id}`) {
        if (parents !== `${input.targetSha} ${input.sourceSha}`)
          return fail('git-failed', 'Recorded merge marker has unexpected parents');
        return { ok: true, value: sha };
      }
      if (sha === input.targetSha) return { ok: true, value: undefined };
    }
    return fail(
      'git-failed',
      'Cannot reconcile merge reservation within target history; inspect before retrying',
    );
  }

  async function mergeBranch(input: {
    readonly sourceCommitSha?: string;
    readonly expectedTargetSha?: string;
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
      if (await mergeInProgress(cwd))
        return fail(
          'merge-in-progress',
          `The primary checkout on ${input.targetBranch} has a merge in progress; finish it or run git merge --abort before merging`,
        );
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
    readonly expectedHeadSha?: string;
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
    if (input.branchName === input.mergedInto)
      return fail('git-failed', 'The destination branch cannot be removed');
    if (input.expectedHeadSha !== undefined) {
      if (!/^[0-9a-f]{40,64}$/.test(input.expectedHeadSha))
        return fail('invalid-path', 'Expected branch commit must be a full object ID');
      const head = await resolveBranch(repository.value, input.branchName);
      if (!head.ok) return head;
      if (head.value !== input.expectedHeadSha)
        return fail(
          'git-failed',
          `Branch ${input.branchName} changed after it was merged; it was retained`,
        );
    }
    const worktrees = await listWorktrees(repository.value);
    if (!worktrees.ok) return worktrees;
    if (worktrees.value.some((tree) => tree.branch === input.branchName))
      return fail(
        'git-failed',
        `Branch ${input.branchName} is checked out in a worktree; it was retained`,
      );
    const ancestor = await run(
      [
        'merge-base',
        '--is-ancestor',
        `refs/heads/${input.branchName}`,
        `refs/heads/${input.mergedInto}`,
      ],
      repository.value,
    );
    if (!ancestor.ok) return ancestor;
    if (ancestor.value.exitCode !== 0) {
      return fail(
        'git-failed',
        `Branch ${input.branchName} is not merged into ${input.mergedInto}`,
      );
    }
    // Compare-and-delete prevents an external ref update between inspection and deletion.
    const deleted = await runOk(
      input.expectedHeadSha
        ? [
            'update-ref',
            '--no-deref',
            '-d',
            `refs/heads/${input.branchName}`,
            input.expectedHeadSha,
          ]
        : ['branch', '-D', '--', input.branchName],
      repository.value,
    );
    if (!deleted.ok) return deleted;
    return { ok: true, value: undefined };
  }

  async function resolveBranch(
    repositoryPath: string,
    branchName: string,
  ): Promise<GitResult<string>> {
    if (!isSafeBranchName(branchName))
      return fail('invalid-path', 'Branch name must be well formed');
    const repo = await canonicalDirectory(repositoryPath);
    if (!repo.ok) return repo;
    const ref = await runOk(
      ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`],
      repo.value,
    );
    if (!ref.ok) return fail('git-failed', `Local branch ${branchName} is unavailable`);
    return { ok: true, value: ref.value.stdout.toString('utf8').trim() };
  }

  async function createBranch(
    repositoryPath: string,
    branchName: string,
    fromBranch: string,
  ): Promise<GitResult<string>> {
    if (!isSafeBranchName(branchName))
      return fail('invalid-path', 'Branch name must be well formed');
    const source = await resolveBranch(repositoryPath, fromBranch);
    if (!source.ok) return source;
    const repo = await canonicalDirectory(repositoryPath);
    if (!repo.ok) return repo;
    const created = await runOk(['branch', '--', branchName, source.value], repo.value);
    if (!created.ok) return created;
    return { ok: true, value: source.value };
  }

  async function isAncestor(
    repositoryPath: string,
    ancestorSha: string,
    descendantSha: string,
  ): Promise<GitResult<boolean>> {
    if (!SHA_PATTERN.test(ancestorSha) || !SHA_PATTERN.test(descendantSha))
      return fail('invalid-path', 'Ancestry requires Git object names');
    const repo = await canonicalDirectory(repositoryPath);
    if (!repo.ok) return repo;
    const result = await run(
      ['merge-base', '--is-ancestor', ancestorSha, descendantSha],
      repo.value,
    );
    if (!result.ok) return result;
    if (result.value.exitCode !== 0 && result.value.exitCode !== 1)
      return fail('git-failed', 'Could not verify commit ancestry');
    return { ok: true, value: result.value.exitCode === 0 };
  }

  async function updateWorktree(input: {
    fastForwardOnly?: boolean;
    worktreePath: string;
    branchName: string;
    expectedHeadSha: string;
    targetSha: string;
  }): Promise<GitResult<{ mergeSha: string }>> {
    if (!SHA_PATTERN.test(input.targetSha))
      return fail('invalid-path', 'Integration commit must be a Git object name');
    const identity = await inspectRepository(input.worktreePath);
    if (!identity.ok) return identity;
    if (await mergeInProgress(identity.value.topLevel))
      return fail(
        'merge-in-progress',
        'The worktree has a merge in progress; finish or abort it before updating',
      );
    if (
      !identity.value.clean ||
      identity.value.branch !== input.branchName ||
      identity.value.headSha !== input.expectedHeadSha
    )
      return fail('git-failed', 'Worktree changed or is not clean; refresh before updating');
    if (input.fastForwardOnly) {
      const ancestry = await isAncestor(
        identity.value.topLevel,
        input.expectedHeadSha,
        input.targetSha,
      );
      if (!ancestry.ok) return ancestry;
      if (!ancestry.value)
        return fail(
          'git-failed',
          'Review snapshot has changes outside integration; inspect changed history.',
        );
      const merged = await run(
        ['merge', '--ff-only', '--', input.targetSha],
        identity.value.topLevel,
      );
      if (!merged.ok) {
        if (!(await recoverInterruptedMerge(identity.value.topLevel)))
          return fail(
            'merge-in-progress',
            `${merged.failure.message}; the interrupted update could not be undone. Inspect the worktree before retrying.`,
          );
        return merged;
      }
      if (merged.value.exitCode !== 0)
        return fail(
          'git-failed',
          'Review snapshot cannot fast-forward to integration; inspect changed history.',
        );
      return { ok: true, value: { mergeSha: input.targetSha } };
    }
    return mergeInto(identity.value.topLevel, {
      branchName: input.branchName,
      sourceCommitSha: input.targetSha,
      expectedTargetSha: input.expectedHeadSha,
      message: 'Merge integration changes before verification and review',
    });
  }

  async function inspectWorktreeChanges(path: string): Promise<GitResult<WorktreeChanges>> {
    const identity = await inspectRepository(path);
    if (!identity.ok) return identity;
    const diff = await runOk(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--binary',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-color',
        '--full-index',
        'HEAD',
        '--',
      ],
      path,
    );
    if (!diff.ok) return diff;
    const names = await runOk(
      ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD', '--'],
      path,
    );
    if (!names.ok) return names;
    const untracked = await runOk(['ls-files', '--others', '--exclude-standard', '-z'], path);
    if (!untracked.ok) return untracked;
    const trackedStatus = await runOk(
      ['status', '--porcelain', '-z', '--untracked-files=no'],
      path,
    );
    if (!trackedStatus.ok) return trackedStatus;
    const conflicts = await runOk(['ls-files', '--unmerged', '-z'], path);
    if (!conflicts.ok) return conflicts;
    let pendingOperation = false;
    for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const pending = await run(['rev-parse', '--verify', ref], path);
      if (!pending.ok) return pending;
      pendingOperation ||= pending.value.exitCode === 0;
    }
    return {
      ok: true,
      value: {
        headSha: identity.value.headSha,
        branch: identity.value.branch,
        clean: identity.value.clean,
        trackedClean: trackedStatus.value.stdout.length === 0,
        paths: splitNul(names.value.stdout),
        untracked: splitNul(untracked.value.stdout),
        fingerprint: createHash('sha256').update(diff.value.stdout).digest('hex'),
        conflicted: conflicts.value.stdout.length > 0 || pendingOperation,
      },
    };
  }

  /** Checkpoint only named tracked/indexed paths; arbitrary untracked files are never staged. */
  async function checkpointWorktree(
    input: {
      worktreePath: string;
      branchName: string;
      expectedHeadSha: string;
      fingerprint: string;
      paths: readonly string[];
      sourceRunId: string;
    },
    verifyOnly = false,
  ): Promise<GitResult<{ commitSha: string }>> {
    if (
      !SHA_PATTERN.test(input.expectedHeadSha) ||
      !isSafeBranchName(input.branchName) ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(input.sourceRunId) ||
      input.paths.length === 0 ||
      input.paths.length > 1000 ||
      input.paths.some(
        (p) => !p || p.startsWith('/') || p.split('/').includes('..') || p.includes('\0'),
      ) ||
      input.paths.join('').length > 100000
    )
      return fail('invalid-path', 'Invalid checkpoint context');
    const before = await inspectWorktreeChanges(input.worktreePath);
    if (!before.ok) return before;
    if (before.value.branch !== input.branchName || before.value.conflicted)
      return fail(
        'git-failed',
        'Checkpoint requires the managed branch without an in-progress merge or conflicts',
      );
    const message = `CraftingTable: finalize run ${input.sourceRunId}`;
    if (before.value.headSha !== input.expectedHeadSha) {
      // Recover the Git/SQLite gap only for the exact reserved checkpoint, never an arbitrary commit.
      const log = await runOk(['log', '-1', '--format=%P%n%s'], input.worktreePath);
      if (!log.ok) return log;
      const [parent, subject] = log.value.stdout.toString('utf8').trim().split('\n');
      const patch = await runOk(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--binary',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--no-color',
          '--full-index',
          input.expectedHeadSha,
          'HEAD',
          '--',
        ],
        input.worktreePath,
      );
      if (!patch.ok) return patch;
      if (
        parent === input.expectedHeadSha &&
        subject === message &&
        createHash('sha256').update(patch.value.stdout).digest('hex') === input.fingerprint
      )
        return { ok: true, value: { commitSha: before.value.headSha } };
      return fail('git-failed', 'Checkpoint HEAD changed; inspect the branch before resuming');
    }
    if (verifyOnly) return fail('git-failed', 'Checkpoint commit did not advance HEAD');
    if (
      before.value.fingerprint !== input.fingerprint ||
      JSON.stringify(before.value.paths) !== JSON.stringify(input.paths)
    )
      return fail('git-failed', 'Checkpoint content changed since reservation');
    const added = await runOk(
      ['--literal-pathspecs', 'add', '--update', '--', ...input.paths],
      input.worktreePath,
    );
    if (!added.ok) return added;
    const staged = await runOk(
      [
        'diff',
        '--cached',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--binary',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-color',
        '--full-index',
        'HEAD',
        '--',
      ],
      input.worktreePath,
    );
    if (!staged.ok) return staged;
    if (createHash('sha256').update(staged.value.stdout).digest('hex') !== input.fingerprint)
      return fail('git-failed', 'Staged content changed during checkpoint');
    const identity = await inspectRepository(input.worktreePath);
    if (!identity.ok) return identity;
    if (
      identity.value.headSha !== input.expectedHeadSha ||
      identity.value.branch !== input.branchName
    )
      return fail('git-failed', 'Checkpoint branch changed during preparation');
    const committed = await runOk(
      [
        '-c',
        'user.name=CraftingTable',
        '-c',
        'user.email=craftingtable@localhost',
        'commit',
        '--no-gpg-sign',
        '-m',
        message,
      ],
      input.worktreePath,
    );
    if (!committed.ok) return committed;
    // Reuse the recovery checks to verify the exact committed patch and parent (including hook effects).
    return checkpointWorktree(input, true);
  }

  async function integrationIdentity(input: IntegrationMergeContext) {
    if (
      !SHA_PATTERN.test(input.headSha) ||
      !SHA_PATTERN.test(input.targetSha) ||
      !isSafeBranchName(input.branchName)
    )
      return fail<RepositoryIdentity>('invalid-path', 'Invalid integration resolution context');
    const state = await inspectRepository(input.worktreePath);
    if (!state.ok) return state;
    if (state.value.branch !== input.branchName)
      return fail<RepositoryIdentity>('git-failed', 'Resolution worktree left its managed branch');
    return state;
  }
  async function inspectIntegrationResolution(
    input: IntegrationMergeContext,
  ): Promise<GitResult<IntegrationMergeState>> {
    const identity = await integrationIdentity(input);
    if (!identity.ok) return identity;
    const mergeHead = await run(['rev-parse', '--verify', 'MERGE_HEAD'], input.worktreePath);
    if (!mergeHead.ok) return mergeHead;
    const conflicts = await runOk(
      ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U', '-z'],
      input.worktreePath,
    );
    if (!conflicts.ok) return conflicts;
    const untracked = await runOk(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      input.worktreePath,
    );
    if (!untracked.ok) return untracked;
    const unstaged = await runOk(
      ['diff', '--quiet', '--no-ext-diff', '--no-textconv'],
      input.worktreePath,
      [0, 1],
    );
    if (!unstaged.ok) return unstaged;
    const paths = splitNul(conflicts.value.stdout);
    const tree = paths.length === 0 ? await runOk(['write-tree'], input.worktreePath) : undefined;
    if (tree && !tree.ok) return tree;
    return {
      ok: true,
      value: {
        headSha: identity.value.headSha,
        ...(mergeHead.value.exitCode === 0
          ? { mergeHeadSha: mergeHead.value.stdout.toString('utf8').trim() }
          : {}),
        conflicts: paths,
        untracked: splitNul(untracked.value.stdout),
        unstaged: unstaged.value.exitCode !== 0,
        ...(tree?.ok ? { treeSha: tree.value.stdout.toString('utf8').trim() } : {}),
      },
    };
  }
  async function previewIntegration(
    input: IntegrationMergeContext,
  ): Promise<GitResult<{ paths: readonly string[]; diagnostics: string }>> {
    const state = await integrationIdentity(input);
    if (!state.ok) return state;
    if (!state.value.clean || state.value.headSha !== input.headSha)
      return fail('git-failed', 'Inspect conflicts from a clean unchanged item branch');
    // This writes only unreachable tree/blob objects, never the index, refs or working files.
    const preview = await runOk(
      ['merge-tree', '--write-tree', '--name-only', '-z', input.headSha, input.targetSha],
      input.worktreePath,
      [0, 1],
    );
    if (!preview.ok) return preview;
    const records = splitNul(preview.value.stdout);
    const separator = records.indexOf('', 1);
    const paths =
      preview.value.exitCode === 1
        ? records.slice(1, separator < 0 ? records.length : separator)
        : [];
    if (paths.length > 1000)
      return fail('git-failed', 'Integration conflict exceeds the 1000-file limit');
    const messages: string[] = [];
    let cursor = separator + 1;
    while (separator >= 0 && cursor < records.length) {
      const count = Number(records[cursor++]);
      if (!Number.isSafeInteger(count) || count < 0) break;
      cursor += count + 1; // Paths and message type precede the readable message.
      const message = records[cursor++];
      if (message) messages.push(message);
    }
    const log = await runOk(
      ['log', '--oneline', '--max-count=50', `${input.headSha}..${input.targetSha}`],
      input.worktreePath,
    );
    if (!log.ok) return log;
    return {
      ok: true,
      value: {
        paths,
        diagnostics:
          `Incoming commits:\n${log.value.stdout.toString('utf8')}\n${messages.join('\n')}`.slice(
            0,
            12000,
          ),
      },
    };
  }
  async function prepareIntegrationResolution(
    input: IntegrationMergeContext,
  ): Promise<GitResult<IntegrationMergeState>> {
    const before = await inspectIntegrationResolution(input);
    if (!before.ok) return before;
    if (before.value.headSha !== input.headSha)
      return fail('git-failed', 'Item commit changed before resolution');
    if (before.value.mergeHeadSha) {
      return before.value.mergeHeadSha === input.targetSha
        ? before
        : fail('git-failed', 'A different merge is already pending');
    }
    const identity = await inspectRepository(input.worktreePath);
    if (!identity.ok) return identity;
    if (!identity.value.clean)
      return fail('git-failed', 'Resolution preparation requires a clean worktree');
    const merge = await run(
      ['merge', '--no-ff', '--no-commit', '--', input.targetSha],
      input.worktreePath,
    );
    if (!merge.ok) return merge;
    const after = await inspectIntegrationResolution(input);
    if (!after.ok) return after;
    if (after.value.mergeHeadSha !== input.targetSha)
      return fail('git-failed', 'Could not prepare the pinned integration merge');
    return after;
  }
  async function finishIntegrationResolution(
    input: IntegrationMergeContext & { treeSha: string; resolutionId: string },
  ): Promise<GitResult<{ commitSha: string }>> {
    if (!SHA_PATTERN.test(input.treeSha) || !/^[a-zA-Z0-9-]{1,100}$/.test(input.resolutionId))
      return fail('invalid-path', 'Invalid resolution commit reservation');
    const subject = `CraftingTable: resolve integration ${input.resolutionId}`;
    const verify = async (): Promise<GitResult<{ commitSha: string }>> => {
      const identity = await integrationIdentity(input);
      if (!identity.ok) return identity;
      const commit = await runOk(['log', '-1', '--format=%P%n%T%n%s'], input.worktreePath);
      if (!commit.ok) return commit;
      const [parents, tree, message] = commit.value.stdout.toString('utf8').trim().split('\n');
      if (
        parents !== `${input.headSha} ${input.targetSha}` ||
        tree !== input.treeSha ||
        message !== subject ||
        !identity.value.clean
      )
        return fail(
          'git-failed',
          'Resolution commit does not match its reserved parents, tree and message',
        );
      return { ok: true, value: { commitSha: identity.value.headSha } };
    };
    const state = await inspectIntegrationResolution(input);
    if (!state.ok) return state;
    if (state.value.headSha !== input.headSha) return verify();
    if (
      state.value.mergeHeadSha !== input.targetSha ||
      state.value.conflicts.length ||
      state.value.untracked.length ||
      state.value.unstaged ||
      state.value.treeSha !== input.treeSha
    )
      return fail(
        'git-failed',
        'Resolve and stage every conflict and intended change; leave no untracked files before completion',
      );
    const checked = await runOk(
      ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--check', input.headSha, '--'],
      input.worktreePath,
    );
    if (!checked.ok)
      return fail('git-failed', 'Resolution contains conflict markers or whitespace errors');
    const committed = await runOk(
      [
        '-c',
        'user.name=CraftingTable',
        '-c',
        'user.email=craftingtable@localhost',
        'commit',
        '--no-gpg-sign',
        '-m',
        subject,
      ],
      input.worktreePath,
    );
    if (!committed.ok) return committed;
    return verify();
  }
  async function abortIntegrationResolution(
    input: IntegrationMergeContext,
  ): Promise<GitResult<void>> {
    const state = await inspectIntegrationResolution(input);
    if (!state.ok) return state;
    if (state.value.headSha !== input.headSha)
      return fail('git-failed', 'Cannot abandon a resolution after HEAD changed');
    if (state.value.mergeHeadSha && state.value.mergeHeadSha !== input.targetSha)
      return fail('git-failed', 'Refusing to abort a different merge');
    if (state.value.mergeHeadSha) {
      const aborted = await runOk(['merge', '--abort'], input.worktreePath);
      if (!aborted.ok) return aborted;
    } else {
      const identity = await inspectRepository(input.worktreePath);
      if (!identity.ok) return identity;
      const originalTree = await runOk(['rev-parse', 'HEAD^{tree}'], input.worktreePath);
      if (!originalTree.ok) return originalTree;
      if (
        state.value.unstaged ||
        state.value.conflicts.length ||
        state.value.treeSha !== originalTree.value.stdout.toString('utf8').trim()
      )
        return fail('git-failed', 'No owned merge is pending; preserve and inspect existing edits');
    }
    return { ok: true, value: undefined };
  }

  async function commonAncestor(
    repositoryPath: string,
    leftSha: string,
    rightSha: string,
  ): Promise<GitResult<string>> {
    if (!SHA_PATTERN.test(leftSha) || !SHA_PATTERN.test(rightSha))
      return fail('invalid-path', 'Merge base requires Git object names');
    const repo = await canonicalDirectory(repositoryPath);
    if (!repo.ok) return repo;
    const result = await runOk(['merge-base', leftSha, rightSha], repo.value);
    if (!result.ok) return result;
    return { ok: true, value: result.value.stdout.toString('utf8').trim() };
  }

  async function resolveCommit(
    repositoryPath: string,
    ref: string,
  ): Promise<GitResult<{ commitSha: string; treeSha: string }>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..'))
      return fail('invalid-path', 'Choose a local branch, tag or complete commit ID.');
    const repo = await canonicalDirectory(repositoryPath);
    if (!repo.ok) return repo;
    const commit = await runOk(
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      repo.value,
    );
    if (!commit.ok) return commit;
    const sha = commit.value.stdout.toString('utf8').trim();
    const tree = await runOk(['rev-parse', '--verify', `${sha}^{tree}`], repo.value);
    if (!tree.ok) return tree;
    return {
      ok: true,
      value: { commitSha: sha, treeSha: tree.value.stdout.toString('utf8').trim() },
    };
  }
  async function exportCommit(
    repositoryPath: string,
    commitSha: string,
  ): Promise<GitResult<readonly { path: string; content: Uint8Array; executable: boolean }[]>> {
    if (!/^[a-f0-9]{40,64}$/.test(commitSha))
      return fail('invalid-path', 'Dependency export requires an exact commit.');
    const repo = await canonicalDirectory(repositoryPath);
    if (!repo.ok) return repo;
    const listing = await runOk(['ls-tree', '-rz', '--full-tree', commitSha], repo.value);
    if (!listing.ok) return listing;
    const entries = splitNul(listing.value.stdout)
      .filter(Boolean)
      .map((line) => {
        const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(line);
        if (
          !match ||
          match[3]!
            .split('/')
            .some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') ||
          [...match[3]!].some((c) => c.charCodeAt(0) < 32 || c === '\\')
        )
          return undefined;
        return { path: match[3]!, sha: match[2]!, executable: match[1] === '100755' };
      });
    if (entries.length > 10000 || entries.some((e) => !e))
      return fail(
        'invalid-path',
        'Pinned sources require at most 10,000 regular files; links, submodules and unsafe paths are not supported.',
      );
    if (!entries.length) return { ok: true, value: [] };
    const batch = await run(
      ['cat-file', '--batch'],
      repo.value,
      `${entries.map((e) => e!.sha).join('\n')}\n`,
      64 * 1024 * 1024,
    );
    if (!batch.ok) return batch;
    if (batch.value.exitCode !== 0) return fail('git-failed', 'Could not export pinned sources.');
    let offset = 0;
    const files: { path: string; content: Uint8Array; executable: boolean }[] = [];
    for (const e of entries) {
      if (!e) continue;
      const end = batch.value.stdout.indexOf(10, offset),
        header = batch.value.stdout.subarray(offset, end).toString('ascii');
      const m = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(header),
        size = Number(m?.[2]);
      if (
        !m ||
        m[1] !== e.sha ||
        !Number.isSafeInteger(size) ||
        size > 16 * 1024 * 1024 ||
        end < offset ||
        end + 1 + size >= batch.value.stdout.length ||
        batch.value.stdout[end + 1 + size] !== 10
      )
        return fail(
          'output-overflow',
          'Pinned source export is incomplete or exceeds file limits.',
        );
      files.push({
        path: e.path,
        content: batch.value.stdout.subarray(end + 1, end + 1 + size),
        executable: e.executable,
      });
      offset = end + size + 2;
    }
    if (offset !== batch.value.stdout.length)
      return fail('git-failed', 'Unexpected data in source export.');
    return { ok: true, value: files };
  }

  async function readCommitFiles(
    repositoryPath: string,
    commitSha: string,
    paths: readonly string[],
  ): Promise<GitResult<ReadonlyMap<string, CommitFile>>> {
    if (!/^[a-f0-9]{40,64}$/.test(commitSha))
      return fail('invalid-path', 'Reading files requires an exact commit.');
    if (
      paths.length > 32 ||
      paths.some(
        (p) =>
          !p ||
          p.startsWith('/') ||
          p.includes('\0') ||
          p.split('/').some((s) => !s || s === '.' || s === '..'),
      )
    )
      return fail('invalid-path', 'Choose at most 32 repository paths.');
    const repo = await canonicalDirectory(repositoryPath);
    if (!repo.ok) return repo;
    const files = new Map<string, CommitFile>();
    if (!paths.length) return { ok: true, value: files };
    // `--literal-pathspecs`: a path names exactly one file, never a pattern.
    const listing = await runOk(
      ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commitSha, '--', ...paths],
      repo.value,
    );
    if (!listing.ok) return listing;
    const blobs: { path: string; sha: string; executable: boolean }[] = [];
    for (const line of splitNul(listing.value.stdout).filter(Boolean)) {
      const match =
        /^(100644|100755|120000|040000|160000) (blob|tree|commit) ([a-f0-9]{40,64})\t(.+)$/s.exec(
          line,
        );
      if (!match || !paths.includes(match[4]!)) continue;
      if (match[1] === '120000') files.set(match[4]!, { kind: 'link' });
      else if (match[2] === 'blob')
        blobs.push({ path: match[4]!, sha: match[3]!, executable: match[1] === '100755' });
    }
    for (const blob of blobs) {
      const content = await run(
        ['cat-file', 'blob', blob.sha],
        repo.value,
        undefined,
        16 * 1024 * 1024,
      );
      if (!content.ok) return content;
      if (content.value.exitCode !== 0) return fail('git-failed', `Could not read ${blob.path}.`);
      files.set(blob.path, {
        kind: 'file',
        content: content.value.stdout,
        executable: blob.executable,
      });
    }
    return { ok: true, value: files };
  }

  async function listBaselineTags(repositoryPath: string): Promise<GitResult<readonly string[]>> {
    const result = await runOk(['tag', '--list', '*/pre-*'], repositoryPath);
    if (!result.ok) return result;
    return {
      ok: true,
      value: result.value.stdout.toString('utf8').trim().split('\n').filter(Boolean).slice(0, 100),
    };
  }
  async function ensureBaselineTag(
    repositoryPath: string,
    tag: string,
    commitSha: string,
  ): Promise<GitResult<void>> {
    if (
      !isSafeBranchName(tag) ||
      !/^[^/]+\/pre-[A-Za-z0-9._-]+$/.test(tag) ||
      !/^[0-9a-f]{40,64}$/.test(commitSha)
    )
      return fail(
        'invalid-path',
        'Only explicit local baseline tags at exact commits are supported',
      );
    const ref = `refs/tags/${tag}`;
    const existing = await run(
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      repositoryPath,
    );
    if (!existing.ok) return existing;
    if (existing.value.exitCode === 0)
      return existing.value.stdout.toString('utf8').trim() === commitSha
        ? { ok: true, value: undefined }
        : fail('git-failed', 'Baseline tag already points to another commit; it will not be moved');
    const resolved = await resolveCommit(repositoryPath, commitSha);
    if (!resolved.ok) return resolved;
    const created = await runOk(
      ['update-ref', ref, commitSha, '0'.repeat(commitSha.length)],
      repositoryPath,
    );
    if (!created.ok) return created;
    return { ok: true, value: undefined };
  }
  return {
    listBaselineTags,
    ensureBaselineTag,
    resolveCommit,
    exportCommit,
    readCommitFiles,
    previewIntegration,
    prepareIntegrationResolution,
    inspectIntegrationResolution,
    finishIntegrationResolution,
    abortIntegrationResolution,
    inspectWorktreeChanges,
    checkpointWorktree,
    commonAncestor,
    resolveBranch,
    createBranch,
    isAncestor,
    updateWorktree,
    inspectRepository,
    createWorktree,
    removeWorktree,
    worktreeDiff,
    listBranches,
    branchHeads,
    mergeBranch,
    inspectMergeOperation,
    deleteBranch,
  };
}
