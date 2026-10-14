import { lstatSync, readdirSync } from 'node:fs';
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
 * What a commit, a rebase or a merge in a linked worktree writes in the common directory:
 * `reftable` is a reftable repository's ref store, `refs/` in another format (R-G16 review L-1).
 */
const GIT_COMMIT_WRITES = new Set(['objects', 'refs', 'reftable', 'logs', 'worktrees']);

/**
 * Names Git creates and removes on its own in the common directory: the primary checkout's state
 * of an operation in progress (Git 2.55's names, as R-G16 review M-2 listed them from its source,
 * less `ORIG_HEAD`, which stays), rerere's `MERGE_RR`, locks and `git gc`'s files. One present at
 * launch may be gone before a later command, and Claude Code would then hold the deny with an
 * empty placeholder, which Git reads as a lock or an operation in progress (R-G19 review
 * MEDIUM-1), so none is denied.
 */
const TRANSIENT_GIT_STATE =
  /^(?:rebase-merge|rebase-apply|sequencer|MERGE_HEAD|MERGE_MSG|MERGE_MODE|MERGE_RR|MERGE_AUTOSTASH|AUTO_MERGE|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|SQUASH_MSG|CHECKOUT_AUTOSTASH_HEAD|BISECT_\w+|NOTES_MERGE_\w+|gc\.pid|gc\.log|.*\.lock)$/;

/** Whether a path is a directory (a worktree's entry is one), not following a link. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A directory's entries, or none when it cannot be listed. */
function entriesOf(directory: string): string[] {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
}

/** Whether a name is present at launch, a link to nothing included. */
function presentAtLaunch(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What sandboxed commands may not write in the repository's Git directory. Claude Code binds a
 * linked worktree's whole common directory writable itself, and mounts denies after allows, so
 * a deny on the common directory would make every allow under it read-only too; Codex's narrower
 * grant cannot be expressed (R-G16, verified on Claude Code 2.1.288). So, beside Claude Code's own
 * `config` and `hooks/`:
 * - every entry of the common directory that exists at launch, but `objects/`, `refs/`, `logs/`
 *   and `worktrees/` (R-G16, operator decision 2026-10-13): the primary checkout's `HEAD`,
 *   `index` and `packed-refs`, `info/` (whose `attributes` could pick a merge driver for the
 *   daemon's merges), `rr-cache/` and the rest;
 * - what says where the repository and its configuration are (R-G14 review MEDIUM-1): the
 *   common directory's `commondir`, `config.worktree` and `objects/info` (alternates), every
 *   other worktree's entry, and the run's own `commondir`, `gitdir` and `config.worktree`.
 * Only what exists at launch is denied (R-G19, ADR-075), and none of Git's transient names
 * (`TRANSIENT_GIT_STATE`): Claude Code checks each denied path before every sandboxed command and
 * holds one that does not exist with an empty placeholder, and a `commondir` placeholder made Git
 * in the primary checkout and the daemon's clone refuse meanwhile. Another worktree's entry the
 * daemon removes during the run is still held so, until the command ends: Git ignores a file
 * there. A name an agent creates later is an accepted risk; the daemon's own Git still refuses a
 * planted `commondir` or a non-empty `config.worktree` (`packages/git`). Claude Code's own empty
 * `config.worktree` files, made before it mounts, are its own. `worktrees/` as a whole cannot be
 * denied: the run's own entry, which a commit writes, lies in it, and a deny would win.
 */
function gitDeniedWrites(git: NonNullable<AgentLaunchRequest['gitDirectories']>): string[] {
  const common = git.gitCommonDirectory;
  return [
    ...new Set([
      ...entriesOf(common)
        .filter((entry) => !GIT_COMMIT_WRITES.has(entry) && !TRANSIENT_GIT_STATE.test(entry))
        .map((entry) => join(common, entry)),
      join(common, 'info'),
      join(common, 'commondir'),
      join(common, 'config.worktree'),
      join(common, 'objects', 'info'),
      // A file there is no worktree's entry, but a placeholder a killed run left behind.
      ...entriesOf(join(common, 'worktrees'))
        .map((entry) => join(common, 'worktrees', entry))
        .filter((entry) => entry !== git.gitDirectory && isDirectory(entry)),
      join(git.gitDirectory, 'commondir'),
      join(git.gitDirectory, 'gitdir'),
      join(git.gitDirectory, 'config.worktree'),
    ]),
  ].filter(presentAtLaunch);
}

/** Whether the run's Bash is sandboxed: every posture but unrestricted. */
export function claudeSandboxed(request: AgentLaunchRequest): boolean {
  return request.readOnly === true || request.permissionMode !== 'unrestricted';
}

/** A path of the shared list in Claude's rule syntax: `~/` stays, and `//` marks an absolute path. */
function rulePath(path: string): string {
  return path.startsWith('~/') ? path : `/${path}`;
}

/**
 * Claude's own file tools (Read, Grep, Glob, Edit) are denied what its sandboxed commands are, the
 * whole `sandboxDeniedReads` list (R-G9 review for the daemon's files; operator decision
 * 2026-10-12 for the rest, so the two agree): the sandbox governs only commands. An unrestricted
 * run, whose commands are not sandboxed, has the operator's authority and is denied only the
 * daemon's own files, as Codex's is (operator decision 2026-10-12, follow-up review M-3). Each path
 * is denied itself, for a file, and everything under it, for a directory.
 */
function deniedFileRules(request: AgentLaunchRequest): string[] {
  const paths = claudeSandboxed(request)
    ? sandboxDeniedReads(request)
    : (request.deniedReads ?? []);
  return paths.flatMap((path) => {
    const rule = rulePath(path);
    return [`Read(${rule})`, `Read(${rule}/**)`, `Edit(${rule})`, `Edit(${rule}/**)`];
  });
}

/**
 * Settings every supervised Claude run gets. Except with the unrestricted posture, Bash runs in
 * Claude Code's OS sandbox (R-G5, SEC-02c): it may write only the worktree, the run's
 * directories, its scratch space, the outside sources' caches, the directories the daemon adds
 * for the run (`additionalDirectories`: a previous run's directory, a historical baseline's Cargo
 * home, a local-CI cache root, the worktree's shared Cargo target) and the repository's Git
 * directory but what `gitDeniedWrites` keeps read-only; it reaches no network but loopback and
 * those sources' hosts, and no command may name more (a strict allowlist); it cannot read what
 * `sandboxDeniedReads` lists (the runtime directory, Docker sockets, the operator's credentials,
 * the daemon's database, backups and settings). The run does not start without the sandbox,
 * and a command may not ask to leave it. Sandboxed commands run without asking only in the auto
 * posture; edit-only keeps its approval rule for commands.
 */
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
