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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { asDeclaredCheckId, asRepositoryCheckDeclarationId } from '@craftingtable/domain';
import { hostGit } from './host-tools-test-support.js';
import {
  type CheckExecution,
  executeCheck,
  prepareCheckManifest,
  resolveGitDirectories,
} from '../src/local-check.js';
import type { CheckOnlyManifest } from '../src/pinned-cargo.js';
import { type PythonToolchain, toolchainProfileDigest } from '../src/toolchains.js';

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
          definitionPaths: ['check.sh'],
          definitionDigests: { 'check.sh': sha256(script) },
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

it.skipIf(!optToolchain)(
  "records the interpreter's and uv's identities and the profile's digest in a Python check's receipt",
  async () => {
    const python: PythonToolchain = {
      interpreter: OPT_PYTHON,
      version: '3.12',
      uv: { path: OPT_UV, version: '0.12' },
    };
    const f = fixture({ python, files: ROOT_LOCK });
    const result = await f.execute();
    expect(result.exitCode, result.output + result.diagnostic).toBe(0);
    expect(result.output).toContain('CHECK-RAN');
    const recorded = result.receipt.python as {
      profileDigest: string;
      tools: { tool: string; path: string; sha256: string; version: string; uid: number }[];
    };
    expect(recorded.profileDigest).toBe(toolchainProfileDigest(python));
    expect(recorded.tools.map((t) => [t.tool, t.path, t.uid])).toEqual([
      ['python', OPT_PYTHON, 0],
      ['uv', OPT_UV, 0],
    ]);
    expect(recorded.tools[0]?.sha256).toBe(sha256(readFileSync(OPT_PYTHON)));
    expect(recorded.tools[0]?.version).toMatch(/^3\.12\.\d+$/);
    expect(recorded.tools[1]?.version).toMatch(/^0\.12\.\d+$/);
    // The daemon is told what it found, for Tools.
    expect(result.toolchain?.map((o) => o.tool)).toEqual(['python', 'uv']);
  },
);

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
