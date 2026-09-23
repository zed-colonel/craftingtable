import type { AgentPermissionMode } from '@craftingtable/domain';
import type { AgentLaunchRequest } from '../index.js';

/**
 * Argument vector for a headless Claude Code session.
 *
 * Pure so it can be asserted exactly. Every value is a discrete argv entry;
 * nothing is ever interpolated into a shell string. The prompt is not here:
 * it is delivered as the first stream-json user message on stdin so the
 * session stays open for follow-up messages.
 */
export function claudeCodeArguments(request: AgentLaunchRequest): readonly string[] {
  const args: string[] = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompts',
    'none',
  ];
  args.push(
    ...(request.readOnly
      ? [
          '--restricted',
          '--tools',
          'Read,Glob,Grep',
          '--strict-mcp-config',
          '--permission-mode',
          'dontAsk',
        ]
      : permissionArguments(request.permissionMode)),
  );
  if (request.model !== undefined) {
    args.push('--model', request.model);
  }
  if (request.appendSystemPrompt !== undefined) {
    args.push('--append-system-prompt', request.appendSystemPrompt);
  }
  for (const directory of request.additionalDirectories ?? []) {
    args.push('--add-dir', directory);
  }
  if (request.resumeSessionId !== undefined) {
    args.push('--resume', request.resumeSessionId);
  }
  if (request.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(request.maxBudgetUsd));
  }
  if (request.sessionName !== undefined) {
    args.push('--name', request.sessionName);
  }
  return args;
}

function permissionArguments(mode: AgentPermissionMode): readonly string[] {
  switch (mode) {
    case 'edit-only':
      return ['--permission-mode', 'acceptEdits'];
    case 'auto':
      return ['--permission-mode', 'auto'];
    case 'unrestricted':
      return ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'];
  }
}

/** One stream-json input line carrying a user message. */
export function claudeUserMessageLine(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}
