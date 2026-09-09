import type { AgentLaunchRequest } from '../index.js';

/** Config overrides work on both exec and resume (which lacks --sandbox). */
function flags(request: AgentLaunchRequest): string[] {
  return [
    '--json',
    ...(request.permissionMode === 'unrestricted'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"']),
    ...(request.model === undefined ? [] : ['--model', request.model]),
  ];
}
export function codexExecArguments(request: AgentLaunchRequest): readonly string[] {
  return ['exec', ...flags(request), '-'];
}
export function codexResumeArguments(
  threadId: string,
  request: AgentLaunchRequest,
): readonly string[] {
  return ['exec', 'resume', ...flags(request), threadId, '-'];
}
