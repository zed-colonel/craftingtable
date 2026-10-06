import { homedir } from 'node:os';
import { join } from 'node:path';
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
    // Never the operator's own configuration (R-G5, AGT-14): no settings file from any scope, no
    // MCP servers, no skills or plugins, no auto-memory. Not the repository's settings either: an
    // agent can rewrite them in its worktree, and they could widen the sandbox or add hooks that
    // run outside it (R-G5 review). CLAUDE.md still applies.
    '--setting-sources',
    '',
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
 * What sandboxed Bash may not read (R-G5 review): the user's runtime directory, which holds the
 * rootless Docker socket and the session bus (Unix sockets are not otherwise blocked where
 * Claude Code's seccomp helper is absent), system Docker sockets, and the operator's
 * credentials. Claude itself still reads its own login; only the agent's commands are denied.
 */
function sandboxDeniedReads(request: AgentLaunchRequest): string[] {
  const uid = process.getuid?.();
  return [
    ...(uid === undefined ? [] : [`/run/user/${uid}`]),
    '/var/run/docker.sock',
    '/run/docker.sock',
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.docker',
    '~/.config/gh',
    '~/.git-credentials',
    '~/.codex',
    '~/.claude/.credentials.json',
    // Cargo's registry tokens, which would let a command publish or yank as the operator.
    join(cargoHome(request), 'credentials.toml'),
    join(cargoHome(request), 'credentials'),
    // The daemon's database, its copies and the credentials file (R-G9).
    ...(request.deniedReads ?? []),
  ];
}

/**
 * The one outside source sandboxed commands may reach: the crates.io registry, so that
 * `cargo fetch` can download dependencies before the daemon's offline builds (operator
 * decision 2026-09-28). Only its sparse index and download hosts: the `crates.io` apex is the
 * write API (publish, yank), which would carry data out (R-G5 follow-up review). A place to
 * configure such sources is a follow-up (R-G14).
 */
const SANDBOX_ALLOWED_DOMAINS = ['index.crates.io', 'static.crates.io'];

/**
 * Where a fetch writes outside the worktree: Cargo's registry and Git caches, the same two
 * directories the daemon's check units may write, and nothing else of the home directory. The
 * sandbox can make only an existing directory writable, so the adapter creates them first.
 */
export function sandboxAllowedWrites(request: AgentLaunchRequest): string[] {
  const home = cargoHome(request);
  return [join(home, 'registry'), join(home, 'git')];
}

/** The Cargo home the daemon named for the run, else Cargo's default; an empty value is unset. */
function cargoHome(request: AgentLaunchRequest): string {
  return request.environment?.CARGO_HOME || join(homedir(), '.cargo');
}

/**
 * Settings every supervised Claude run gets. Except with the unrestricted posture, Bash runs in
 * Claude Code's OS sandbox (R-G5, SEC-02c): it may write only the worktree, the run's
 * directories, its scratch space and Cargo's download caches; it reaches no network but loopback
 * and crates.io, and no command may name more hosts (a strict allowlist); it cannot read the
 * Docker socket or the operator's credentials. The run does not start without the sandbox, and
 * a command may not ask to leave it. Sandboxed commands run without asking only in the auto
 * posture; edit-only keeps its approval rule for commands.
 */
/** Whether the run's Bash is sandboxed: every posture but unrestricted. */
export function claudeSandboxed(request: AgentLaunchRequest): boolean {
  return request.readOnly === true || request.permissionMode !== 'unrestricted';
}

function claudeRunSettings(request: AgentLaunchRequest): Record<string, unknown> {
  return {
    autoMemoryEnabled: false,
    ...(!claudeSandboxed(request)
      ? {}
      : {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: request.permissionMode === 'auto' && !request.readOnly,
            filesystem: {
              denyRead: sandboxDeniedReads(request),
              allowWrite: sandboxAllowedWrites(request),
            },
            network: {
              allowLocalBinding: true,
              strictAllowlist: true,
              allowedDomains: SANDBOX_ALLOWED_DOMAINS,
            },
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
