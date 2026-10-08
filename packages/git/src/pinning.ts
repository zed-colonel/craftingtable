import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { GitTrust } from './operations.js';

/** The Git directories a daemon command runs against, named explicitly (R-G14 review MEDIUM-1). */
export interface PinnedGitDirectories {
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  /** Absent for a bare repository. */
  readonly workTree?: string;
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The canonical path, or undefined when it cannot be resolved. */
function canonical(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The common directory a linked worktree's Git directory belongs to, from where Git puts it
 * (`<common>/worktrees/<name>`), never from its `commondir` file, which an agent may rewrite. A
 * Git directory that is not such an entry is its own common directory.
 */
export function commonDirectoryOf(gitDirectory: string): string {
  return basename(dirname(gitDirectory)) === 'worktrees'
    ? dirname(dirname(gitDirectory))
    : gitDirectory;
}

/**
 * The Git directories a checkout names: its `.git` directory, or the one its `.git` file points
 * to. Undefined when it has neither, or the pointer cannot be read.
 */
export function checkoutGitDirectories(checkout: string): PinnedGitDirectories | undefined {
  const dotGit = join(checkout, '.git');
  if (isDirectory(dotGit)) {
    const own = canonical(dotGit);
    return own === undefined
      ? undefined
      : { gitDirectory: own, commonDirectory: own, workTree: checkout };
  }
  let pointer: string;
  try {
    pointer = readFileSync(dotGit, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir: (.+)$/m.exec(pointer);
  const named =
    match?.[1] === undefined ? undefined : canonical(resolve(checkout, match[1].trim()));
  if (named === undefined || !isDirectory(named)) return undefined;
  return { gitDirectory: named, commonDirectory: commonDirectoryOf(named), workTree: checkout };
}

/**
 * Whether the Git directory's `commondir` file says what its place says: none in a repository's
 * own Git directory, and the directory it lies in for a linked worktree's entry.
 */
function commonDirectoryFileAgrees(named: PinnedGitDirectories): boolean {
  const file = join(named.gitDirectory, 'commondir');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !exists(file);
  }
  if (named.gitDirectory === named.commonDirectory) return false;
  return canonical(resolve(named.gitDirectory, text.trim())) === named.commonDirectory;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether a linked worktree entry's `gitdir` file names this checkout's `.git`. */
function namesCheckout(gitDirectory: string, checkout: string): boolean {
  try {
    const named = readFileSync(join(gitDirectory, 'gitdir'), 'utf8').trim();
    return canonical(named) === canonical(join(checkout, '.git'));
  } catch {
    return false;
  }
}

/**
 * The Git directories a daemon command in `cwd` runs against (R-G14 review MEDIUM-1):
 * - a checkout with a `.git` directory: that directory, as Git directory and common directory;
 * - a checkout with a `.git` file: the Git directory it names and, as common directory, the one
 *   that entry lies in; with `trust`, only when that is a trusted repository's, its `gitdir` file
 *   names this checkout back, and never a `.git` directory under a managed worktree root;
 * - a bare repository (no `.git`, but `HEAD`, `objects` and `refs`): itself;
 * - anything else (no repository yet, as before `init`): undefined, and Git finds its own way.
 * `'untrusted'` when `trust` refuses it.
 */
export function pinGitDirectories(
  cwd: string,
  trust: GitTrust | undefined,
): PinnedGitDirectories | 'untrusted' | undefined {
  const dotGit = join(cwd, '.git');
  let entry: ReturnType<typeof lstatSync> | undefined;
  try {
    entry = lstatSync(dotGit);
  } catch {
    entry = undefined;
  }
  const here = canonical(cwd) ?? cwd;
  const managed =
    trust?.worktreeRoots.some((root) => {
      const resolved = canonical(root) ?? root;
      return inside(here, resolved) && here !== resolved;
    }) === true;
  if (entry === undefined) {
    if (managed) return 'untrusted';
    if (
      ['HEAD', 'objects', 'refs'].every((name) => {
        try {
          lstatSync(join(cwd, name));
          return true;
        } catch {
          return false;
        }
      })
    ) {
      const own = canonical(cwd);
      return own === undefined ? undefined : { gitDirectory: own, commonDirectory: own };
    }
    return undefined;
  }
  if (entry.isDirectory() && managed) return 'untrusted';
  const named = checkoutGitDirectories(cwd);
  if (named === undefined) return trust === undefined ? undefined : 'untrusted';
  // Git's ref store reads a `commondir` file in the Git directory even when `GIT_COMMON_DIR` names
  // another (checked with Git 2.55), so a planted or rewritten one is refused, not overridden.
  if (!commonDirectoryFileAgrees(named)) return 'untrusted';
  if (trust === undefined || entry.isDirectory()) return named;
  const trusted = trust.commonDirectories.map((path) => canonical(path) ?? path);
  if (!trusted.includes(named.commonDirectory)) return 'untrusted';
  if (named.gitDirectory !== named.commonDirectory && !namesCheckout(named.gitDirectory, cwd))
    return 'untrusted';
  return named;
}
