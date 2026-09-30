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
import { pathToFileURL } from 'node:url';
import {
  mkdir as fsMkdir,
  open as fsOpen,
  stat as fsStat,
  readdir as fsReaddir,
  rm as fsRm,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
    GIT_NO_REPLACE_OBJECTS: '1',
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
  /**
   * A daemon-owned Cargo target directory for the run's declared checks, outside every writable
   * root, so the agent cannot plant build outputs they reuse (R-G13 review).
   */
  readonly declaredTargetDirectory?: string;
  /**
   * Published crates (operator decisions 2026-09-29): a check's Cargo home is a local registry
   * of their index entries and matching downloads. Without it, no registry crate reaches it.
   */
  readonly crateRegistry?: CrateRegistry;
  /** Where this check's fresh Cargo home is made: stable per concurrent check of a run. */
  readonly cargoHomeDirectory?: string;
  /**
   * Roots agents can write, of every run (the data directory, run and worktree roots): a
   * declared check's unit sees none of them but its own paths (R-G13 review).
   */
  readonly hiddenRoots?: readonly string[];
}
/** What the daemon knows of published crates: checksums, and each crate's index file. */
export interface CrateRegistry {
  checksum(source: string, name: string, version: string): Promise<string | undefined>;
  indexFile(source: string, name: string): Promise<string | undefined>;
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
  /** Paths the unit cannot see at all, such as the run's agent-writable roots. */
  inaccessible: readonly string[] = [],
  /** Roots replaced by empty read-only file systems, and paths bound back over them. */
  hidden: {
    readonly roots: readonly string[];
    readonly binds: readonly string[];
    readonly readOnlyBinds?: readonly string[];
  } = {
    roots: [],
    binds: [],
  },
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
    ...inaccessible.flatMap((p) => ['-p', `InaccessiblePaths=-${p}`]),
    // The host's shared memory is writable from every unit, so no unit sees it (R-G13 review).
    '-p',
    'TemporaryFileSystem=/dev/shm',
    // Nor the user's runtime directory, whose user bus would start a unit outside every
    // confinement (R-G13 review). Local CI keeps only its Docker socket there.
    ...runtimeDirectoryConfinement(network),
    ...hidden.roots.flatMap((p) => ['-p', `TemporaryFileSystem=${p}:ro`]),
    ...hidden.binds.flatMap((p) => ['-p', `BindPaths=${p}`]),
    ...(hidden.readOnlyBinds ?? []).flatMap((p) => ['-p', `BindReadOnlyPaths=-${p}`]),
    '--',
    '/usr/bin/env',
    '-i',
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    ...command,
  ];
}

/** What of the user's runtime directory and the system's service sockets a unit may reach. */
function runtimeDirectoryConfinement(localCi: boolean): string[] {
  const uid = process.getuid?.();
  const runtime = uid === undefined ? undefined : `/run/user/${uid}`;
  const hide = (paths: readonly string[]) =>
    paths.flatMap((p) => ['-p', `InaccessiblePaths=-${p}`]);
  if (localCi)
    return hide([
      ...(runtime ? [`${runtime}/bus`, `${runtime}/systemd`] : []),
      '/run/dbus/system_bus_socket',
    ]);
  return [
    ...(runtime ? ['-p', `TemporaryFileSystem=${runtime}:ro`] : []),
    ...hide(['/run/docker.sock', '/var/run/docker.sock', '/run/dbus/system_bus_socket']),
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
/** Runs the daemon's Git, without hooks or the operator's configuration, and returns stdout. */
function daemonGit(
  m: PinnedCargoManifest,
  args: readonly string[],
  cwd: string,
  limit = 1024 * 1024,
  timeoutMs = 120_000,
  environment: Readonly<Record<string, string>> = {},
): Promise<Buffer> {
  return new Promise((resolveResult, reject) =>
    execFile(
      m.gitExecutable,
      [...DAEMON_GIT_OPTIONS, ...args],
      {
        cwd,
        encoding: 'buffer',
        timeout: Math.max(1, Math.min(120_000, timeoutMs)),
        maxBuffer: limit,
        env: { ...daemonGitEnvironment(), ...environment },
      },
      (error, stdout) => (error ? reject(error) : resolveResult(stdout)),
    ),
  );
}

/**
 * A daemon-private clone of the commit under review, where a declared check runs (R-G13
 * review): the agent keeps running while its checks do, and could change its own worktree
 * mid-check. The commit must be on a branch; a detached commit fails closed. Tags come along
 * through the same verified pack: a repository's own checks may compare one with a fixed commit.
 */
async function cloneReviewedCommit(m: PinnedCargoManifest, sha: string, into: string) {
  if (!m.gitCommonDirectory) throw new Error('The run has no daemon-resolved git directory.');
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(sha))
    throw new Error('The reviewed commit could not be read.');
  rmSync(into, { recursive: true, force: true });
  mkdirSync(dirname(into), { recursive: true, mode: 0o700 });
  try {
    await daemonGit(
      m,
      // `--no-local` copies through a pack, whose objects Git hashes on receipt: an object the
      // agent rewrote in the shared store no longer matches its name, and the clone fails. A
      // clone that borrows the store would read the rewritten bytes (R-G13 review).
      ['clone', '--quiet', '--no-checkout', '--no-local', m.gitCommonDirectory, into],
      dirname(into),
    );
    await daemonGit(
      m,
      ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha],
      into,
    );
  } catch {
    throw new Error('The reviewed commit could not be checked out for the declared check.');
  }
}

/**
 * Daemon-private checkouts of the upstream commits a pinned build compiles against (R-G13
 * increment 2), and a pins configuration naming them. Each commit is fetched by its exact id into
 * a fresh repository, through a pack Git hashes on receipt, so an object an agent rewrote in the
 * upstream's store fails the fetch; its tree must be the pin's. The run's own copies, which the
 * agent can write, are never read.
 */
async function clonePinnedSources(
  m: PinnedCargoManifest,
  into: string,
  within: () => number,
): Promise<{ packages: { name: string; path: string }[]; configPath: string }> {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true, mode: 0o700 });
  const packages: { name: string; path: string }[] = [];
  for (const [index, source] of (m.dependencySources ?? []).entries()) {
    const root = join(into, `source-${index}`);
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(source.commitSha))
      throw new Error(`The pinned ${source.alias} commit could not be read.`);
    try {
      await daemonGit(m, ['init', '--quiet', root], into, undefined, within());
      await daemonGit(
        m,
        [
          'fetch',
          '--quiet',
          '--no-tags',
          '--depth=1',
          pathToFileURL(source.gitDirectory).href,
          `${source.commitSha}:refs/pinned/source`,
        ],
        root,
        undefined,
        within(),
        // By exact commit, reachable or not: the upstream's upload-pack reads this too.
        {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'uploadpack.allowAnySHA1InWant',
          GIT_CONFIG_VALUE_0: 'true',
        },
      );
      await daemonGit(
        m,
        ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', source.commitSha],
        root,
        undefined,
        within(),
      );
    } catch {
      throw new Error(
        `The pinned ${source.alias} commit could not be read through a verified pack.`,
      );
    }
    if (
      source.treeSha !== undefined &&
      (await daemonGit(m, ['rev-parse', 'HEAD^{tree}'], root)).toString('utf8').trim() !==
        source.treeSha
    )
      throw new Error(`The pinned ${source.alias} commit does not hold the pinned tree.`);
    for (const pkg of source.packages) {
      const path = resolve(root, pkg.path);
      const r = relative(root, path);
      if (r.startsWith('..') || isAbsolute(r))
        throw new Error(`The pinned ${source.alias} package path is outside its source.`);
      packages.push({ name: pkg.name, path });
    }
  }
  const configPath = join(into, 'pins.toml');
  writeFileSync(
    configPath,
    `[patch.crates-io]\n${packages
      .map((p) => `${JSON.stringify(p.name)} = { path = ${JSON.stringify(p.path)} }`)
      .join('\n')}\n`,
    { mode: 0o400 },
  );
  return { packages, configPath };
}

/**
 * SHA-256 of each definition file as the reviewed commit stores it (R-G13), read before the
 * check runs. A link, a directory or a missing path is absent, which no adoption matches.
 */
async function committedDigests(
  m: PinnedCargoManifest,
  repository: string,
  sha: string,
  paths: readonly string[],
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const path of paths) {
    const listed = (
      await daemonGit(
        m,
        ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', sha, '--', path],
        repository,
      )
    ).toString('utf8');
    const entry = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)\0$/s.exec(listed);
    if (!entry || entry[3] !== path) continue;
    digests[path] = hash(
      await daemonGit(m, ['cat-file', 'blob', entry[2]!], repository, 16 * 1024 * 1024),
    );
  }
  return digests;
}

/** PATH without any directory the run can write: an agent could plant a program there. */
/**
 * What a `Cargo.lock` pins (lock format 2 and later): registry packages with the checksum the
 * lock claims, and the commits of Git dependencies. The claim is not trusted: every crate is
 * checked against the daemon's checksum authority, so a misread lock can only leave a crate
 * out, never let one in.
 */
export function lockedPackages(lock: string): {
  readonly registry: readonly {
    source: string;
    name: string;
    version: string;
    checksum?: string;
  }[];
  readonly gitCommits: readonly string[];
} {
  const registry: { source: string; name: string; version: string; checksum?: string }[] = [];
  const gitCommits: string[] = [];
  for (const block of lock.split(/^\[\[package\]\][ \t]*\r?$/m).slice(1)) {
    const body = block.split(/^\[/m)[0]!;
    const field = (key: string) =>
      new RegExp(`^${key} = "([^"\\n]*)"[ \\t]*\\r?$`, 'm').exec(body)?.[1];
    const name = field('name'),
      version = field('version'),
      source = field('source'),
      checksum = field('checksum');
    if (!name || !version || !source) continue;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !/^[A-Za-z0-9.+-]{1,64}$/.test(version)) continue;
    if (/^(registry|sparse)\+/.test(source))
      registry.push({
        source,
        name,
        version,
        ...(checksum && /^[a-f0-9]{64}$/.test(checksum) ? { checksum } : {}),
      });
    else if (source.startsWith('git+')) {
      const commit = /#([a-f0-9]{40}|[a-f0-9]{64})$/.exec(source)?.[1];
      if (commit) gitCommits.push(commit);
    }
  }
  return { registry, gitCommits };
}

/** A file's bytes, only if it is a regular file within `limit`; never blocks on a FIFO. */
export async function readRegular(path: string, limit: number): Promise<Buffer | undefined> {
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fsOpen(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) return undefined;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export interface PrivateCargoHome {
  /** Crates copied, each matching the checksum authority. */
  readonly crates: number;
  /** Crates or Git databases left out, and why. */
  readonly leftOut: readonly string[];
  /** Whether the tree had any lock to read. */
  readonly locked: boolean;
}

/**
 * A fresh Cargo home for one check (operator decisions 2026-09-29, R-G13 review). Agents fetch
 * into the daemon's shared Cargo home, which they can therefore write, and Cargo trusts what it
 * finds in a home without checking it again. So nothing of the shared home's registry comes
 * along, not even its index: the check's home is a local registry the daemon builds, holding
 * the published index entries of the crates the checked tree's locks pin (from the daemon's
 * registry authority, crates.io's own index) and only those downloaded crates whose SHA-256
 * matches the published checksum; each is read without following links or blocking, then
 * hashed and written. The home's configuration replaces crates.io with that registry and keeps
 * Cargo offline. Cargo extracts sources afresh, and checks each crate against the index entry
 * again. Git dependencies whose locked commit a database holds are cloned through a pack, which
 * Git hashes on receipt. A crate that is missing, rewritten or unverifiable is left out and
 * named, and the build fails.
 */
async function preparePrivateCargoHome(
  m: PinnedCargoManifest,
  shared: string,
  into: string,
  locks: readonly string[],
  registry: CrateRegistry | undefined,
  within: () => number,
): Promise<PrivateCargoHome> {
  await fsRm(into, { recursive: true, force: true });
  const verified = join(into, 'ct-verified');
  await fsMkdir(join(verified, 'index'), { recursive: true, mode: 0o700 });
  await fsWriteFile(
    join(into, 'config.toml'),
    `[source.crates-io]\nreplace-with = "ct-verified"\n\n[source.ct-verified]\nlocal-registry = ${JSON.stringify(verified)}\n\n[net]\noffline = true\n`,
    { mode: 0o600 },
  );
  const pinned = locks.map(lockedPackages);
  const wanted = new Map<string, { source: string; name: string; version: string }>();
  for (const lock of pinned)
    for (const p of lock.registry) wanted.set(`${p.source}\0${p.name}\0${p.version}`, p);
  const leftOut: string[] = [];
  let crates = 0;
  const cache = join(shared, 'registry', 'cache');
  let registries: string[] = [];
  try {
    registries = (await fsReaddir(cache, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // Nothing downloaded yet.
  }
  const indexed = new Set<string>();
  let asked = 0;
  for (const p of wanted.values()) {
    within();
    const file = `${p.name}-${p.version}.crate`;
    // Only crates that were downloaded are looked up, and at most 5,000 per check, so a lock
    // cannot make the daemon crawl the registry (R-G13 review).
    const downloaded = [];
    for (const directory of registries)
      if (
        await fsStat(join(cache, directory, file)).then(
          () => true,
          () => false,
        )
      )
        downloaded.push(directory);
    if (!downloaded.length) {
      leftOut.push(`${file} (not downloaded)`);
      continue;
    }
    if (++asked > 5000) {
      leftOut.push(`${file} (more crates than one check verifies)`);
      continue;
    }
    const published = await registry?.checksum(p.source, p.name, p.version);
    const index = published && (await registry?.indexFile(p.source, p.name));
    if (!published || !index) {
      leftOut.push(`${file} (its published checksum could not be learned)`);
      continue;
    }
    let found = false,
      matched = false;
    for (const directory of downloaded) {
      const content = await readRegular(join(cache, directory, file), 256 * 1024 * 1024);
      if (!content) continue;
      found = true;
      if (hash(content) !== published) continue;
      await fsWriteFile(join(verified, file), content, { mode: 0o600 });
      matched = true;
      break;
    }
    if (!matched) {
      leftOut.push(
        found ? `${file} (does not match its published checksum)` : `${file} (not downloaded)`,
      );
      continue;
    }
    crates++;
    const name = p.name.toLowerCase();
    if (indexed.has(name)) continue;
    indexed.add(name);
    const path = join(verified, 'index', ...lockIndexPath(name).split('/'));
    await fsMkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fsWriteFile(path, index, { mode: 0o600 });
  }
  const commits = [...new Set(pinned.flatMap((lock) => lock.gitCommits))];
  const db = join(shared, 'git', 'db');
  let repositories: string[] = [];
  try {
    repositories = commits.length
      ? (await fsReaddir(db, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];
  } catch {
    // No Git dependencies downloaded.
  }
  for (const repository of repositories) {
    const source = join(db, repository);
    // Only databases that hold a locked commit; each is then copied through a pack.
    let holds = false;
    for (const commit of commits)
      if (!holds)
        holds = await daemonGit(
          m,
          ['--git-dir', source, 'cat-file', '-e', `${commit}^{commit}`],
          into,
          undefined,
          Math.min(within(), 30_000),
        )
          .then(() => true)
          .catch(() => false);
    if (!holds) continue;
    await fsMkdir(join(into, 'git', 'db'), { recursive: true, mode: 0o700 });
    try {
      await daemonGit(
        m,
        ['clone', '--quiet', '--mirror', '--no-local', source, join(into, 'git', 'db', repository)],
        into,
        undefined,
        within(),
      );
    } catch {
      within();
      leftOut.push(`git/db/${repository} (its objects do not match their names)`);
      await fsRm(join(into, 'git', 'db', repository), { recursive: true, force: true });
    }
  }
  return { crates, leftOut, locked: locks.length > 0 };
}

/** A crate's file in a registry index, by Cargo's layout. */
function lockIndexPath(name: string): string {
  if (name.length === 1) return `1/${name}`;
  if (name.length === 2) return `2/${name}`;
  if (name.length === 3) return `3/${name[0]}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

/**
 * The `Cargo.lock` files of a tree: tracked, or untracked and not ignored, and the root's. At most
 * 64 locks and 64 MiB in all, each read without following links or blocking (R-G13 review); a
 * lock beyond that is left out, so its crates are too, and the build fails closed.
 */
async function cargoLocks(
  m: PinnedCargoManifest,
  root: string,
): Promise<{ locks: string[]; skipped: number }> {
  let listed: string[] = [];
  try {
    listed = (
      await daemonGit(
        m,
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        root,
        64 * 1024 * 1024,
      )
    )
      .toString('utf8')
      .split('\0')
      .filter((p) => p === 'Cargo.lock' || p.endsWith('/Cargo.lock'));
  } catch {
    // Not a Git tree: the root's lock only.
  }
  const locks: string[] = [];
  const paths = [...new Set(['Cargo.lock', ...listed])];
  let total = 0,
    read = 0;
  for (const path of paths.slice(0, 64)) {
    const content = await readRegular(join(root, path), 16 * 1024 * 1024);
    read++;
    if (!content) continue;
    total += content.byteLength;
    if (total > 64 * 1024 * 1024) {
      read--;
      break;
    }
    locks.push(content.toString('utf8'));
  }
  return { locks, skipped: paths.length - read };
}

export function trustedPath(path: string | undefined, writable: readonly string[]): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const roots = writable.flatMap((root) => [resolve(root), real(root)]);
  const inside = (entry: string) =>
    [resolve(entry), real(entry)].some((candidate) =>
      roots.some((root) => {
        const r = relative(root, candidate);
        return r === '' || (!r.startsWith('..') && !isAbsolute(r));
      }),
    );
  return (path ?? '/usr/bin')
    .split(':')
    .filter((entry) => entry !== '' && isAbsolute(entry) && !inside(entry))
    .join(':');
}

/**
 * What a declared check's unit gets (R-G13): a PATH without any directory the run can write,
 * its own scratch and Cargo target, write access to nothing else but the daemon's Cargo caches,
 * and no sight of the run's agent-writable roots, which a committed link could otherwise reach.
 */
export function declaredUnitSettings(input: {
  readonly environment: Readonly<Record<string, string>>;
  /** Where the run itself may write: the worktree, the run directory, the Cargo caches. */
  readonly runWritablePaths: readonly string[];
  readonly launcherDirectory: string;
  readonly workspacePath: string;
  readonly snapshot: string;
  readonly privateDirectory: string;
  readonly target: string;
  /** The daemon's shared Cargo home, which agents write; the environment names the check's own. */
  readonly sharedCargoHome?: string;
  /**
   * Every root agents can write, of any run: the data directory, the run and worktree roots,
   * the shared Cargo home, the CI cache. The unit sees none of them, except its own paths.
   */
  readonly hiddenRoots?: readonly string[];
  /**
   * The operator's home, hidden whole (R-G13 review): repositories' shared Git directories and
   * other files agents write live there. Only the toolchain comes back, read-only.
   */
  readonly homeDirectory?: string;
  /** Daemon-written paths the check reads and must not change, such as pinned sources. */
  readonly readOnlyPaths?: readonly string[];
}): {
  readonly environment: Record<string, string>;
  readonly writable: readonly string[];
  readonly inaccessible: readonly string[];
  /** Mounted as empty read-only file systems in the unit. */
  readonly hidden: readonly string[];
  /** The check's own paths, bound back into the unit over the hidden roots. */
  readonly binds: readonly string[];
  /** The toolchain under a hidden root, bound back read-only. */
  readonly readOnlyBinds: readonly string[];
} {
  const tmp = join(input.privateDirectory, 'tmp');
  for (const p of [tmp, input.target]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const cargoHome = input.environment.CARGO_HOME;
  const own = cargoHome && cargoHome !== input.sharedCargoHome ? [cargoHome] : [];
  const home = input.homeDirectory;
  // No PATH entry under a hidden root: binding it back would reopen that root (R-G13 review).
  const path = trustedPath(input.environment.PATH, [
    input.launcherDirectory,
    input.workspacePath,
    ...input.runWritablePaths,
    ...(input.sharedCargoHome ? [input.sharedCargoHome] : []),
    ...(input.hiddenRoots ?? []),
  ]);
  const underHome = (p: string) => {
    if (!home) return false;
    const r = relative(home, p);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r);
  };
  const rustupHome = input.environment.RUSTUP_HOME ?? (home ? join(home, '.rustup') : undefined);
  return {
    environment: {
      ...input.environment,
      PATH: path,
      TMPDIR: tmp,
      CARGO_TARGET_DIR: input.target,
      // The home is hidden: the check gets a scratch one, and the toolchain by its own path.
      ...(home ? { HOME: tmp } : {}),
      ...(rustupHome ? { RUSTUP_HOME: rustupHome } : {}),
    },
    // The check's own Cargo home, never the shared one (operator decision 2026-09-29).
    writable: [input.snapshot, tmp, input.target, ...own],
    // A committed configuration or link could otherwise name any path agents write, of this run
    // or another, and the check would build from it (R-G13 review): only the reviewed clone,
    // its scratch, its build outputs and its own Cargo home remain visible.
    hidden: [...new Set([...(input.hiddenRoots ?? []), ...(home ? [home] : [])])],
    binds: [input.snapshot, tmp, input.target, ...own],
    readOnlyBinds: [
      ...new Set([
        ...(input.readOnlyPaths ?? []),
        ...(rustupHome && underHome(rustupHome) ? [rustupHome] : []),
        ...path.split(':').filter((entry) => entry && underHome(entry)),
      ]),
    ],
    inaccessible: [
      input.workspacePath,
      input.launcherDirectory,
      ...input.runWritablePaths,
      ...(input.sharedCargoHome ? [input.sharedCargoHome] : []),
    ],
  };
}

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
  let declared: NonNullable<PinnedCargoManifest['declaredChecks']>['checks'][number] | undefined;
  let snapshot: string | undefined;
  let inaccessible: readonly string[] = [];
  let hidden: {
    roots: readonly string[];
    binds: readonly string[];
    readOnlyBinds?: readonly string[];
  } = { roots: [], binds: [] };
  let privateCargoHome: string | undefined;
  let pinnedSources: string | undefined;
  let observed = false;
  let declaredDigests: Record<string, string> = {};
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
    // Every Cargo build in a check unit gets a fresh, private Cargo home, holding only verified
    // downloads, and cannot see the shared one (operator decision 2026-09-29). The approved
    // native environment keeps its own (ADR-054), and act runs in containers.
    const sharedCargoHome = e.environment.CARGO_HOME;
    const within = (root: string, p: string) => {
      const r = relative(root, p);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    };
    const usePrivateCargoHome = async (manifest: PinnedCargoManifest, root: string) => {
      if (!sharedCargoHome || native || act) return;
      // A stable path per concurrent check of a run keeps Cargo's fingerprints, which name the
      // sources' path, valid from one check to the next; the home itself is always fresh.
      privateCargoHome = e.cargoHomeDirectory ?? join(e.privateDirectory, 'cargo-home');
      const lockFiles = await cargoLocks(manifest, root);
      const prepared = await preparePrivateCargoHome(
        manifest,
        sharedCargoHome,
        privateCargoHome,
        lockFiles.locks,
        e.crateRegistry,
        () => {
          if (e.signal.aborted) throw new Error('Interrupted.');
          const left = deadline - Date.now();
          if (left <= 0)
            throw new Error('The check time limit passed while its Cargo home was prepared.');
          return left;
        },
      );
      if (lockFiles.skipped)
        e.onOutput(
          `${lockFiles.skipped} Cargo.lock files were not read: a check reads at most 64 of them, 64 MiB in all.\n`,
        );
      if (!prepared.locked)
        e.onOutput(
          'No Cargo.lock in the checked tree, so no registry dependency is available to this offline check. Commit Cargo.lock.\n',
        );
      if (prepared.leftOut.length)
        e.onOutput(`Left out of this check's Cargo home: ${prepared.leftOut.join('; ')}.\n`);
      // Offline whatever the tree's own configuration says: nothing is fetched from anywhere.
      environment = { ...environment, CARGO_HOME: privateCargoHome, CARGO_NET_OFFLINE: 'true' };
      writable = [...writable.filter((p) => !within(sharedCargoHome, p)), privateCargoHome];
      inaccessible = [...inaccessible, sharedCargoHome];
    };
    const manifest = m;
    const remainingTime = () => {
      if (e.signal.aborted) throw new Error('Interrupted.');
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error('The check time limit passed while its sources were prepared.');
      return left;
    };
    // A check on a daemon-private clone (R-G13): its unit sees none of the roots agents write,
    // only the clone, its scratch, its build outputs, its Cargo home and what `readOnlyPaths` adds.
    const confineToClone = (
      tree: string,
      readOnlyPaths: readonly string[] = [],
      hiddenRoots: readonly string[] = [],
    ) => {
      const unit = declaredUnitSettings({
        environment,
        runWritablePaths: e.writablePaths,
        launcherDirectory: dirname(e.manifestPath),
        workspacePath: manifest.workspacePath,
        snapshot: tree,
        privateDirectory: e.privateDirectory,
        ...(sharedCargoHome ? { sharedCargoHome } : {}),
        hiddenRoots: [
          ...(e.hiddenRoots ?? []),
          ...(sharedCargoHome ? [sharedCargoHome] : []),
          ...(manifest.localCi ? [manifest.localCi.cacheRoot] : []),
          // The repository's shared Git directory, which agents write when they commit.
          ...(manifest.gitCommonDirectory ? [manifest.gitCommonDirectory] : []),
          ...hiddenRoots,
        ],
        homeDirectory: homedir(),
        // One per commit: a build script of another commit cannot leave outputs it reuses.
        target: join(
          e.declaredTargetDirectory ?? join(e.privateDirectory, 'target'),
          before.headSha,
        ),
        readOnlyPaths,
      });
      environment = unit.environment;
      writable = [...unit.writable];
      inaccessible = unit.inaccessible;
      hidden = { roots: unit.hidden, binds: unit.binds, readOnlyBinds: unit.readOnlyBinds };
    };
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
      // What the build resolves against: for a run whose manifest names its sources (R-G13
      // increment 2), private clones of the committed head and of each pinned upstream, never
      // the worktree or the run's copies, which the agent can change while the build runs. A
      // build of uncommitted work, which no gate accepts, still runs in the worktree: that is the
      // agent's own development loop.
      let built: PinnedCargoManifest = m;
      before = await observeGitState(m);
      observed = true;
      if (m.dependencySources && before.clean) {
        snapshot = join(e.privateDirectory, 'tree');
        await cloneReviewedCommit(m, before.headSha, snapshot);
        pinnedSources = join(e.privateDirectory, 'pinned');
        const sources = await clonePinnedSources(m, pinnedSources, remainingTime);
        built = {
          ...m,
          workspacePath: snapshot,
          packages: sources.packages,
          configPath: sources.configPath,
        };
        cwd = snapshot;
        await usePrivateCargoHome(m, snapshot);
        confineToClone(
          snapshot,
          [pinnedSources, dirname(m.cargoExecutable)],
          // The upstreams' Git directories, which agents write too.
          m.dependencySources.map((source) => source.gitDirectory),
        );
      } else {
        await usePrivateCargoHome(m, m.workspacePath);
        environment = { ...environment, CARGO_TARGET_DIR: m.targetDirectory };
      }
      const toolchain = (
        await captureCheck(m.cargoExecutable, ['--version', '--verbose'], {
          cwd,
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
              cwd,
              330,
              writable,
              environment,
              [m.cargoExecutable, ...pinnedMetadataArguments(built, e.args)],
              false,
              snapshot ? [] : [join(m.workspacePath, '.git')],
              inaccessible,
              hidden,
            )
          : pinnedMetadataArguments(built, e.args),
        {
          cwd,
          env: e.confinement === 'systemd' ? userBusEnvironment() : environment,
          timeoutMs: Math.min(300000, Math.max(1, deadline - Date.now())),
        },
      );
      if (metadata.code !== 0)
        throw new Error(
          `Pinned dependency resolution failed. Align Cargo version constraints with the pinned crates; registry fallback is not accepted.\n${metadata.stderr}`,
        );
      // Named as the run's manifest names them, wherever the build read them.
      const packages = pinnedResolvedPackages(built, metadata.stdout).map(
        (p) => m!.packages.find((q) => q.name === p.name) ?? p,
      );
      cargoReceipt = {
        ...pinnedReceiptKind(m, packages),
        toolchain,
        toolchainDigest: cargoManifestDigest(toolchain),
        packages,
      };
      command = m.cargoExecutable;
      actual = pinnedCargoArguments(built, e.args);
    } else if (e.tool === 'ct-check' && e.args[0] === '--declared') {
      // A declared check runs the adopted command from the verified manifest (R-G13): the
      // request names the check and nothing else.
      if (e.args.length !== 2) throw new Error('Usage: ct-check --declared <check>');
      declared = m.declaredChecks?.checks.find((c) => c.id === e.args[1]);
      if (!declared)
        throw new Error(
          `${e.args[1]} is not a declared check of this repository. Declared: ${
            m.declaredChecks?.checks.map((c) => c.id).join(', ') || 'none'
          }.`,
        );
      command = declared.argv[0]!;
      actual = declared.argv.slice(1);
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
    if (!observed) before = await observeGitState(m);
    if (e.tool === 'ct-check' && !declared) await usePrivateCargoHome(m, m.workspacePath);
    if (declared) {
      snapshot = join(e.privateDirectory, 'tree');
      await cloneReviewedCommit(m, before.headSha, snapshot);
      declaredDigests = await committedDigests(
        m,
        snapshot,
        before.headSha,
        declared.definitionPaths,
      );
      // A program with a path is the repository's own, from the reviewed commit.
      if (command.includes('/')) command = join(snapshot, command);
      cwd = snapshot;
      await usePrivateCargoHome(m, snapshot);
      confineToClone(snapshot);
    }
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
          snapshot ? [] : [join(m.workspacePath, '.git')],
          inaccessible,
          hidden,
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
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
    if (pinnedSources) rmSync(pinnedSources, { recursive: true, force: true });
    if (privateCargoHome) rmSync(privateCargoHome, { recursive: true, force: true });
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
      ...(declared && m?.declaredChecks
        ? {
            declaredCheck: {
              id: declared.id,
              declarationId: m.declaredChecks.declarationId,
              // What defined the check at the reviewed commit; the gate compares it with the
              // adoption.
              definitionDigests: declaredDigests,
            },
          }
        : {}),
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
