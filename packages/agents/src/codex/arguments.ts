import type { AgentLaunchRequest } from '../index.js';

/** Permission overrides are explicit on both new and resumed threads. */
export function codexThreadParams(request: AgentLaunchRequest): Record<string, unknown> {
  return {
    cwd: request.cwd,
    ...codexApprovalParams(request),
    sandbox: request.permissionMode === 'unrestricted' ? 'danger-full-access' : 'workspace-write',
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.appendSystemPrompt === undefined
      ? {}
      : { developerInstructions: request.appendSystemPrompt }),
    config: {
      ...(request.reasoningEffort ? { model_reasoning_effort: request.reasoningEffort } : {}),
      'sandbox_workspace_write.writable_roots': request.additionalDirectories ?? [],
      'sandbox_workspace_write.network_access': false,
    },
  };
}

function codexApprovalParams(request: AgentLaunchRequest): Record<string, unknown> {
  return request.permissionMode === 'auto'
    ? { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    : { approvalPolicy: 'never', approvalsReviewer: 'user' };
}

export function codexTurnParams(request: AgentLaunchRequest): Record<string, unknown> {
  return {
    ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
    cwd: request.cwd,
    ...codexApprovalParams(request),
    sandboxPolicy:
      request.permissionMode === 'unrestricted'
        ? { type: 'dangerFullAccess' }
        : {
            type: 'workspaceWrite',
            writableRoots: [request.cwd, ...(request.additionalDirectories ?? [])],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
    ...(request.model === undefined ? {} : { model: request.model }),
  };
}
