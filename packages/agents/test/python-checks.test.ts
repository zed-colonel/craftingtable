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
import { buildWheel, FixtureWheels, lockFor, writePythonProject } from './python-fixture.js';
import {
  type CheckExecution,
  executeCheck,
  prepareCheckManifest,
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
 * Increment 3 (decisions 11, 12, 13 and 17): an adopted check of a Python project runs in a fresh
 * venv built offline, in the check's private directory, from the daemon's verified wheels alone.
 */

const OPT_PROFILE: PythonToolchain = {
  interpreter: OPT_PYTHON,
  version: '3.12',
  uv: { path: OPT_UV, version: '0.12' },
};
const UNITTEST = ['python', '-m', 'unittest', 'discover', '-s', 'tests', '-v'];

/** A Python project with an adopted check, the wheels it locks, and the store standing in for PyPI. */
function pythonCheck(
  options: {
    readonly argv?: readonly string[];
    readonly value?: number;
    readonly sdistOnly?: readonly { name: string; version: string }[];
    readonly extraFiles?: Readonly<Record<string, string>>;
    /** Files left out of the adopted definition files although the tree tracks them. */
    readonly unadopted?: readonly string[];
    readonly hold?: boolean;
    readonly serve?: 'all' | 'none';
    readonly cargo?: string;
    readonly checkTimeoutMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ct-python-venv-'));
  roots.push(root);
  const workspacePath = join(root, 'repository');
  const wheel = writePythonProject(workspacePath, join(root, 'wheels'), {
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.sdistOnly ? { sdistOnly: options.sdistOnly } : {}),
  });
  for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
    mkdirSync(join(workspacePath, path, '..'), { recursive: true });
    writeFileSync(join(workspacePath, path), content);
  }
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
  const store = new FixtureWheels(options.serve === 'none' ? [] : [wheel], options.hold ?? false);
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
      pythonWheels: store,
      ...overrides,
    });
    return { ...outcome, output };
  };
  return { root, workspacePath, wheel, store, privateDirectory, execute };
}

const itPython = it.skipIf(!optToolchain);

itPython(
  'runs the adopted check in a fresh venv built offline from the verified wheels, and records the lock and the wheel set',
  async () => {
    const f = pythonCheck();
    const result = await f.execute();
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    // The locked package, installed from the verified wheel into the check's own venv.
    expect(result.output).toMatch(
      /CTFIX 42 \S*\.private\/python\/venv\/lib\/python3\.12\/site-packages\/ctfix_pkg\/__init__\.py/,
    );
    expect(f.store.requests).toEqual([
      { name: 'ctfix-pkg', version: '1.0', filename: f.wheel.filename, sha256: f.wheel.sha256 },
    ]);
    const recorded = result.receipt.python as {
      lockDigest: string;
      wheelSetDigest: string;
      tools: { tool: string }[];
    };
    expect(recorded.lockDigest).toBe(sha256(readFileSync(join(f.workspacePath, 'uv.lock'))));
    expect(recorded.wheelSetDigest).toBe(sha256(`${f.wheel.sha256}  ${f.wheel.filename}\n`));
    expect(recorded.tools.map((t) => t.tool)).toEqual(['python', 'uv']);
    // The tools as the check re-read them (decision 5), and the profile as configured.
    const tools = result.receipt.python as {
      profileDigest: string;
      tools: { tool: string; path: string; sha256: string; version: string; uid: number }[];
    };
    expect(tools.profileDigest).toBe(toolchainProfileDigest(OPT_PROFILE));
    expect(tools.tools.map((t) => [t.tool, t.path, t.uid])).toEqual([
      ['python', OPT_PYTHON, 0],
      ['uv', OPT_UV, 0],
    ]);
    expect(tools.tools[0]?.sha256).toBe(sha256(readFileSync(OPT_PYTHON)));
    expect(tools.tools[0]?.version).toMatch(/^3\.12\.\d+$/);
    expect(tools.tools[1]?.version).toMatch(/^0\.12\.\d+$/);
    // The daemon is told what it found, for Tools.
    expect(result.toolchain?.map((o) => o.tool)).toEqual(['python', 'uv']);
    // Nothing of it is left: the next check builds its own.
    expect(existsSync(join(f.privateDirectory, 'python'))).toBe(false);
  },
);

itPython('fails naming the file when the store cannot vouch for a locked wheel', async () => {
  const f = pythonCheck({ serve: 'none' });
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CTFIX');
  expect(result.diagnostic).toContain(f.wheel.filename);
});

itPython('refuses an sdist-only dependency by name, building and running nothing', async () => {
  const f = pythonCheck({ sdistOnly: [{ name: 'only-source', version: '2.0' }] });
  const result = await f.execute();
  expect(result.exitCode).toBe(1);
  expect(result.output).not.toContain('CTFIX');
  expect(result.diagnostic).toContain('only-source');
  expect(result.diagnostic).toMatch(/source distribution|sdist/);
  expect(f.store.requests).toEqual([]);
});

itPython(
  "never takes a package from the agents' cache, PYTHONPATH or a venv the environment names",
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
    // A second check builds again: with the store now unable to vouch, it cannot pass on the
    // first one's venv.
    const second = await f.execute({ pythonWheels: new FixtureWheels([]) });
    expect(second.exitCode).toBe(1);
    expect(second.output).not.toContain('CTFIX');
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

itPython('ends within seconds when cancelled while a wheel is fetched', async () => {
  const f = pythonCheck({ hold: true });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 300);
  const result = await f.execute({ signal: controller.signal });
  expect(result.exitCode).toBe(1);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.output).not.toContain('CTFIX');
});

itPython(
  'ends at the check time limit while a wheel is fetched (increment 3 review M2)',
  async () => {
    const f = pythonCheck({ hold: true, checkTimeoutMs: 2_000 });
    const started = Date.now();
    const result = await f.execute();
    expect(result.exitCode).toBe(1);
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(result.diagnostic).toContain('time limit');
    expect(result.output).not.toContain('CTFIX');
  },
);

it.skipIf(!optToolchain || hostCargo === undefined)(
  'builds a Cargo binary and runs Python against it in one check, with the venv beside a fresh Cargo home (decision 17)',
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

it.skipIf(!optToolchain || !['running', 'degraded'].includes(userManager ?? ''))(
  "a confined Python check has no network and cannot change its venv, which its build's units made with none either",
  async () => {
    const probe = [
      'import os, socket, ctfix_pkg',
      'print("CTFIX", ctfix_pkg.VALUE)',
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
    const result = await f.execute({
      confinement: 'systemd',
      unitName: `craftingtable-check-test-${process.pid}-${Date.now()}`,
      hiddenRoots: [f.root],
    });
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    expect(result.output).toContain('CTFIX 42');
    expect(result.output).toContain('NET-DENIED');
    expect(result.output).toContain('VENV-READONLY');
  },
);

itPython(
  'refuses a wheel whose bytes are not what the store vouched for, installing nothing',
  async () => {
    const f = pythonCheck();
    // The store answers with a path whose file is not the locked one.
    const other = join(f.root, 'other.whl');
    writeFileSync(other, 'not the wheel');
    const result = await f.execute({
      pythonWheels: { wheel: async () => ({ path: other }) },
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain('CTFIX');
    expect(result.diagnostic).toContain(`${f.wheel.filename} changed after the daemon verified it`);
  },
);

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

itPython(
  'digests the wheel set in a fixed order, whatever order the lock lists them in',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-python-order-'));
    roots.push(root);
    const extra = buildWheel(join(root, 'wheels'), 'aaa-first', '1.0', {
      'aaa_first/__init__.py': '',
    });
    const f = pythonCheck();
    // The lock lists ctfix-pkg before aaa-first; the digest sorts by SHA-256.
    writeFileSync(join(f.workspacePath, 'uv.lock'), lockFor('ct-python-fixture', [f.wheel, extra]));
    git(['add', '-A'], f.workspacePath);
    git(
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'two wheels'],
      f.workspacePath,
    );
    const result = await f.execute({ pythonWheels: new FixtureWheels([f.wheel, extra]) });
    // The adopted lock changed, so the check is held to the new one only by its digests; what
    // matters here is the receipt's wheel set.
    const lines = [f.wheel, extra].map((w) => `${w.sha256}  ${w.filename}\n`).sort();
    expect((result.receipt.python as { wheelSetDigest: string }).wheelSetDigest).toBe(
      sha256(lines.join('')),
    );
  },
);

describe("a Python check's helper steps (increment 3 review L1–L4)", () => {
  const confinement = {
    unitName: 'craftingtable-check-x',
    limits: DEFAULT_CHECK_UNIT_LIMITS,
    directory: '/data/private/python',
    tree: '/data/private/clone',
    hiddenRoots: ['/agents/root', '/data/cargo-home', '/repo/.git'],
    inaccessible: ['/work/x', '/run/dir'],
    home: '/home/op',
  };

  it('runs each step in a unit with no network that writes only the Python directory and reads the clone', () => {
    const args = pythonStepUnitArguments(
      confinement,
      'craftingtable-check-x-python-1',
      '/opt/uv',
      ['venv'],
      {
        cwd: '/data/private/python',
        env: { PATH: '/usr/bin:/bin', UV_NO_CONFIG: '1' },
        timeoutMs: 60_000,
      },
    );
    const properties = args.flatMap((arg, index) => (args[index - 1] === '-p' ? [arg] : []));
    expect(args).toContain('--unit=craftingtable-check-x-python-1');
    expect(properties).toEqual(
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
    // Nothing else is writable, and the clone is not bound writable.
    expect(properties.filter((p) => p.startsWith('ReadWritePaths='))).toEqual([
      'ReadWritePaths=-/data/private/python',
    ]);
    expect(properties.filter((p) => p.startsWith('BindPaths='))).toEqual([
      'BindPaths=/data/private/python',
    ]);
    expect(args.slice(args.indexOf('--'))).toEqual(
      expect.arrayContaining(['/opt/uv', 'venv', 'UV_NO_CONFIG=1']),
    );
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
        hiddenRoots: [],
        inaccessible: [],
        home: homedir(),
        confinement: 'systemd',
        signal: controller.signal,
      });
      const started = Date.now();
      setTimeout(() => controller.abort(), 1_000);
      const result = await run('/usr/bin/sleep', ['60'], {
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 60_000,
      });
      expect(result.code).toBeNull();
      expect(Date.now() - started).toBeLessThan(12_000);
      const state = spawnSync('systemctl', ['--user', 'is-active', `${unitName}-python-1`], {
        encoding: 'utf8',
      }).stdout.trim();
      expect(state).not.toBe('active');
    },
  );

  itPython(
    'builds offline with fixed arguments: every hash required, nothing built, no index, no configuration, each step within the time left',
    async () => {
      const f = pythonCheck();
      const directory = join(f.root, 'python');
      const calls: {
        command: string;
        args: readonly string[];
        env: Record<string, string>;
        timeoutMs: number;
      }[] = [];
      const record: PythonStepRunner = async (command, args, options) => {
        calls.push({ command, args, env: { ...options.env }, timeoutMs: options.timeoutMs });
        const result = spawnSync(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          encoding: 'utf8',
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
      };
      await preparePythonEnvironment({
        profile: OPT_PROFILE,
        target: { pythonVersion: '3.12.15', platform: 'linux-x86_64', libc: 'glibc 2.44' },
        tree: f.workspacePath,
        lock: readFileSync(join(f.workspacePath, 'uv.lock')),
        directory,
        wheels: f.store,
        signal: new AbortController().signal,
        remainingMs: () => 4_321,
        run: record,
        onOutput: () => undefined,
      });
      const venv = join(directory, 'venv');
      expect(
        calls.map((call) => [call.command, ...call.args.filter((a) => !a.includes('\n'))]),
      ).toEqual([
        [OPT_PYTHON, '-I', '-S', '-c', join(directory, 'uv.lock')],
        [
          OPT_UV,
          'export',
          '--frozen',
          '--no-emit-project',
          '--format',
          'requirements.txt',
          '--output-file',
          join(directory, 'requirements.txt'),
          '--quiet',
        ],
        [OPT_UV, 'venv', venv, '--python', OPT_PYTHON, '--quiet'],
        [
          OPT_UV,
          'pip',
          'install',
          '--python',
          join(venv, 'bin', 'python'),
          '--offline',
          '--no-index',
          '--find-links',
          join(directory, 'wheels'),
          '--require-hashes',
          '--no-build',
          '--quiet',
          '-r',
          join(directory, 'requirements.txt'),
        ],
      ]);
      for (const call of calls) {
        expect(call.env).toMatchObject({
          PATH: '/usr/bin:/bin',
          UV_OFFLINE: '1',
          UV_NO_CONFIG: '1',
          UV_PYTHON_DOWNLOADS: 'never',
          UV_CACHE_DIR: join(directory, 'uv-cache'),
        });
        expect(call.timeoutMs).toBeLessThanOrEqual(4_321);
      }
    },
  );
});
