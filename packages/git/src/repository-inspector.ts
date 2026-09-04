import { join } from 'node:path';
import { createBoundedCommandRunner } from './command-runner.js';
import { INSPECTION_TIMEOUT_REASON } from './command-runner.js';
import {
  DEFAULT_CONFIGURATION_DEPENDENCIES,
  resolveInspectorConfiguration,
} from './configuration.js';
import type { ConfigurationDependencies } from './configuration.js';
import { createParsedObservation } from './comparison.js';
import type { FixedGitProcessOutcome } from './command-runner.js';
import { admitRepositoryPath, verifyPathSnapshots } from './path-policy.js';
import {
  REPOSITORY_INSPECTION_POLICY_VERSION,
  REPOSITORY_OBSERVATION_VERSION,
  REPOSITORY_RISK_SCAN_PATTERN,
  REPOSITORY_RISK_SCAN_SCOPE_VERSION,
  createInspectionError,
} from './types.js';
import type {
  RepositoryInspectionError,
  RepositoryInspectionResult,
  RepositoryInspector,
  RepositoryInspectorCreationResult,
  RepositoryInspectorOptions,
  RepositoryRiskSignal,
} from './types.js';

export interface RepositoryInspectorDependencies extends ConfigurationDependencies {
  readonly now: () => Date;
}

const DEFAULT_INSPECTOR_DEPENDENCIES: RepositoryInspectorDependencies = {
  ...DEFAULT_CONFIGURATION_DEPENDENCIES,
  now: () => new Date(),
};

type IdentityParseResult =
  | { readonly ok: true; readonly objectFormat: 'sha1' | 'sha256' }
  | { readonly ok: false; readonly error: RepositoryInspectionError };

function decodeUtf8(value: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function peelTrailingLines(
  value: Buffer,
  count: number,
): { readonly prefix: Buffer; readonly lines: readonly Buffer[] } | undefined {
  if (value.length === 0 || value[value.length - 1] !== 0x0a) {
    return undefined;
  }
  const lines: Buffer[] = [];
  let end = value.length - 1;
  for (let index = 0; index < count; index += 1) {
    const separator = value.lastIndexOf(0x0a, end - 1);
    if (separator < 0) {
      return undefined;
    }
    lines.unshift(value.subarray(separator + 1, end));
    end = separator;
  }
  return { prefix: value.subarray(0, end + 1), lines };
}

function hasThreeTerminatedPathFields(prefix: Buffer): boolean {
  if (prefix.length === 0 || prefix[prefix.length - 1] !== 0x0a) {
    return false;
  }
  let newlines = 0;
  for (const byte of prefix) {
    if (byte === 0x0a) {
      newlines += 1;
    }
  }
  return newlines >= 3;
}

function identityPrefix(topLevel: string, gitDirectory: string): Buffer {
  return Buffer.from(`${topLevel}\n${gitDirectory}\n${gitDirectory}\n`, 'utf8');
}

export function parseIdentityOutcome(
  outcome: FixedGitProcessOutcome,
  expectedTopLevel: string,
  expectedGitDirectory: string,
  ancestorCandidates: readonly string[],
): IdentityParseResult {
  if (outcome.exitCode !== 0) {
    const stderr = decodeUtf8(outcome.stderr);
    if (stderr === undefined) {
      return {
        ok: false,
        error: createInspectionError('invalid-output-encoding', 'inspect-path'),
      };
    }
    if (stderr.includes('detected dubious ownership')) {
      return {
        ok: false,
        error: createInspectionError('ownership-refused', 'inspect-path'),
      };
    }
    if (stderr.includes('must be run in a work tree')) {
      return {
        ok: false,
        error: createInspectionError('not-primary-repository', 'inspect-path'),
      };
    }
    if (
      /unknown repository extension|unsupported repository extension|unknown repository format extension/i.test(
        stderr,
      )
    ) {
      return {
        ok: false,
        error: createInspectionError('unsupported-repository-extension', 'inspect-path'),
      };
    }
    if (stderr.includes('not a git repository')) {
      return {
        ok: false,
        error: createInspectionError(
          ancestorCandidates.length > 0 ? 'not-primary-repository' : 'not-git-repository',
          'inspect-path',
        ),
      };
    }
    return {
      ok: false,
      error: createInspectionError('git-command-failed', 'inspect-path', {
        commandKind: outcome.commandKind,
        exitCode: outcome.exitCode,
      }),
    };
  }
  if (outcome.stderr.length !== 0) {
    return {
      ok: false,
      error: createInspectionError('malformed-identity-output', 'inspect-path'),
    };
  }

  const expectedPrefix = identityPrefix(expectedTopLevel, expectedGitDirectory);
  for (const objectFormat of ['sha1', 'sha256'] as const) {
    const expected = Buffer.concat([
      expectedPrefix,
      Buffer.from(`false\ntrue\n${objectFormat}\n`, 'ascii'),
    ]);
    if (outcome.stdout.equals(expected)) {
      return { ok: true, objectFormat };
    }
  }

  const framed = peelTrailingLines(outcome.stdout, 3);
  if (framed === undefined) {
    return {
      ok: false,
      error: createInspectionError('malformed-identity-output', 'inspect-path'),
    };
  }
  const tail = framed.lines.map((line) => decodeUtf8(line));
  if (tail.some((line) => line === undefined)) {
    return {
      ok: false,
      error: createInspectionError('invalid-output-encoding', 'inspect-path'),
    };
  }
  const [bare, insideWorkTree, objectFormat] = tail as [string, string, string];
  const candidatePrefixes = [
    expectedPrefix,
    ...ancestorCandidates.map((candidate) => identityPrefix(candidate, join(candidate, '.git'))),
  ];
  const knownPrefix = candidatePrefixes.some((candidate) => framed.prefix.equals(candidate));
  const structurallyFramed = knownPrefix || hasThreeTerminatedPathFields(framed.prefix);
  if (
    !structurallyFramed ||
    !['true', 'false'].includes(bare) ||
    !['true', 'false'].includes(insideWorkTree)
  ) {
    return {
      ok: false,
      error: createInspectionError('malformed-identity-output', 'inspect-path'),
    };
  }
  if (bare === 'true' || insideWorkTree === 'false') {
    return {
      ok: false,
      error: createInspectionError('not-primary-repository', 'inspect-path'),
    };
  }
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    return {
      ok: false,
      error: createInspectionError('unsupported-object-format', 'inspect-path'),
    };
  }
  return {
    ok: false,
    error: createInspectionError('not-primary-repository', 'inspect-path'),
  };
}

function signalForConfigKey(key: string): RepositoryRiskSignal | undefined {
  if (key === 'extensions.worktreeconfig') {
    return 'worktree-config-enabled';
  }
  if (key === 'core.hookspath') {
    return 'core-hooks-path';
  }
  if (key === 'core.fsmonitor') {
    return 'core-fsmonitor';
  }
  if (key === 'core.worktree') {
    return 'core-worktree-redirection';
  }
  if (key === 'diff.external') {
    return 'diff-external';
  }
  if (/^diff\..+\.command$/.test(key)) {
    return 'diff-driver-command';
  }
  if (/^diff\..+\.textconv$/.test(key)) {
    return 'diff-driver-textconv';
  }
  if (/^filter\..+\.clean$/.test(key)) {
    return 'filter-clean';
  }
  if (/^filter\..+\.smudge$/.test(key)) {
    return 'filter-smudge';
  }
  if (/^filter\..+\.process$/.test(key)) {
    return 'filter-process';
  }
  if (key === 'include.path') {
    return 'config-include';
  }
  if (/^includeif\..+\.path$/.test(key)) {
    return 'conditional-config-include';
  }
  return undefined;
}

export function parseRiskSignalOutcome(outcome: FixedGitProcessOutcome):
  | { readonly ok: true; readonly signals: readonly RepositoryRiskSignal[] }
  | {
      readonly ok: false;
      readonly error: RepositoryInspectionError;
    } {
  if (outcome.exitCode === 1 && outcome.stdout.length === 0 && outcome.stderr.length === 0) {
    return { ok: true, signals: [] };
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      error: createInspectionError(
        outcome.exitCode === 1 ? 'malformed-feature-output' : 'git-command-failed',
        'inspect-path',
        { commandKind: outcome.commandKind, exitCode: outcome.exitCode },
      ),
    };
  }
  if (outcome.stderr.length !== 0) {
    return {
      ok: false,
      error: createInspectionError('malformed-feature-output', 'inspect-path'),
    };
  }
  if (outcome.stdout.length === 0) {
    return { ok: true, signals: [] };
  }
  if (outcome.stdout[outcome.stdout.length - 1] !== 0) {
    return {
      ok: false,
      error: createInspectionError('malformed-feature-output', 'inspect-path'),
    };
  }
  const decoded = decodeUtf8(outcome.stdout);
  if (decoded === undefined) {
    return {
      ok: false,
      error: createInspectionError('invalid-output-encoding', 'inspect-path'),
    };
  }
  const keys = decoded.split('\0');
  keys.pop();
  if (keys.length > 256) {
    return {
      ok: false,
      error: createInspectionError('feature-count-exceeded', 'inspect-path'),
    };
  }
  const signals = new Set<RepositoryRiskSignal>();
  for (const key of keys) {
    if (key.length === 0) {
      return {
        ok: false,
        error: createInspectionError('malformed-feature-output', 'inspect-path'),
      };
    }
    const signal = signalForConfigKey(key);
    if (signal === undefined) {
      return {
        ok: false,
        error: createInspectionError('malformed-feature-output', 'inspect-path'),
      };
    }
    signals.add(signal);
  }
  return { ok: true, signals: [...signals].sort() };
}

function checkpointFor(signal: AbortSignal): () => RepositoryInspectionError | undefined {
  return () => {
    if (!signal.aborted) {
      return undefined;
    }
    return createInspectionError(
      signal.reason === INSPECTION_TIMEOUT_REASON ? 'timed-out' : 'aborted',
      'inspect-path',
    );
  };
}

export async function createRepositoryInspectorWithDependencies(
  options: RepositoryInspectorOptions,
  dependencies: RepositoryInspectorDependencies,
): Promise<RepositoryInspectorCreationResult> {
  const resolved = await resolveInspectorConfiguration(options, dependencies);
  if (!resolved.ok) {
    return resolved;
  }
  const configuration = resolved.configuration;
  const runner = createBoundedCommandRunner(configuration.executable, configuration.runnerOptions);

  const inspector: RepositoryInspector = {
    async inspect(request): Promise<RepositoryInspectionResult> {
      if (request.signal?.aborted) {
        return {
          ok: false,
          error: createInspectionError('aborted', 'inspect-path'),
        };
      }
      const controller = new AbortController();
      const onCallerAbort = (): void => {
        controller.abort(request.signal?.reason);
      };
      request.signal?.addEventListener('abort', onCallerAbort, { once: true });
      const inspectionTimer = setTimeout(() => {
        controller.abort(INSPECTION_TIMEOUT_REASON);
      }, configuration.inspectionTimeoutMs);
      inspectionTimer.unref();
      const checkpoint = checkpointFor(controller.signal);

      try {
        const admittedResult = await admitRepositoryPath(
          request.requestedPath,
          configuration.rootPolicy,
          configuration.effectiveUid,
          checkpoint,
          configuration.fs,
        );
        if (!admittedResult.ok) {
          return admittedResult;
        }
        const admitted = admittedResult.admitted;

        const identityResult = await runner.run(
          {
            kind: 'identity',
            cwd: admitted.canonicalTopLevel,
            ceilingDirectory: admitted.ceilingDirectory,
            expectedTopLevel: admitted.canonicalTopLevel,
            expectedGitDirectory: admitted.canonicalGitDirectory,
            ancestorCandidates: admitted.ancestorCandidates,
          },
          controller.signal,
        );
        if (!identityResult.ok) {
          return identityResult;
        }
        const identity = parseIdentityOutcome(
          identityResult.outcome,
          admitted.canonicalTopLevel,
          admitted.canonicalGitDirectory,
          admitted.ancestorCandidates,
        );
        if (!identity.ok) {
          return identity;
        }

        const riskResult = await runner.run(
          {
            kind: 'local-risk-signal-names',
            cwd: admitted.canonicalTopLevel,
            ceilingDirectory: admitted.ceilingDirectory,
          },
          controller.signal,
        );
        if (!riskResult.ok) {
          return riskResult;
        }
        const parsedRisk = parseRiskSignalOutcome(riskResult.outcome);
        if (!parsedRisk.ok) {
          return parsedRisk;
        }

        const signals = new Set<RepositoryRiskSignal>(parsedRisk.signals);
        const hooksPath = join(admitted.canonicalGitDirectory, 'hooks');
        if (admitted.hooksDirectorySymlink) {
          signals.add('hooks-directory-symlink');
        } else {
          try {
            const entries = await configuration.fs.readdir(hooksPath);
            if (entries.some((entry) => !entry.name.endsWith('.sample'))) {
              signals.add('hook-entry');
            }
          } catch {
            const hooksWasAbsent = admitted.snapshots.every((entry) => entry.path !== hooksPath);
            if (!hooksWasAbsent) {
              return {
                ok: false,
                error: createInspectionError('repository-metadata-unreadable', 'inspect-path'),
              };
            }
          }
        }

        const checkpointError = checkpoint();
        if (checkpointError !== undefined) {
          return { ok: false, error: checkpointError };
        }
        if (!(await verifyPathSnapshots(admitted.snapshots, configuration.fs))) {
          return {
            ok: false,
            error: createInspectionError('observation-raced', 'inspect-path'),
          };
        }
        const finalCheckpointError = checkpoint();
        if (finalCheckpointError !== undefined) {
          return { ok: false, error: finalCheckpointError };
        }

        const topSnapshot = admitted.snapshots.find(
          (entry) => entry.path === admitted.canonicalTopLevel,
        );
        const commonSnapshot = admitted.snapshots.find(
          (entry) => entry.path === admitted.canonicalGitDirectory,
        );
        if (topSnapshot === undefined || commonSnapshot === undefined) {
          return {
            ok: false,
            error: createInspectionError('observation-raced', 'inspect-path'),
          };
        }
        const sortedSignals = [...signals].sort();
        return {
          ok: true,
          observation: createParsedObservation({
            observationVersion: REPOSITORY_OBSERVATION_VERSION,
            inspectionPolicyVersion: REPOSITORY_INSPECTION_POLICY_VERSION,
            observedAt: dependencies.now().toISOString(),
            gitVersion: configuration.gitVersion,
            canonicalTopLevel: admitted.canonicalTopLevel,
            canonicalGitDirectory: admitted.canonicalGitDirectory,
            canonicalCommonGitDirectory: admitted.canonicalGitDirectory,
            objectFormat: identity.objectFormat,
            coreIdentity: {
              topLevelInode: topSnapshot.inode,
              commonDirectoryInode: commonSnapshot.inode,
            },
            environmentalEvidence: {
              topLevelDevice: topSnapshot.device,
              commonDirectoryDevice: commonSnapshot.device,
            },
            riskScan: {
              scanScopeVersion: REPOSITORY_RISK_SCAN_SCOPE_VERSION,
              scannedKeyPattern: REPOSITORY_RISK_SCAN_PATTERN,
              classification:
                sortedSignals.length === 0 ? 'no-signals-in-scanned-set' : 'signals-observed',
              signals: sortedSignals,
            },
          }),
        };
      } finally {
        clearTimeout(inspectionTimer);
        request.signal?.removeEventListener('abort', onCallerAbort);
      }
    },
  };

  return { ok: true, inspector };
}

export async function createRepositoryInspector(
  options: RepositoryInspectorOptions,
): Promise<RepositoryInspectorCreationResult> {
  return await createRepositoryInspectorWithDependencies(options, DEFAULT_INSPECTOR_DEPENDENCIES);
}
