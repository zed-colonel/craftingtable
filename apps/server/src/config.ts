import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Worktree, run, Git, and agent-backend settings for the execution loop. */
export interface ExecutionConfig {
  readonly developmentCapacity?: number;
  readonly verificationCapacity?: number;
  /** Stable integration scratch location, independent of future checkout placement. */
  readonly mergeRoot?: string;
  /** Explicit Git executable; when absent the daemon searches PATH at startup. */
  readonly gitExecutable?: string;
  /** Explicit Claude Code executable; when absent the daemon searches PATH and ~/.local/bin. */
  readonly claudeExecutable?: string;
  readonly codexExecutable?: string;
  /** Linked worktrees are created strictly below this directory. */
  readonly worktreeRoot: string;
  /** Per-run brief and plan documents are written strictly below this directory. */
  readonly runsRoot: string;
  /** Upper bound on a single diff response's patch text. */
  readonly maxPatchBytes: number;
  /** `id=Label,id=Label` model options for the launch form; absent means the built-in list. */
  readonly claudeModels?: string;
  readonly codexModels?: string;
  /**
   * How the daemon isolates the checks it runs for agents (R-G4): `systemd`, a transient user
   * unit with a read-only file system except the run's own paths and no network, or `none`,
   * a plain process group (tests; a host without a systemd user manager).
   */
  readonly checkConfinement: 'systemd' | 'none';
  /** Daemon-owned check logs, outside every agent's writable roots. */
  readonly checkLogRoot: string;
  /**
   * Variable names, beyond the built-in allowlist, that reach agent processes
   * (`CRAFTINGTABLE_AGENT_ENV_ALLOW`, comma-separated; R-G5).
   */
  readonly agentEnvironmentAllow: readonly string[];
  /**
   * The daemon's own Cargo home (R-G5 review): agents fetch into it and check units build from
   * it, never the operator's, so a planted crate never reaches the operator's builds.
   */
  readonly cargoHome: string;
  /**
   * The Cargo home whose registry and Git caches seed `cargoHome` at start
   * (`CRAFTINGTABLE_CARGO_SEED_FROM`; the operator's by default; empty turns seeding off).
   */
  readonly cargoSeedFrom?: string;
  /**
   * Where each run's agent process gets a short private temporary directory (LIVE-31): Claude
   * Code's command sandbox makes Unix sockets in its TMPDIR, whose paths hold at most 107 bytes,
   * so the directory must be short: `<data>/t`, or `CRAFTINGTABLE_AGENT_TMP_ROOT` where the data
   * directory's path is long (each run's is this plus 13 bytes, and must be at most 60).
   * A start removes the run directories it holds (12 hex characters), and nothing else; it may
   * not be `/`, `/tmp`, `/var/tmp`, `/dev/shm`, `/run`, `XDG_RUNTIME_DIR`, `TMPDIR` or a home,
   * nor above one, nor overlap the database's directory, the default backup directory or another
   * of the daemon's roots (TS-H3).
   */
  readonly agentTemporaryRoot: string;
}

export interface TlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  /** True when the daemon listens on something other than a loopback address. */
  readonly lanExposed: boolean;
  readonly tls?: TlsConfig;
  /** Built browser app to serve from the daemon; absent means API only. */
  readonly webDistDir?: string;
  readonly sessionLifetimeSeconds: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly execution: ExecutionConfig;
  /**
   * How long a stop waits for live agent turns to finish before interrupting them for an
   * automatic resume after restart (R-B9). The service manager's stop timeout must exceed it.
   */
  readonly drainTimeoutMs: number;
}

export const SERVER_VERSION = '0.3.0';
export const SESSION_COOKIE_NAME = 'craftingtable_session';
export const CSRF_HEADER_NAME = 'x-craftingtable-csrf';

/** The data directory's subdirectory holding the database and its pre-migration copies. */
const DATABASE_DIRECTORY = 'state';
/** The data directory's subdirectory the storage policy keeps database backups in by default. */
export const DATABASE_BACKUP_DIRECTORY = 'backups';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6_PATTERN = /^[0-9a-f:]+$/i;
const LOG_LEVELS = new Set<ServerConfig['logLevel']>([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

/** The daemon's data directory: `CRAFTINGTABLE_DATA_DIR`, or `craftingtable` under the XDG data home. */
export function dataDirectory(env: NodeJS.ProcessEnv): string {
  const override = env.CRAFTINGTABLE_DATA_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error('CRAFTINGTABLE_DATA_DIR must be an absolute path');
    }
    return override;
  }
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'craftingtable');
}

function isNormalizedAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !value.includes('\0') &&
    isAbsolute(value) &&
    normalize(value) === value &&
    resolve(value) === value
  );
}

function equalOrWithin(candidate: string, parent: string): boolean {
  const delta = relative(parent, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function pathsOverlap(left: string, right: string): boolean {
  return equalOrWithin(left, right) || equalOrWithin(right, left);
}

/** A path as written, and with its links resolved as far as it exists (TS-H3). */
interface ComparedPath {
  readonly written: string;
  readonly resolved: string;
}

/** How many links one path may pass through, as the kernel allows (`MAXSYMLINKS`). */
const LINK_HOPS = 40;

/**
 * `path` with the links of its deepest existing part resolved, a dangling link followed to what
 * it names, and the rest as written. For the agents' root itself (`variable` named), a part that
 * cannot be resolved for any reason but its absence refuses the configuration rather than
 * passing a link unseen. For a path it is compared with, such a part counts as missing, so an
 * unreadable HOME or TMPDIR never stops the daemon starting.
 */
function comparedPath(path: string, variable?: string): ComparedPath {
  return { written: path, resolved: resolvedPath(path, variable, 0) };
}

function resolvedPath(path: string, variable: string | undefined, hops: number): string {
  const rest: string[] = [];
  for (let existing = path; ; existing = dirname(existing)) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const link = code === 'ENOENT' ? danglingLinkTarget(existing) : undefined;
      if (link !== undefined && hops < LINK_HOPS)
        // A relative target starts from the link's real directory, as the kernel's does.
        return resolvedPath(
          join(resolve(realDirectory(dirname(existing)), link), ...rest),
          variable,
          hops + 1,
        );
      const unresolvable =
        link !== undefined ? 'ELOOP' : code === 'ENOENT' || code === 'ENOTDIR' ? undefined : code;
      if (variable !== undefined && unresolvable !== undefined)
        throw new Error(`${variable} ${path} could not be resolved: ${unresolvable}`);
      if (dirname(existing) === existing) return path;
      rest.unshift(basename(existing));
    }
  }
}

/** A directory that exists (a link's own), through its links; as written if it cannot be read. */
function realDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** What a link names, if `path` is a link (one that resolves nowhere, as `realpath` found). */
function danglingLinkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** Equal or within, as written or through the links of what exists. */
function equalOrWithinCompared(candidate: ComparedPath, parent: ComparedPath): boolean {
  return (
    equalOrWithin(candidate.written, parent.written) ||
    equalOrWithin(candidate.resolved, parent.resolved)
  );
}

function overlapCompared(left: ComparedPath, right: ComparedPath): boolean {
  return equalOrWithinCompared(left, right) || equalOrWithinCompared(right, left);
}

/** The account's home in the user database, whatever HOME says, if it has an entry. */
function accountHome(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    // No passwd entry (a container's arbitrary user): nothing more to protect.
    return undefined;
  }
}

/**
 * Directories other files share, which an agents' temporary root may lie inside but never be
 * nor contain (TS-H3): the file system's root, the shared and runtime temporary directories,
 * the process's TMPDIR, HOME and the account's home.
 */
function sharedDirectories(env: NodeJS.ProcessEnv): string[] {
  const named = [env.HOME, accountHome(), env.XDG_RUNTIME_DIR, env.TMPDIR].filter(
    (path): path is string => path !== undefined && isAbsolute(path),
  );
  return [
    ...new Set([
      '/',
      '/tmp',
      '/var/tmp',
      '/dev/shm',
      '/run',
      ...named.map((path) => resolve(path)),
    ]),
  ];
}

function boundedInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isListenableHost(value: string): boolean {
  return (
    LOOPBACK_HOSTS.has(value) ||
    HOSTNAME_PATTERN.test(value) ||
    IPV4_PATTERN.test(value) ||
    (value.includes(':') && IPV6_PATTERN.test(value))
  );
}

function defaultWebDistDir(): string | undefined {
  // apps/server/src/config.ts (or dist/config.js) → apps/web/dist.
  const candidate = fileURLToPath(new URL('../../web/dist/', import.meta.url)).replace(/\/$/, '');
  return existsSync(join(candidate, 'index.html')) ? candidate : undefined;
}

function executionConfig(env: NodeJS.ProcessEnv, dataDir: string): ExecutionConfig {
  const gitExecutable = env.CRAFTINGTABLE_GIT_EXECUTABLE;
  const claudeExecutable = env.CRAFTINGTABLE_CLAUDE_EXECUTABLE;
  const codexExecutable = env.CRAFTINGTABLE_CODEX_EXECUTABLE;
  for (const [label, value] of [
    ['CRAFTINGTABLE_GIT_EXECUTABLE', gitExecutable],
    ['CRAFTINGTABLE_CLAUDE_EXECUTABLE', claudeExecutable],
    ['CRAFTINGTABLE_CODEX_EXECUTABLE', codexExecutable],
  ] as const) {
    if (value !== undefined && !isNormalizedAbsolutePath(value)) {
      throw new Error(`${label} must be a normalized absolute path`);
    }
  }
  const worktreeRoot = env.CRAFTINGTABLE_WORKTREE_ROOT ?? join(dataDir, 'worktrees');
  const runsRoot = env.CRAFTINGTABLE_RUNS_ROOT ?? join(dataDir, 'runs');
  for (const [label, value] of [
    ['CRAFTINGTABLE_WORKTREE_ROOT', worktreeRoot],
    ['CRAFTINGTABLE_RUNS_ROOT', runsRoot],
  ] as const) {
    if (!isNormalizedAbsolutePath(value)) {
      throw new Error(`${label} must be a normalized absolute path`);
    }
  }
  if (pathsOverlap(worktreeRoot, runsRoot)) {
    throw new Error('Worktree and runs roots must not overlap');
  }
  const checkLogRoot = join(dataDir, 'check-logs');
  if (pathsOverlap(checkLogRoot, runsRoot) || pathsOverlap(checkLogRoot, worktreeRoot)) {
    throw new Error('Check logs must lie outside the worktree and runs roots');
  }
  const cargoHome = join(dataDir, 'cargo-home');
  if (pathsOverlap(cargoHome, runsRoot) || pathsOverlap(cargoHome, worktreeRoot)) {
    throw new Error("The daemon's Cargo home must lie outside the worktree and runs roots");
  }
  // Short, for Claude Code's sandbox sockets; a long data directory names one elsewhere.
  const agentTemporaryRoot = env.CRAFTINGTABLE_AGENT_TMP_ROOT ?? join(dataDir, 't');
  if (!isNormalizedAbsolutePath(agentTemporaryRoot))
    throw new Error('CRAFTINGTABLE_AGENT_TMP_ROOT must be a normalized absolute path');
  // A start sweeps the run directories it holds (LIVE-31): it may share nothing it could
  // mistake for one, nor what it could reach through a mistake (TS-H3).
  const agentRoot = comparedPath(
    agentTemporaryRoot,
    env.CRAFTINGTABLE_AGENT_TMP_ROOT === undefined
      ? "The agents' default temporary root"
      : 'CRAFTINGTABLE_AGENT_TMP_ROOT',
  );
  for (const shared of sharedDirectories(env))
    if (equalOrWithinCompared(comparedPath(shared), agentRoot))
      throw new Error(
        `CRAFTINGTABLE_AGENT_TMP_ROOT must be a directory of its own, not ${shared} or a directory above it`,
      );
  const databaseDirectory = join(dataDir, DATABASE_DIRECTORY);
  if (overlapCompared(agentRoot, comparedPath(databaseDirectory)))
    throw new Error(
      `CRAFTINGTABLE_AGENT_TMP_ROOT must lie outside the database's directory ${databaseDirectory}`,
    );
  if (
    [
      runsRoot,
      worktreeRoot,
      checkLogRoot,
      cargoHome,
      join(dataDir, DATABASE_BACKUP_DIRECTORY),
    ].some((root) => overlapCompared(agentRoot, comparedPath(root)))
  )
    throw new Error("Agents' temporary directories must lie outside the daemon's other roots");
  const cargoSeedFrom =
    env.CRAFTINGTABLE_CARGO_SEED_FROM ??
    (env.CARGO_HOME || (env.HOME ? join(env.HOME, '.cargo') : ''));
  if (cargoSeedFrom !== '' && !isNormalizedAbsolutePath(cargoSeedFrom))
    throw new Error('CRAFTINGTABLE_CARGO_SEED_FROM must be a normalized absolute path');
  const agentEnvironmentAllow = (env.CRAFTINGTABLE_AGENT_ENV_ALLOW ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (agentEnvironmentAllow.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new Error('CRAFTINGTABLE_AGENT_ENV_ALLOW must list variable names, separated by commas');
  const checkConfinement = env.CRAFTINGTABLE_CHECK_CONFINEMENT ?? 'systemd';
  if (checkConfinement !== 'systemd' && checkConfinement !== 'none') {
    throw new Error('CRAFTINGTABLE_CHECK_CONFINEMENT must be systemd or none');
  }
  return Object.freeze({
    ...(gitExecutable === undefined ? {} : { gitExecutable }),
    ...(claudeExecutable === undefined ? {} : { claudeExecutable }),
    ...(codexExecutable === undefined ? {} : { codexExecutable }),
    ...(env.CRAFTINGTABLE_CODEX_MODELS === undefined
      ? {}
      : { codexModels: env.CRAFTINGTABLE_CODEX_MODELS }),
    worktreeRoot,
    runsRoot,
    checkConfinement,
    checkLogRoot,
    agentEnvironmentAllow,
    cargoHome,
    agentTemporaryRoot,
    ...(cargoSeedFrom === '' ? {} : { cargoSeedFrom }),
    ...(env.CRAFTINGTABLE_CLAUDE_MODELS === undefined
      ? {}
      : { claudeModels: env.CRAFTINGTABLE_CLAUDE_MODELS }),
    developmentCapacity: boundedInteger(
      env.CRAFTINGTABLE_DEVELOPMENT_CAPACITY,
      2,
      1,
      32,
      'CRAFTINGTABLE_DEVELOPMENT_CAPACITY',
    ),
    verificationCapacity: boundedInteger(
      env.CRAFTINGTABLE_VERIFICATION_CAPACITY,
      1,
      1,
      32,
      'CRAFTINGTABLE_VERIFICATION_CAPACITY',
    ),
    maxPatchBytes: boundedInteger(
      env.CRAFTINGTABLE_DIFF_LIMIT_BYTES,
      4 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024,
      'CRAFTINGTABLE_DIFF_LIMIT_BYTES',
    ),
  });
}

/**
 * Settings of the removed CT-04A1 repository inspector (R-B8). They no longer do anything;
 * startup names any that are still set, because `CRAFTINGTABLE_GIT_BIN` differs from the live
 * `CRAFTINGTABLE_GIT_EXECUTABLE` by one word and would otherwise be ignored silently.
 */
const RETIRED_SETTINGS = [
  'CRAFTINGTABLE_ARTIFACT_ROOT',
  'CRAFTINGTABLE_GIT_BIN',
  'CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS',
  'CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS',
  'CRAFTINGTABLE_GIT_SEARCH_PATH',
  'CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES',
  'CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES',
  'CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS',
  'CRAFTINGTABLE_GIT_TIMEOUT_MS',
  'CRAFTINGTABLE_MANAGED_WORKTREE_ROOT',
  'CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS',
  'CRAFTINGTABLE_REPOSITORY_ROOTS',
] as const;

/** The retired settings present in `env`, for a startup warning. */
export function retiredSettings(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return RETIRED_SETTINGS.filter((name) => env[name] !== undefined);
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.CRAFTINGTABLE_HOST ?? '127.0.0.1';
  if (!isListenableHost(host)) {
    throw new Error(`CRAFTINGTABLE_HOST must be a hostname or IP address; got "${host}"`);
  }
  const lanExposed = !LOOPBACK_HOSTS.has(host);

  const port = Number(env.CRAFTINGTABLE_PORT ?? 4600);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `CRAFTINGTABLE_PORT must be an integer between 1 and 65535; got "${env.CRAFTINGTABLE_PORT}"`,
    );
  }

  let publicOriginUrl: URL;
  try {
    publicOriginUrl = new URL(env.CRAFTINGTABLE_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173');
  } catch {
    throw new Error('CRAFTINGTABLE_PUBLIC_ORIGIN must be an HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(publicOriginUrl.protocol) ||
    publicOriginUrl.username !== '' ||
    publicOriginUrl.password !== '' ||
    publicOriginUrl.pathname !== '/' ||
    publicOriginUrl.search !== '' ||
    publicOriginUrl.hash !== ''
  ) {
    throw new Error('CRAFTINGTABLE_PUBLIC_ORIGIN must be an HTTP(S) origin');
  }
  const publicOrigin = publicOriginUrl.origin;

  const certPath = env.CRAFTINGTABLE_TLS_CERT;
  const keyPath = env.CRAFTINGTABLE_TLS_KEY;
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new Error('CRAFTINGTABLE_TLS_CERT and CRAFTINGTABLE_TLS_KEY must be set together');
  }
  const tls = certPath === undefined || keyPath === undefined ? undefined : { certPath, keyPath };
  if (tls !== undefined && (!isAbsolute(tls.certPath) || !isAbsolute(tls.keyPath))) {
    throw new Error('CRAFTINGTABLE_TLS_CERT and CRAFTINGTABLE_TLS_KEY must be absolute paths');
  }
  if (lanExposed && tls === undefined && publicOriginUrl.protocol !== 'https:') {
    throw new Error(
      'Listening on a non-loopback host requires TLS (CRAFTINGTABLE_TLS_CERT/KEY) or an HTTPS public origin served by a TLS proxy',
    );
  }

  // An empty value disables static serving even when a build exists.
  const webDistDir =
    env.CRAFTINGTABLE_WEB_DIST === ''
      ? undefined
      : (env.CRAFTINGTABLE_WEB_DIST ?? defaultWebDistDir());
  if (webDistDir !== undefined && !isAbsolute(webDistDir)) {
    throw new Error('CRAFTINGTABLE_WEB_DIST must be an absolute path');
  }

  const sessionLifetimeSeconds = Number(env.CRAFTINGTABLE_SESSION_LIFETIME_SECONDS ?? 2_592_000);
  if (
    !Number.isInteger(sessionLifetimeSeconds) ||
    sessionLifetimeSeconds < 300 ||
    sessionLifetimeSeconds > 7_776_000
  ) {
    throw new Error(
      'CRAFTINGTABLE_SESSION_LIFETIME_SECONDS must be an integer between 300 and 7776000',
    );
  }

  const configuredLogLevel = env.CRAFTINGTABLE_LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.has(configuredLogLevel as ServerConfig['logLevel'])) {
    throw new Error(`Invalid CRAFTINGTABLE_LOG_LEVEL "${configuredLogLevel}"`);
  }

  const drainTimeoutSeconds = Number(env.CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS ?? 180);
  if (
    !Number.isInteger(drainTimeoutSeconds) ||
    drainTimeoutSeconds < 0 ||
    drainTimeoutSeconds > 3600
  ) {
    throw new Error('CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS must be an integer between 0 and 3600');
  }

  const dataDir = dataDirectory(env);
  const execution = executionConfig(env, dataDir);
  return {
    host,
    port,
    dataDir,
    databasePath: join(dataDir, DATABASE_DIRECTORY, 'craftingtable.sqlite'),
    publicOrigin,
    secureCookies: publicOriginUrl.protocol === 'https:',
    lanExposed,
    ...(tls === undefined ? {} : { tls }),
    ...(webDistDir === undefined ? {} : { webDistDir }),
    sessionLifetimeSeconds,
    logLevel: configuredLogLevel as ServerConfig['logLevel'],
    execution,
    drainTimeoutMs: drainTimeoutSeconds * 1000,
  };
}
