import type { AgentLaunchRequest } from '../index.js';
import { launchOutsideSources, outsideSourceHosts } from '../outside-sources.js';

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
    filesystem: Object.fromEntries(
      [...(request.additionalDirectories ?? []), ...sources.flatMap((source) => source.caches)].map(
        (path) => [path, 'write'],
      ),
    ),
    network:
      hosts.length === 0
        ? { enabled: false }
        : { enabled: true, domains: Object.fromEntries(hosts.map((host) => [host, 'allow'])) },
  };
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
