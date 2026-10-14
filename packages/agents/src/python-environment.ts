import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { constants as fsConstants, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type LockedPackage,
  type PythonWheelSource,
  planWheels,
  type WheelRefusal,
  type WheelTarget,
} from './python-wheels.js';
import type { PythonToolchain } from './toolchains.js';

/**
 * A Python check's environment (R-G17 decisions 11, 12 and 14): a fresh venv in the check's
 * private directory, built with no network from the daemon's verified wheels alone, which the
 * check then runs in with uv held offline and frozen. It never reuses a venv and never reads the
 * agents' uv cache. This module spawns nothing itself: `run` is the check runner's, which runs
 * each step in a unit with no network.
 */

/** Runs one fixed helper step: a root-owned tool of the profile, with fixed arguments. */
export type PythonStepRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  },
) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;

export interface PythonEnvironmentInput {
  readonly profile: PythonToolchain;
  /** The interpreter's probed facts, which decide the wheels that fit. */
  readonly target: WheelTarget;
  /** The reviewed commit's private clone. */
  readonly tree: string;
  /** The lock's bytes, as the check runner read them from the clone (a regular file). */
  readonly lock: Buffer;
  /** Daemon-owned, for this check alone: the wheels, the venv and uv's scratch cache. */
  readonly directory: string;
  readonly wheels: PythonWheelSource | undefined;
  readonly signal: AbortSignal;
  /** Milliseconds left of the check's time limit; throws when none are. */
  readonly remainingMs: () => number;
  readonly run: PythonStepRunner;
  readonly onOutput: (text: string) => void;
}

export interface PythonEnvironment {
  readonly venv: string;
  /** SHA-256 of the adopted `uv.lock`. */
  readonly lockDigest: string;
  /**
   * SHA-256 of the verified wheels the install could draw on (uv installs those the lock's
   * markers select for this host): each `"<sha256>  <file name>"`, sorted, one per line.
   */
  readonly wheelSetDigest: string;
  readonly wheels: number;
  /** The check's environment: `base` without any Python or uv setting, then the venv's. */
  environment(base: Readonly<Record<string, string>>): Record<string, string>;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Why a package is refused, as the check's diagnostic names it. */
const REFUSALS: Readonly<Record<WheelRefusal, string>> = {
  'packaged-project':
    'is a packaged project; Python checks support virtual projects only (tool.uv.package = false), run as `python -m …` or as scripts',
  'git-source': 'comes from Git; Python checks install wheels from PyPI only',
  'url-source': 'comes from a URL; Python checks install wheels from PyPI only',
  'path-source': 'comes from a local path; Python checks install wheels from PyPI only',
  'other-index': 'comes from an index other than PyPI; Python checks install wheels from PyPI only',
  'sdist-only': 'has only a source distribution (sdist); Python checks build nothing from source',
  'unhashed-wheel': 'has a wheel the lock gives no SHA-256 for',
};

/**
 * Reads the lock with the profile's interpreter and its standard `tomllib`: each package's name,
 * version, source, wheels (URL and hash) and whether it has an sdist, as JSON.
 */
const LOCK_READER = [
  'import json, sys, tomllib',
  'lock = tomllib.load(open(sys.argv[1], "rb"))',
  'out = []',
  'for p in lock.get("package", []):',
  '    source = p.get("source") if isinstance(p.get("source"), dict) else {}',
  '    out.append({"name": str(p.get("name", "")), "version": p.get("version"),',
  '                "source": {k: v for k, v in source.items() if isinstance(v, str)},',
  '                "wheels": [{"url": w.get("url"), "hash": w.get("hash")} for w in p.get("wheels", []) if isinstance(w, dict)],',
  '                "sdist": "sdist" in p})',
  'print(json.dumps(out))',
].join('\n');

/** Variables a check of a Python project may never inherit: they choose code or its sources. */
const INHERITED = /^(PYTHON|UV_|PIP_|VIRTUAL_ENV$|CONDA|PYENV|PDM_|POETRY_)/;

function lockedPackages(stdout: string): LockedPackage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('The uv.lock could not be read as a uv lock.');
  }
  if (!Array.isArray(parsed)) throw new Error('The uv.lock could not be read as a uv lock.');
  return parsed.map((entry: Record<string, unknown>) => ({
    name: String(entry.name),
    ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
    source: (entry.source ?? {}) as Record<string, string>,
    wheels: Array.isArray(entry.wheels)
      ? entry.wheels.map((wheel: Record<string, unknown>) => ({
          ...(typeof wheel.url === 'string' ? { url: wheel.url } : {}),
          ...(typeof wheel.hash === 'string' ? { hash: wheel.hash } : {}),
        }))
      : [],
    sdist: entry.sdist === true,
  }));
}

/** A file's SHA-256, read as a stream. */
function fileDigest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** The tail of a failed step's output, for the check's diagnostic. */
const tail = (text: string) => text.trim().split('\n').slice(-8).join('\n').slice(-2000);

/**
 * Builds the check's environment. Every refusal names what it refused: a package by name, a
 * wheel by file name, a step by its output.
 */
export async function preparePythonEnvironment(
  input: PythonEnvironmentInput,
): Promise<PythonEnvironment> {
  const { profile, directory } = input;
  const wheelsDirectory = join(directory, 'wheels');
  const venv = join(directory, 'venv');
  const scratch = join(directory, 'tmp');
  for (const path of [wheelsDirectory, scratch]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const lockCopy = join(directory, 'uv.lock');
  writeFileSync(lockCopy, input.lock, { mode: 0o600 });
  // Each step: the profile's tools, a fixed environment, uv offline, with no configuration of
  // the tree's or the operator's, and a cache of its own.
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: scratch,
    TMPDIR: scratch,
    LC_ALL: 'C',
    UV_CACHE_DIR: join(directory, 'uv-cache'),
    UV_PYTHON_DOWNLOADS: 'never',
    UV_OFFLINE: '1',
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1',
  };
  const step = async (label: string, command: string, args: readonly string[], cwd: string) => {
    if (input.signal.aborted) throw new Error('Interrupted.');
    const result = await input.run(command, args, {
      cwd,
      env,
      timeoutMs: Math.min(10 * 60_000, input.remainingMs()),
    });
    if (input.signal.aborted) throw new Error('Interrupted.');
    if (result.code !== 0)
      throw new Error(
        `The Python environment could not be built (${label}):\n${tail(result.stderr || result.stdout)}`,
      );
    return result.stdout;
  };

  // The lock selects: every PyPI wheel of it that fits this interpreter.
  const packages = lockedPackages(
    await step(
      'reading uv.lock',
      profile.interpreter,
      ['-I', '-S', '-c', LOCK_READER, lockCopy],
      directory,
    ),
  );
  const plan = planWheels(packages, input.target);
  if (plan.refused.length)
    throw new Error(
      `The uv.lock names what a Python check cannot install: ${plan.refused
        .map(({ name, reason }) => `${name} ${REFUSALS[reason]}`)
        .join('; ')}.`,
    );
  if (plan.wheels.length && !input.wheels)
    throw new Error('This daemon has no store of verified wheels, so a Python check gets none.');
  // PyPI vouches: each file from the daemon's store, copied, then hashed again here.
  const verified: string[] = [];
  for (const request of plan.wheels) {
    // Each fetch within what is left of the check's time limit (increment 3 review M2): the
    // store follows this signal, so a slow PyPI holds no check past its limit.
    const limit = AbortSignal.timeout(input.remainingMs() + 5);
    const got = await input.wheels!.wheel(request, AbortSignal.any([input.signal, limit]));
    if (input.signal.aborted) throw new Error('Interrupted.');
    if (limit.aborted) {
      input.remainingMs();
      throw new Error('The check time limit passed while its wheels were fetched.');
    }
    if ('problem' in got) throw new Error(`A locked wheel is not available: ${got.problem}.`);
    const copy = join(wheelsDirectory, request.filename);
    await copyFile(got.path, copy, fsConstants.COPYFILE_EXCL);
    if ((await fileDigest(copy)) !== request.sha256)
      throw new Error(
        `${request.filename} changed after the daemon verified it; nothing was installed.`,
      );
    verified.push(`${request.sha256}  ${request.filename}\n`);
  }
  input.onOutput(
    `Python environment: ${verified.length} verified wheels from the adopted uv.lock.\n`,
  );

  // Built with no network: the lock's own requirements, every hash required, nothing built.
  const requirements = join(directory, 'requirements.txt');
  await step(
    'uv export',
    profile.uv.path,
    [
      'export',
      '--frozen',
      '--no-emit-project',
      '--format',
      'requirements.txt',
      '--output-file',
      requirements,
      '--quiet',
    ],
    input.tree,
  );
  await step(
    'uv venv',
    profile.uv.path,
    ['venv', venv, '--python', profile.interpreter, '--quiet'],
    directory,
  );
  await step(
    'uv pip install',
    profile.uv.path,
    [
      'pip',
      'install',
      '--python',
      join(venv, 'bin', 'python'),
      '--offline',
      '--no-index',
      '--find-links',
      wheelsDirectory,
      '--require-hashes',
      '--no-build',
      '--quiet',
      '-r',
      requirements,
    ],
    directory,
  );
  return {
    venv,
    lockDigest: sha256(input.lock),
    wheelSetDigest: sha256(verified.sort().join('')),
    wheels: verified.length,
    environment(base) {
      const kept = Object.fromEntries(Object.entries(base).filter(([key]) => !INHERITED.test(key)));
      return {
        ...kept,
        // The venv first, then the profile's uv, then what the check had.
        PATH: [join(venv, 'bin'), dirname(profile.uv.path), base.PATH].filter(Boolean).join(':'),
        VIRTUAL_ENV: venv,
        UV_PROJECT_ENVIRONMENT: venv,
        UV_PYTHON: join(venv, 'bin', 'python'),
        UV_PYTHON_DOWNLOADS: 'never',
        UV_OFFLINE: '1',
        UV_FROZEN: '1',
        UV_NO_SYNC: '1',
        UV_NO_CONFIG: '1',
        UV_CACHE_DIR: join(base.TMPDIR ?? scratch, 'uv-cache'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      };
    },
  };
}
