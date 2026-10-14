import { isAbsolute, posix } from 'node:path';

/**
 * What a Python check's install step may take from the adopted `uv.lock` (R-G19, ADR-076):
 * PyPI's packages, with wheels or only a source distribution, every file on PyPI's files host
 * and hashed by SHA-256, so `uv sync --locked` checks each against the lock; the project itself,
 * packaged or virtual, and paths inside the reviewed tree (workspace members, vendored files).
 * Anything else would need a network beyond PyPI's or a file outside the tree, and is refused by
 * name before anything is installed.
 */

/** A package of the lock, as the profile's interpreter reads it with `tomllib`. */
export interface LockedPackage {
  readonly name: string;
  readonly version?: string;
  /** `{registry}`, `{virtual}`, `{editable}`, `{directory}`, `{path}`, `{git}` or `{url}`. */
  readonly source?: Readonly<Record<string, unknown>>;
  readonly wheels: readonly {
    readonly url?: string;
    readonly filename?: string;
    readonly hash?: string;
  }[];
  readonly sdist?: { readonly url?: string; readonly hash?: string };
}

export type LockRefusal =
  | 'git-source'
  | 'url-source'
  | 'other-index'
  | 'path-outside-tree'
  | 'unhashed-file'
  | 'unknown-source';

/** PyPI's index, the only one. */
export const PYPI_INDEX = 'https://pypi.org/simple';
/** PyPI's files host, the only place a registry file is fetched from. */
export const PYPI_FILES = 'https://files.pythonhosted.org/';

/** The source keys whose value is a path relative to the project's root. */
const TREE_SOURCES = ['virtual', 'editable', 'directory', 'path'] as const;

/** Whether a lock's path stays inside the tree: relative, and never above its root. */
function insideTree(path: unknown): boolean {
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return false;
  const normalized = posix.normalize(path);
  return normalized !== '..' && !normalized.startsWith('../');
}

/** Why a package of the lock cannot be installed by a check, or undefined when it can. */
function refusal(locked: LockedPackage): LockRefusal | undefined {
  const source = locked.source ?? {};
  const tree = TREE_SOURCES.find((key) => key in source);
  if (tree) return insideTree(source[tree]) ? undefined : 'path-outside-tree';
  if ('git' in source) return 'git-source';
  if ('url' in source) return 'url-source';
  if (!('registry' in source)) return 'unknown-source';
  if (source.registry !== PYPI_INDEX) return 'other-index';
  const files = [...locked.wheels, ...(locked.sdist ? [locked.sdist] : [])];
  if (files.some((file) => !file.url?.startsWith(PYPI_FILES))) return 'other-index';
  if (files.some((file) => !/^sha256:[0-9a-f]{64}$/.test(file.hash ?? ''))) return 'unhashed-file';
  return undefined;
}

/** Every package of the lock a check cannot install, by name, in the lock's order. */
export function lockRefusals(
  packages: readonly LockedPackage[],
): { readonly name: string; readonly reason: LockRefusal }[] {
  return packages.flatMap((locked) => {
    const reason = refusal(locked);
    return reason ? [{ name: locked.name, reason }] : [];
  });
}
