import { constants } from 'node:fs';
import type { BigIntStats, Dirent } from 'node:fs';
import {
  access as nodeAccess,
  lstat as nodeLstat,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
  stat as nodeStat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { createGitCeilingDirectory, isGitCeilingDirectoryRepresentable } from './environment.js';
import type { GitCeilingDirectory } from './environment.js';
import { createInspectionError } from './types.js';
import type { RepositoryInspectionError } from './types.js';

declare const canonicalPathBrand: unique symbol;

export type CanonicalPath = string & {
  readonly [canonicalPathBrand]: true;
};

export function asCanonicalPath(path: string): CanonicalPath {
  return path as CanonicalPath;
}

export interface FileSystemBoundary {
  readonly lstat: (path: string) => Promise<BigIntStats>;
  readonly stat: (path: string) => Promise<BigIntStats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly readdir: (path: string) => Promise<readonly Dirent[]>;
  readonly access: (path: string, mode: number) => Promise<void>;
}

export const NODE_FILE_SYSTEM_BOUNDARY: FileSystemBoundary = {
  lstat: async (path) => await nodeLstat(path, { bigint: true }),
  stat: async (path) => await nodeStat(path, { bigint: true }),
  realpath: nodeRealpath,
  readdir: async (path) => await nodeReaddir(path, { withFileTypes: true }),
  access: nodeAccess,
};

export interface RootPolicy {
  readonly allowedSourceRoots: readonly CanonicalPath[];
  readonly reservedRoots: readonly CanonicalPath[];
}

export interface PathSnapshot {
  readonly path: string;
  readonly kind: 'directory' | 'file' | 'symlink' | 'other';
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNanoseconds: string;
}

export interface AdmittedRepositoryPath {
  readonly canonicalTopLevel: CanonicalPath;
  readonly canonicalGitDirectory: CanonicalPath;
  readonly ceilingDirectory: GitCeilingDirectory;
  readonly sourceRoot: CanonicalPath;
  readonly ancestorCandidates: readonly string[];
  readonly hooksDirectorySymlink: boolean;
  readonly snapshots: readonly PathSnapshot[];
}

export type RootPolicyResult =
  | { readonly ok: true; readonly policy: RootPolicy }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

export type PathAdmissionResult =
  | { readonly ok: true; readonly admitted: AdmittedRepositoryPath }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

export type InspectionCheckpoint = () => RepositoryInspectionError | undefined;

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['EACCES', 'EPERM'].includes(String((error as { readonly code?: unknown }).code))
  );
}

function isNormalizedAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !value.includes('\0') &&
    isAbsolute(value) &&
    normalize(value) === value &&
    resolve(value) === value
  );
}

function kindOf(metadata: BigIntStats): PathSnapshot['kind'] {
  if (metadata.isDirectory()) {
    return 'directory';
  }
  if (metadata.isFile()) {
    return 'file';
  }
  if (metadata.isSymbolicLink()) {
    return 'symlink';
  }
  return 'other';
}

function snapshot(path: string, metadata: BigIntStats): PathSnapshot {
  return {
    path,
    kind: kindOf(metadata),
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    mtimeNanoseconds: metadata.mtimeNs.toString(),
  };
}

function componentPaths(path: string): readonly string[] {
  const root = path.slice(0, path.indexOf(sep) + 1);
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  const paths = [root];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    paths.push(current);
  }
  return paths;
}

function equalOrWithin(candidate: string, parent: string): boolean {
  const delta = relative(parent, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

export function pathsOverlap(left: string, right: string): boolean {
  return equalOrWithin(left, right) || equalOrWithin(right, left);
}

async function validateConfiguredPath(
  path: string,
  requireExisting: boolean,
  fs: FileSystemBoundary,
): Promise<boolean> {
  if (!isNormalizedAbsolutePath(path)) {
    return false;
  }

  let complete = true;
  for (const component of componentPaths(path)) {
    let metadata: BigIntStats;
    try {
      metadata = await fs.lstat(component);
    } catch (error) {
      if (!requireExisting && isMissing(error)) {
        complete = false;
        break;
      }
      return false;
    }
    if (metadata.isSymbolicLink()) {
      return false;
    }
  }

  if (!complete) {
    return true;
  }

  try {
    const resolved = await fs.realpath(path);
    const metadata = await fs.stat(path);
    return resolved === path && metadata.isDirectory();
  } catch {
    return false;
  }
}

export async function createRootPolicy(
  allowedSourceRoots: readonly string[],
  reservedRoots: readonly string[],
  fs: FileSystemBoundary = NODE_FILE_SYSTEM_BOUNDARY,
): Promise<RootPolicyResult> {
  if (
    allowedSourceRoots.length < 1 ||
    allowedSourceRoots.length > 32 ||
    reservedRoots.length > 32
  ) {
    return {
      ok: false,
      error: createInspectionError('invalid-root-policy', 'create-inspector'),
    };
  }

  for (const root of allowedSourceRoots) {
    if (
      !isGitCeilingDirectoryRepresentable(root) ||
      !(await validateConfiguredPath(root, true, fs))
    ) {
      return {
        ok: false,
        error: createInspectionError('invalid-root-policy', 'create-inspector'),
      };
    }
  }
  for (const root of reservedRoots) {
    if (!(await validateConfiguredPath(root, false, fs))) {
      return {
        ok: false,
        error: createInspectionError('invalid-root-policy', 'create-inspector'),
      };
    }
  }

  const allSets = [allowedSourceRoots, reservedRoots];
  for (const paths of allSets) {
    for (let left = 0; left < paths.length; left += 1) {
      for (let right = left + 1; right < paths.length; right += 1) {
        const leftPath = paths[left];
        const rightPath = paths[right];
        if (
          leftPath !== undefined &&
          rightPath !== undefined &&
          pathsOverlap(leftPath, rightPath)
        ) {
          return {
            ok: false,
            error: createInspectionError('invalid-root-policy', 'create-inspector'),
          };
        }
      }
    }
  }
  for (const sourceRoot of allowedSourceRoots) {
    for (const reservedRoot of reservedRoots) {
      if (pathsOverlap(sourceRoot, reservedRoot)) {
        return {
          ok: false,
          error: createInspectionError('invalid-root-policy', 'create-inspector'),
        };
      }
    }
  }

  return {
    ok: true,
    policy: {
      allowedSourceRoots: Object.freeze(allowedSourceRoots.map(asCanonicalPath)),
      reservedRoots: Object.freeze(reservedRoots.map(asCanonicalPath)),
    },
  };
}

async function findAncestorCandidates(
  request: string,
  sourceRoot: string,
  fs: FileSystemBoundary,
  checkpoint: InspectionCheckpoint,
): Promise<readonly string[]> {
  const candidates: string[] = [];
  let current = dirname(request);
  while (equalOrWithin(current, sourceRoot)) {
    const checkpointError = checkpoint();
    if (checkpointError !== undefined) {
      throw checkpointError;
    }
    try {
      await fs.lstat(join(current, '.git'));
      candidates.push(current);
    } catch {
      // Missing or unreadable ancestor markers do not admit the requested path.
    }
    if (current === sourceRoot) {
      break;
    }
    current = dirname(current);
  }
  return candidates;
}

async function requireReadable(
  path: string,
  fs: FileSystemBoundary,
): Promise<RepositoryInspectionError | undefined> {
  try {
    await fs.access(path, constants.R_OK);
    return undefined;
  } catch {
    return createInspectionError('repository-metadata-unreadable', 'inspect-path');
  }
}

export async function admitRepositoryPath(
  requestedPath: string,
  policy: RootPolicy,
  effectiveUid: number,
  checkpoint: InspectionCheckpoint,
  fs: FileSystemBoundary = NODE_FILE_SYSTEM_BOUNDARY,
): Promise<PathAdmissionResult> {
  const initialCheckpointError = checkpoint();
  if (initialCheckpointError !== undefined) {
    return { ok: false, error: initialCheckpointError };
  }
  if (!isNormalizedAbsolutePath(requestedPath)) {
    return { ok: false, error: createInspectionError('invalid-path', 'inspect-path') };
  }
  if (!isGitCeilingDirectoryRepresentable(dirname(requestedPath))) {
    return {
      ok: false,
      error: createInspectionError('invalid-path', 'inspect-path', {
        reason: 'ambiguous-git-ceiling',
      }),
    };
  }

  const sourceRoots = policy.allowedSourceRoots.filter(
    (root) => requestedPath !== root && equalOrWithin(requestedPath, root),
  );
  if (sourceRoots.length !== 1) {
    return {
      ok: false,
      error: createInspectionError('outside-allowed-root', 'inspect-path'),
    };
  }
  const sourceRoot = sourceRoots[0];
  if (sourceRoot === undefined) {
    return {
      ok: false,
      error: createInspectionError('outside-allowed-root', 'inspect-path'),
    };
  }
  if (policy.reservedRoots.some((root) => pathsOverlap(requestedPath, root))) {
    return {
      ok: false,
      error: createInspectionError('reserved-root-overlap', 'inspect-path'),
    };
  }

  for (const component of componentPaths(requestedPath)) {
    const checkpointError = checkpoint();
    if (checkpointError !== undefined) {
      return { ok: false, error: checkpointError };
    }
    try {
      const metadata = await fs.lstat(component);
      if (metadata.isSymbolicLink()) {
        return { ok: false, error: createInspectionError('symlink-rejected', 'inspect-path') };
      }
    } catch (error) {
      return {
        ok: false,
        error: createInspectionError(
          isPermissionError(error) ? 'repository-metadata-unreadable' : 'path-unavailable',
          'inspect-path',
        ),
      };
    }
  }

  let topMetadata: BigIntStats;
  try {
    if ((await fs.realpath(requestedPath)) !== requestedPath) {
      return { ok: false, error: createInspectionError('symlink-rejected', 'inspect-path') };
    }
    topMetadata = await fs.lstat(requestedPath);
    if (!topMetadata.isDirectory()) {
      return { ok: false, error: createInspectionError('path-unavailable', 'inspect-path') };
    }
  } catch (error) {
    return {
      ok: false,
      error: createInspectionError(
        isPermissionError(error) ? 'repository-metadata-unreadable' : 'path-unavailable',
        'inspect-path',
      ),
    };
  }

  let ancestorCandidates: readonly string[];
  try {
    ancestorCandidates = await findAncestorCandidates(requestedPath, sourceRoot, fs, checkpoint);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return { ok: false, error: error as RepositoryInspectionError };
    }
    return { ok: false, error: createInspectionError('path-unavailable', 'inspect-path') };
  }

  const gitDirectory = join(requestedPath, '.git');
  let gitMetadata: BigIntStats;
  try {
    gitMetadata = await fs.lstat(gitDirectory);
  } catch (error) {
    let bareLayout = false;
    if (isMissing(error)) {
      try {
        const [head, objects, refs] = await Promise.all([
          fs.lstat(join(requestedPath, 'HEAD')),
          fs.lstat(join(requestedPath, 'objects')),
          fs.lstat(join(requestedPath, 'refs')),
        ]);
        bareLayout = head.isFile() && objects.isDirectory() && refs.isDirectory();
      } catch {
        bareLayout = false;
      }
    }
    return {
      ok: false,
      error: createInspectionError(
        isMissing(error) && ancestorCandidates.length === 0 && !bareLayout
          ? 'not-git-repository'
          : 'not-primary-repository',
        'inspect-path',
      ),
    };
  }
  if (!gitMetadata.isDirectory()) {
    return {
      ok: false,
      error: createInspectionError(
        gitMetadata.isSymbolicLink() ? 'symlink-rejected' : 'not-primary-repository',
        'inspect-path',
      ),
    };
  }

  try {
    await fs.lstat(join(gitDirectory, 'commondir'));
    return {
      ok: false,
      error: createInspectionError('not-primary-repository', 'inspect-path'),
    };
  } catch (error) {
    if (!isMissing(error)) {
      return {
        ok: false,
        error: createInspectionError('repository-metadata-unreadable', 'inspect-path'),
      };
    }
  }

  const configPath = join(gitDirectory, 'config');
  let configMetadata: BigIntStats | undefined;
  try {
    configMetadata = await fs.lstat(configPath);
    if (configMetadata.isSymbolicLink()) {
      return { ok: false, error: createInspectionError('symlink-rejected', 'inspect-path') };
    }
    if (!configMetadata.isFile()) {
      return {
        ok: false,
        error: createInspectionError('repository-metadata-unreadable', 'inspect-path'),
      };
    }
  } catch (error) {
    if (!isMissing(error) || ancestorCandidates.length === 0) {
      return {
        ok: false,
        error: createInspectionError('repository-metadata-unreadable', 'inspect-path'),
      };
    }
  }
  if (configMetadata !== undefined) {
    const configReadError = await requireReadable(configPath, fs);
    if (configReadError !== undefined) {
      return { ok: false, error: configReadError };
    }
  }

  const hooksPath = join(gitDirectory, 'hooks');
  let hooksMetadata: BigIntStats | undefined;
  try {
    hooksMetadata = await fs.lstat(hooksPath);
  } catch (error) {
    if (!isMissing(error)) {
      return {
        ok: false,
        error: createInspectionError('repository-metadata-unreadable', 'inspect-path'),
      };
    }
  }
  const hooksDirectorySymlink = hooksMetadata?.isSymbolicLink() ?? false;
  if (hooksMetadata !== undefined && !hooksDirectorySymlink && !hooksMetadata.isDirectory()) {
    return {
      ok: false,
      error: createInspectionError('repository-metadata-unreadable', 'inspect-path'),
    };
  }
  if (hooksMetadata !== undefined && !hooksDirectorySymlink) {
    const hooksReadError = await requireReadable(hooksPath, fs);
    if (hooksReadError !== undefined) {
      return { ok: false, error: hooksReadError };
    }
  }

  if (topMetadata.uid !== BigInt(effectiveUid) || gitMetadata.uid !== BigInt(effectiveUid)) {
    return { ok: false, error: createInspectionError('ownership-refused', 'inspect-path') };
  }

  const finalCheckpointError = checkpoint();
  if (finalCheckpointError !== undefined) {
    return { ok: false, error: finalCheckpointError };
  }

  const canonicalTopLevel = asCanonicalPath(requestedPath);
  const canonicalGitDirectory = asCanonicalPath(gitDirectory);
  const ceilingDirectory = createGitCeilingDirectory(canonicalTopLevel);
  if (ceilingDirectory === undefined) {
    return {
      ok: false,
      error: createInspectionError('invalid-path', 'inspect-path', {
        reason: 'ambiguous-git-ceiling',
      }),
    };
  }

  const snapshots = [
    snapshot(canonicalTopLevel, topMetadata),
    snapshot(canonicalGitDirectory, gitMetadata),
  ];
  if (configMetadata !== undefined) {
    snapshots.push(snapshot(configPath, configMetadata));
  }
  if (hooksMetadata !== undefined) {
    snapshots.push(snapshot(hooksPath, hooksMetadata));
  }

  return {
    ok: true,
    admitted: {
      canonicalTopLevel,
      canonicalGitDirectory,
      ceilingDirectory,
      sourceRoot,
      ancestorCandidates,
      hooksDirectorySymlink,
      snapshots,
    },
  };
}

export async function verifyPathSnapshots(
  snapshots: readonly PathSnapshot[],
  fs: FileSystemBoundary = NODE_FILE_SYSTEM_BOUNDARY,
): Promise<boolean> {
  for (const expected of snapshots) {
    try {
      const metadata = await fs.lstat(expected.path);
      const actual = snapshot(expected.path, metadata);
      if (
        actual.kind !== expected.kind ||
        actual.device !== expected.device ||
        actual.inode !== expected.inode ||
        actual.size !== expected.size ||
        actual.mtimeNanoseconds !== expected.mtimeNanoseconds
      ) {
        return false;
      }
      if (actual.kind !== 'symlink' && (await fs.realpath(expected.path)) !== expected.path) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
