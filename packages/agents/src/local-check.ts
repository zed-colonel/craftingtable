/** Local verification adapter; commands originate in the supervised agent, never HTTP. */
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  existsSync,
  rmSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { PinnedCargoManifest } from './pinned-cargo.js';

// Generated launchers also run directly from TypeScript in adapter tests.
const { nativeHostDigest, nativeArguments, nativeExecutables, nativeUnit, stopNativeUnit } =
  (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './native-environment.ts' : './native-environment.js',
      import.meta.url,
    ).href
  )) as typeof import('./native-environment.js');

export interface LocalCiConfig {
  readonly actExecutable: string;
  readonly dockerExecutable: string;
  readonly dockerHost: string;
  readonly image: string;
  readonly cacheRoot: string;
}
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export function loadLocalCiConfig(path: string | undefined): LocalCiConfig | undefined {
  if (!path) return;
  const c = JSON.parse(readFileSync(path, 'utf8')) as LocalCiConfig;
  if (
    !c ||
    ![c.actExecutable, c.dockerExecutable, c.cacheRoot].every(
      (p) => typeof p === 'string' && isAbsolute(p) && !/[\s,:]/.test(p) && !p.includes('\0'),
    ) ||
    !/^unix:\/\/\/[A-Za-z0-9/_.-]+$/.test(c.dockerHost) ||
    !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(c.image)
  )
    throw new Error(
      'Local CI requires absolute executable/cache paths, a local Unix Docker socket and an image pinned by digest.',
    );
  return c;
}
export function prepareLocalCheckLaunchers(bin: string, manifest: string, digest: string) {
  for (const name of ['ct-check', 'ct-act', 'ct-native']) {
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!${process.execPath}\nimport(${JSON.stringify(import.meta.url)}).then(m=>m.runLocalCheck(${JSON.stringify(manifest)},${JSON.stringify(digest)},${JSON.stringify(name)},process.argv.slice(2))).catch(e=>{console.error(e.message);process.exitCode=1;});\n`,
      { mode: 0o500 },
    );
    chmodSync(path, 0o500);
  }
}
function gitState(m: PinnedCargoManifest) {
  const head = spawnSync(m.gitExecutable, ['rev-parse', 'HEAD'], {
    cwd: m.workspacePath,
    encoding: 'utf8',
    timeout: 10000,
  });
  const dirty = spawnSync(m.gitExecutable, ['status', '--porcelain'], {
    cwd: m.workspacePath,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    headSha: head.status === 0 ? head.stdout.trim() : '',
    clean: dirty.status === 0 && !dirty.stdout.trim(),
  };
}
function verifySources(m: PinnedCargoManifest) {
  for (const f of [...m.files, { path: m.configPath, digest: m.configDigest }])
    if (
      !lstatSync(f.path).isFile() ||
      realpathSync(f.path) !== resolve(f.path) ||
      hash(readFileSync(f.path)) !== f.digest
    )
      throw new Error(`Supplied dependency source changed: ${f.path}`);
}
export function localActArguments(
  m: PinnedCargoManifest,
  manifestPath: string,
  args: string[],
  evidenceDirectory: string,
): string[] {
  const ci = m.localCi;
  if (!ci) throw new Error('Local act is not configured by the operator.');
  let workflow = '',
    job = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-W' && !workflow) workflow = args[++i] ?? '';
    else if (args[i] === '-j' && !job) job = args[++i] ?? '';
    else throw new Error('Usage: ct-act -W .github/workflows/<file>.yml [-j <job>]');
  }
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow) ||
    (job && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(job))
  )
    throw new Error('Select one repository workflow and optionally one job ID.');
  const file = join(m.workspacePath, workflow);
  if (!lstatSync(file).isFile() || realpathSync(file) !== resolve(file))
    throw new Error('Workflow must be an ordinary repository file.');
  const runDirectory = dirname(dirname(manifestPath));
  if ([runDirectory, m.workspacePath].some((p) => /[\s,:]/.test(p) || p.includes('\0')))
    throw new Error('Local CI mount paths cannot contain whitespace, colons or commas.');
  const mount = (path: string) => `--mount type=bind,source=${path},target=${path}`;
  // Managed worktrees have a .git file pointing outside the checkout. Supply only
  // their Git metadata read-only so ordinary git/version checks work inside CI.
  const metadata = spawnSync(
    m.gitExecutable,
    ['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir'],
    { cwd: m.workspacePath, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
  );
  if (metadata.status !== 0) throw new Error('Could not locate managed worktree Git metadata.');
  const gitPaths = [...new Set(metadata.stdout.trim().split('\n'))].filter((path) => {
    const rel = relative(m.workspacePath, path);
    return rel.startsWith('..') || isAbsolute(rel);
  });
  if (
    gitPaths.some(
      (p) =>
        !isAbsolute(p) || /[\s,:]/.test(p) || p.includes('\0') || realpathSync(p) !== resolve(p),
    )
  )
    throw new Error('Unsupported Git metadata path for local CI.');
  const gitMounts = gitPaths
    .filter((path, i) => !gitPaths.some((parent, j) => i !== j && path.startsWith(parent + '/')))
    .map((path) => `${mount(path)},readonly`)
    .join(' ');
  return [
    'push',
    '-C',
    m.workspacePath,
    '-W',
    file,
    ...(job ? ['-j', job] : []),
    '--bind',
    '--pull=false',
    '--rm',
    '--concurrent-jobs=1',
    '--container-daemon-socket=-',
    '--container-options',
    `${mount(runDirectory)} ${gitMounts} --mount type=bind,source=${join(ci.cacheRoot, 'cargo-registry')},target=/opt/craftingtable/cargo/registry --mount type=bind,source=${join(ci.cacheRoot, 'cargo-git')},target=/opt/craftingtable/cargo/git --label craftingtable.run=${m.runId} --cpus=4 --memory=8g`,
    ...['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04'].flatMap((label) => [
      '-P',
      `${label}=${ci.image}`,
    ]),
    '--action-cache-path',
    join(ci.cacheRoot, 'actions'),
    '--no-cache-server',
    '--env-file',
    '/dev/null',
    '--secret-file',
    '/dev/null',
    '--var-file',
    '/dev/null',
    '--input-file',
    '/dev/null',
    '--env',
    `CRAFTINGTABLE_DEPENDENCY_MANIFEST=${manifestPath}`,
    '--env',
    `CRAFTINGTABLE_CARGO_CONFIG=${m.configPath}`,
    '--env',
    `CRAFTINGTABLE_VERIFICATION_MODE=${m.verification?.mode ?? 'current-upstream-build'}`,
    '--env',
    `CARGO_TARGET_DIR=${m.targetDirectory}`,
    '--env',
    `CRAFTINGTABLE_CI_ARTIFACTS_DIR=${join(evidenceDirectory, 'artifacts')}`,
  ];
}
/** Only this run's labelled containers; never global Docker prune. */
export function cleanupLocalCi(ci: LocalCiConfig, runId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid CI run identity.');
  const env = { ...process.env, DOCKER_HOST: ci.dockerHost };
  const listed = spawnSync(
    ci.dockerExecutable,
    ['ps', '-aq', '--filter', `label=craftingtable.run=${runId}`],
    { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
  );
  if (listed.status !== 0) throw new Error('Could not inspect local CI containers.');
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
    throw new Error('Invalid Docker container identity.');
  if (ids.length) {
    const removed = spawnSync(ci.dockerExecutable, ['rm', '-f', '-v', ...ids], {
      env,
      timeout: 10000,
      stdio: 'pipe',
    });
    if (removed.status !== 0) throw new Error('Could not remove this run’s CI containers.');
  }
}
export async function runLocalCheck(
  path: string,
  digest: string,
  kind: string,
  args: string[],
): Promise<void> {
  const raw = readFileSync(path, 'utf8');
  if (hash(raw) !== digest) throw new Error('Verification manifest changed.');
  const m = JSON.parse(raw) as PinnedCargoManifest;
  const directory = join(dirname(path), 'checks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${process.pid}`;
  const logPath = join(directory, `${id}.log`);
  const before = gitState(m);
  let success = false,
    diagnostic = '',
    code: number | null = null,
    log = '',
    command = '',
    actual: string[] = [];
  const isCi = kind === 'ct-act';
  const isNative = kind === 'ct-native';
  const lease = join(directory, isNative ? 'native-active' : 'act-active');
  let ownsLease = false;
  try {
    verifySources(m);
    if (isCi) {
      actual = localActArguments(m, path, args, directory);
      command = m.localCi!.actExecutable;
      mkdirSync(lease); // One act invocation at a time per supervised run.
      ownsLease = true;
      for (const part of ['cargo-registry', 'cargo-git'])
        mkdirSync(join(m.localCi!.cacheRoot, part), { recursive: true, mode: 0o700 });
      mkdirSync(join(directory, 'artifacts'), { recursive: true, mode: 0o700 });
    } else {
      if (args[0] === '--') args = args.slice(1);
      command = args[0] ?? '';
      actual = args.slice(1);
      if (!command || command.startsWith('-') || command.includes('\0'))
        throw new Error('Usage: ct-check -- <executable> <arguments>');
    }
    if (isNative) {
      if (!m.nativeVerification || m.nativeVerification.hostDigest !== nativeHostDigest())
        throw new Error('A current approved native environment is required.');
      mkdirSync(lease);
      ownsLease = true;
      const home = join(directory, 'native-home'),
        tmp = join(directory, 'native-tmp');
      for (const p of [home, tmp]) mkdirSync(p, { recursive: true, mode: 0o700 });
      actual = nativeArguments(
        nativeUnit(m.runId),
        m.workspacePath,
        (m.checkTimeoutMs ?? 1800000) / 1000,
        [
          '/usr/bin/env',
          '-i',
          `PATH=${dirname(path)}/bin:${join(homedir(), '.cargo/bin')}:/usr/local/bin:/usr/bin`,
          `HOME=${home}`,
          `TMPDIR=${tmp}`,
          `CARGO_HOME=${join(homedir(), '.cargo')}`,
          `RUSTUP_HOME=${join(homedir(), '.rustup')}`,
          'RUSTUP_AUTO_INSTALL=0',
          `CARGO_TARGET_DIR=${m.targetDirectory}`,
          `CRAFTINGTABLE_CARGO_CONFIG=${m.configPath}`,
          `CRAFTINGTABLE_DEPENDENCY_MANIFEST=${path}`,
          command,
          ...actual,
        ],
      );
      command = nativeExecutables.systemdRun;
    }
    const env = isCi
      ? {
          PATH: process.env.PATH,
          HOME: join(directory, 'home'),
          DOCKER_HOST: m.localCi!.dockerHost,
          XDG_CACHE_HOME: m.localCi!.cacheRoot,
        }
      : { ...process.env, CARGO_TARGET_DIR: m.targetDirectory };
    if (isCi) mkdirSync(env.HOME!, { recursive: true, mode: 0o700 });
    // act reads .actrc from its process cwd. Keep that cwd controller-owned;
    // -C names the worktree separately. No host .env/.secrets are loaded.
    code = await new Promise<number | null>((resolveResult, reject) => {
      const child = spawn(command, actual, {
        cwd: isCi ? directory : m.workspacePath,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let expired = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
        expired = true;
        child.kill('SIGTERM');
        if (isNative) void stopNativeUnit(m.runId).catch(() => {});
        if (isCi) {
          try {
            cleanupLocalCi(m.localCi!, m.runId);
          } catch {
            /* final cleanup reports failures */
          }
        }
      };
      const timer = setTimeout(stop, m.checkTimeoutMs ?? 30 * 60000);
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      const collect = (data: Buffer) => {
        const text = data.toString();
        if (Buffer.byteLength(log) < 2 * 1024 * 1024) log += text;
        process.stdout.write(text);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
      };
      child.once('error', (error) => {
        finish();
        reject(error);
      });
      child.once('close', (value) => {
        finish();
        resolveResult(expired ? null : value);
      });
    });
    if (hash(readFileSync(path)) !== digest)
      throw new Error('Verification manifest changed during the check.');
    verifySources(m);
    success = code === 0;
    if (!success)
      diagnostic = code === null ? 'Check interrupted or timed out.' : `Check exited ${code}.`;
  } catch (e) {
    diagnostic = e instanceof Error ? e.message : 'Check failed.';
  } finally {
    if (isNative && ownsLease) {
      try {
        await stopNativeUnit(m.runId);
        rmSync(lease, { recursive: true });
      } catch (e) {
        success = false;
        diagnostic += ` ${e instanceof Error ? e.message : 'Native cleanup failed.'}`;
      }
    }
    if (ownsLease && !isNative && m.localCi) {
      try {
        cleanupLocalCi(m.localCi, m.runId);
        rmSync(lease, { recursive: true });
      } catch (e) {
        success = false;
        diagnostic += ` ${e instanceof Error ? e.message : 'CI cleanup failed.'}`;
      }
    }
    const after = gitState(m);
    writeFileSync(logPath, `${log}\n${diagnostic}\n`, { mode: 0o600 });
    appendFileSync(
      m.receiptPath,
      JSON.stringify({
        kind: isNative ? 'native-check' : isCi ? 'local-ci' : 'scoped-check',
        ...(isNative ? { nativeVerification: m.nativeVerification } : {}),
        runtimeId: m.runtimeId,
        runId: m.runId,
        manifestDigest: digest,
        verificationMode: m.verification?.mode,
        policyDigest: m.verification && hash(JSON.stringify(m.verification)),
        headSha: after.headSha,
        clean: before.clean && after.clean && before.headSha === after.headSha,
        command,
        args,
        success,
        exitCode: code,
        diagnostic,
        logPath: relative(dirname(path), logPath),
        logDigest: hash(readFileSync(logPath)),
        ...(isCi ? { image: m.localCi?.image } : {}),
        at: new Date().toISOString(),
      }) + '\n',
      { mode: 0o600 },
    );
    if (diagnostic) console.error(diagnostic);
    process.exitCode = success ? 0 : 1;
  }
}

/** Terminal/restart fallback after the agent process has stopped; never inside a DB transaction. */
export async function cleanupLocalCiManifest(path: string, digest: string): Promise<void> {
  const nativeLease = join(dirname(path), 'checks', 'native-active');
  if (existsSync(nativeLease)) {
    const raw = readFileSync(path, 'utf8');
    if (hash(raw) !== digest) throw new Error('Native cleanup manifest changed.');
    const m = JSON.parse(raw) as PinnedCargoManifest;
    await stopNativeUnit(m.runId);
    rmSync(nativeLease, { recursive: true });
  }
  const lease = join(dirname(path), 'checks', 'act-active');
  if (!existsSync(lease)) return;
  const raw = readFileSync(path, 'utf8');
  if (hash(raw) !== digest) throw new Error('CI cleanup manifest changed.');
  const m = JSON.parse(raw) as PinnedCargoManifest;
  if (!m.localCi) return;
  // A separate helper keeps slow Docker requests off the daemon event loop.
  const moduleUrl = import.meta.url.endsWith('.ts')
    ? new URL('../dist/local-check.js', import.meta.url).href
    : import.meta.url;
  await new Promise<void>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { cleanupLocalCi } from ${JSON.stringify(moduleUrl)}; cleanupLocalCi(${JSON.stringify(m.localCi)}, ${JSON.stringify(m.runId)});`,
      ],
      { shell: false, stdio: 'ignore' },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolveResult()
        : reject(new Error('Run-owned CI cleanup failed; inspect the rootless engine.'));
    });
  });
  rmSync(lease, { recursive: true });
}
