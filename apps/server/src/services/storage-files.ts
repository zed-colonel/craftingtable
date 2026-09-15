import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { StorageRootIdentity } from '@craftingtable/storage';
import { ExecutionRequestError } from './errors.js';
export const GiB = 1024 ** 3;
export function within(path: string, parent: string): boolean {
  const delta = relative(parent, path);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}
export const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);
export function resolveRoot(path: string): StorageRootIdentity {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === '/' ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new ExecutionRequestError(
      'invalid-request',
      'Storage locations must be normalized absolute directory paths.',
    );
  if (!existsSync(path)) {
    const parent = realpathSync(dirname(path));
    accessSync(parent, constants.R_OK | constants.W_OK | constants.X_OK);
    return { path: join(parent, basename(path)), device: statSync(parent).dev };
  }
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory())
    throw new ExecutionRequestError('invalid-request', 'Storage location must be a directory.');
  accessSync(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
  return { path: canonical, device: statSync(canonical).dev };
}
export function prepareRoot(path: string): StorageRootIdentity {
  const root = resolveRoot(path);
  // Only create one leaf: never recreate a missing mount and silently fill its parent disk.
  if (!existsSync(root.path)) mkdirSync(root.path, { mode: 0o700 });
  checkRoot(root);
  return root;
}
export function checkRoot(root: StorageRootIdentity): void {
  if (
    realpathSync(root.path) !== root.path ||
    !statSync(root.path).isDirectory() ||
    statSync(root.path).dev !== root.device
  )
    throw new ExecutionRequestError(
      'unavailable',
      `Storage volume changed or is unavailable: ${root.path}. Restore the mount before continuing.`,
    );
}
export function requireFree(root: StorageRootIdentity, minimumBytes: number): void {
  try {
    checkRoot(root);
    const volume = statfsSync(root.path);
    if (volume.bavail * volume.bsize < minimumBytes)
      throw new ExecutionRequestError(
        'unavailable',
        `Storage has less than ${(minimumBytes / GiB).toFixed(1)} GiB free at ${root.path}. Use Storage settings to reclaim caches or choose another disk, then retry.`,
      );
  } catch (error) {
    if (error instanceof ExecutionRequestError) throw error;
    throw new ExecutionRequestError(
      'unavailable',
      `Storage is unavailable at ${root.path}. Restore the volume before continuing.`,
    );
  }
}
/** Never follow links or cross filesystem boundaries during inventory. */
export async function directoryBytes(path: string, device?: number): Promise<number> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) return 0;
  const expected = device ?? entry.dev;
  if (entry.dev !== expected) throw new Error(`Skipped a nested mount at ${path}`);
  if (!entry.isDirectory()) return entry.blocks * 512;
  let bytes = entry.blocks * 512;
  for (const name of await readdir(path)) bytes += await directoryBytes(join(path, name), expected);
  return bytes;
}
export interface BuildCache {
  readonly path: string;
  readonly runId: string;
  readonly bytes: number;
  readonly device: number;
  readonly inode: number;
  readonly kind: 'build' | 'scratch';
}
export async function cargoCaches(run: {
  path: string;
  runId: string;
  device: number;
}): Promise<BuildCache[]> {
  if (!existsSync(run.path)) return [];
  checkRoot({ path: run.path, device: run.device });
  const scratch = join(run.path, 'scratch');
  if (!existsSync(scratch)) return [];
  if (lstatSync(scratch).isSymbolicLink() || realpathSync(scratch) !== scratch) return [];
  const caches: BuildCache[] = [];
  let visited = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (++visited > 10000) throw new Error('Scratch cache inventory limit reached; retained.');
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== run.device) return;
    const tag = join(path, 'CACHEDIR.TAG');
    if (!existsSync(tag)) {
      if (depth > 0)
        for (const child of await readdir(path, { withFileTypes: true }))
          if (child.isDirectory() && !child.isSymbolicLink())
            await visit(join(path, child.name), depth - 1);
      return;
    }
    try {
      const compiler = join(path, '.rustc_info.json');
      if (
        (await lstat(tag)).isSymbolicLink() ||
        !(await lstat(tag)).isFile() ||
        (await lstat(tag)).size > 4096
      )
        return;
      if (!(await lstat(compiler)).isFile() || (await lstat(compiler)).isSymbolicLink()) return;
      const fingerprint = ['debug', 'release']
        .map((profile) => join(path, profile, '.fingerprint'))
        .find((p) => existsSync(p) && realpathSync(p) === p && lstatSync(p).isDirectory());
      if (!fingerprint) return;
      const text = await readFile(tag, 'utf8');
      if (
        !text.startsWith('Signature: 8a477f597d28d172789f06886806bc55\n') ||
        !text.includes('cache directory tag created by cargo')
      )
        return;
      caches.push({
        kind: 'build',
        path,
        runId: run.runId,
        device: entry.dev,
        inode: entry.ino,
        bytes: await directoryBytes(path, run.device),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  await visit(scratch, 4);
  return caches;
}

async function latestModification(path: string, device: number): Promise<number> {
  const entry = await lstat(path);
  if (entry.dev !== device) throw new Error('Scratch contains a nested mount; retained.');
  let latest = entry.mtimeMs;
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    for (const name of await readdir(path))
      latest = Math.max(latest, await latestModification(join(path, name), device));
  }
  return latest;
}
export async function cleanupCandidates(
  run: { path: string; runId: string; device: number; retainedSince: string },
  retentionDays: 0 | 30,
  now: Date,
): Promise<BuildCache[]> {
  if (!existsSync(run.path)) return [];
  checkRoot({ path: run.path, device: run.device });
  const scratch = join(run.path, 'scratch');
  if (
    retentionDays &&
    existsSync(scratch) &&
    !lstatSync(scratch).isSymbolicLink() &&
    realpathSync(scratch) === scratch
  ) {
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    if (
      Date.parse(run.retainedSince) <= cutoff &&
      (await latestModification(scratch, run.device)) <= cutoff
    ) {
      const entry = await lstat(scratch);
      if (entry.isDirectory())
        return [
          {
            kind: 'scratch',
            path: scratch,
            runId: run.runId,
            device: entry.dev,
            inode: entry.ino,
            bytes: await directoryBytes(scratch, run.device),
          },
        ];
    }
  }
  return cargoCaches(run);
}
