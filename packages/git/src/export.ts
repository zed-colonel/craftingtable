import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GitResult, CommitFile, GitOperations } from './operations.js';
import type { GitRunner } from './runner.js';
import { fail, splitNul, canonicalDirectory } from './support.js';

/** An exact commit's files, read through a verified pack. */

/**
 * The files of an exact commit, read through a pack (R-G13 increment 2, operator decision
 * 2026-09-30). Git never re-hashes an object it reads from a store, and agents can write the
 * repositories' stores, so the commit is fetched into a daemon-private repository first: a
 * fetch receives a pack, whose objects Git hashes on receipt, and a rewritten object fails.
 * With `treeSha`, the commit's tree must be the pin's.
 */
export async function exportCommit(
  ctx: GitRunner,
  repositoryPath: string,
  commitSha: string,
  treeSha?: string,
): Promise<GitResult<readonly { path: string; content: Uint8Array; executable: boolean }[]>> {
  if (!/^[a-f0-9]{40,64}$/.test(commitSha))
    return fail('invalid-path', 'Dependency export requires an exact commit.');
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  const common = await ctx.runOk(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    repo.value,
  );
  if (!common.ok) return common;
  const scratch = await mkdtemp(join(tmpdir(), 'ct-pinned-source-'));
  try {
    const init = await ctx.runOk(['init', '--quiet', '--bare', scratch], scratch);
    if (!init.ok) return init;
    // By exact commit, reachable or not: protocol v2 serves any object id (a local
    // upload-pack is given none of the daemon's configuration, so v0 could not).
    const fetched = await ctx.run(
      [
        '-c',
        'protocol.version=2',
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        pathToFileURL(common.value.stdout.toString('utf8').trim()).href,
        `${commitSha}:refs/pinned/source`,
      ],
      scratch,
    );
    if (!fetched.ok) return fetched;
    if (fetched.value.exitCode !== 0)
      return fail('git-failed', 'The pinned commit could not be read through a verified pack.');
    if (treeSha !== undefined) {
      const tree = await ctx.runOk(['rev-parse', '--verify', `${commitSha}^{tree}`], scratch);
      if (!tree.ok) return tree;
      if (tree.value.stdout.toString('utf8').trim() !== treeSha)
        return fail('git-failed', 'The pinned commit does not hold the pinned tree.');
    }
    return await exportVerifiedCommit(ctx, scratch, commitSha);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function exportVerifiedCommit(
  ctx: GitRunner,
  repository: string,
  commitSha: string,
): Promise<GitResult<readonly { path: string; content: Uint8Array; executable: boolean }[]>> {
  const repo = { value: repository };
  const listing = await ctx.runOk(['ls-tree', '-rz', '--full-tree', commitSha], repo.value);
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
  const batch = await ctx.run(['cat-file', '--batch'], repo.value, {
    input: `${entries.map((e) => e!.sha).join('\n')}\n`,
    limit: 64 * 1024 * 1024,
  });
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
      return fail('output-overflow', 'Pinned source export is incomplete or exceeds file limits.');
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

/** Every path an exact commit tracks (R-G13 posture review): names only, no contents. */
export async function listCommitPaths(
  ctx: GitRunner,
  repositoryPath: string,
  commitSha: string,
): Promise<GitResult<readonly string[]>> {
  if (!/^[a-f0-9]{40,64}$/.test(commitSha))
    return fail('invalid-path', 'Listing files requires an exact commit.');
  const repo = await canonicalDirectory(repositoryPath);
  if (!repo.ok) return repo;
  const listing = await ctx.run(
    ['ls-tree', '-rz', '--name-only', '--full-tree', commitSha],
    repo.value,
    { limit: 64 * 1024 * 1024 },
  );
  if (!listing.ok) return listing;
  if (listing.value.exitCode !== 0) return fail('git-failed', 'Could not list the commit.');
  return { ok: true, value: splitNul(listing.value.stdout) };
}

export async function readCommitFiles(
  ctx: GitRunner,
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
  const listing = await ctx.runOk(
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
    const content = await ctx.run(['cat-file', 'blob', blob.sha], repo.value, {
      limit: 16 * 1024 * 1024,
    });
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

/** The operations of this module, bound to one runner, as `createGitOperations` spreads them. */
export const exportOperations = (
  ctx: GitRunner,
): Pick<GitOperations, 'exportCommit' | 'listCommitPaths' | 'readCommitFiles'> => ({
  exportCommit: exportCommit.bind(undefined, ctx),
  listCommitPaths: listCommitPaths.bind(undefined, ctx),
  readCommitFiles: readCommitFiles.bind(undefined, ctx),
});
