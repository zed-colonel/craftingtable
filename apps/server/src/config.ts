import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RepositoryFeatureConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly allowedSourceRoots: readonly string[];
      readonly reservedDataRoot: string;
      readonly artifactRoot: string;
      readonly managedWorktreeRoot: string;
      readonly gitExecutable?: string;
      readonly executableSearchPath?: string;
      readonly commandTimeoutMs: number;
      readonly creationTimeoutMs: number;
      readonly inspectionTimeoutMs: number;
      readonly stdoutLimitBytes: number;
      readonly stderrLimitBytes: number;
      readonly terminationGraceMs: number;
      readonly retryDelayMs: number;
    };

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
  readonly repositoryFeature: RepositoryFeatureConfig;
  readonly execution: ExecutionConfig;
}

export const SERVER_VERSION = '0.3.0';
export const SESSION_COOKIE_NAME = 'craftingtable_session';
export const CSRF_HEADER_NAME = 'x-craftingtable-csrf';

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

const REPOSITORY_ENVIRONMENT_KEYS = [
  'CRAFTINGTABLE_REPOSITORY_ROOTS',
  'CRAFTINGTABLE_ARTIFACT_ROOT',
  'CRAFTINGTABLE_MANAGED_WORKTREE_ROOT',
  'CRAFTINGTABLE_GIT_BIN',
  'CRAFTINGTABLE_GIT_SEARCH_PATH',
  'CRAFTINGTABLE_GIT_TIMEOUT_MS',
  'CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS',
  'CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS',
  'CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES',
  'CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES',
  'CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS',
  'CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS',
] as const;

function dataDirectory(env: NodeJS.ProcessEnv): string {
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

function parsePathList(value: string, label: string, maximum = 32): readonly string[] {
  const entries = value.split(delimiter);
  if (
    entries.length === 0 ||
    entries.length > maximum ||
    entries.some((entry) => !isNormalizedAbsolutePath(entry)) ||
    new Set(entries).size !== entries.length
  ) {
    throw new Error(`${label} must be a unique list of normalized absolute paths`);
  }
  return Object.freeze([...entries]);
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

function repositoryFeatureConfig(env: NodeJS.ProcessEnv, dataDir: string): RepositoryFeatureConfig {
  if (REPOSITORY_ENVIRONMENT_KEYS.every((key) => env[key] === undefined)) {
    return Object.freeze({ enabled: false });
  }
  if (!isNormalizedAbsolutePath(dataDir)) {
    throw new Error(
      'CRAFTINGTABLE_DATA_DIR must be normalized and absolute when repository inspection is enabled',
    );
  }
  const rootsValue = env.CRAFTINGTABLE_REPOSITORY_ROOTS;
  if (rootsValue === undefined) {
    throw new Error(
      'CRAFTINGTABLE_REPOSITORY_ROOTS is required when repository inspection is enabled',
    );
  }
  const gitExecutable = env.CRAFTINGTABLE_GIT_BIN;
  const executableSearchPath = env.CRAFTINGTABLE_GIT_SEARCH_PATH;
  if (gitExecutable === undefined && executableSearchPath === undefined) {
    throw new Error(
      'CRAFTINGTABLE_GIT_BIN or CRAFTINGTABLE_GIT_SEARCH_PATH is required when repository inspection is enabled',
    );
  }

  const allowedSourceRoots = parsePathList(rootsValue, 'CRAFTINGTABLE_REPOSITORY_ROOTS');
  for (const [index, root] of allowedSourceRoots.entries()) {
    if (pathsOverlap(root, dataDir)) {
      throw new Error('CRAFTINGTABLE_REPOSITORY_ROOTS must not overlap CRAFTINGTABLE_DATA_DIR');
    }
    if (allowedSourceRoots.slice(index + 1).some((candidate) => pathsOverlap(root, candidate))) {
      throw new Error('CRAFTINGTABLE_REPOSITORY_ROOTS entries must not overlap');
    }
  }

  if (gitExecutable !== undefined && !isNormalizedAbsolutePath(gitExecutable)) {
    throw new Error('CRAFTINGTABLE_GIT_BIN must be a normalized absolute path');
  }
  if (executableSearchPath !== undefined) {
    parsePathList(executableSearchPath, 'CRAFTINGTABLE_GIT_SEARCH_PATH');
  }

  const artifactRoot = env.CRAFTINGTABLE_ARTIFACT_ROOT ?? join(dataDir, 'artifacts');
  const managedWorktreeRoot = env.CRAFTINGTABLE_MANAGED_WORKTREE_ROOT ?? join(dataDir, 'worktrees');
  for (const [label, value] of [
    ['CRAFTINGTABLE_ARTIFACT_ROOT', artifactRoot],
    ['CRAFTINGTABLE_MANAGED_WORKTREE_ROOT', managedWorktreeRoot],
  ] as const) {
    if (!isNormalizedAbsolutePath(value) || value === dataDir || !equalOrWithin(value, dataDir)) {
      throw new Error(`${label} must be a normalized strict descendant of CRAFTINGTABLE_DATA_DIR`);
    }
  }
  if (pathsOverlap(artifactRoot, managedWorktreeRoot)) {
    throw new Error('Repository artifact and managed-worktree roots must not overlap');
  }

  const commandTimeoutMs = boundedInteger(
    env.CRAFTINGTABLE_GIT_TIMEOUT_MS,
    5000,
    100,
    30000,
    'CRAFTINGTABLE_GIT_TIMEOUT_MS',
  );
  const creationTimeoutMs = boundedInteger(
    env.CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS,
    2 * commandTimeoutMs + 5000,
    1000,
    90000,
    'CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS',
  );
  const inspectionTimeoutMs = boundedInteger(
    env.CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS,
    2 * commandTimeoutMs + 5000,
    1000,
    90000,
    'CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS',
  );
  if (creationTimeoutMs < commandTimeoutMs) {
    throw new Error('CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS must be at least the command timeout');
  }
  if (inspectionTimeoutMs < 2 * commandTimeoutMs) {
    throw new Error(
      'CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS must be at least twice the command timeout',
    );
  }

  return Object.freeze({
    enabled: true,
    allowedSourceRoots,
    reservedDataRoot: dataDir,
    artifactRoot,
    managedWorktreeRoot,
    ...(gitExecutable === undefined ? {} : { gitExecutable }),
    ...(executableSearchPath === undefined ? {} : { executableSearchPath }),
    commandTimeoutMs,
    creationTimeoutMs,
    inspectionTimeoutMs,
    stdoutLimitBytes: boundedInteger(
      env.CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES,
      65536,
      16384,
      1048576,
      'CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES',
    ),
    stderrLimitBytes: boundedInteger(
      env.CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES,
      65536,
      1024,
      1048576,
      'CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES',
    ),
    terminationGraceMs: boundedInteger(
      env.CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS,
      250,
      50,
      2000,
      'CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS',
    ),
    retryDelayMs: boundedInteger(
      env.CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS,
      5000,
      100,
      60000,
      'CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS',
    ),
  });
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
  return Object.freeze({
    ...(gitExecutable === undefined ? {} : { gitExecutable }),
    ...(claudeExecutable === undefined ? {} : { claudeExecutable }),
    ...(codexExecutable === undefined ? {} : { codexExecutable }),
    ...(env.CRAFTINGTABLE_CODEX_MODELS === undefined
      ? {}
      : { codexModels: env.CRAFTINGTABLE_CODEX_MODELS }),
    worktreeRoot,
    runsRoot,
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

  const dataDir = dataDirectory(env);
  const repositoryFeature = repositoryFeatureConfig(env, dataDir);
  const execution = executionConfig(env, dataDir);
  return {
    host,
    port,
    dataDir,
    databasePath: join(dataDir, 'state', 'craftingtable.sqlite'),
    publicOrigin,
    secureCookies: publicOriginUrl.protocol === 'https:',
    lanExposed,
    ...(tls === undefined ? {} : { tls }),
    ...(webDistDir === undefined ? {} : { webDistDir }),
    sessionLifetimeSeconds,
    logLevel: configuredLogLevel as ServerConfig['logLevel'],
    repositoryFeature,
    execution,
  };
}
