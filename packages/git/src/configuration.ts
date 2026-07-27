import { lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, normalize, resolve } from 'node:path';
import { createBoundedCommandRunner, readExecutableEvidence } from './command-runner.js';
import type { CommandRunnerOptions, GitExecutableEvidence } from './command-runner.js';
import { createRootPolicy, NODE_FILE_SYSTEM_BOUNDARY } from './path-policy.js';
import type { FileSystemBoundary, RootPolicy } from './path-policy.js';
import { createInspectionError } from './types.js';
import type { RepositoryInspectionError, RepositoryInspectorOptions } from './types.js';

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface ResolvedInspectorConfiguration {
  readonly rootPolicy: RootPolicy;
  readonly executable: GitExecutableEvidence;
  readonly gitVersion: GitVersion;
  readonly runnerOptions: CommandRunnerOptions;
  readonly inspectionTimeoutMs: number;
  readonly effectiveUid: number;
  readonly fs: FileSystemBoundary;
}

export interface ConfigurationDependencies {
  readonly platform: NodeJS.Platform;
  readonly effectiveUid: number | undefined;
  readonly ambientPath: string | undefined;
  readonly fs: FileSystemBoundary;
}

export const DEFAULT_CONFIGURATION_DEPENDENCIES: ConfigurationDependencies = {
  platform: process.platform,
  effectiveUid: process.geteuid?.(),
  ambientPath: process.env.PATH,
  fs: NODE_FILE_SYSTEM_BOUNDARY,
};

export type ConfigurationResult =
  | { readonly ok: true; readonly configuration: ResolvedInspectorConfiguration }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

const OPTION_KEYS = new Set([
  'allowedSourceRoots',
  'reservedRoots',
  'gitExecutable',
  'executableSearchPath',
  'commandTimeoutMs',
  'inspectionTimeoutMs',
  'stdoutLimitBytes',
  'stderrLimitBytes',
  'terminationGraceMs',
]);

function isBoundedInteger(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number | undefined {
  const candidate = value ?? defaultValue;
  return Number.isInteger(candidate) &&
    typeof candidate === 'number' &&
    candidate >= minimum &&
    candidate <= maximum
    ? candidate
    : undefined;
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

async function executableCandidate(
  candidate: string,
  allowSymlink: boolean,
): Promise<GitExecutableEvidence | undefined> {
  if (!isNormalizedAbsolutePath(candidate)) {
    return undefined;
  }
  try {
    const metadata = await lstat(candidate, { bigint: true });
    if (metadata.isSymbolicLink() && !allowSymlink) {
      return undefined;
    }
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      return undefined;
    }
    const canonical = await realpath(candidate);
    return await readExecutableEvidence(canonical);
  } catch {
    return undefined;
  }
}

async function resolveExecutable(
  options: RepositoryInspectorOptions,
  dependencies: ConfigurationDependencies,
): Promise<
  | { readonly ok: true; readonly executable: GitExecutableEvidence }
  | { readonly ok: false; readonly error: RepositoryInspectionError }
> {
  if (options.gitExecutable !== undefined) {
    if (typeof options.gitExecutable !== 'string') {
      return {
        ok: false,
        error: createInspectionError('git-not-executable', 'create-inspector'),
      };
    }
    const executable = await executableCandidate(options.gitExecutable, false);
    if (executable === undefined) {
      return {
        ok: false,
        error: createInspectionError('git-not-executable', 'create-inspector'),
      };
    }
    return { ok: true, executable };
  }

  const searchPath =
    options.executableSearchPath === undefined
      ? dependencies.ambientPath
      : options.executableSearchPath;
  if (searchPath !== undefined && typeof searchPath !== 'string') {
    return {
      ok: false,
      error: createInspectionError('invalid-options', 'create-inspector'),
    };
  }
  for (const entry of searchPath?.split(delimiter) ?? []) {
    if (!isNormalizedAbsolutePath(entry)) {
      continue;
    }
    const executable = await executableCandidate(join(entry, 'git'), true);
    if (executable !== undefined) {
      return { ok: true, executable };
    }
  }
  return {
    ok: false,
    error: createInspectionError('git-not-found', 'create-inspector'),
  };
}

export function parseGitVersion(stdout: Buffer): GitVersion | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch {
    return undefined;
  }
  const match = /^git version ([0-9]{1,9})\.([0-9]{1,9})(?:\.([0-9]{1,9}))?(?=$|[\s.])/.exec(text);
  if (match === null) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }
  return { major, minor, patch };
}

function meetsMinimumGitVersion(version: GitVersion): boolean {
  return version.major > 2 || (version.major === 2 && version.minor >= 32);
}

function validateOptionShape(value: unknown): value is RepositoryInspectorOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).some((key) => !OPTION_KEYS.has(key))) {
    return false;
  }
  const candidate = value as Partial<RepositoryInspectorOptions>;
  return (
    Array.isArray(candidate.allowedSourceRoots) &&
    candidate.allowedSourceRoots.every((root) => typeof root === 'string') &&
    (candidate.reservedRoots === undefined ||
      (Array.isArray(candidate.reservedRoots) &&
        candidate.reservedRoots.every((root) => typeof root === 'string')))
  );
}

export async function resolveInspectorConfiguration(
  value: RepositoryInspectorOptions,
  dependencies: ConfigurationDependencies = DEFAULT_CONFIGURATION_DEPENDENCIES,
): Promise<ConfigurationResult> {
  if (!validateOptionShape(value)) {
    return {
      ok: false,
      error: createInspectionError('invalid-options', 'create-inspector'),
    };
  }
  if (!['darwin', 'linux', 'freebsd', 'openbsd', 'netbsd', 'aix'].includes(dependencies.platform)) {
    return {
      ok: false,
      error: createInspectionError('unsupported-platform', 'create-inspector'),
    };
  }
  if (dependencies.effectiveUid === undefined) {
    return {
      ok: false,
      error: createInspectionError('unsupported-platform', 'create-inspector'),
    };
  }
  if (dependencies.effectiveUid === 0) {
    return {
      ok: false,
      error: createInspectionError('root-daemon-refused', 'create-inspector'),
    };
  }

  const commandTimeoutMs = isBoundedInteger(value.commandTimeoutMs, 5000, 100, 30000);
  const stdoutLimitBytes = isBoundedInteger(value.stdoutLimitBytes, 65536, 16384, 1048576);
  const stderrLimitBytes = isBoundedInteger(value.stderrLimitBytes, 65536, 1024, 1048576);
  const terminationGraceMs = isBoundedInteger(value.terminationGraceMs, 250, 50, 2000);
  if (
    commandTimeoutMs === undefined ||
    stdoutLimitBytes === undefined ||
    stderrLimitBytes === undefined ||
    terminationGraceMs === undefined
  ) {
    return {
      ok: false,
      error: createInspectionError('invalid-options', 'create-inspector'),
    };
  }
  const inspectionTimeoutMs = isBoundedInteger(
    value.inspectionTimeoutMs,
    2 * commandTimeoutMs + 5000,
    1000,
    90000,
  );
  if (inspectionTimeoutMs === undefined || inspectionTimeoutMs < 2 * commandTimeoutMs) {
    return {
      ok: false,
      error: createInspectionError('invalid-options', 'create-inspector'),
    };
  }

  const rootPolicy = await createRootPolicy(
    value.allowedSourceRoots,
    value.reservedRoots ?? [],
    dependencies.fs,
  );
  if (!rootPolicy.ok) {
    return rootPolicy;
  }

  const executable = await resolveExecutable(value, dependencies);
  if (!executable.ok) {
    return executable;
  }

  const runnerOptions = {
    commandTimeoutMs,
    stdoutLimitBytes,
    stderrLimitBytes,
    terminationGraceMs,
  };
  const runner = createBoundedCommandRunner(executable.executable, runnerOptions);
  const versionResult = await runner.run(
    { kind: 'version', cwd: rootPolicy.policy.allowedSourceRoots[0] as string },
    undefined,
    'create-inspector',
  );
  if (!versionResult.ok) {
    return versionResult;
  }
  if (versionResult.outcome.exitCode !== 0) {
    return {
      ok: false,
      error: createInspectionError('git-command-failed', 'create-inspector', {
        commandKind: 'version',
        exitCode: versionResult.outcome.exitCode,
      }),
    };
  }
  const gitVersion = parseGitVersion(versionResult.outcome.stdout);
  if (gitVersion === undefined) {
    return {
      ok: false,
      error: createInspectionError('malformed-version-output', 'create-inspector'),
    };
  }
  if (!meetsMinimumGitVersion(gitVersion)) {
    return {
      ok: false,
      error: createInspectionError('unsupported-git-version', 'create-inspector', {
        gitMajor: gitVersion.major,
        gitMinor: gitVersion.minor,
        gitPatch: gitVersion.patch,
      }),
    };
  }

  return {
    ok: true,
    configuration: {
      rootPolicy: rootPolicy.policy,
      executable: executable.executable,
      gitVersion,
      runnerOptions,
      inspectionTimeoutMs,
      effectiveUid: dependencies.effectiveUid,
      fs: dependencies.fs,
    },
  };
}
