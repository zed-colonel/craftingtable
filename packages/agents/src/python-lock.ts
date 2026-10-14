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

/** The resolver options uv records in a lock's `[options]`, as `tomllib` reads them. */
export type LockOptions = Readonly<Record<string, unknown>>;

const RESOLUTIONS = new Set(['highest', 'lowest', 'lowest-direct']);
const PRERELEASES = new Set([
  'disallow',
  'allow',
  'if-necessary',
  'explicit',
  'if-necessary-or-explicit',
]);
const FORK_STRATEGIES = new Set(['fewest', 'requires-python']);
/** A date, or a date and time with an optional offset, as uv writes them (RFC 3339). */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
/** An ISO 8601 duration, as uv records a relative `exclude-newer` (`P1W`, `P3DT12H`). */
const SPAN = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
const PACKAGE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * The flags that give `uv sync --locked` the resolver options the lock was made with (R-G19
 * review HIGH-1). The install runs with `UV_NO_CONFIG`, so a project's `[tool.uv]` or `uv.toml`
 * settings such as `exclude-newer` would not apply, and uv would find the lock out of date; the
 * lock itself records them, adopted with it. A key or value this cannot pass is refused by name,
 * rather than left to uv's "run `uv lock`", which the agent could not act on.
 */
export function lockOptionArguments(
  options: LockOptions,
): { readonly arguments: readonly string[] } | { readonly problem: string } {
  const args: string[] = [];
  const refuse = (key: string) => ({
    problem: `uv.lock records the resolver option ${key} with a value Python checks cannot pass to uv`,
  });
  const choice = (key: string, flag: string, allowed: ReadonlySet<string>) => {
    const value = options[key];
    if (value === undefined) return true;
    if (typeof value !== 'string' || !allowed.has(value)) return false;
    args.push(`--${flag}=${value}`);
    return true;
  };
  for (const key of Object.keys(options))
    if (
      ![
        'resolution-mode',
        'prerelease-mode',
        'fork-strategy',
        'exclude-newer',
        'exclude-newer-span',
        'exclude-newer-package',
      ].includes(key)
    )
      return {
        problem: `uv.lock records the resolver option ${key}, which Python checks do not know how to pass to uv`,
      };
  if (!choice('resolution-mode', 'resolution', RESOLUTIONS)) return refuse('resolution-mode');
  if (!choice('prerelease-mode', 'prerelease', PRERELEASES)) return refuse('prerelease-mode');
  if (!choice('fork-strategy', 'fork-strategy', FORK_STRATEGIES)) return refuse('fork-strategy');
  // A relative `exclude-newer` is recorded as its span, beside a placeholder date uv ignores.
  const span = options['exclude-newer-span'];
  const newer = options['exclude-newer'];
  if (span !== undefined) {
    if (typeof span !== 'string' || !SPAN.test(span)) return refuse('exclude-newer-span');
    args.push(`--exclude-newer=${span}`);
  } else if (newer !== undefined) {
    if (typeof newer !== 'string' || !TIMESTAMP.test(newer)) return refuse('exclude-newer');
    args.push(`--exclude-newer=${newer}`);
  }
  const packages = options['exclude-newer-package'];
  if (packages !== undefined) {
    if (typeof packages !== 'object' || packages === null || Array.isArray(packages))
      return refuse('exclude-newer-package');
    // A date, a relative value (recorded as its span beside a placeholder date), or an opt-out.
    for (const [name, value] of Object.entries(packages)) {
      const span =
        typeof value === 'object' && value !== null
          ? (value as { span?: unknown }).span
          : undefined;
      const flag =
        value === false
          ? 'false'
          : typeof value === 'string' && TIMESTAMP.test(value)
            ? value
            : typeof span === 'string' && SPAN.test(span)
              ? span
              : undefined;
      if (!PACKAGE_NAME.test(name) || flag === undefined) return refuse('exclude-newer-package');
      args.push(`--exclude-newer-package=${name}=${flag}`);
    }
  }
  return { arguments: args };
}
