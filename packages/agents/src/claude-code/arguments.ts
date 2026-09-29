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
    // Never the operator's own configuration (R-G5, AGT-14): only the repository's settings, no
    // MCP servers, no skills or plugins, no auto-memory. The repository's own `.claude`
    // settings and CLAUDE.md still apply; the repository declares them.
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--settings',
    JSON.stringify(claudeRunSettings(request)),
  ];
  args.push(
    ...(request.readOnly
      ? ['--restricted', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk']
      : permissionArguments(request.permissionMode)),
  );
  if (request.reasoningEffort !== undefined) {
    args.push('--effort', request.reasoningEffort);
  }
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

/**
 * Hosts a sandboxed run may reach, to download the dependencies its checks need: Cargo's
 * registry, npm's, and GitHub for git dependencies (R-G5). Everything else is refused.
 */
export const SANDBOX_ALLOWED_DOMAINS = [
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'registry.npmjs.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
] as const;

/**
 * Settings every supervised Claude run gets on top of the repository's own. Except with the
 * unrestricted posture, Bash runs in Claude Code's OS sandbox (R-G5, SEC-02c): it may write
 * only the worktree, the run's directories and its scratch space, reach only loopback and the
 * dependency hosts, and use no Unix socket. The run does not start without the sandbox, and a
 * command may not ask to leave it.
 */
function claudeRunSettings(request: AgentLaunchRequest): Record<string, unknown> {
  return {
    autoMemoryEnabled: false,
    ...(request.permissionMode === 'unrestricted' && !request.readOnly
      ? {}
      : {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: true,
            network: { allowLocalBinding: true, allowedDomains: [...SANDBOX_ALLOWED_DOMAINS] },
          },
        }),
  };
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
