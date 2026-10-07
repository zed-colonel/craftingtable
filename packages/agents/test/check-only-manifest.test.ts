import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostGit } from './host-tools-test-support.js';
import {
  type CheckExecution,
  executeCheck,
  prepareCheckManifest,
  resolveGitDirectories,
} from '../src/local-check.js';
import type { CheckOnlyManifest } from '../src/pinned-cargo.js';
import { testTimeScale } from './test-time.js';

/**
 * R-G13 increment 4 (operator decision 2026-10-06): a run with no pinned dependency environment
 * is held to its repository's adopted checks through a check-only manifest. It runs `ct-check`
 * and nothing else, has no supplied sources to verify, and resolves a toolchain only where the
 * host has Cargo.
 */

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

const CHECK_SCRIPT = '#!/bin/sh\necho DECLARED-RAN\n';

function fixture(manifest: Partial<CheckOnlyManifest> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ct-check-only-'));
  roots.push(root);
  const workspacePath = join(root, 'repository');
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, 'check.sh'), CHECK_SCRIPT, { mode: 0o755 });
  git(['init', '-q', '-b', 'main'], workspacePath);
  git(['add', '.'], workspacePath);
  git(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c'],
    workspacePath,
  );
  const head = git(['rev-parse', 'HEAD'], workspacePath);
  const m: CheckOnlyManifest = {
    kind: 'checks',
    runId: 'run',
    gitExecutable: hostGit(),
    ...resolveGitDirectories(hostGit(), workspacePath),
    workspacePath,
    declaredChecks: {
      declarationId: randomUUID(),
      version: 1,
      checks: [
        {
          id: 'c',
          argv: ['./check.sh'],
          definitionPaths: ['check.sh'],
          definitionDigests: { 'check.sh': sha256(CHECK_SCRIPT) },
        },
      ],
    },
    ...manifest,
  };
  const directory = join(root, 'run', 'checks');
  const spool = {
    directory: join(directory, 'requests'),
    replies: join(root, 'daemon', 'replies'),
    limitMs: 60_000,
  };
  const prepared = prepareCheckManifest(directory, m, spool);
  // A PATH with no Cargo on it: the host this manifest is for may have none.
  const bin = join(root, 'no-cargo-bin');
  mkdirSync(bin);
  for (const tool of ['sh', 'env', 'git', 'touch', 'true'])
    for (const directory of ['/usr/bin', '/bin'])
      if (existsSync(join(directory, tool)) && !existsSync(join(bin, tool)))
        symlinkSync(join(directory, tool), join(bin, tool));
  const execute = (
    tool: CheckExecution['tool'],
    args: readonly string[],
    overrides: Partial<CheckExecution> = {},
  ) => {
    let output = '';
    const outcome = executeCheck({
      tool,
      manifestPath: prepared.manifestPath,
      manifestDigest: prepared.manifestDigest,
      manifest: prepared.manifest,
      args,
      logPath: join(root, 'daemon', 'logs', `${randomUUID()}.log`),
      logReference: 'check-logs/run/c.log',
      privateDirectory: join(root, 'daemon', `${randomUUID()}.private`),
      declaredTargetDirectory: join(root, 'daemon', 'declared-target'),
      confinement: 'none',
      unitName: 'unused',
      writablePaths: [workspacePath],
      environment: { PATH: bin },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
      ...overrides,
    }).then((result) => ({ ...result, output }));
    return outcome;
  };
  return { root, workspacePath, head, m, prepared, execute };
}

it('a check-only manifest runs a declared check on a private clone with no Cargo on the host, and its receipt carries no runtime (R-G13 increment 4)', async () => {
  const f = fixture();
  // The run's launchers: ct-check alone, and no Cargo launcher in front of the agent's own.
  expect(readdirSync(f.prepared.binDirectory)).toEqual(['ct-check']);
  const declared = await f.execute('ct-check', ['--declared', 'c']);
  expect(declared.exitCode, declared.output + declared.diagnostic).toBe(0);
  expect(declared.output).toContain('DECLARED-RAN');
  expect(declared.receipt).toMatchObject({
    kind: 'scoped-check',
    recordedBy: 'daemon',
    runId: 'run',
    manifestDigest: f.prepared.manifestDigest,
    headSha: f.head,
    clean: true,
    success: true,
    declaredCheck: {
      id: 'c',
      declarationId: f.m.declaredChecks.declarationId,
      definitionDigests: { 'check.sh': sha256(CHECK_SCRIPT) },
    },
  });
  expect(declared.receipt).not.toHaveProperty('runtimeId');
  expect(declared.receipt.verificationMode).toBeUndefined();
  // A command the agent chooses still runs, and is no run of a declared check.
  const chosen = await f.execute('ct-check', ['--', 'true']);
  expect(chosen.exitCode, chosen.output + chosen.diagnostic).toBe(0);
  expect(chosen.receipt).not.toHaveProperty('declaredCheck');
  expect(chosen.receipt).not.toHaveProperty('runtimeId');
});

it.each([
  ['cargo', ['build']],
  ['ct-act', ['-W', '.github/workflows/ci.yml']],
  ['ct-native', ['--', 'touch', 'NATIVE-RAN']],
] as const)(
  'a check-only manifest refuses %s and runs nothing for it (R-G13 increment 4)',
  async (tool, args) => {
    const f = fixture();
    const refused = await f.execute(tool, args);
    expect(refused.exitCode).toBe(1);
    expect(refused.diagnostic).toContain('runs only ct-check');
    expect(refused.receipt.success).toBe(false);
    expect(existsSync(join(f.workspacePath, 'NATIVE-RAN'))).toBe(false);
  },
);

/** A rustup stand-in whose `which` answers `answer`, or never answers when `hang`. */
function fakeRustup(root: string, answer: string, hang = false) {
  const directory = join(root, 'fake-rustup');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'rustup'),
    `#!/bin/sh\nif [ "$1" = which ]; then ${hang ? 'exec sleep 30' : `echo ${answer}`}; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  symlinkSync(join(directory, 'rustup'), join(directory, 'cargo'));
  const rustupHome = join(root, 'rustup-home');
  mkdirSync(join(rustupHome, 'toolchains'), { recursive: true });
  return { cargo: join(directory, 'cargo'), rustupHome };
}

it("a check-only manifest on a host with Cargo runs the commit's managed toolchain, and refuses another (R-G13 increment 4)", async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-check-only-rustup-'));
  roots.push(root);
  // The commit's toolchain resolves outside rustup's toolchains: a `path` toolchain.
  const outside = join(root, 'tree-toolchain', 'bin', 'cargo');
  mkdirSync(join(root, 'tree-toolchain', 'bin'), { recursive: true });
  writeFileSync(outside, '#!/bin/sh\necho FAKE-CARGO\n', { mode: 0o755 });
  const rustup = fakeRustup(root, outside);
  const f = fixture({ cargoExecutable: rustup.cargo });
  const refused = await f.execute('ct-check', ['--declared', 'c'], {
    environment: { PATH: '/usr/bin:/bin', RUSTUP_HOME: rustup.rustupHome },
  });
  expect(refused.diagnostic).toContain('not a rustup-managed toolchain');
  expect(refused.output).not.toContain('DECLARED-RAN');
});

it.each([
  ['its clone', 'clone'],
  ['its toolchain', 'toolchain'],
] as const)(
  'cancelling a declared check stops %s at once (R-G13 increment 3 disposition, increment 4)',
  async (_label, step) => {
    const root = mkdtempSync(join(tmpdir(), 'ct-check-only-abort-'));
    roots.push(root);
    // A Git whose clone, or a rustup whose toolchain lookup, would take half a minute.
    const slowGit = join(root, 'slow-git');
    writeFileSync(
      slowGit,
      `#!/bin/sh\ncase " $* " in *" clone "*) exec sleep 30;; esac\nexec ${hostGit()} "$@"\n`,
      { mode: 0o755 },
    );
    const rustup = fakeRustup(root, '/nowhere', true);
    const f = fixture(
      step === 'clone' ? { gitExecutable: slowGit } : { cargoExecutable: rustup.cargo },
    );
    const controller = new AbortController();
    const started = Date.now();
    const pending = f.execute('ct-check', ['--declared', 'c'], {
      signal: controller.signal,
      environment: { PATH: '/usr/bin:/bin', RUSTUP_HOME: rustup.rustupHome },
    });
    setTimeout(() => controller.abort(), 500);
    const outcome = await pending;
    expect(Date.now() - started).toBeLessThan(10_000 * testTimeScale());
    expect(outcome.exitCode).toBe(1);
    expect(outcome.diagnostic).toContain('Interrupted');
    expect(outcome.output).not.toContain('DECLARED-RAN');
  },
);
