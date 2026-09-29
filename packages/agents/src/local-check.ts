/** Local verification adapter; commands originate in the supervised agent, never HTTP. */
import { execFile, spawn, spawnSync } from 'node:child_process';
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
  statSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PinnedCargoManifest } from './pinned-cargo.js';

// Generated launchers also run directly from TypeScript in adapter tests.
const { nativeHostDigest, nativeArguments, nativeExecutables, nativeUnit, stopNativeUnit } =
  (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './native-environment.ts' : './native-environment.js',
      import.meta.url,
    ).href
  )) as typeof import('./native-environment.js');
const {
  assertPinnedCargoArguments,
  cargoManifestDigest,
  PINNED_BUILD_COMMANDS,
  pinnedCargoArguments,
  pinnedMetadataArguments,
  pinnedReceiptKind,
  pinnedResolvedPackages,
} = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? './pinned-cargo.ts' : './pinned-cargo.js',
    import.meta.url,
  ).href
)) as typeof import('./pinned-cargo.js');

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
/**
 * Writes the run's check launchers. With a spool, each only asks the daemon to run the check
 * (R-G4); `limitMs` bounds its wait for the daemon's answer.
 */
export function prepareLocalCheckLaunchers(
  bin: string,
  manifest: string,
  digest: string,
  spool?: { readonly directory: string; readonly replies: string; readonly limitMs: number },
) {
  const spoolModule = new URL(
    import.meta.url.endsWith('.ts') ? './check-spool.ts' : './check-spool.js',
    import.meta.url,
  ).href;
  if (spool) mkdirSync(spool.directory, { recursive: true, mode: 0o700 });
  for (const name of ['ct-check', 'ct-act', 'ct-native']) {
    const path = join(bin, name);
    const call = spool
      ? `import(${JSON.stringify(spoolModule)}).then(m=>m.submitCheck(${JSON.stringify(spool.directory)},${JSON.stringify(spool.replies)},${JSON.stringify(name)},process.argv.slice(2),${spool.limitMs}))`
      : `import(${JSON.stringify(import.meta.url)}).then(m=>m.runLocalCheck(${JSON.stringify(manifest)},${JSON.stringify(digest)},${JSON.stringify(name)},process.argv.slice(2)))`;
    writeFileSync(
      path,
      `#!${process.execPath}\n${call}.catch(e=>{console.error(e.message);process.exitCode=1;});\n`,
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
/**
 * How the daemon runs Git on an agent's worktree (R-G4 review): against the git directory it
 * resolved before the agent started, never the worktree's `.git` pointer; with no system or
 * global configuration, no fsmonitor and no hooks; and with named variables only.
 */
function daemonGitEnvironment(gitDirectory?: string, workTree?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    ...(gitDirectory ? { GIT_DIR: gitDirectory } : {}),
    ...(workTree ? { GIT_WORK_TREE: workTree } : {}),
  };
}
const DAEMON_GIT_OPTIONS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

/**
 * The worktree's git directory and common directory, resolved by the daemon before the agent
 * starts, while the `.git` pointer is still the one the daemon created.
 */
export function resolveGitDirectories(
  gitExecutable: string,
  workspacePath: string,
): { gitDirectory: string; gitCommonDirectory: string } {
  const resolved = spawnSync(
    gitExecutable,
    [
      ...DAEMON_GIT_OPTIONS,
      'rev-parse',
      '--path-format=absolute',
      '--absolute-git-dir',
      '--git-common-dir',
    ],
    {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      env: daemonGitEnvironment(),
    },
  );
  const [gitDirectory, gitCommonDirectory] = (resolved.stdout ?? '').trim().split('\n');
  if (resolved.status !== 0 || !gitDirectory || !gitCommonDirectory)
    throw new Error('Could not resolve the worktree git directory.');
  return { gitDirectory, gitCommonDirectory };
}

/** The same observation without blocking the daemon's event loop, on the pinned git directory. */
async function observeGitState(m: PinnedCargoManifest) {
  if (!m.gitDirectory) throw new Error('The run has no daemon-resolved git directory.');
  const git = (args: string[]) =>
    new Promise<{ ok: boolean; stdout: string }>((resolveResult) =>
      execFile(
        m.gitExecutable,
        [...DAEMON_GIT_OPTIONS, ...args],
        {
          cwd: m.workspacePath,
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 1024 * 1024,
          env: daemonGitEnvironment(m.gitDirectory, m.workspacePath),
        },
        (error, stdout) => resolveResult({ ok: !error, stdout: String(stdout) }),
      ),
    );
  const [head, dirty] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain']),
  ]);
  return { headSha: head.ok ? head.stdout.trim() : '', clean: dirty.ok && !dirty.stdout.trim() };
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
/**
 * Refuses a workflow whose jobs could reach the host through Docker (R-G4 review, operator
 * decision 2026-09-28): a job `container` or `services` can bind host paths into a job, a
 * reusable workflow (`uses` on a job) brings jobs this check cannot see, and a `docker://` step
 * runs an arbitrary image. The daemon runs act without the escalation a sandboxed agent needed.
 */
function refuseHostReachingJobs(text: string): void {
  let workflow: unknown;
  try {
    workflow = parseYaml(text, { maxAliasCount: 100 });
  } catch {
    throw new Error('The workflow could not be read as YAML.');
  }
  // A workflow without a jobs mapping runs nothing; act reports it.
  const jobs = (workflow as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return;
  for (const [name, job] of Object.entries(jobs as Record<string, unknown>)) {
    const j = (job ?? {}) as Record<string, unknown>;
    for (const key of ['container', 'services', 'uses'])
      if (key in j)
        throw new Error(
          `Job ${name} declares \`${key}\`; local CI does not run jobs that reach the host through Docker.`,
        );
    const steps = Array.isArray(j.steps) ? (j.steps as Record<string, unknown>[]) : [];
    if (steps.some((step) => String(step?.uses ?? '').startsWith('docker://')))
      throw new Error(
        `Job ${name} uses a docker:// step; local CI does not run jobs that reach the host through Docker.`,
      );
  }
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
  refuseHostReachingJobs(readFileSync(file, 'utf8'));
  const runDirectory = dirname(dirname(manifestPath));
  if ([runDirectory, m.workspacePath].some((p) => /[\s,:]/.test(p) || p.includes('\0')))
    throw new Error('Local CI mount paths cannot contain whitespace, colons or commas.');
  const mount = (path: string) => `--mount type=bind,source=${path},target=${path}`;
  // Managed worktrees have a .git file pointing outside the checkout. Supply only
  // their Git metadata read-only so ordinary git/version checks work inside CI.
  // A daemon-run check mounts the git directories the daemon resolved before the agent started;
  // the worktree's `.git` pointer may since have been rewritten (R-G4 review).
  const metadata =
    m.gitDirectory && m.gitCommonDirectory
      ? { status: 0, stdout: `${m.gitCommonDirectory}\n${m.gitDirectory}\n` }
      : spawnSync(
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
    .filter((path, i) => !gitPaths.some((parent, j) => i !== j && path.startsWith(`${parent}/`)))
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
/**
 * act names its job containers and volumes after the workflow's `name` and the job, with no
 * per-invocation part, so two runs of one workflow on the same Docker host remove each other's
 * containers (exit 137, "volume is in use"). One ct-act per workflow name runs at a time on a
 * host; the lock lives beside the shared CI cache and survives only as long as its owner.
 */
export function localCiLockPath(ci: LocalCiConfig, workspacePath: string, args: readonly string[]) {
  const workflow = args[args.indexOf('-W') + 1] ?? '';
  const text = readFileSync(join(workspacePath, workflow), 'utf8');
  const named = /^name:[ \t]*(['"]?)(.*?)\1[ \t]*(?:#.*)?$/m.exec(text)?.[2]?.trim();
  return join(ci.cacheRoot, 'locks', `act-${hash(named || basename(workflow))}`);
}
/** A process identity that a reused PID cannot fake: its start time where /proc has one. */
function processIdentity(pid: number): string | undefined {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return `${pid}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch {
    return `${pid}`;
  }
}
/** The lock's recorded owner, or nothing while its owner is between creating and naming it. */
function lockOwner(path: string): { identity?: string; runId?: string } {
  try {
    return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
  } catch {
    return {};
  }
}
/** A lock whose owner is gone, or that no owner named within ten seconds. */
function staleLock(path: string): boolean {
  const owner = lockOwner(path);
  if (owner.identity) {
    const pid = Number(owner.identity.split(':')[0]);
    return !pid || processIdentity(pid) !== owner.identity;
  }
  try {
    return Date.now() - statSync(path).mtimeMs > 10_000;
  } catch {
    return false; // Released meanwhile.
  }
}
/**
 * Removes a stale lock. Contenders that each saw it stale must not each remove it, or a later
 * one deletes the lock an earlier one has just taken (LIVE-03). Removal is serialized by a
 * guard directory and decided again under it. The guard's holder only does a few synchronous
 * file operations, so a guard older than ten seconds belonged to a process that died.
 */
function reclaimStaleLock(path: string): void {
  const guard = `${path}.reclaim`;
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      if (Date.now() - statSync(guard).mtimeMs > 10_000)
        rmSync(guard, { recursive: true, force: true });
    } catch {
      // Released meanwhile.
    }
    return;
  }
  try {
    if (staleLock(path)) rmSync(path, { recursive: true, force: true });
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}
export async function acquireLocalCiLock(
  path: string,
  runId: string,
  timeoutMs: number,
  pollMs = 2000,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const identity = processIdentity(process.pid)!;
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    if (signal?.aborted) throw new Error("Interrupted while waiting for this workflow's local CI.");
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, 'owner.json'), JSON.stringify({ identity, runId }), { mode: 0o600 });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (staleLock(path)) {
      reclaimStaleLock(path);
      continue;
    }
    const owner = lockOwner(path);
    if (Date.now() >= deadline)
      throw new Error(
        `Another run (${owner.runId ?? 'unknown'}) held this workflow's local CI past the check time limit.`,
      );
    if (!announced) {
      announced = true;
      console.error(
        `Waiting for run ${owner.runId ?? 'unknown'} to finish this workflow's local CI; act cannot run it twice at once on one Docker host.`,
      );
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
function releaseLocalCiLock(path: string): void {
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    if (owner.identity === processIdentity(process.pid)) rmSync(path, { recursive: true });
  } catch {
    // Not ours, or already gone.
  }
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

interface SupervisedCheck {
  readonly code: number | null;
  readonly log: string;
}
/**
 * Runs one check in its own process group, so a timeout or cancellation reaches everything it
 * started (build scripts, test binaries), not only the direct child (AGT-09). Output is kept up
 * to 2 MiB for the log and relayed as it arrives. `code` is null when the check was stopped.
 */
function superviseCheck(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly onOutput: (text: string) => void;
    /** Extra work when the check is stopped, such as stopping its unit or its containers. */
    readonly onStop?: () => void;
    /** A launcher in the agent's tree stops the check when it is itself interrupted. */
    readonly forwardSignals?: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<SupervisedCheck> {
  return new Promise<SupervisedCheck>((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    let expired = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (graceMs = 5000) => {
      killTimer ??= setTimeout(() => signalGroup('SIGKILL'), graceMs);
      expired = true;
      signalGroup('SIGTERM');
      options.onStop?.();
    };
    const timer = setTimeout(() => stop(), options.timeoutMs);
    // The agent supervisor escalates to SIGKILL after its own grace period;
    // escalate sooner so the detached group never outlives this launcher.
    const interrupted = () => stop(1000);
    // Last resort if this launcher exits while the check is still running.
    const exiting = () => signalGroup('SIGKILL');
    if (options.forwardSignals) {
      process.once('SIGTERM', interrupted);
      process.once('SIGINT', interrupted);
      process.once('exit', exiting);
    }
    if (options.signal?.aborted) interrupted();
    else options.signal?.addEventListener('abort', interrupted, { once: true });
    const collect = (data: Buffer) => {
      const text = data.toString();
      if (Buffer.byteLength(log) < 2 * 1024 * 1024) log += text;
      options.onOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', interrupted);
      if (options.forwardSignals) {
        process.removeListener('SIGTERM', interrupted);
        process.removeListener('SIGINT', interrupted);
        process.removeListener('exit', exiting);
      }
      // Nothing a check started may keep running once its result is recorded.
      signalGroup('SIGKILL');
    };
    child.once('error', (error) => {
      finish();
      reject(error);
    });
    child.once('close', (value) => {
      finish();
      resolveResult({ code: expired ? null : value, log });
    });
  });
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
  let workflowLock: string | undefined;
  try {
    verifySources(m);
    if (isCi) {
      actual = localActArguments(m, path, args, directory);
      command = m.localCi!.actExecutable;
      mkdirSync(lease); // One act invocation at a time per supervised run.
      ownsLease = true;
      const lock = localCiLockPath(m.localCi!, m.workspacePath, args);
      // The wait can be long, so an interruption ends it through this function's cleanup
      // rather than the default exit, which would leave the run's lease behind.
      const waiting = new AbortController();
      const abandon = () => waiting.abort();
      process.once('SIGTERM', abandon);
      process.once('SIGINT', abandon);
      try {
        await acquireLocalCiLock(
          lock,
          m.runId,
          m.checkTimeoutMs ?? 30 * 60000,
          2000,
          waiting.signal,
        );
      } finally {
        process.off('SIGTERM', abandon);
        process.off('SIGINT', abandon);
      }
      workflowLock = lock;
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
    const supervised = await superviseCheck(command, actual, {
      cwd: isCi ? directory : m.workspacePath,
      env,
      timeoutMs: m.checkTimeoutMs ?? 30 * 60000,
      onOutput: (text) => process.stdout.write(text),
      onStop: () => {
        if (isNative) void stopNativeUnit(m.runId).catch(() => {});
        if (isCi) {
          try {
            cleanupLocalCi(m.localCi!, m.runId);
          } catch {
            /* final cleanup reports failures */
          }
        }
      },
      forwardSignals: true,
    });
    code = supervised.code;
    log = supervised.log;
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
    // Released after this run's containers are gone, so the next run starts clean.
    if (workflowLock) releaseLocalCiLock(workflowLock);
    const after = gitState(m);
    writeFileSync(logPath, `${log}\n${diagnostic}\n`, { mode: 0o600 });
    appendFileSync(
      m.receiptPath,
      `${JSON.stringify({
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
      })}\n`,
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

/** How the daemon isolates a check it runs for an agent (R-G4). */
export type CheckConfinement = 'systemd' | 'none';
/**
 * Holds the host's one act run of a workflow (LIVE-03) for this check until `deadline` and
 * returns its release. It rejects when the deadline passes or the check is cancelled.
 */
export type WorkflowHold = (
  key: string,
  deadline: number,
  signal: AbortSignal,
  onWait: (holder: string) => void,
) => Promise<() => void>;
export interface CheckExecution {
  readonly tool: 'ct-check' | 'ct-act' | 'ct-native' | 'cargo';
  /** Where the run's manifest was published; its directory locates the run's launchers. */
  readonly manifestPath: string;
  /** The digest the daemon recorded for this run's manifest. */
  readonly manifestDigest: string;
  /**
   * The manifest as the daemon verified it at launch. The published file is the agent's to
   * read (and, being in its writable roots, to rewrite); the daemon never reads it back.
   */
  readonly manifest: string;
  readonly args: readonly string[];
  /** A daemon-owned file outside every writable root of the run. */
  readonly logPath: string;
  /** How the receipt names the log. */
  readonly logReference: string;
  /**
   * A daemon-owned directory outside every writable root of the run. act reads `.actrc` from
   * its working directory and HOME, so both live here rather than where the agent can write.
   */
  readonly privateDirectory: string;
  readonly confinement: CheckConfinement;
  /** The transient unit's name under systemd confinement. */
  readonly unitName: string;
  /** Paths the check may write under systemd confinement; missing ones are ignored. */
  readonly writablePaths: readonly string[];
  /** The check's entire environment (ct-check; act gets its own minimal one). */
  readonly environment: Readonly<Record<string, string>>;
  readonly holdWorkflow?: WorkflowHold;
  readonly onOutput: (text: string) => void;
  readonly signal: AbortSignal;
  /** The most of the check's output the daemon keeps (R-G4 review); 2 MiB by default. */
  readonly logLimitBytes?: number;
}
export interface CheckOutcome {
  /** One receipt line, in the format frozen into the run's build record. */
  readonly receipt: Record<string, unknown>;
  readonly exitCode: number;
  readonly diagnostic: string;
  /** Bytes of log the daemon kept for this check. */
  readonly logBytes: number;
}

/**
 * The systemd-run arguments that run a command in a transient user unit: the file system is
 * read-only except `writable`, with a private /tmp and no new privileges, no network unless
 * `network`, and the whole cgroup stops at the time limit. `env -i` gives the command exactly
 * `environment`, rather than the user manager's.
 */
export function confinedCheckArguments(
  unitName: string,
  cwd: string,
  timeoutSeconds: number,
  writable: readonly string[],
  environment: Readonly<Record<string, string>>,
  command: readonly string[],
  network = false,
  /** Paths inside `writable` that stay read-only, such as a worktree's `.git` pointer. */
  readOnly: readonly string[] = [],
): string[] {
  if (!/^[A-Za-z0-9_.-]+$/.test(unitName)) throw new Error('Invalid check unit name.');
  return [
    '--user',
    '--wait',
    '--collect',
    '--quiet',
    '--pipe',
    `--unit=${unitName}`,
    `--working-directory=${cwd}`,
    '-p',
    'ProtectSystem=strict',
    '-p',
    'ProtectHome=read-only',
    '-p',
    'PrivateTmp=yes',
    '-p',
    `PrivateNetwork=${network ? 'no' : 'yes'}`,
    '-p',
    'NoNewPrivileges=yes',
    '-p',
    'KillMode=control-group',
    '-p',
    `RuntimeMaxSec=${Math.max(1, Math.ceil(timeoutSeconds))}`,
    ...writable.flatMap((p) => ['-p', `ReadWritePaths=-${p}`]),
    ...readOnly.flatMap((p) => ['-p', `ReadOnlyPaths=-${p}`]),
    '--',
    '/usr/bin/env',
    '-i',
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    ...command,
  ];
}

function stopCheckUnit(unitName: string): void {
  spawnSync('systemctl', ['--user', 'stop', unitName], { timeout: 10000, stdio: 'ignore' });
}

/** Stops every check unit whose name starts with `prefix`, such as a previous daemon's. */
export function stopCheckUnits(prefix: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(prefix)) throw new Error('Invalid check unit prefix.');
  const listed = spawnSync(
    'systemctl',
    ['--user', 'list-units', '--plain', '--no-legend', '--all', `${prefix}*`],
    { encoding: 'utf8', timeout: 10000 },
  );
  for (const line of (listed.stdout ?? '').split('\n')) {
    const unit = line.trim().split(/\s+/)[0];
    if (unit?.startsWith(prefix)) stopCheckUnit(unit);
  }
}

/** The daemon's user bus, for systemd-run; a check itself gets only its own environment. */
function userBusEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

/** Runs a short helper command in its own process group and keeps its output apart. */
function captureCheck(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(kill, options.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 32 * 1024 * 1024) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveResult({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      kill();
      resolveResult({ code, stdout, stderr });
    });
  });
}

/** Removes this run's labelled CI containers without blocking the daemon's event loop. */
async function removeRunContainers(ci: LocalCiConfig, runId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid CI run identity.');
  const docker = (args: string[]) =>
    new Promise<string>((resolveResult, reject) =>
      execFile(
        ci.dockerExecutable,
        args,
        {
          env: { PATH: process.env.PATH, DOCKER_HOST: ci.dockerHost },
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 65536,
        },
        (error, stdout) => (error ? reject(error) : resolveResult(String(stdout))),
      ),
    );
  const ids = (await docker(['ps', '-aq', '--filter', `label=craftingtable.run=${runId}`]))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
    throw new Error('Invalid Docker container identity.');
  if (ids.length) await docker(['rm', '-f', '-v', ...ids]);
}

/**
 * Stops what a daemon-run check of `runId` may have left (R-G4 review): its native unit, and
 * its labelled CI containers, which belong to the Docker engine rather than any unit. The
 * daemon calls it when the run ends, including when a restart ends it. `localCi` is the
 * daemon's own configuration, never the run's published manifest.
 */
export async function cleanupDaemonRunChecks(
  runId: string,
  localCi: LocalCiConfig | undefined,
): Promise<void> {
  const failures: string[] = [];
  try {
    await stopNativeUnit(runId);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'Native cleanup failed.');
  }
  if (localCi)
    try {
      await removeRunContainers(localCi, runId);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'CI cleanup failed.');
    }
  if (failures.length) throw new Error(failures.join(' '));
}

/** The name act gives a workflow's containers, which is what two runs must not share. */
function actWorkflowName(workspacePath: string, args: readonly string[]): string {
  const workflow = args[args.indexOf('-W') + 1] ?? '';
  const text = readFileSync(join(workspacePath, workflow), 'utf8');
  const named = /^name:[ \t]*(['"]?)(.*?)\1[ \t]*(?:#.*)?$/m.exec(text)?.[2]?.trim();
  return named || basename(workflow);
}

/**
 * Runs a check an agent asked for, in the daemon (R-G4): `ct-check -- <executable> <arguments>`,
 * `ct-act -W <workflow> [-j <job>]` or `ct-native -- <executable> <arguments>`. The daemon, not the agent, observes the commit and
 * cleanliness before and after, applies the time limit and keeps the log; the receipt is
 * returned for the daemon to record in its database. For act, the wait for the workflow's host
 * lock counts against the check's time limit.
 */
export async function executeCheck(e: CheckExecution): Promise<CheckOutcome> {
  let success = false,
    diagnostic = '',
    code: number | null = null,
    log = '',
    command = '',
    actual: string[] = [];
  let m: PinnedCargoManifest | undefined;
  let before = { headSha: '', clean: false };
  let waitExpired = false;
  const releases: (() => void)[] = [];
  const act = e.tool === 'ct-act';
  const native = e.tool === 'ct-native';
  const cargo = e.tool === 'cargo';
  let cargoReceipt: Record<string, unknown> | undefined;
  let ownsNativeUnit = false;
  const started = Date.now();
  try {
    if (hash(e.manifest) !== e.manifestDigest) throw new Error('Verification manifest changed.');
    m = JSON.parse(e.manifest) as PinnedCargoManifest;
    verifySources(m);
    const timeoutMs = m.checkTimeoutMs ?? 30 * 60000;
    const deadline = started + timeoutMs;
    let cwd = m.workspacePath;
    let environment: Record<string, string> = { ...e.environment };
    let writable = [...e.writablePaths];
    if (act) {
      const ci = m.localCi;
      if (!ci) throw new Error('Local act is not configured by the operator.');
      const evidence = join(dirname(e.manifestPath), 'checks');
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      actual = localActArguments(m, e.manifestPath, [...e.args], evidence);
      command = ci.actExecutable;
      if (!e.holdWorkflow) throw new Error('Local CI needs the daemon workflow queue.');
      const key = hash(`${ci.dockerHost}\0${actWorkflowName(m.workspacePath, e.args)}`);
      try {
        releases.push(
          await e.holdWorkflow(key, deadline, e.signal, (holder) =>
            e.onOutput(
              `Waiting for run ${holder} to finish this workflow's local CI; act cannot run it twice at once on one Docker host.\n`,
            ),
          ),
        );
        // Launchers of runs prepared before R-G4 still take the file lock; keep excluding them.
        const lock = localCiLockPath(ci, m.workspacePath, e.args);
        await acquireLocalCiLock(lock, m.runId, Math.max(0, deadline - Date.now()), 2000, e.signal);
        releases.push(() => releaseLocalCiLock(lock));
      } catch (error) {
        waitExpired = !e.signal.aborted;
        throw error;
      }
      for (const part of ['cargo-registry', 'cargo-git'])
        mkdirSync(join(ci.cacheRoot, part), { recursive: true, mode: 0o700 });
      mkdirSync(join(evidence, 'artifacts'), { recursive: true, mode: 0o700 });
      const home = join(e.privateDirectory, 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      cwd = e.privateDirectory;
      environment = {
        PATH: process.env.PATH ?? '/usr/bin',
        HOME: home,
        DOCKER_HOST: ci.dockerHost,
        XDG_CACHE_HOME: ci.cacheRoot,
      };
      writable = [...writable, ci.cacheRoot, e.privateDirectory];
    } else if (cargo) {
      // Pinned Cargo (ADR-047): only builds come here; the daemon resolves the graph itself.
      const subcommand = assertPinnedCargoArguments(e.args);
      if (!PINNED_BUILD_COMMANDS.has(subcommand))
        throw new Error(`cargo ${subcommand} records nothing; run it directly.`);
      environment = { ...environment, CARGO_TARGET_DIR: m.targetDirectory };
      const toolchain = (
        await captureCheck(m.cargoExecutable, ['--version', '--verbose'], {
          cwd: m.workspacePath,
          env: environment,
          timeoutMs: 30000,
        })
      ).stdout.trim();
      if (!toolchain) throw new Error('Could not identify Cargo toolchain.');
      const metadata = await captureCheck(
        e.confinement === 'systemd' ? 'systemd-run' : m.cargoExecutable,
        e.confinement === 'systemd'
          ? confinedCheckArguments(
              `${e.unitName}-metadata`,
              m.workspacePath,
              330,
              writable,
              environment,
              [m.cargoExecutable, ...pinnedMetadataArguments(m, e.args)],
              false,
              [join(m.workspacePath, '.git')],
            )
          : pinnedMetadataArguments(m, e.args),
        {
          cwd: m.workspacePath,
          env: e.confinement === 'systemd' ? userBusEnvironment() : environment,
          timeoutMs: Math.min(300000, Math.max(1, deadline - Date.now())),
        },
      );
      if (metadata.code !== 0)
        throw new Error(
          `Pinned dependency resolution failed. Align Cargo version constraints with the pinned crates; registry fallback is not accepted.\n${metadata.stderr}`,
        );
      const packages = pinnedResolvedPackages(m, metadata.stdout);
      cargoReceipt = {
        ...pinnedReceiptKind(m, packages),
        toolchain,
        toolchainDigest: cargoManifestDigest(toolchain),
        packages,
      };
      command = m.cargoExecutable;
      actual = pinnedCargoArguments(m, e.args);
    } else {
      const args = e.args[0] === '--' ? e.args.slice(1) : [...e.args];
      command = args[0] ?? '';
      actual = args.slice(1);
      if (!command || command.startsWith('-') || command.includes('\0'))
        throw new Error(`Usage: ${e.tool} -- <executable> <arguments>`);
      if (
        native &&
        (!m.nativeVerification || m.nativeVerification.hostDigest !== nativeHostDigest())
      )
        throw new Error('A current approved native environment is required.');
    }
    before = await observeGitState(m);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('The check time limit passed before it could start.');
    const confined = e.confinement === 'systemd';
    const ci = m.localCi;
    const runId = m.runId;
    const busEnvironment = userBusEnvironment();
    let spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv };
    if (native) {
      // The approved native unit (ADR-054): its own limits, a fresh HOME and TMPDIR the daemon
      // owns, and `env -i` with only the toolchain it names.
      const home = join(e.privateDirectory, 'home');
      const tmp = join(e.privateDirectory, 'tmp');
      for (const p of [home, tmp]) mkdirSync(p, { recursive: true, mode: 0o700 });
      spawned = {
        command: nativeExecutables.systemdRun,
        args: nativeArguments(nativeUnit(runId), m.workspacePath, remaining / 1000, [
          '/usr/bin/env',
          '-i',
          `PATH=${dirname(e.manifestPath)}/bin:${join(homedir(), '.cargo/bin')}:/usr/local/bin:/usr/bin`,
          `HOME=${home}`,
          `TMPDIR=${tmp}`,
          `CARGO_HOME=${join(homedir(), '.cargo')}`,
          `RUSTUP_HOME=${join(homedir(), '.rustup')}`,
          'RUSTUP_AUTO_INSTALL=0',
          `CARGO_TARGET_DIR=${m.targetDirectory}`,
          `CRAFTINGTABLE_CARGO_CONFIG=${m.configPath}`,
          `CRAFTINGTABLE_DEPENDENCY_MANIFEST=${e.manifestPath}`,
          command,
          ...actual,
        ]),
        env: busEnvironment,
      };
      command = nativeExecutables.systemdRun;
      ownsNativeUnit = true;
    } else if (confined)
      spawned = {
        command: 'systemd-run',
        args: confinedCheckArguments(
          e.unitName,
          cwd,
          remaining / 1000 + 30,
          writable,
          environment,
          [command, ...actual],
          // act fetches actions itself; its job containers reach Docker's network anyway.
          act,
          // The worktree's `.git` pointer stays as the daemon made it (R-G4 review).
          [join(m.workspacePath, '.git')],
        ),
        env: busEnvironment,
      };
    else spawned = { command, args: actual, env: environment };
    const supervised = await superviseCheck(spawned.command, spawned.args, {
      cwd,
      env: spawned.env,
      timeoutMs: remaining,
      onOutput: e.onOutput,
      signal: e.signal,
      onStop: () => {
        if (native) void stopNativeUnit(runId).catch(() => {});
        else if (confined) stopCheckUnit(e.unitName);
        if (act && ci) void removeRunContainers(ci, runId).catch(() => {});
      },
    });
    code = supervised.code;
    log = supervised.log;
    verifySources(m);
    success = code === 0;
    if (!success)
      diagnostic = code === null ? 'Check interrupted or timed out.' : `Check exited ${code}.`;
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : 'Check failed.';
  } finally {
    if (ownsNativeUnit && m) {
      try {
        await stopNativeUnit(m.runId);
      } catch (error) {
        success = false;
        diagnostic += ` ${error instanceof Error ? error.message : 'Native cleanup failed.'}`;
      }
    }
    if (act && m?.localCi) {
      try {
        await removeRunContainers(m.localCi, m.runId);
      } catch (error) {
        success = false;
        diagnostic += ` ${error instanceof Error ? error.message : 'CI cleanup failed.'}`;
      }
    }
    // Released after this run's containers are gone, so the next run starts clean.
    for (const release of releases.reverse()) release();
  }
  const after = m ? await observeGitState(m) : { headSha: '', clean: false };
  mkdirSync(dirname(e.logPath), { recursive: true, mode: 0o700 });
  const limit = e.logLimitBytes ?? 2 * 1024 * 1024;
  const kept =
    Buffer.byteLength(log) > limit ? Buffer.from(log).subarray(0, limit).toString() : log;
  writeFileSync(
    e.logPath,
    `${kept}\n${kept === log ? '' : '[log truncated: this run reached its retained log limit]\n'}${diagnostic}\n`,
    { mode: 0o600 },
  );
  const logBytes = statSync(e.logPath).size;
  if (cargo)
    return {
      exitCode: success ? 0 : 1,
      diagnostic,
      logBytes,
      // The pinned build receipt (ADR-047), as the launcher wrote it, now from the daemon.
      receipt: {
        ...(cargoReceipt ? pinnedReceiptKind(m!, cargoReceipt.packages as unknown[]) : {}),
        recordedBy: 'daemon',
        runtimeId: m?.runtimeId,
        runId: m?.runId,
        ...(m?.verification
          ? {
              verificationMode: m.verification.mode,
              policyDigest: hash(JSON.stringify(m.verification)),
            }
          : {}),
        manifestDigest: e.manifestDigest,
        command: e.args[0] ?? 'help',
        args: e.args,
        toolchain: cargoReceipt?.toolchain,
        toolchainDigest: cargoReceipt?.toolchainDigest,
        headSha: after.headSha,
        clean: before.clean && after.clean && before.headSha === after.headSha,
        packages: cargoReceipt?.packages ?? [],
        success,
        exitCode: code,
        diagnostic,
        logPath: e.logReference,
        logDigest: hash(readFileSync(e.logPath)),
        at: new Date().toISOString(),
      },
    };
  return {
    exitCode: success ? 0 : 1,
    diagnostic,
    logBytes,
    receipt: {
      kind: act ? 'local-ci' : native ? 'native-check' : 'scoped-check',
      ...(native && m?.nativeVerification ? { nativeVerification: m.nativeVerification } : {}),
      recordedBy: 'daemon',
      runtimeId: m?.runtimeId,
      runId: m?.runId,
      manifestDigest: e.manifestDigest,
      verificationMode: m?.verification?.mode,
      policyDigest: m?.verification && hash(JSON.stringify(m.verification)),
      headSha: after.headSha,
      clean: before.clean && after.clean && before.headSha === after.headSha,
      command,
      args: e.args,
      success,
      exitCode: code,
      diagnostic,
      ...(waitExpired ? { workflowWait: 'expired' } : {}),
      logPath: e.logReference,
      logDigest: hash(readFileSync(e.logPath)),
      ...(act ? { image: m?.localCi?.image } : {}),
      at: new Date().toISOString(),
    },
  };
}

/**
 * The daemon's own Cargo home (R-G5 review, operator decision 2026-09-28): agents fetch into it
 * and the daemon's check units build from it, so nothing an agent writes in a Cargo cache ever
 * reaches the operator's own builds. Brings in, one way, the registry and Git caches of the
 * operator's Cargo home (`source`) that it lacks, so offline builds and agents that cannot fetch
 * find what the operator already downloaded; existing files are never replaced, and nothing
 * else (tokens, configuration, binaries) is copied. Copy-on-write where the file system allows.
 */
export function syncDaemonCargoHome(target: string, source?: string): void {
  for (const cache of ['registry', 'git']) {
    const into = join(target, cache);
    // Both caches always exist: a check unit cannot be given a missing writable path, nor can
    // Claude's sandbox make one writable.
    mkdirSync(into, { recursive: true, mode: 0o700 });
    if (!source || !isAbsolute(source)) continue;
    const from = join(source, cache);
    if (!existsSync(from)) continue;
    const copied = spawnSync(
      'cp',
      ['-R', '--no-dereference', '--reflink=auto', '--update=none', `${from}/.`, `${into}/`],
      { encoding: 'utf8', timeout: 30 * 60 * 1000 },
    );
    if (copied.status !== 0)
      throw new Error(
        `Seeding the daemon's Cargo ${cache} cache failed: ${copied.error?.message ?? copied.stderr}`,
      );
  }
}
