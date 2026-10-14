import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asDeclaredCheckId,
  asRepositoryCheckDeclarationId,
  PYTHON_ENVIRONMENT_FILE_PATTERN,
} from '@craftingtable/domain';
import { hostCargo, hostGit } from './host-tools-test-support.js';
import { buildWheel, writePythonProject } from './python-fixture.js';
import {
  type CheckExecution,
  executeCheck,
  prepareCheckManifest,
  pythonStepConfinement,
  pythonStepRunner,
  pythonStepUnitArguments,
  resolveGitDirectories,
} from '../src/local-check.js';
import { type PythonStepRunner, preparePythonEnvironment } from '../src/python-environment.js';
import type { CheckOnlyManifest } from '../src/pinned-cargo.js';
import {
  DEFAULT_CHECK_UNIT_LIMITS,
  type PythonToolchain,
  toolchainProfileDigest,
} from '../src/toolchains.js';

/**
 * R-G17: an adopted check of a reviewed commit with a root `uv.lock` gets the configured Python
 * profile. Increment 1: each such check re-reads the tools' identities (decision 5, amended),
 * records them in its receipt, and is refused when a tool is missing, no longer root-owned or
 * writable by others, or no longer fits its configured version.
 */

const OPT_PYTHON = '/opt/craftingtable/python/cpython-3.12.15-linux-x86_64-gnu/bin/python3.12';
const OPT_UV = '/opt/craftingtable/bin/uv';
const optToolchain = existsSync(OPT_PYTHON) && existsSync(OPT_UV);
const SYSTEM_PYTHON = '/usr/bin/python3.14';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync(hostGit(), args, { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** A repository with an adopted check that leaves a marker when it runs. */
function fixture(options: {
  readonly python?: PythonToolchain;
  readonly files?: Readonly<Record<string, string>>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'ct-python-check-'));
  roots.push(root);
  const workspacePath = join(root, 'repository');
  mkdirSync(workspacePath);
  const marker = join(root, 'ran');
  const script = `#!/bin/sh\necho CHECK-RAN\n`;
  writeFileSync(join(workspacePath, 'check.sh'), script, { mode: 0o755 });
  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(join(workspacePath, path, '..'), { recursive: true });
    writeFileSync(join(workspacePath, path), content);
  }
  git(['init', '-q', '-b', 'main'], workspacePath);
  git(['add', '.'], workspacePath);
  git(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c'],
    workspacePath,
  );
  // Adopted with every Python environment file the tree tracks, as adoption requires.
  const environmentFiles = Object.keys(options.files ?? {}).filter((path) =>
    /(^|\/)(pyproject\.toml|uv\.lock|uv\.toml|\.python-version)$/.test(path),
  );
  const m: CheckOnlyManifest = {
    kind: 'checks',
    runId: 'run',
    gitExecutable: hostGit(),
    ...resolveGitDirectories(hostGit(), workspacePath),
    workspacePath,
    declaredChecks: {
      declarationId: asRepositoryCheckDeclarationId(randomUUID()),
      version: 1,
      checks: [
        {
          id: asDeclaredCheckId('c'),
          argv: ['./check.sh'],
          definitionPaths: ['check.sh', ...environmentFiles],
          definitionDigests: {
            'check.sh': sha256(script),
            ...Object.fromEntries(
              environmentFiles.map((path) => [path, sha256(options.files?.[path] ?? '')]),
            ),
          },
        },
      ],
    },
    ...(options.python ? { python: options.python } : {}),
  };
  const directory = join(root, 'run', 'checks');
  const prepared = prepareCheckManifest(directory, m, {
    directory: join(directory, 'requests'),
    replies: join(root, 'daemon', 'replies'),
    limitMs: 60_000,
  });
  const execute = async (overrides: Partial<CheckExecution> = {}) => {
    let output = '';
    const outcome = await executeCheck({
      tool: 'ct-check',
      manifestPath: prepared.manifestPath,
      manifestDigest: prepared.manifestDigest,
      manifest: prepared.manifest,
      args: ['--declared', 'c'],
      logPath: join(root, 'daemon', 'logs', `${randomUUID()}.log`),
      logReference: 'check-logs/run/c.log',
      privateDirectory: join(root, 'daemon', `${randomUUID()}.private`),
      declaredTargetDirectory: join(root, 'daemon', 'declared-target'),
      confinement: 'none',
      unitName: 'unused',
      writablePaths: [workspacePath],
      environment: { PATH: '/usr/bin:/bin' },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
      ...overrides,
    });
    return { ...outcome, output };
  };
  return { root, workspacePath, marker, execute };
}

const LOCK = 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n';
const ROOT_LOCK = { 'uv.lock': LOCK };

it('refuses a Python check whose interpreter is not root-owned, and runs nothing of it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-python-owned-'));
  roots.push(root);
  const interpreter = join(root, 'python3.12');
  copyFileSync(SYSTEM_PYTHON, interpreter);
  const f = fixture({
    python: { interpreter, version: '3', uv: { path: '/usr/bin/env', version: '0' } },
    files: ROOT_LOCK,
  });
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CHECK-RAN');
  expect(result.receipt.success).toBe(false);
  expect(result.diagnostic).toContain(interpreter);
  expect(result.diagnostic).toMatch(/not owned by root|writable by its group or by others/);
  expect(result.toolchain?.[0]?.problem?.code).toMatch(/^(untrusted-owner|writable)$/);
});

it('refuses a Python check whose interpreter no longer fits its configured version, recording what it found', async () => {
  const f = fixture({
    python: {
      interpreter: SYSTEM_PYTHON,
      version: '3.12',
      uv: { path: '/usr/bin/env', version: '0' },
    },
    files: ROOT_LOCK,
  });
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CHECK-RAN');
  expect(result.diagnostic).toContain('does not fit the configured 3.12');
  const recorded = result.receipt.python as { tools: { tool: string; version?: string }[] };
  expect(recorded.tools[0]).toMatchObject({ tool: 'python' });
  expect(recorded.tools[0]?.version).toMatch(/^3\.14\./);
});

it('refuses a Python check whose interpreter is missing', async () => {
  const f = fixture({
    python: {
      interpreter: '/opt/craftingtable-no-such/bin/python3.12',
      version: '3.12',
      uv: { path: '/usr/bin/env', version: '0' },
    },
    files: ROOT_LOCK,
  });
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CHECK-RAN');
  expect(result.diagnostic).toContain('does not exist');
});

it('refuses a Python check whose uv alone is missing, while the interpreter fits (review L-3)', async () => {
  const f = fixture({
    python: {
      interpreter: SYSTEM_PYTHON,
      version: '3',
      uv: { path: '/opt/craftingtable-no-such/bin/uv', version: '0.12' },
    },
    files: ROOT_LOCK,
  });
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CHECK-RAN');
  expect(result.diagnostic).toContain('uv /opt/craftingtable-no-such/bin/uv');
});

it('refuses a Python check whose uv alone does not answer its probe (review L-3)', async () => {
  const f = fixture({
    python: {
      interpreter: SYSTEM_PYTHON,
      version: '3',
      uv: { path: '/usr/bin/false', version: '0' },
    },
    files: ROOT_LOCK,
  });
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CHECK-RAN');
  expect(result.diagnostic).toContain('did not answer its fixed version probe');
});

it('gives a check no Python, and reads no tool, without a root uv.lock, even with a nested one', async () => {
  // A profile that would be refused: it is not consulted, so the check runs as before.
  const python = {
    interpreter: '/opt/craftingtable-no-such/bin/python3.12',
    version: '3.12',
    uv: { path: '/usr/bin/env', version: '0' },
  };
  const trees: Record<string, string>[] = [{}, { 'tools/sub/uv.lock': LOCK }];
  for (const files of trees) {
    const f = fixture({ python, files });
    const result = await f.execute();
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    expect(result.output).toContain('CHECK-RAN');
    expect(result.receipt.python).toBeUndefined();
    expect(result.toolchain).toBeUndefined();
  }
});

it('takes a root uv.lock that is a link as a Python project, so its tools are still checked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-python-link-'));
  roots.push(root);
  const f = fixture({
    python: {
      interpreter: '/opt/craftingtable-no-such/bin/python3.12',
      version: '3.12',
      uv: { path: '/usr/bin/env', version: '0' },
    },
  });
  // Committed as a link, as an agent could commit one.
  symlinkSync('/etc/hostname', join(f.workspacePath, 'uv.lock'));
  git(['add', 'uv.lock'], f.workspacePath);
  git(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'link'],
    f.workspacePath,
  );
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CHECK-RAN');
});

/*
 * R-G19 (ADR-076, revising R-G17's increment 3): an adopted check of a Python project runs in a
 * fresh venv that an install step builds in the check's private directory with
 * `uv sync --locked`, from PyPI and the tree only, packaged projects included; the check itself
 * then runs offline.
 */

const OPT_PROFILE: PythonToolchain = {
  interpreter: OPT_PYTHON,
  version: '3.12',
  uv: { path: OPT_UV, version: '0.12' },
};
const UNITTEST = ['python', '-m', 'unittest', 'discover', '-s', 'tests', '-v'];

/** A Python project with an adopted check: the packaged fixture, its in-tree wheel and its lock. */
function pythonCheck(
  options: {
    readonly argv?: readonly string[];
    readonly value?: number;
    readonly slow?: boolean;
    readonly uvSettings?: readonly string[];
    readonly extraFiles?: Readonly<Record<string, string>>;
    /** Replaces the lock the fixture's uv wrote. */
    readonly lock?: string;
    /** Files left out of the adopted definition files although the tree tracks them. */
    readonly unadopted?: readonly string[];
    readonly cargo?: string;
    readonly checkTimeoutMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ct-python-venv-'));
  roots.push(root);
  const workspacePath = join(root, 'repository');
  const wheel = writePythonProject(workspacePath, {
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.slow ? { slow: true } : {}),
    ...(options.uvSettings ? { uvSettings: options.uvSettings } : {}),
  });
  for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
    mkdirSync(join(workspacePath, path, '..'), { recursive: true });
    writeFileSync(join(workspacePath, path), content);
  }
  if (options.lock !== undefined) writeFileSync(join(workspacePath, 'uv.lock'), options.lock);
  git(['init', '-q', '-b', 'main'], workspacePath);
  git(['add', '.'], workspacePath);
  git(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c'],
    workspacePath,
  );
  const tracked = git(['ls-files'], workspacePath).split('\n');
  const definitionPaths = tracked.filter(
    (path) =>
      PYTHON_ENVIRONMENT_FILE_PATTERN.test(path) && !(options.unadopted ?? []).includes(path),
  );
  const m: CheckOnlyManifest = {
    kind: 'checks',
    runId: 'run',
    gitExecutable: hostGit(),
    ...resolveGitDirectories(hostGit(), workspacePath),
    workspacePath,
    declaredChecks: {
      declarationId: asRepositoryCheckDeclarationId(randomUUID()),
      version: 1,
      checks: [
        {
          id: asDeclaredCheckId('tests'),
          argv: [...(options.argv ?? UNITTEST)],
          definitionPaths,
          definitionDigests: Object.fromEntries(
            definitionPaths.map((path) => [path, sha256(readFileSync(join(workspacePath, path)))]),
          ),
        },
      ],
    },
    python: OPT_PROFILE,
    ...(options.cargo ? { cargoExecutable: options.cargo } : {}),
    ...(options.checkTimeoutMs ? { checkTimeoutMs: options.checkTimeoutMs } : {}),
  };
  const directory = join(root, 'run', 'checks');
  const prepared = prepareCheckManifest(directory, m, {
    directory: join(directory, 'requests'),
    replies: join(root, 'daemon', 'replies'),
    limitMs: 60_000,
  });
  const privateDirectory = join(root, 'daemon', `${randomUUID()}.private`);
  const execute = async (overrides: Partial<CheckExecution> = {}) => {
    let output = '';
    const outcome = await executeCheck({
      tool: 'ct-check',
      manifestPath: prepared.manifestPath,
      manifestDigest: prepared.manifestDigest,
      manifest: prepared.manifest,
      args: ['--declared', 'tests'],
      logPath: join(root, 'daemon', 'logs', `${randomUUID()}.log`),
      logReference: 'check-logs/run/tests.log',
      privateDirectory,
      declaredTargetDirectory: join(root, 'daemon', 'declared-target'),
      confinement: 'none',
      unitName: 'unused',
      writablePaths: [workspacePath],
      environment: { PATH: '/usr/bin:/bin' },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
      ...overrides,
    });
    return { ...outcome, output };
  };
  return { root, workspacePath, wheel, privateDirectory, execute };
}

const itPython = it.skipIf(!optToolchain);

itPython(
  'installs a packaged project with `uv sync --locked` into a fresh venv, runs its console script, and records the lock',
  async () => {
    const f = pythonCheck();
    const result = await f.execute();
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    // The locked package, installed into the check's own venv; the project's console script.
    expect(result.output).toMatch(
      /CTFIX 42 \S*\.private\/python\/venv\/lib\/python3\.12\/site-packages\/ctfix_pkg\/__init__\.py/,
    );
    expect(result.output).toContain('FROM-SCRIPT CTFIX-APP 42');
    expect(result.output).toContain('uv sync --locked');
    const recorded = result.receipt.python as {
      profileDigest: string;
      lockDigest: string;
      wheelSetDigest?: string;
      tools: { tool: string; path: string; sha256: string; version: string; uid: number }[];
    };
    expect(recorded.lockDigest).toBe(sha256(readFileSync(join(f.workspacePath, 'uv.lock'))));
    // No store of wheels any more (R-G19): the lock is what the install was held to.
    expect(recorded.wheelSetDigest).toBeUndefined();
    // The tools as the check re-read them (R-G17 decision 5), and the profile as configured.
    expect(recorded.profileDigest).toBe(toolchainProfileDigest(OPT_PROFILE));
    expect(recorded.tools.map((t) => [t.tool, t.path, t.uid])).toEqual([
      ['python', OPT_PYTHON, 0],
      ['uv', OPT_UV, 0],
    ]);
    expect(recorded.tools[0]?.sha256).toBe(sha256(readFileSync(OPT_PYTHON)));
    expect(recorded.tools[0]?.version).toMatch(/^3\.12\.\d+$/);
    expect(recorded.tools[1]?.version).toMatch(/^0\.12\.\d+$/);
    // The daemon is told what it found, for Tools.
    expect(result.toolchain?.map((o) => o.tool)).toEqual(['python', 'uv']);
    // Nothing of it is left, its private uv cache included: the next check builds its own.
    expect(existsSync(join(f.privateDirectory, 'python'))).toBe(false);
  },
);

itPython(
  "keeps what it downloads and builds in the daemon's check cache when given one, and its venv apart from it",
  async () => {
    const f = pythonCheck();
    const cache = join(f.root, 'daemon', 'uv-checks');
    const result = await f.execute({ pythonCacheDirectory: cache });
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    // uv kept the project's build and the vendored wheel there, for the next check.
    expect(existsSync(cache)).toBe(true);
    expect(git(['ls-files'], f.workspacePath)).not.toContain('uv-checks');
    expect(spawnSync('find', [cache, '-name', 'ctfix_pkg'], { encoding: 'utf8' }).stdout).not.toBe(
      '',
    );
    expect(existsSync(join(f.privateDirectory, 'python'))).toBe(false);
    // A second check installs again, from that cache, into a venv of its own.
    const second = await f.execute({ pythonCacheDirectory: cache });
    expect(second.exitCode, second.output + second.diagnostic).toBe(0);
    expect(second.output).toMatch(/Installed \d+ packages?/);
  },
);

itPython(
  "installs a project whose uv settings the lock records, which the install's `UV_NO_CONFIG` would otherwise drop (R-G19 review HIGH-1)",
  async () => {
    const f = pythonCheck({
      uvSettings: [
        'exclude-newer = "2026-01-01T00:00:00Z"',
        'resolution = "lowest-direct"',
        'prerelease = "allow"',
        'exclude-newer-package = { ctfix-pkg = "2026-02-01T00:00:00Z" }',
      ],
    });
    expect(readFileSync(join(f.workspacePath, 'uv.lock'), 'utf8')).toContain(
      'resolution-mode = "lowest-direct"',
    );
    const result = await f.execute();
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    expect(result.output).toContain('FROM-SCRIPT CTFIX-APP 42');
  },
);

itPython(
  'refuses, by name and before installing, a resolver option the lock records that it cannot pass to uv (mutation round 2, O7)',
  async () => {
    const f = pythonCheck();
    const lock = readFileSync(join(f.workspacePath, 'uv.lock'), 'utf8');
    writeFileSync(
      join(f.workspacePath, 'uv.lock'),
      lock.replace(
        'requires-python = ">=3.12"\n',
        'requires-python = ">=3.12"\n\n[options]\nresolution-mode = "newest"\n',
      ),
    );
    git(['add', '-A'], f.workspacePath);
    git(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'options'],
      f.workspacePath,
    );
    const result = await f.execute();
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain('uv sync --locked');
    expect(result.diagnostic).toContain('resolver option resolution-mode');
  },
);

itPython(
  "refuses, by name and before installing, a lock that records the project's dependency metadata, which the install's `UV_NO_CONFIG` would drop (R-G19 re-check R-2)",
  async () => {
    const f = pythonCheck();
    const lock = readFileSync(join(f.workspacePath, 'uv.lock'), 'utf8');
    writeFileSync(
      join(f.workspacePath, 'uv.lock'),
      `${lock}\n[[manifest.dependency-metadata]]\nname = "ctfix-pkg"\nversion = "1.0"\nrequires-dist = []\n`,
    );
    git(['add', '-A'], f.workspacePath);
    git(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'metadata'],
      f.workspacePath,
    );
    const result = await f.execute();
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain('uv sync --locked');
    expect(result.diagnostic).toContain('dependency-metadata');
  },
);

itPython(
  "fails, with uv's reason, when a file of the tree does not match the lock's hash",
  async () => {
    const f = pythonCheck();
    // The vendored wheel changed after the lock was written: uv checks it against the lock.
    buildWheel(join(f.workspacePath, 'vendor'), 'ctfix-pkg', '1.0', {
      'ctfix_pkg/__init__.py': 'VALUE = 666\n',
    });
    git(['add', '-A'], f.workspacePath);
    git(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'swap'],
      f.workspacePath,
    );
    const result = await f.execute();
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain('CTFIX');
    expect(result.diagnostic).toContain('uv sync --locked');
    expect(result.diagnostic).toContain('Hash mismatch');
  },
);

itPython(
  'refuses, by name, a lock that names a source other than PyPI or the tree, installing nothing',
  async () => {
    const lock = [
      'version = 1',
      'revision = 3',
      'requires-python = ">=3.12"',
      '',
      '[[package]]',
      'name = "ct-python-fixture"',
      'version = "0.1.0"',
      'source = { editable = "." }',
      '',
      '[[package]]',
      'name = "from-git"',
      'version = "1.0"',
      'source = { git = "https://example.org/from-git.git?rev=v1#0123456789abcdef0123456789abcdef01234567" }',
      '',
      '[[package]]',
      'name = "mirrored"',
      'version = "1.0"',
      'source = { registry = "https://mirror.example.org/simple" }',
      `sdist = { url = "https://mirror.example.org/mirrored-1.0.tar.gz", hash = "sha256:${'a'.repeat(64)}" }`,
      '',
      '[[package]]',
      'name = "sdist-elsewhere"',
      'version = "1.0"',
      'source = { registry = "https://pypi.org/simple" }',
      `sdist = { url = "https://example.org/sdist-elsewhere-1.0.tar.gz", hash = "sha256:${'b'.repeat(64)}" }`,
      '',
      '[[package]]',
      'name = "outside"',
      'version = "1.0"',
      'source = { directory = "../outside" }',
      '',
    ].join('\n');
    const f = pythonCheck({ lock });
    const result = await f.execute();
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain('CTFIX');
    expect(result.output).not.toContain('uv sync --locked');
    expect(result.diagnostic).toContain('from-git comes from Git');
    expect(result.diagnostic).toContain('mirrored comes from an index other than PyPI');
    // Read from the lock's sdist entry (mutation round 1, P13).
    expect(result.diagnostic).toContain('sdist-elsewhere comes from an index other than PyPI');
    expect(result.diagnostic).toContain('outside lies outside the repository');
  },
);

itPython(
  "never takes a package from PYTHONPATH, the environment's uv or pip settings, or a venv it names",
  async () => {
    const f = pythonCheck();
    // Planted where an agent could write: a package that says 666.
    const planted = join(f.root, 'planted');
    mkdirSync(join(planted, 'ctfix_pkg'), { recursive: true });
    writeFileSync(join(planted, 'ctfix_pkg', '__init__.py'), 'VALUE = 666\n');
    const result = await f.execute({
      environment: {
        PATH: '/usr/bin:/bin',
        PYTHONPATH: planted,
        PYTHONHOME: planted,
        PYTHONSTARTUP: join(planted, 'ctfix_pkg', '__init__.py'),
        UV_CACHE_DIR: planted,
        UV_FIND_LINKS: planted,
        UV_INDEX_URL: 'https://example.org/simple',
        PIP_FIND_LINKS: planted,
        VIRTUAL_ENV: planted,
      },
    });
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    expect(result.output).toContain('CTFIX 42');
    expect(result.output).not.toContain('666');
  },
);

itPython(
  'uses its own venv, never one the tree carries, even through `uv run`, and never reuses one',
  async () => {
    const f = pythonCheck({
      argv: ['uv', 'run', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-v'],
      extraFiles: {
        // A venv committed in the reviewed tree, holding a planted package.
        '.venv/pyvenv.cfg': 'home = /usr/bin\n',
        '.venv/lib/python3.12/site-packages/ctfix_pkg/__init__.py': 'VALUE = 666\n',
      },
    });
    const first = await f.execute();
    expect(first.exitCode, first.output + first.diagnostic).toBe(0);
    expect(first.output).toContain('CTFIX 42');
    expect(first.output).toContain('.private/python/venv/');
    // A second check installs again into a new venv: uv says it installed, not that it audited.
    const second = await f.execute();
    expect(second.exitCode, second.output + second.diagnostic).toBe(0);
    expect(second.output).toMatch(/Installed \d+ packages?/);
  },
);

itPython(
  'refuses a Python environment file the check was not adopted with, at any depth, running nothing',
  async () => {
    for (const path of [
      'pytest.ini',
      '.pytest.ini',
      'tests/pytest.toml',
      '.coveragerc',
      'tools/lint/ruff.toml',
      'runtimes/a/pyproject.toml',
    ]) {
      const f = pythonCheck({
        extraFiles: { [path]: '[pytest]\naddopts = -p evil\n' },
        unadopted: [path],
      });
      const result = await f.execute();
      expect(result.exitCode, path).toBe(1);
      expect(result.output, path).not.toContain('CTFIX');
      expect(result.diagnostic, path).toContain(`${path} is not a definition file of this check`);
    }
  },
);

itPython('ends within seconds when cancelled during the install', async () => {
  const f = pythonCheck({ slow: true });
  const controller = new AbortController();
  let cancelled = 0;
  let installing = false;
  // Cancelled once uv has made the venv, before it builds the slow dependency (review NIT 1).
  const poll = setInterval(() => {
    if (cancelled || !existsSync(join(f.privateDirectory, 'python', 'venv', 'pyvenv.cfg'))) return;
    installing = true;
    setTimeout(() => {
      cancelled = Date.now();
      controller.abort();
    }, 500);
    clearInterval(poll);
  }, 50);
  const result = await f.execute({ signal: controller.signal });
  clearInterval(poll);
  expect(result.exitCode).toBe(1);
  expect(installing).toBe(true);
  expect(cancelled).toBeGreaterThan(0);
  expect(Date.now() - cancelled).toBeLessThan(5_000);
  expect(result.output).not.toContain('CTFIX');
  expect(existsSync(join(f.privateDirectory, 'python'))).toBe(false);
});

itPython('ends at the check time limit during the install', async () => {
  const f = pythonCheck({ slow: true, checkTimeoutMs: 6_000 });
  const started = Date.now();
  let installing = false;
  const poll = setInterval(() => {
    installing ||= existsSync(join(f.privateDirectory, 'python', 'venv', 'pyvenv.cfg'));
  }, 50);
  const result = await f.execute();
  clearInterval(poll);
  expect(result.exitCode).toBe(1);
  expect(installing).toBe(true);
  expect(Date.now() - started).toBeLessThan(14_000);
  expect(result.diagnostic).toContain('time limit');
  expect(result.output).not.toContain('CTFIX');
});

it.skipIf(!optToolchain || hostCargo === undefined)(
  'builds a Cargo binary and runs Python against it in one check, with the venv beside a fresh Cargo home (R-G17 decision 17)',
  async () => {
    const f = pythonCheck({
      argv: [
        'bash',
        '-c',
        'cargo build --offline --quiet && python -m unittest discover -s tests -v',
      ],
      cargo: hostCargo,
      extraFiles: {
        'Cargo.toml':
          '[package]\nname = "ctbin"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
        'Cargo.lock':
          '# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "ctbin"\nversion = "0.1.0"\n',
        'src/main.rs': 'fn main() { println!("RUST-BUILT"); }\n',
        'tests/test_rust.py': [
          'import os, subprocess, unittest',
          '',
          'class RustTest(unittest.TestCase):',
          '    def test_binary(self):',
          '        binary = os.path.join(os.environ["CARGO_TARGET_DIR"], "debug", "ctbin")',
          '        out = subprocess.run([binary], capture_output=True, text=True, check=True).stdout',
          '        print("FROM-RUST", out.strip(), "HOME", os.environ["CARGO_HOME"])',
          '        self.assertEqual(out.strip(), "RUST-BUILT")',
          '',
        ].join('\n'),
      },
    });
    const sharedCargoHome = join(f.root, 'shared-cargo-home');
    mkdirSync(join(sharedCargoHome, 'registry'), { recursive: true });
    mkdirSync(join(sharedCargoHome, 'git'), { recursive: true });
    const result = await f.execute({
      environment: {
        PATH: `${join(homedir(), '.cargo', 'bin')}:/usr/bin:/bin`,
        HOME: homedir(),
        CARGO_HOME: sharedCargoHome,
        RUSTUP_HOME: join(homedir(), '.rustup'),
      },
      cargoHomeDirectory: join(f.root, 'daemon', 'cargo-home-0'),
    });
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    expect(result.output).toContain('CTFIX 42');
    // The binary Cargo built in the check's own Cargo home, run by Python from the venv.
    expect(result.output).toContain(
      `FROM-RUST RUST-BUILT HOME ${join(f.root, 'daemon', 'cargo-home-0')}`,
    );
  },
);

const userManager = spawnSync('systemctl', ['--user', 'is-system-running'], {
  encoding: 'utf8',
}).stdout?.trim();
const itConfinedPython = it.skipIf(
  !optToolchain || !['running', 'degraded'].includes(userManager ?? ''),
);

itConfinedPython(
  'a confined Python check has no network and cannot change its venv, which its install step made',
  async () => {
    const probe = [
      'import os, socket, subprocess, ctfix_pkg',
      'print("CTFIX", ctfix_pkg.VALUE)',
      'print(subprocess.run(["ctfix-app"], capture_output=True, text=True).stdout.strip())',
      'try:',
      '    socket.create_connection(("pypi.org", 443), 3)',
      '    print("NET-OPEN")',
      'except OSError:',
      '    print("NET-DENIED")',
      'try:',
      '    open(os.path.join(os.environ["VIRTUAL_ENV"], "planted"), "w")',
      '    print("VENV-WRITABLE")',
      'except OSError:',
      '    print("VENV-READONLY")',
    ].join('\n');
    const f = pythonCheck({ argv: ['python', '-c', probe] });
    const cache = join(f.root, 'daemon', 'uv-checks');
    const result = await f.execute({
      confinement: 'systemd',
      unitName: `craftingtable-check-test-${process.pid}-${Date.now()}`,
      hiddenRoots: [f.root],
      pythonCacheDirectory: cache,
    });
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    expect(result.output).toContain('CTFIX 42');
    expect(result.output).toContain('CTFIX-APP 42');
    expect(result.output).toContain('NET-DENIED');
    expect(result.output).toContain('VENV-READONLY');
  },
);

itConfinedPython("stops a confined install's unit within seconds of a cancel", async () => {
  const f = pythonCheck({ slow: true });
  const unitName = `craftingtable-check-test-${process.pid}-${Date.now()}`;
  const controller = new AbortController();
  const units = () =>
    spawnSync('systemctl', ['--user', 'list-units', '--plain', '--no-legend', `${unitName}*`], {
      encoding: 'utf8',
    }).stdout.trim();
  let during = '';
  let cancelled = 0;
  setTimeout(() => {
    during = units();
    cancelled = Date.now();
    controller.abort();
  }, 2_500);
  const result = await f.execute({
    confinement: 'systemd',
    unitName,
    hiddenRoots: [f.root],
    pythonCacheDirectory: join(f.root, 'daemon', 'uv-checks'),
    signal: controller.signal,
  });
  expect(result.exitCode).toBe(1);
  // The install step ran in its own unit, numbered after the check's.
  expect(during).toContain(`${unitName}-python-2`);
  expect(Date.now() - cancelled).toBeLessThan(5_000);
  expect(units()).toBe('');
});

itPython('refuses a root uv.lock committed as a link, never reading through it', async () => {
  const f = pythonCheck();
  rmSync(join(f.workspacePath, 'uv.lock'));
  symlinkSync('/etc/hostname', join(f.workspacePath, 'uv.lock'));
  git(['add', '-A'], f.workspacePath);
  git(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'link'],
    f.workspacePath,
  );
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CTFIX');
  // Either refusal holds: the adopted lock's digest no longer matches, or it is no file.
  expect(result.diagnostic).toContain('uv.lock must be a regular file');
});

describe("a Python check's helper steps (R-G17 increment 3 review L1–L4; R-G19)", () => {
  const confinement = {
    unitName: 'craftingtable-check-x',
    limits: DEFAULT_CHECK_UNIT_LIMITS,
    directory: '/data/private/python',
    tree: '/data/private/clone',
    cache: '/data/uv/checks',
    hiddenRoots: ['/agents/root', '/data/cargo-home', '/repo/.git'],
    inaccessible: ['/work/x', '/run/dir'],
    home: '/home/op',
  };
  const runtime = `/run/user/${process.getuid?.()}`;
  const properties = (args: readonly string[]) =>
    args.flatMap((arg, index) => (args[index - 1] === '-p' ? [arg] : []));

  it('reads the lock in a unit with no network that writes only the Python directory and reads the clone', () => {
    const args = pythonStepUnitArguments(
      confinement,
      'craftingtable-check-x-python-1',
      OPT_PYTHON,
      ['-I', '-S', '-c', 'reader'],
      {
        cwd: '/data/private/python',
        env: { PATH: '/usr/bin:/bin', UV_NO_CONFIG: '1' },
        timeoutMs: 60_000,
        install: false,
      },
    );
    const set = properties(args);
    expect(args).toContain('--unit=craftingtable-check-x-python-1');
    expect(set).toEqual(
      expect.arrayContaining([
        'PrivateNetwork=yes',
        'ProtectHome=read-only',
        'RuntimeMaxSec=60',
        'MemorySwapMax=0',
        'ReadWritePaths=-/data/private/python',
        'InaccessiblePaths=-/work/x',
        'InaccessiblePaths=-/run/dir',
        'TemporaryFileSystem=/agents/root:ro',
        'TemporaryFileSystem=/data/cargo-home:ro',
        'TemporaryFileSystem=/repo/.git:ro',
        'TemporaryFileSystem=/home/op:ro',
        'BindPaths=/data/private/python',
        'BindReadOnlyPaths=-/data/private/clone',
      ]),
    );
    // Nothing else is writable: neither the clone nor the uv cache.
    expect(set.filter((p) => p.startsWith('ReadWritePaths='))).toEqual([
      'ReadWritePaths=-/data/private/python',
    ]);
    expect(set.filter((p) => p.startsWith('BindPaths='))).toEqual([
      'BindPaths=/data/private/python',
    ]);
    expect(args.slice(args.indexOf('--'))).toEqual(
      expect.arrayContaining([OPT_PYTHON, 'reader', 'UV_NO_CONFIG=1']),
    );
  });

  it('runs the install in a unit with the network that writes the Python directory, the clone and the uv cache, and reaches no Docker socket or runtime directory (R-G19)', () => {
    const set = properties(
      pythonStepUnitArguments(confinement, 'craftingtable-check-x-python-2', OPT_UV, ['sync'], {
        cwd: '/data/private/clone',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 600_000,
        install: true,
      }),
    );
    expect(set).toContain('PrivateNetwork=no');
    // A stop ends a build that ignores SIGTERM within seconds, not systemd's 90 (review NIT 5).
    expect(set).toContain('TimeoutStopSec=5');
    expect(set.filter((p) => p.startsWith('ReadWritePaths='))).toEqual([
      'ReadWritePaths=-/data/private/python',
      'ReadWritePaths=-/data/private/clone',
      'ReadWritePaths=-/data/uv/checks',
    ]);
    expect(set.filter((p) => p.startsWith('BindPaths='))).toEqual([
      'BindPaths=/data/private/python',
      'BindPaths=/data/private/clone',
      'BindPaths=/data/uv/checks',
    ]);
    expect(set.filter((p) => p.startsWith('BindReadOnlyPaths='))).toEqual([]);
    // Still everything agents write hidden, and nothing of the user's runtime directory or
    // Docker, as for any check: the network is the install's only addition.
    expect(set).toEqual(
      expect.arrayContaining([
        'TemporaryFileSystem=/agents/root:ro',
        'TemporaryFileSystem=/home/op:ro',
        'InaccessiblePaths=-/work/x',
        `TemporaryFileSystem=${runtime}:ro`,
        'InaccessiblePaths=-/run/docker.sock',
        'InaccessiblePaths=-/var/run/docker.sock',
        'InaccessiblePaths=-/run/dbus/system_bus_socket',
      ]),
    );
  });

  it("takes a step's confinement from the check's execution (re-check S2b, S5, S5c)", () => {
    const signal = new AbortController().signal;
    expect(
      pythonStepConfinement(
        {
          confinement: 'systemd',
          unitName: 'craftingtable-check-x',
          hiddenRoots: ['/agents/root'],
          manifestPath: '/run/launcher/manifest.json',
          writablePaths: ['/work/x', '/run/dir'],
          signal,
        },
        {
          limits: DEFAULT_CHECK_UNIT_LIMITS,
          directory: '/data/private/python',
          tree: '/data/private/clone',
          cache: '/data/uv/checks',
          workspacePath: '/work/x',
          sharedCargoHome: '/data/cargo-home',
          commonDirectory: '/repo/.git',
        },
      ),
    ).toEqual({
      confinement: 'systemd',
      unitName: 'craftingtable-check-x',
      limits: DEFAULT_CHECK_UNIT_LIMITS,
      directory: '/data/private/python',
      tree: '/data/private/clone',
      cache: '/data/uv/checks',
      hiddenRoots: ['/agents/root', '/data/cargo-home', '/repo/.git'],
      inaccessible: ['/work/x', '/run/launcher', '/work/x', '/run/dir', '/data/cargo-home'],
      home: homedir(),
      signal,
    });
  });

  it('ends a step at once on a cancel, and at its own time limit', async () => {
    const controller = new AbortController();
    const run = pythonStepRunner({
      ...confinement,
      confinement: 'none',
      signal: controller.signal,
    });
    let started = Date.now();
    setTimeout(() => controller.abort(), 200);
    const cancelled = await run('/usr/bin/sleep', ['60'], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 60_000,
      install: false,
    });
    expect(cancelled.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    const limited = pythonStepRunner({
      ...confinement,
      confinement: 'none',
      signal: new AbortController().signal,
    });
    started = Date.now();
    const timedOut = await limited('/usr/bin/sleep', ['60'], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 300,
      install: false,
    });
    expect(timedOut.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it.skipIf(!['running', 'degraded'].includes(userManager ?? ''))(
    "stops a confined step's unit on a cancel, not only the systemd-run client",
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ct-python-step-'));
      roots.push(root);
      const unitName = `craftingtable-check-test-${process.pid}-${Date.now()}`;
      const controller = new AbortController();
      const run = pythonStepRunner({
        ...confinement,
        unitName,
        directory: root,
        tree: root,
        cache: root,
        hiddenRoots: [],
        inaccessible: [],
        home: homedir(),
        confinement: 'systemd',
        signal: controller.signal,
      });
      const started = Date.now();
      const unitState = () =>
        spawnSync('systemctl', ['--user', 'is-active', `${unitName}-python-1`], {
          encoding: 'utf8',
        }).stdout.trim();
      let before = '';
      setTimeout(() => {
        // The step runs in its own unit, numbered after the check's.
        before = unitState();
        controller.abort();
      }, 1_000);
      const result = await run('/usr/bin/sleep', ['60'], {
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 60_000,
        install: false,
      });
      expect(before).toBe('active');
      expect(result.code).toBeNull();
      expect(Date.now() - started).toBeLessThan(12_000);
      expect(unitState()).not.toBe('active');
    },
  );

  it("keeps the end of a step's error output, where uv names the cause, past 64 KiB (R-G19 review LOW-1)", async () => {
    const run = pythonStepRunner({
      ...confinement,
      confinement: 'none',
      signal: new AbortController().signal,
    });
    const result = await run(
      '/usr/bin/bash',
      [
        '-c',
        'for i in $(seq 1 20000); do echo "noise line $i" >&2; done; echo FINAL-CAUSE >&2; exit 1',
      ],
      { cwd: '/', env: { PATH: '/usr/bin:/bin' }, timeoutMs: 60_000, install: false },
    );
    expect(result.code).toBe(1);
    expect(result.stderr.trimEnd().endsWith('FINAL-CAUSE')).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(64 * 1024);
  });

  it.skipIf(!['running', 'degraded'].includes(userManager ?? ''))(
    'stops a confined step whose processes ignore SIGTERM within seconds of a cancel (R-G19 review NIT 5)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ct-python-step-'));
      roots.push(root);
      const unitName = `craftingtable-check-test-${process.pid}-${Date.now()}`;
      const controller = new AbortController();
      const run = pythonStepRunner({
        ...confinement,
        unitName,
        directory: root,
        tree: root,
        cache: root,
        hiddenRoots: [],
        inaccessible: [],
        home: homedir(),
        confinement: 'systemd',
        signal: controller.signal,
      });
      let cancelled = 0;
      setTimeout(() => {
        cancelled = Date.now();
        controller.abort();
      }, 1_000);
      // A build that ignores SIGTERM: only SIGKILL ends it.
      const result = await run('/usr/bin/bash', ['-c', "trap '' TERM; while :; do sleep 1; done"], {
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 120_000,
        install: false,
      });
      expect(result.code).toBeNull();
      expect(Date.now() - cancelled).toBeLessThan(15_000);
      expect(
        spawnSync('systemctl', ['--user', 'is-active', `${unitName}-python-1`], {
          encoding: 'utf8',
        }).stdout.trim(),
      ).not.toBe('active');
    },
    60_000,
  );

  itPython(
    'installs with fixed arguments: `uv sync --locked` on the profile, no configuration, its own cache, venv copies, each step within the time left',
    async () => {
      const f = pythonCheck();
      const directory = join(f.root, 'python');
      const cache = join(f.root, 'uv-checks');
      const calls: {
        command: string;
        args: readonly string[];
        cwd: string;
        env: Record<string, string>;
        timeoutMs: number;
        install: boolean;
      }[] = [];
      const record: PythonStepRunner = async (command, args, options) => {
        calls.push({
          command,
          args,
          cwd: options.cwd,
          env: { ...options.env },
          timeoutMs: options.timeoutMs,
          install: options.install,
        });
        const result = spawnSync(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          encoding: 'utf8',
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
      };
      const environment = await preparePythonEnvironment({
        profile: OPT_PROFILE,
        tree: f.workspacePath,
        lock: readFileSync(join(f.workspacePath, 'uv.lock')),
        directory,
        cache,
        signal: new AbortController().signal,
        remainingMs: () => 654_321,
        run: record,
        onOutput: () => undefined,
      });
      const venv = join(directory, 'venv');
      expect(
        calls.map((call) => [
          call.command,
          ...call.args.filter((a) => !a.includes('\n')),
          call.cwd,
          call.install,
        ]),
      ).toEqual([
        [OPT_PYTHON, '-I', '-S', '-c', join(directory, 'uv.lock'), directory, false],
        [OPT_UV, 'sync', '--locked', '--python', OPT_PYTHON, f.workspacePath, true],
      ]);
      const scratch = join(directory, 'tmp');
      expect(calls[0]?.env).toEqual({
        PATH: '/usr/bin:/bin',
        HOME: scratch,
        TMPDIR: scratch,
        LC_ALL: 'C',
      });
      expect(calls[1]?.env).toEqual({
        PATH: '/usr/bin:/bin',
        HOME: scratch,
        TMPDIR: scratch,
        LC_ALL: 'C',
        UV_CACHE_DIR: cache,
        UV_PROJECT_ENVIRONMENT: venv,
        UV_PYTHON: OPT_PYTHON,
        UV_PYTHON_DOWNLOADS: 'never',
        UV_NO_CONFIG: '1',
        UV_LINK_MODE: 'copy',
        UV_NO_PROGRESS: '1',
      });
      // The lock is read within ten minutes; the install may take what is left of the check's.
      expect(calls[0]?.timeoutMs).toBe(600_000);
      expect(calls[1]?.timeoutMs).toBe(654_321);
      // The check's own environment (re-check E7, E8): every inherited Python or uv setting
      // dropped, then the venv's, uv offline, frozen and with no configuration.
      expect(
        environment.environment({
          PATH: '/usr/bin:/bin',
          TMPDIR: '/scratch',
          HOME: '/scratch',
          PYTHONPATH: '/planted',
          UV_INDEX_URL: 'https://example.org/simple',
          PIP_FIND_LINKS: '/planted',
          VIRTUAL_ENV: '/planted',
        }),
      ).toEqual({
        PATH: `${join(venv, 'bin')}:/opt/craftingtable/bin:/usr/bin:/bin`,
        TMPDIR: '/scratch',
        HOME: '/scratch',
        VIRTUAL_ENV: venv,
        UV_PROJECT_ENVIRONMENT: venv,
        UV_PYTHON: join(venv, 'bin', 'python'),
        UV_PYTHON_DOWNLOADS: 'never',
        UV_OFFLINE: '1',
        UV_FROZEN: '1',
        UV_NO_SYNC: '1',
        UV_NO_CONFIG: '1',
        UV_CACHE_DIR: '/scratch/uv-cache',
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      });
      expect(environment.lockDigest).toBe(sha256(readFileSync(join(f.workspacePath, 'uv.lock'))));
    },
  );
});
