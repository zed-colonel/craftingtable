import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { inspectRepository } from './worktrees.js';
import type {
  GitResult,
  DiffFile,
  DiffFileStatus,
  DiffCommit,
  WorktreeDiff,
  WorktreeChanges,
  WorktreeSnapshot,
  GitOperations,
} from './operations.js';
import type { GitRunner } from './runner.js';
import { fail, SHA_PATTERN, splitNul, canonicalDirectory } from './support.js';

/** A worktree's diff, changes and snapshot. */

/** The files directly in `directory`, sorted; none when it is absent. */
async function directoryFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort().map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/**
 * One digest of `entries` (paths under `root`, or absolute): each entry's type and mode, a
 * link's target, and a file's contents while the budget lasts, its size and modification time
 * after that. A directory is its own entry, never walked; an absent entry is recorded absent.
 */
async function entriesDigest(
  root: string,
  entries: readonly string[],
  budget: { bytes: number; metadataOnly: number },
): Promise<string> {
  const hash = createHash('sha256');
  const listed = [...entries].sort();
  for (const entry of listed.slice(0, SNAPSHOT_ENTRIES)) {
    const path = isAbsolute(entry) ? entry : join(root, entry.replace(/\/$/, ''));
    hash.update(`${entry}\0`);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch {
      hash.update('absent\0');
      continue;
    }
    hash.update(`${info.mode}\0`);
    if (info.isSymbolicLink()) hash.update(`link ${await readlink(path)}\0`);
    else if (info.isDirectory()) hash.update(`directory ${info.mtimeMs}\0`);
    else if (info.isFile() && info.size <= SNAPSHOT_FILE_BYTES && info.size <= budget.bytes) {
      budget.bytes -= info.size;
      hash.update(
        `file ${createHash('sha256')
          .update(await readFile(path))
          .digest('hex')}\0`,
      );
    } else {
      budget.metadataOnly += 1;
      hash.update(`metadata ${info.size} ${info.mtimeMs}\0`);
    }
  }
  if (listed.length > SNAPSHOT_ENTRIES) {
    budget.metadataOnly += listed.length - SNAPSHOT_ENTRIES;
    hash.update(`and ${listed.length - SNAPSHOT_ENTRIES} more\0`);
  }
  return hash.digest('hex');
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

/** The first `maxBytes` of a patch, taken chunk by chunk; past them it asks to stop. */
export function patchCollector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    take: (chunk: Buffer): 'stop' | undefined => {
      if (truncated) return 'stop';
      const room = maxBytes - bytes;
      if (chunk.byteLength <= room) {
        chunks.push(chunk);
        bytes += chunk.byteLength;
        return undefined;
      }
      chunks.push(chunk.subarray(0, Math.max(0, room)));
      bytes = maxBytes;
      truncated = true;
      return 'stop';
    },
    truncated: () => truncated,
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Bounds on what a snapshot reads (R-C16): past them, files are compared by metadata. */
const SNAPSHOT_FILE_BYTES = 1024 * 1024;

const SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024;

const SNAPSHOT_ENTRIES = 20_000;

/**
 * Untracked files' line counts, and their patch appended to `patch`, from one diff (R-G10):
 * the paths are added as intent-to-add to a copy of the worktree's index in a daemon temp
 * file, which `GIT_INDEX_FILE` names for those commands alone, so a diff of that index
 * against the working tree shows them as new files. The worktree's own index never changes.
 */
export async function untrackedPass(
  ctx: GitRunner,
  cwd: string,
  paths: readonly string[],
  patch: ReturnType<typeof patchCollector>,
): Promise<GitResult<Map<string, { additions: number; binary: boolean }>>> {
  const counts = new Map<string, { additions: number; binary: boolean }>();
  if (paths.length === 0) return { ok: true, value: counts };
  const index = await ctx.runOk(
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
    cwd,
  );
  if (!index.ok) return index;
  const scratch = await mkdtemp(join(tmpdir(), 'ct-untracked-index-'));
  const indexFile = join(scratch, 'index');
  try {
    try {
      await copyFile(index.value.stdout.toString('utf8').trim(), indexFile);
    } catch (error) {
      return fail('git-failed', error instanceof Error ? error.message : 'index copy failed');
    }
    const added = await ctx.runOk(
      [
        // A split index would write its shared part into the repository's Git directory.
        '-c',
        'core.splitIndex=false',
        '--literal-pathspecs',
        'add',
        '--intent-to-add',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      cwd,
      [0],
      { input: paths.join('\0'), indexFile },
    );
    if (!added.ok) return added;
    // Index against working tree: only the intent-to-add entries are additions.
    const newFiles = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-filter=A'];
    const numstat = await ctx.runOk([...newFiles, '--numstat', '-z', '--'], cwd, [0], {
      indexFile,
    });
    if (!numstat.ok) return numstat;
    const wanted = new Set(paths);
    for (const entry of splitNul(numstat.value.stdout)) {
      const [added = '-', , path = ''] = entry.split('\t');
      if (!wanted.has(path)) continue;
      const binary = added === '-';
      counts.set(path, { additions: binary ? 0 : Number(added), binary });
    }
    if (!patch.truncated()) {
      const streamed = await ctx.stream([...newFiles, '--'], cwd, patch.take, [0], { indexFile });
      if (!streamed.ok) return streamed;
    }
    return { ok: true, value: counts };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function worktreeDiff(
  ctx: GitRunner,
  input: {
    readonly worktreePath: string;
    readonly baseSha: string;
    readonly maxPatchBytes: number;
  },
): Promise<GitResult<WorktreeDiff>> {
  const worktree = await canonicalDirectory(input.worktreePath);
  if (!worktree.ok) return worktree;
  if (!SHA_PATTERN.test(input.baseSha)) {
    return fail('invalid-path', 'Base revision must be a hex object name');
  }
  const cwd = worktree.value;

  const head = await ctx.runOk(['rev-parse', '--verify', 'HEAD'], cwd);
  if (!head.ok) return head;
  const headSha = head.value.stdout.toString('utf8').trim();

  const log = await ctx.runOk(
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

  const nameStatus = await ctx.runOk(
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
  const numstat = await ctx.runOk(
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
  const untracked = await ctx.runOk(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
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
  // The patch streams, keeping its first `maxPatchBytes` (R-G10, GIT-03).
  const patch = patchCollector(input.maxPatchBytes);
  const tracked = await ctx.stream(
    ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', input.baseSha, '--'],
    cwd,
    patch.take,
  );
  if (!tracked.ok) return tracked;

  // Every untracked file, in one pass whatever their number (R-G10, GIT-03). A nested
  // repository lists as a directory (`name/`) and is counted without a patch.
  const untrackedCounts = await untrackedPass(
    ctx,
    cwd,
    untrackedPaths.filter((path) => !path.endsWith('/')),
    patch,
  );
  if (!untrackedCounts.ok) return untrackedCounts;
  for (const path of untrackedPaths)
    files.push({
      path,
      status: 'untracked',
      additions: 0,
      deletions: 0,
      binary: false,
      ...untrackedCounts.value.get(path),
    });
  const patchTruncated = patch.truncated();

  return {
    ok: true,
    value: {
      baseSha: input.baseSha,
      headSha,
      commits,
      files,
      patch: patch.text(),
      patchTruncated,
    },
  };
}

export async function inspectWorktreeChanges(
  ctx: GitRunner,
  path: string,
): Promise<GitResult<WorktreeChanges>> {
  const identity = await inspectRepository(ctx, path);
  if (!identity.ok) return identity;
  // Hashed as it streams (R-G10): a change of any size has a fingerprint.
  const fingerprint = await ctx.hashDiff(
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
  if (!fingerprint.ok) return fingerprint;
  const names = await ctx.runOk(
    ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD', '--'],
    path,
  );
  if (!names.ok) return names;
  const untracked = await ctx.runOk(['ls-files', '--others', '--exclude-standard', '-z'], path);
  if (!untracked.ok) return untracked;
  const trackedStatus = await ctx.runOk(
    ['status', '--porcelain', '-z', '--untracked-files=no'],
    path,
  );
  if (!trackedStatus.ok) return trackedStatus;
  const conflicts = await ctx.runOk(['ls-files', '--unmerged', '-z'], path);
  if (!conflicts.ok) return conflicts;
  let pendingOperation = false;
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const pending = await ctx.run(['rev-parse', '--verify', ref], path);
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
      fingerprint: fingerprint.value,
      conflicted: conflicts.value.stdout.length > 0 || pendingOperation,
    },
  };
}

export async function snapshotWorktree(
  ctx: GitRunner,
  path: string,
): Promise<GitResult<WorktreeSnapshot>> {
  const changes = await inspectWorktreeChanges(ctx, path);
  if (!changes.ok) return changes;
  const ignored = await ctx.runOk(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    path,
  );
  if (!ignored.ok) return ignored;
  const directories = await ctx.runOk(
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    path,
  );
  if (!directories.ok) return directories;
  const [gitDir, commonDir] = directories.value.stdout.toString('utf8').trim().split('\n');
  if (!gitDir || !commonDir) return fail('git-failed', 'Git did not name its directories');
  const budget = { bytes: SNAPSHOT_TOTAL_BYTES, metadataOnly: 0 };
  const untracked = changes.value.untracked;
  const ignoredEntries = splitNul(ignored.value.stdout);
  // A linked worktree's `.git` is a file naming its Git directory; a main worktree's is that
  // directory, whose own entry every commit touches.
  const pointer = join(path, '.git');
  const pointerIsFile = await lstat(pointer).then(
    (info) => info.isFile(),
    () => false,
  );
  const gitFiles = [
    join(commonDir, 'config'),
    join(gitDir, 'config.worktree'),
    ...(pointerIsFile ? [pointer] : []),
    ...(await directoryFiles(join(commonDir, 'hooks'))),
    ...(await directoryFiles(join(commonDir, 'info'))),
  ];
  return {
    ok: true,
    value: {
      headSha: changes.value.headSha,
      branch: changes.value.branch,
      fingerprint: changes.value.fingerprint,
      trackedClean: changes.value.trackedClean,
      untrackedDigest: await entriesDigest(path, untracked, budget),
      ignoredDigest: await entriesDigest(path, ignoredEntries, budget),
      gitDigest: await entriesDigest('/', gitFiles, budget),
      metadataOnly: budget.metadataOnly,
      changedPaths: [...changes.value.paths, ...untracked].slice(0, 20),
    },
  };
}

/** The operations of this module, bound to one runner, as `createGitOperations` spreads them. */
export const diffOperations = (
  ctx: GitRunner,
): Pick<GitOperations, 'worktreeDiff' | 'inspectWorktreeChanges' | 'snapshotWorktree'> => ({
  worktreeDiff: worktreeDiff.bind(undefined, ctx),
  inspectWorktreeChanges: inspectWorktreeChanges.bind(undefined, ctx),
  snapshotWorktree: snapshotWorktree.bind(undefined, ctx),
});
