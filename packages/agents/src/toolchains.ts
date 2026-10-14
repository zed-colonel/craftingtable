import { createHash } from 'node:crypto';
import { constants, lstatSync, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import type { ToolchainTool, ToolProblemCode } from '@craftingtable/domain';
import { spawnSupervisedProcess } from './process.js';

export type { ToolchainTool, ToolProblemCode } from '@craftingtable/domain';

/**
 * The tools a Python check uses (R-G17, `toolchains.json`): a root-owned CPython interpreter and
 * uv, each with the version it must fit, and the media tools and font files the operator lists,
 * which are recorded by identity. The daemon validates the file at start; checks re-read every
 * identity (decision 5).
 */
export interface PythonToolchain {
  readonly interpreter: string;
  /** A dotted prefix the interpreter's version must fit: `3.12` takes 3.12.x. */
  readonly version: string;
  readonly uv: { readonly path: string; readonly version: string };
  readonly media?: MediaTools;
}

export interface MediaTools {
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  readonly fonts?: readonly string[];
}

/** The resource caps every check unit gets (R-G17 decision 7). */
export interface CheckUnitLimits {
  /** systemd's MemoryMax: bytes, or a number with K, M or G. */
  readonly memoryMax: string;
  readonly tasksMax: number;
}

/**
 * The caps a check unit gets when `toolchains.json` names none (R-G17 decision 7): 8 GB of
 * memory and no swap, as the approved native unit; and 1024 tasks, sixteen times the peak of
 * WorldInterface's heaviest adopted checks (64 tasks for `foundation-test`, 63 for
 * `runtime-test`, 61 for `contract-check` at 8d25c1f, measured on a 16-core workstation, where
 * Cargo's and the test harness's parallelism follow the core count).
 */
export const DEFAULT_CHECK_UNIT_LIMITS: CheckUnitLimits = Object.freeze({
  memoryMax: '8G',
  tasksMax: 1024,
});

/** What `toolchains.json` configures (R-G17): an optional Python profile, and the caps. */
export interface ToolchainSettings {
  readonly python?: PythonToolchain;
  readonly limits: CheckUnitLimits;
}

/** What a configured tool is, as the daemon read it. */
export interface ToolIdentity {
  readonly tool: ToolchainTool;
  /** The configured path, which is its real path: the rule refuses links. */
  readonly path: string;
  readonly uid: number;
  /** Permission bits in octal, `0755`. */
  readonly mode: string;
  readonly size: number;
  readonly sha256: string;
  readonly version?: string;
  /** For Python: its platform (`linux-x86_64`) and the host's C library (`glibc 2.44`). */
  readonly platform?: string;
  readonly libc?: string;
}

export interface ToolProblem {
  readonly code: ToolProblemCode;
  readonly message: string;
}

/** One tool's identity, or why it cannot be used, or both (a version that no longer fits). */
export interface ToolObservation {
  readonly tool: ToolchainTool;
  readonly path: string;
  readonly configuredVersion?: string;
  readonly identity?: ToolIdentity;
  readonly problem?: ToolProblem;
}

/** The largest tool file the daemon hashes: uv is about 48 MB. */
const TOOL_MAX_BYTES = 512 * 1024 * 1024;
/** How long one fixed probe may run. */
const PROBE_TIMEOUT_MS = 15_000;

const problem = (code: ToolProblemCode, message: string): ToolProblem => ({ code, message });

/** Why one path component breaks the rule, or undefined; `last` must be a `kind`. */
function componentProblem(
  path: string,
  status: Stats,
  last: 'file' | 'directory' | undefined,
): ToolProblem | undefined {
  if (status.isSymbolicLink())
    return problem('linked', `${path} is a link; name the file it points to`);
  if (status.uid !== 0) return problem('untrusted-owner', `${path} is not owned by root`);
  if ((status.mode & 0o022) !== 0)
    return problem('writable', `${path} is writable by its group or by others`);
  if (last === 'file' && !status.isFile())
    return problem('not-regular', `${path} is not a regular file`);
  if (last === 'directory' && !status.isDirectory())
    return problem('not-regular', `${path} is not a directory`);
  return undefined;
}

/**
 * Why a configured tool file cannot be trusted (R-G17 decision 2), or undefined: it must be an
 * absolute, normalized path to a regular file, and it and every directory above it must be no
 * link, owned by root and writable by no group or other user. Agents run as the operator's
 * account, so anything that account can write could become a check's privileged configuration.
 */
export function trustedFileProblem(path: string): ToolProblem | undefined {
  return trustedPathProblem(path, 'file');
}

/** The rule for a file or a directory: every component from `/` down. */
function trustedPathProblem(path: string, kind: 'file' | 'directory'): ToolProblem | undefined {
  if (!isAbsolute(path) || normalize(path) !== path)
    return problem('linked', `${path} must be an absolute, normalized path`);
  const components = path.split('/').filter(Boolean);
  let current = '/';
  for (let index = 0; index <= components.length; index++) {
    if (index > 0) current = join(current, components[index - 1] as string);
    let status: Stats;
    try {
      status = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR'
        ? problem('missing', `${path} does not exist`)
        : problem('untrusted-owner', `${current} could not be checked: ${code ?? String(error)}`);
    }
    const found = componentProblem(current, status, index === components.length ? kind : undefined);
    if (found) return found;
  }
  return undefined;
}

/**
 * Why a directory a tool loads from (Python's prefix and standard library) cannot be trusted:
 * the same rule as a tool file, for a directory.
 */
export function trustedDirectoryProblem(path: string): ToolProblem | undefined {
  return trustedPathProblem(normalize(path).replace(/\/+$/, '') || '/', 'directory');
}

/** Whether `observed` fits `configured`, a dotted prefix: `3.12` takes 3.12.x, never 3.120. */
export function versionFits(observed: string | undefined, configured: string): boolean {
  return (
    observed !== undefined && (observed === configured || observed.startsWith(`${configured}.`))
  );
}

/** The file's SHA-256 and status, read without following a link or blocking on a pipe. */
async function digestOf(path: string): Promise<{ sha256: string; status: Stats }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new Error(`${path} is not a regular file`);
    if (status.size > TOOL_MAX_BYTES) throw new Error(`${path} is larger than 512 MiB`);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (let position = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position > TOOL_MAX_BYTES) throw new Error(`${path} grew past 512 MiB`);
    }
    return { sha256: hash.digest('hex'), status };
  } finally {
    await handle.close();
  }
}

/**
 * Runs one fixed probe: a root-owned tool with fixed arguments, a fixed environment and no
 * input, through the supervised process spawner. Its stdout lines, or undefined when it did
 * not exit 0 within the time limit.
 */
async function probeLines(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  let child: ReturnType<typeof spawnSupervisedProcess>;
  try {
    child = spawnSupervisedProcess({
      executable,
      args,
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', UV_NO_CONFIG: '1' },
      terminationGraceMs: 1000,
      maxLineBytes: 64 * 1024,
      backgroundWorkTimeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  child.endInput();
  const stop = () => child.terminate();
  const timer = setTimeout(stop, PROBE_TIMEOUT_MS);
  signal?.addEventListener('abort', stop, { once: true });
  const lines: string[] = [];
  let exitCode: number | null = null;
  try {
    for await (const item of child.items) {
      if (item.type === 'stdout-line' && lines.length < 32) lines.push(item.line);
      if (item.type === 'exited') exitCode = item.exitCode;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  return exitCode === 0 ? lines : undefined;
}

/**
 * The interpreter's fixed probe (`-I -S`: no environment, no user site, no `site` module): its
 * version, platform, the host's C library, and where it loads its standard library from.
 */
const PYTHON_PROBE = [
  'import json, os, platform, sys, sysconfig',
  'paths = sysconfig.get_paths()',
  'print(json.dumps({"version": platform.python_version(), "platform": sysconfig.get_platform(),',
  ' "libc": os.confstr("CS_GNU_LIBC_VERSION") or "", "prefix": sys.prefix,',
  ' "stdlib": paths["stdlib"], "platstdlib": paths["platstdlib"]}))',
].join('\n');

const bounded = (text: string) => text.slice(0, 64);

interface ProbeResult {
  readonly version?: string;
  readonly platform?: string;
  readonly libc?: string;
  /** Directories the tool loads from, which must pass the rule too. */
  readonly loadsFrom?: readonly string[];
}

/** What a tool's fixed probe says, or undefined when it failed. */
async function probe(
  tool: ToolchainTool,
  path: string,
  signal?: AbortSignal,
): Promise<ProbeResult | undefined> {
  switch (tool) {
    case 'python': {
      const lines = await probeLines(path, ['-I', '-S', '-c', PYTHON_PROBE], signal);
      try {
        const facts = JSON.parse(lines?.[0] ?? '') as Record<string, unknown>;
        const text = (key: string) =>
          typeof facts[key] === 'string' ? (facts[key] as string) : undefined;
        const version = text('version');
        if (!version || !/^\d+\.\d+\.\d+/.test(version)) return undefined;
        return {
          version: bounded(version),
          ...(text('platform') ? { platform: bounded(text('platform') as string) } : {}),
          ...(text('libc') ? { libc: bounded(text('libc') as string) } : {}),
          loadsFrom: ['prefix', 'stdlib', 'platstdlib'].flatMap((key) => text(key) ?? []),
        };
      } catch {
        return undefined;
      }
    }
    case 'uv': {
      const lines = await probeLines(path, ['--version'], signal);
      const version = lines?.[0]?.trim().split(/\s+/)[1];
      return version && /^\d+\.\d+\.\d+/.test(version) ? { version: bounded(version) } : undefined;
    }
    case 'ffmpeg':
    case 'ffprobe': {
      const lines = await probeLines(path, ['-hide_banner', '-version'], signal);
      const words = lines?.[0]?.trim().split(/\s+/);
      return words?.[1] === 'version' && words[2] ? { version: bounded(words[2]) } : undefined;
    }
    case 'font':
      return {};
  }
}

/**
 * One tool's identity (R-G17 decisions 4 and 5): the rule first, so a tool that fails it is
 * never run; then its SHA-256, owner, mode and size; then its fixed probe, and the version it
 * must fit. A Python interpreter's prefix and standard library directories must pass the rule
 * as well.
 */
export async function identifyTool(
  tool: ToolchainTool,
  path: string,
  options: { readonly configuredVersion?: string; readonly signal?: AbortSignal } = {},
): Promise<ToolObservation> {
  const base = {
    tool,
    path,
    ...(options.configuredVersion === undefined
      ? {}
      : { configuredVersion: options.configuredVersion }),
  };
  const refused = trustedFileProblem(path);
  if (refused) return { ...base, problem: refused };
  let digest: Awaited<ReturnType<typeof digestOf>>;
  try {
    digest = await digestOf(path);
  } catch (error) {
    return {
      ...base,
      problem: problem('not-regular', error instanceof Error ? error.message : String(error)),
    };
  }
  const probed = await probe(tool, path, options.signal);
  const identity: ToolIdentity = {
    tool,
    path,
    uid: digest.status.uid,
    mode: `0${(digest.status.mode & 0o777).toString(8)}`,
    size: digest.status.size,
    sha256: digest.sha256,
    ...(probed?.version ? { version: probed.version } : {}),
    ...(probed?.platform ? { platform: probed.platform } : {}),
    ...(probed?.libc ? { libc: probed.libc } : {}),
  };
  if (probed === undefined)
    return {
      ...base,
      identity,
      problem: problem('probe-failed', `${path} did not answer its fixed version probe`),
    };
  for (const directory of probed.loadsFrom ?? []) {
    const unsafe = trustedDirectoryProblem(directory);
    if (unsafe) return { ...base, identity, problem: unsafe };
  }
  if (
    options.configuredVersion !== undefined &&
    !versionFits(probed.version, options.configuredVersion)
  )
    return {
      ...base,
      identity,
      problem: problem(
        'version-mismatch',
        `${path} is version ${probed.version ?? 'unknown'}, which does not fit the configured ${options.configuredVersion}`,
      ),
    };
  return { ...base, identity };
}

/** Every tool of a Python profile, in a fixed order: Python, uv, FFmpeg, ffprobe, the fonts. */
export async function observeToolchain(
  profile: PythonToolchain,
  signal?: AbortSignal,
): Promise<ToolObservation[]> {
  const media = profile.media;
  return Promise.all([
    identifyTool('python', profile.interpreter, {
      configuredVersion: profile.version,
      ...(signal ? { signal } : {}),
    }),
    identifyTool('uv', profile.uv.path, {
      configuredVersion: profile.uv.version,
      ...(signal ? { signal } : {}),
    }),
    ...(media?.ffmpeg ? [identifyTool('ffmpeg', media.ffmpeg, signal ? { signal } : {})] : []),
    ...(media?.ffprobe ? [identifyTool('ffprobe', media.ffprobe, signal ? { signal } : {})] : []),
    ...(media?.fonts ?? []).map((font) => identifyTool('font', font, signal ? { signal } : {})),
  ]);
}

/** Canonical JSON: object keys sorted at every depth. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The digest of a profile as configured, recorded in each Python check's receipt. */
export function toolchainProfileDigest(profile: PythonToolchain): string {
  return createHash('sha256').update(canonical(profile)).digest('hex');
}
