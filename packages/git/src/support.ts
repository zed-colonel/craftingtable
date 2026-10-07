import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { GitFailure, GitFailureKind, GitResult } from './operations.js';

/** Helpers every Git module shares; none of them runs a process. */

/** How many uncommitted paths a refused removal or promotion reports. */
export const CHANGED_PATH_LIMIT = 50;

export const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
/** A full tree object name, SHA-1 or SHA-256, as `merge-tree --write-tree` prints it. */
export const TREE_OID = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export function isSafeBranchName(value: string): boolean {
  return (
    BRANCH_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.lock') &&
    !value.endsWith('/')
  );
}

export function failure(
  kind: GitFailureKind,
  message: string,
  extra: Partial<GitFailure> = {},
): GitFailure {
  return { kind, message, ...extra };
}

export function fail<T>(
  kind: GitFailureKind,
  message: string,
  extra: Partial<GitFailure> = {},
): GitResult<T> {
  return { ok: false, failure: failure(kind, message, extra) };
}

/** NUL-separated entries as their raw bytes: a name need not be UTF-8. */
export function splitNulBytes(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let end = buffer.indexOf(0); end >= 0; end = buffer.indexOf(0, start)) {
    parts.push(buffer.subarray(start, end));
    start = end + 1;
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

export function splitNul(buffer: Buffer): string[] {
  const text = buffer.toString('utf8');
  const parts = text.split('\0');
  if (parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
}

/** Up to five paths for a message, and how many more there are. */
export function namedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(', ');
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

/** An absolute, existing directory, with links resolved. */
export async function canonicalDirectory(path: string): Promise<GitResult<string>> {
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
