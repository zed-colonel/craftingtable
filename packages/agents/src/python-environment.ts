import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type LockedPackage,
  type LockOptions,
  type LockRefusal,
  lockOptionArguments,
  lockRefusals,
} from './python-lock.js';
import type { PythonToolchain } from './toolchains.js';

/**
 * A Python check's environment (R-G19, ADR-076, revising R-G17's increment 3): a fresh venv in
 * the check's private directory, which an install step builds with `uv sync --locked` from PyPI
 * and the tree, packaged projects and source builds included, and which the check then runs in,
 * offline, with uv held offline and frozen. It never reuses a venv and never reads the agents' uv
 * cache. This module spawns nothing itself: `run` is the check runner's, which reads the lock in
 * a unit with no network and runs the install in a unit with it.
 */

/** Runs one fixed helper step: a root-owned tool of the profile, with fixed arguments. */
export type PythonStepRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    /**
     * The install: it reaches the network (PyPI, and whatever a build it runs reaches) and
     * writes the clone (a build in the tree) and the uv cache. No other step has either.
     */
    readonly install: boolean;
  },
) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;

export interface PythonEnvironmentInput {
  readonly profile: PythonToolchain;
  /** The reviewed commit's private clone. */
  readonly tree: string;
  /** The lock's bytes, as the check runner read them from the clone (a regular file). */
  readonly lock: Buffer;
  /** Daemon-owned, for this check alone: the venv and the steps' scratch. */
  readonly directory: string;
  /**
   * uv's cache for the install: the daemon's own for checks (`<data>/uv/checks`), which no agent
   * writes, or one inside `directory`, removed with it.
   */
  readonly cache: string;
  readonly signal: AbortSignal;
  /** Milliseconds left of the check's time limit; throws when none are. */
  readonly remainingMs: () => number;
  readonly run: PythonStepRunner;
  readonly onOutput: (text: string) => void;
}

export interface PythonEnvironment {
  readonly venv: string;
  /** SHA-256 of the adopted `uv.lock`, which the install was held to. */
  readonly lockDigest: string;
  /** The check's environment: `base` without any Python or uv setting, then the venv's. */
  environment(base: Readonly<Record<string, string>>): Record<string, string>;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Why a package is refused, as the check's diagnostic names it. */
const REFUSALS: Readonly<Record<LockRefusal, string>> = {
  'git-source': 'comes from Git',
  'url-source': 'comes from a URL',
  'other-index': 'comes from an index other than PyPI',
  'path-outside-tree': 'lies outside the repository',
  'unhashed-file': 'has a file on PyPI the lock gives no SHA-256 for',
  'unknown-source': 'has a source uv.lock does not describe',
};

/**
 * Reads the lock with the profile's interpreter and its standard `tomllib`: each package's name,
 * version, source, wheels (URL or file name, and hash) and source distribution, and the resolver
 * options the lock was made with, as JSON.
 */
const LOCK_READER = [
  'import json, sys, tomllib',
  'lock = tomllib.load(open(sys.argv[1], "rb"))',
  'def file(f):',
  '    return {k: f[k] for k in ("url", "filename", "hash") if isinstance(f.get(k), str)}',
  'out = []',
  'for p in lock.get("package", []):',
  '    source = p.get("source") if isinstance(p.get("source"), dict) else {}',
  '    sdist = p.get("sdist")',
  '    out.append({"name": str(p.get("name", "")), "version": p.get("version"),',
  '                "source": {k: v for k, v in source.items() if isinstance(v, str)},',
  '                "wheels": [file(w) for w in p.get("wheels", []) if isinstance(w, dict)],',
  '                "sdist": file(sdist) if isinstance(sdist, dict) else None})',
  'options = lock.get("options")',
  'manifest = lock.get("manifest") if isinstance(lock.get("manifest"), dict) else {}',
  'print(json.dumps({"packages": out, "options": options if isinstance(options, dict) else {},',
  '                  "dependencyMetadata": bool(manifest.get("dependency-metadata"))}, default=str))',
].join('\n');

/** Variables a check of a Python project may never inherit: they choose code or its sources. */
const INHERITED = /^(PYTHON|UV_|PIP_|VIRTUAL_ENV$|CONDA|PYENV|PDM_|POETRY_)/;

function readLock(stdout: string): {
  readonly packages: LockedPackage[];
  readonly options: LockOptions;
  readonly dependencyMetadata: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('The uv.lock could not be read as a uv lock.');
  }
  const read = parsed as {
    packages?: unknown;
    options?: unknown;
    dependencyMetadata?: unknown;
  } | null;
  if (!read || !Array.isArray(read.packages) || typeof read.options !== 'object' || !read.options)
    throw new Error('The uv.lock could not be read as a uv lock.');
  const file = (entry: Record<string, unknown>) => ({
    ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
    ...(typeof entry.filename === 'string' ? { filename: entry.filename } : {}),
    ...(typeof entry.hash === 'string' ? { hash: entry.hash } : {}),
  });
  return {
    packages: read.packages.map((entry: Record<string, unknown>) => ({
      name: String(entry.name),
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      source: (entry.source ?? {}) as Record<string, string>,
      wheels: Array.isArray(entry.wheels) ? entry.wheels.map(file) : [],
      ...(entry.sdist && typeof entry.sdist === 'object'
        ? { sdist: file(entry.sdist as Record<string, unknown>) }
        : {}),
    })),
    options: read.options as LockOptions,
    dependencyMetadata: read.dependencyMetadata === true,
  };
}

/** The tail of a step's output, for the check's log or diagnostic. */
const tail = (text: string) => text.trim().split('\n').slice(-20).join('\n').slice(-2000);

/**
 * Builds the check's environment. Every refusal names what it refused: a package by name, a
 * step by its output.
 */
export async function preparePythonEnvironment(
  input: PythonEnvironmentInput,
): Promise<PythonEnvironment> {
  const { profile, directory } = input;
  const venv = join(directory, 'venv');
  const scratch = join(directory, 'tmp');
  for (const path of [scratch, input.cache]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const lockCopy = join(directory, 'uv.lock');
  writeFileSync(lockCopy, input.lock, { mode: 0o600 });
  // Each step: the profile's tools and a fixed environment, nothing of the daemon's.
  const base = { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, LC_ALL: 'C' };
  const step = async (
    label: string,
    command: string,
    args: readonly string[],
    cwd: string,
    options: {
      readonly env: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
      readonly install: boolean;
    },
  ) => {
    if (input.signal.aborted) throw new Error('Interrupted.');
    const result = await input.run(command, args, { cwd, ...options });
    if (input.signal.aborted) throw new Error('Interrupted.');
    if (result.code !== 0) {
      // A step ended by the check's time limit fails as the check's time limit.
      input.remainingMs();
      throw new Error(
        `The Python environment could not be built (${label}):\n${tail(result.stderr || result.stdout)}`,
      );
    }
    return result;
  };

  // Read with no network: the lock may name only what PyPI and the tree hold.
  const read = await step(
    'reading uv.lock',
    profile.interpreter,
    ['-I', '-S', '-c', LOCK_READER, lockCopy],
    directory,
    { env: base, timeoutMs: Math.min(10 * 60_000, input.remainingMs()), install: false },
  );
  const lock = readLock(read.stdout);
  const refused = lockRefusals(lock.packages);
  if (refused.length)
    throw new Error(
      `The uv.lock names what a Python check cannot install: ${refused
        .map(({ name, reason }) => `${name} ${REFUSALS[reason]}`)
        .join('; ')}. Python checks install from PyPI and the repository only.`,
    );
  // The resolver options the lock was made with, which `UV_NO_CONFIG` would otherwise drop.
  const options = lockOptionArguments(lock.options);
  if ('problem' in options) throw new Error(`${options.problem}.`);
  // Recorded from `[tool.uv] dependency-metadata`, which no flag carries (re-check R-2).
  if (lock.dependencyMetadata)
    throw new Error(
      "uv.lock records dependency-metadata from the project's uv settings, which Python checks cannot pass to uv.",
    );

  // The install: uv checks every file against the lock's hashes and builds what needs building
  // (the project, source distributions), with the profile's interpreter, no configuration of the
  // tree's or the operator's but the resolver options the lock records, and copies, not links,
  // into the venv. It may take what is left of the check's time limit.
  const installed = await step(
    'uv sync --locked',
    profile.uv.path,
    ['sync', '--locked', '--python', profile.interpreter, ...options.arguments],
    input.tree,
    {
      env: {
        ...base,
        UV_CACHE_DIR: input.cache,
        UV_PROJECT_ENVIRONMENT: venv,
        UV_PYTHON: profile.interpreter,
        UV_PYTHON_DOWNLOADS: 'never',
        UV_NO_CONFIG: '1',
        UV_LINK_MODE: 'copy',
        UV_NO_PROGRESS: '1',
      },
      timeoutMs: input.remainingMs(),
      install: true,
    },
  );
  input.onOutput(
    `Python environment: uv sync --locked, from the adopted uv.lock.\n${tail(installed.stderr)}\n`,
  );
  return {
    venv,
    lockDigest: sha256(input.lock),
    environment(inherited) {
      const kept = Object.fromEntries(
        Object.entries(inherited).filter(([key]) => !INHERITED.test(key)),
      );
      return {
        ...kept,
        // The venv first, then the profile's uv, then what the check had.
        PATH: [join(venv, 'bin'), dirname(profile.uv.path), inherited.PATH]
          .filter(Boolean)
          .join(':'),
        VIRTUAL_ENV: venv,
        UV_PROJECT_ENVIRONMENT: venv,
        UV_PYTHON: join(venv, 'bin', 'python'),
        UV_PYTHON_DOWNLOADS: 'never',
        UV_OFFLINE: '1',
        UV_FROZEN: '1',
        UV_NO_SYNC: '1',
        UV_NO_CONFIG: '1',
        UV_CACHE_DIR: join(inherited.TMPDIR ?? scratch, 'uv-cache'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      };
    },
  };
}
