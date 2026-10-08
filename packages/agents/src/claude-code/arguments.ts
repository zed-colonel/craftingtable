import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPermissionMode } from '@craftingtable/domain';
import type { AgentLaunchRequest } from '../index.js';
import { launchOutsideSources, outsideSourceHosts } from '../outside-sources.js';
import { sandboxDeniedReads } from '../sandbox-reads.js';

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

/** Every source's exact hosts, once each. */
function sandboxAllowedDomains(request: AgentLaunchRequest): string[] {
  return outsideSourceHosts(launchOutsideSources(request));
}

/**
 * Where a fetch writes outside the worktree: the sources' caches (for `cargo`, Cargo's registry
 * and Git caches), and nothing else of the home directory. The sandbox can make only an
 * existing directory writable, so the adapter creates them first.
 */
export function sandboxAllowedWrites(request: AgentLaunchRequest): string[] {
  return launchOutsideSources(request).flatMap((source) => source.caches);
}

/**
 * Settings every supervised Claude run gets. Except with the unrestricted posture, Bash runs in
 * Claude Code's OS sandbox (R-G5, SEC-02c): it may write only the worktree, the run's
 * directories, its scratch space and the outside sources' caches; it reaches no network but
 * loopback and those sources' hosts, and no command may name more (a strict allowlist); it
 * cannot read the Docker socket or the operator's credentials. The run does not start without the sandbox, and
 * a command may not ask to leave it. Sandboxed commands run without asking only in the auto
 * posture; edit-only keeps its approval rule for commands.
 */
/**
 * What sandboxed commands may not write in the repository's Git directory (R-G14 review
 * MEDIUM-1, operator decision 2026-10-08). Claude Code lets them write it, so a run can commit,
 * except `config` and `hooks/`; these keep the rest of what says where the repository and its
 * configuration are read-only, existing or not (Claude Code stops a denied path's creation, and
 * leaves an empty placeholder for a missing `config.worktree`): `info/` (whose `attributes`
 * could pick a merge driver for the daemon's merges), the common directory's `commondir`,
 * `config.worktree` and `objects/info` (alternates), every other worktree's entry, and the run's
 * own `commondir`, `gitdir` and `config.worktree`. `worktrees/` as a whole cannot be denied: the
 * run's own entry, which a commit writes, lies in it, and a deny would win.
 */
function gitDeniedWrites(git: NonNullable<AgentLaunchRequest['gitDirectories']>): string[] {
  const common = git.gitCommonDirectory;
  let entries: string[] = [];
  try {
    entries = readdirSync(join(common, 'worktrees'));
  } catch {
    // No other worktree.
  }
  return [
    join(common, 'info'),
    join(common, 'commondir'),
    join(common, 'config.worktree'),
    join(common, 'objects', 'info'),
    ...entries
      .map((entry) => join(common, 'worktrees', entry))
      .filter((entry) => entry !== git.gitDirectory),
    join(git.gitDirectory, 'commondir'),
    join(git.gitDirectory, 'gitdir'),
    join(git.gitDirectory, 'config.worktree'),
  ];
}

/** Whether the run's Bash is sandboxed: every posture but unrestricted. */
export function claudeSandboxed(request: AgentLaunchRequest): boolean {
  return request.readOnly === true || request.permissionMode !== 'unrestricted';
}

/**
 * Claude's own file tools (Read, Grep, Glob, Edit) may not touch the daemon's files either
 * (R-G9 review): the sandbox governs only commands. `//` marks an absolute path in a rule.
 */
function deniedFileRules(request: AgentLaunchRequest): string[] {
  return (request.deniedReads ?? []).flatMap((path) => [`Read(/${path}/**)`, `Edit(/${path}/**)`]);
}

function claudeRunSettings(request: AgentLaunchRequest): Record<string, unknown> {
  const deny = deniedFileRules(request);
  return {
    autoMemoryEnabled: false,
    ...(deny.length === 0 ? {} : { permissions: { deny } }),
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
              ...(request.gitDirectories === undefined
                ? {}
                : { denyWrite: gitDeniedWrites(request.gitDirectories) }),
            },
            network: {
              allowLocalBinding: true,
              strictAllowlist: true,
              allowedDomains: sandboxAllowedDomains(request),
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
