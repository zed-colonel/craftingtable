/**
 * Which wheels a Python check needs (R-G17 decisions 8, 10, 11 and 14): from the adopted
 * `uv.lock`, each PyPI package's wheels that fit the profile's interpreter, by their tags; and
 * what is refused by name: Git, URL, path and other-index sources, sdist-only packages and a
 * packaged project. The lock selects; the daemon's store fetches each file from PyPI and keeps
 * it only when its bytes match both PyPI's digest and the lock's hash.
 *
 * Which of the fitting wheels are installed is uv's to decide, offline and hash-required, in the
 * check's unit: it evaluates the lock's markers. A package whose wheels fit nothing here is not
 * asked for; if uv needs it, the install fails naming it.
 */

/** A package of the lock, as the profile's interpreter reads it with `tomllib`. */
export interface LockedPackage {
  readonly name: string;
  readonly version?: string;
  /** `{registry}`, `{virtual}`, `{editable}`, `{git}`, `{url}`, `{path}` or `{directory}`. */
  readonly source?: Readonly<Record<string, unknown>>;
  readonly wheels: readonly { readonly url?: string; readonly hash?: string }[];
  readonly sdist: boolean;
}

/** What a wheel must fit: the interpreter's version, platform and C library, as probed. */
export interface WheelTarget {
  /** `3.12.15`. */
  readonly pythonVersion: string;
  /** `linux-x86_64`, as `sysconfig.get_platform()` says. */
  readonly platform: string;
  /** `glibc 2.44`; none on a host whose C library is not glibc, where only pure wheels fit. */
  readonly libc?: string | undefined;
}

/** A file the daemon's store must provide, verified. */
export interface WheelRequest {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  /** The lock's SHA-256, which PyPI's digest and the bytes must both match. */
  readonly sha256: string;
}

export type WheelRefusal =
  | 'packaged-project'
  | 'git-source'
  | 'url-source'
  | 'path-source'
  | 'other-index'
  | 'sdist-only'
  | 'unhashed-wheel';

export interface WheelPlan {
  readonly wheels: readonly WheelRequest[];
  readonly refused: readonly { readonly name: string; readonly reason: WheelRefusal }[];
}

/** PyPI's index, the only one (decision 10). */
export const PYPI_INDEX = 'https://pypi.org/simple';
/** PyPI's files host, the only place a wheel is fetched from. */
export const PYPI_FILES = 'https://files.pythonhosted.org/';

/** A wheel's file name, `{name}-{version}(-{build})?-{python}-{abi}-{platform}.whl` (PEP 427). */
const WHEEL_FILENAME =
  /^(?<name>[A-Za-z0-9_.]+)-(?<version>[A-Za-z0-9_.!+]+)(?:-(?<build>\d[A-Za-z0-9_.]*))?-(?<python>[A-Za-z0-9_.]+)-(?<abi>[A-Za-z0-9_.]+)-(?<platform>[A-Za-z0-9_.]+)\.whl$/;

/** Whether a name is a wheel's file name (PEP 427), with no directory in it. */
export function isWheelFilename(filename: string): boolean {
  return WHEEL_FILENAME.test(filename);
}

/** The platform tags that fit a glibc host of this machine and C library version. */
function platformFits(
  tag: string,
  machine: string,
  glibc: readonly [number, number] | undefined,
): boolean {
  if (tag === 'any') return true;
  if (glibc === undefined) return false;
  const legacy: Readonly<Record<string, readonly [number, number]>> = {
    [`manylinux1_${machine}`]: [2, 5],
    [`manylinux2010_${machine}`]: [2, 12],
    [`manylinux2014_${machine}`]: [2, 17],
  };
  const required =
    legacy[tag] ??
    ((match) => (match ? ([Number(match[1]), Number(match[2])] as const) : undefined))(
      new RegExp(`^manylinux_(\\d+)_(\\d+)_${machine}$`).exec(tag),
    );
  if (required)
    return required[0] < glibc[0] || (required[0] === glibc[0] && required[1] <= glibc[1]);
  return tag === `linux_${machine}`;
}

/** Whether a wheel's tags fit the target (PEP 425), for CPython. */
export function wheelFits(filename: string, target: WheelTarget): boolean {
  const parsed = WHEEL_FILENAME.exec(filename)?.groups;
  if (!parsed) return false;
  const version = /^(\d+)\.(\d+)/.exec(target.pythonVersion);
  const machine = /^linux-(\w+)$/.exec(target.platform)?.[1];
  if (!version || !machine) return false;
  const [major, minor] = [Number(version[1]), Number(version[2])];
  const glibcMatch = /^glibc (\d+)\.(\d+)/.exec(target.libc ?? '');
  const glibc = glibcMatch ? ([Number(glibcMatch[1]), Number(glibcMatch[2])] as const) : undefined;
  const own = `cp${major}${minor}`;
  const pythons = (parsed.python as string).split('.');
  const abis = (parsed.abi as string).split('.');
  const platforms = (parsed.platform as string).split('.');
  if (!platforms.some((tag) => platformFits(tag, machine, glibc))) return false;
  return pythons.some((python) =>
    abis.some((abi) => {
      if (python === own) return abi === own || abi === 'abi3' || abi === 'none';
      const stable = /^cp(\d)(\d+)$/.exec(python);
      if (stable && abi === 'abi3')
        return Number(stable[1]) === major && Number(stable[2]) <= minor;
      const generic = /^py(\d)(\d*)$/.exec(python);
      if (generic && abi === 'none')
        return Number(generic[1]) === major && (generic[2] === '' || Number(generic[2]) <= minor);
      return false;
    }),
  );
}

/** The wheels to fetch for the target, and the packages refused by name. */
export function planWheels(packages: readonly LockedPackage[], target: WheelTarget): WheelPlan {
  const wheels: WheelRequest[] = [];
  const refused: { name: string; reason: WheelRefusal }[] = [];
  for (const locked of packages) {
    const source = locked.source ?? {};
    const refuse = (reason: WheelRefusal) => refused.push({ name: locked.name, reason });
    if ('virtual' in source) continue;
    if ('editable' in source) {
      refuse(source.editable === '.' ? 'packaged-project' : 'path-source');
      continue;
    }
    if ('git' in source) refuse('git-source');
    else if ('url' in source) refuse('url-source');
    else if ('path' in source || 'directory' in source) refuse('path-source');
    else if (source.registry !== PYPI_INDEX) refuse('other-index');
    else if (locked.wheels.length === 0) refuse('sdist-only');
    else {
      const requests: WheelRequest[] = [];
      let problem: WheelRefusal | undefined;
      for (const wheel of locked.wheels) {
        const url = wheel.url ?? '';
        if (!url.startsWith(PYPI_FILES)) {
          problem = 'other-index';
          break;
        }
        let filename: string;
        try {
          filename = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
        } catch {
          problem = 'other-index';
          break;
        }
        if (!wheelFits(filename, target)) continue;
        const sha256 = /^sha256:([0-9a-f]{64})$/.exec(wheel.hash ?? '')?.[1];
        if (!sha256 || locked.version === undefined) {
          problem = 'unhashed-wheel';
          break;
        }
        requests.push({ name: locked.name, version: locked.version, filename, sha256 });
      }
      if (problem) refuse(problem);
      else wheels.push(...requests);
    }
  }
  return { wheels, refused };
}

/**
 * Where a check gets each verified wheel (R-G17 decision 8): the daemon's store, which fetches
 * from PyPI and keeps a file only when its bytes match PyPI's digest and the lock's hash. The
 * path it gives is daemon-owned; the check copies the file and hashes it again.
 */
export interface PythonWheelSource {
  wheel(
    request: WheelRequest,
    signal: AbortSignal,
  ): Promise<{ readonly path: string } | { readonly problem: string }>;
}
