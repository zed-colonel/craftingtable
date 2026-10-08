import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentLaunchRequest } from '../index.js';
import { launchOutsideSources, outsideSourceHosts } from '../outside-sources.js';
import { CLAUDE_CREDENTIALS_FILE, sandboxDeniedReads } from '../sandbox-reads.js';

/**
 * The permission profile a sandboxed Codex run's commands get (R-G14), defined for the run in
 * its thread's configuration and selected by this id on the thread and on every turn.
 */
export const CODEX_PERMISSION_PROFILE = 'craftingtable';

/** Whether the run's commands are sandboxed: every posture but unrestricted, and read-only. */
export function codexSandboxed(request: AgentLaunchRequest): boolean {
  return !request.readOnly && request.permissionMode !== 'unrestricted';
}

/**
 * The run's permission profile (R-G14; the route the step-1 experiment found). Commands may write
 * the worktree and the temporary directories (`:workspace`, as the legacy workspace-write
 * sandbox), the run's directories and the outside sources' caches. They reach no network but the
 * sources' exact hosts, through Codex's own proxy, which refuses any other host and cuts a direct
 * connection. With no source, the network stays off.
 */
function codexPermissionProfile(request: AgentLaunchRequest): Record<string, unknown> {
  const sources = launchOutsideSources(request);
  const hosts = outsideSourceHosts(sources);
  return {
    extends: ':workspace',
    filesystem: Object.fromEntries([
      ...[
        ...(request.additionalDirectories ?? []),
        ...sources.flatMap((source) => source.caches),
      ].map((path) => [path, 'write']),
      ...codexGitAccess(request),
      ...codexDeniedReads(request).map((path) => [path, 'deny']),
    ]),
    network:
      hosts.length === 0
        ? { enabled: false }
        : { enabled: true, domains: Object.fromEntries(hosts.map((host) => [host, 'allow'])) },
  };
}

/**
 * What a sandboxed run's commands may do with the worktree's Git directories (R-G14, operator
 * decision 2026-10-08): write them, so they can stage and commit, as Claude Code's sandbox
 * allows. Codex keeps the worktree's own Git directory read-only unless it is named itself. The
 * common directory's `config`, `hooks` and `info` stay read-only: the daemon's own Git reads its
 * settings and hook programs there, and `info/attributes` could pick another built-in merge
 * driver (`union`, say) for the daemon's merges.
 */
function codexGitAccess(request: AgentLaunchRequest): [string, string][] {
  const git = request.gitDirectories;
  if (git === undefined) return [];
  return [
    [git.gitCommonDirectory, 'write'],
    [git.gitDirectory, 'write'],
    ...['config', 'hooks', 'info'].map((name): [string, string] => [
      join(git.gitCommonDirectory, name),
      'read',
    ]),
  ];
}

/** The path a link names, for a path that exists; the path itself otherwise. */
function throughLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * What a sandboxed run's commands may not read (R-G14, operator decision 2026-10-08): the list
 * Claude's sandbox denies (`sandboxDeniedReads`), in the form Codex 0.160.0 can apply. It masks
 * any number of directories and paths that do not exist, but more than one existing file makes
 * every command fail, so the whole of `~/.claude` is denied in place of its credentials file, and
 * each path is taken through its links and listed once (the Docker socket has two names).
 */
export function codexDeniedReads(
  request: AgentLaunchRequest,
  resolve: (path: string) => string = throughLinks,
): string[] {
  const home = homedir();
  return [
    ...new Set(
      sandboxDeniedReads(request)
        .map((path) => (path === CLAUDE_CREDENTIALS_FILE ? '~/.claude' : path))
        .map((path) => (path.startsWith('~/') ? join(home, path.slice(2)) : path))
        .map(resolve),
    ),
  ];
}

/**
 * Of the given denied reads, those Codex would have to mask as files: they exist and are not
 * directories (a link that names nothing counts, as it cannot be looked through). Returned only
 * when there is more than one, which makes every command of the run fail in Codex 0.160.0, so
 * the backend refuses such a launch (R-G14); undefined when the profile can mask them.
 */
export function unmaskableDeniedFiles(paths: readonly string[]): string[] | undefined {
  const files = paths.filter((path) => {
    try {
      lstatSync(path);
    } catch {
      return false;
    }
    try {
      return !statSync(path).isDirectory();
    } catch {
      return true;
    }
  });
  return files.length > 1 ? files : undefined;
}

/** For a sandboxed run, the denied reads its profile could not mask; undefined otherwise. */
export function codexUnmaskableFiles(request: AgentLaunchRequest): string[] | undefined {
  return codexSandboxed(request) ? unmaskableDeniedFiles(codexDeniedReads(request)) : undefined;
}

/** The outside sources' caches a sandboxed run may write, which the backend creates first. */
export function codexSourceCaches(request: AgentLaunchRequest): string[] {
  return codexSandboxed(request)
    ? launchOutsideSources(request).flatMap((source) => source.caches)
    : [];
}

/** Permission overrides are explicit on both new and resumed threads. */
export function codexThreadParams(request: AgentLaunchRequest): Record<string, unknown> {
  const sandboxed = codexSandboxed(request);
  const profile = sandboxed ? codexPermissionProfile(request) : undefined;
  return {
    cwd: request.cwd,
    ...CODEX_APPROVAL,
    ...(profile
      ? { permissions: CODEX_PERMISSION_PROFILE }
      : { sandbox: request.readOnly ? 'read-only' : 'danger-full-access' }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.appendSystemPrompt === undefined
      ? {}
      : { developerInstructions: request.appendSystemPrompt }),
    config: {
      ...(request.reasoningEffort ? { model_reasoning_effort: request.reasoningEffort } : {}),
      ...(profile
        ? {
            // Codex applies a host list only through its proxy, which this turns on.
            ...((profile.network as { enabled: boolean }).enabled
              ? { 'features.network_proxy': true }
              : {}),
            [`permissions.${CODEX_PERMISSION_PROFILE}`]: profile,
          }
        : {
            'sandbox_workspace_write.writable_roots': request.additionalDirectories ?? [],
            'sandbox_workspace_write.network_access': false,
          }),
    },
  };
}

/**
 * No command may ask to leave the sandbox, on any posture (operator decision 2026-10-07, R-G14):
 * an approved escalation would run fully unsandboxed, and Codex's own reviewer approved one on a
 * claim of authorization nothing can check. Leaving the sandbox is only ever `unrestricted`.
 */
const CODEX_APPROVAL = { approvalPolicy: 'never', approvalsReviewer: 'user' } as const;

export function codexTurnParams(request: AgentLaunchRequest): Record<string, unknown> {
  return {
    ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
    cwd: request.cwd,
    ...CODEX_APPROVAL,
    ...(codexSandboxed(request)
      ? { permissions: CODEX_PERMISSION_PROFILE }
      : {
          sandboxPolicy: request.readOnly ? { type: 'readOnly' } : { type: 'dangerFullAccess' },
        }),
    ...(request.model === undefined ? {} : { model: request.model }),
  };
}
