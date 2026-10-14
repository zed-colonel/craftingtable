import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claudeCodeArguments } from '../../src/claude-code/arguments.js';
import { cargoOutsideSource } from '../../src/outside-sources.js';
it('limits decision preparation to file-reading tools without ambient MCP or write permissions', () => {
  const args = claudeCodeArguments({
    cwd: '/work/x',
    prompt: 'Prepare',
    permissionMode: 'unrestricted',
    readOnly: true,
  });
  expect(args).toContain('--restricted');
  expect(args).toContain('--strict-mcp-config');
  expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
  expect(args).toContain('dontAsk');
  expect(args).not.toContain('bypassPermissions');
});

it("never loads the operator's settings, plugins, skills, MCP servers or memory, on any posture (R-G5, AGT-14)", () => {
  for (const request of [
    { permissionMode: 'auto' as const },
    { permissionMode: 'edit-only' as const },
    { permissionMode: 'unrestricted' as const },
    { permissionMode: 'auto' as const, readOnly: true },
  ]) {
    const args = claudeCodeArguments({ cwd: '/work/x', prompt: 'Go', ...request });
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toMatchObject({
      autoMemoryEnabled: false,
    });
    expect(args.filter((a) => a === '--strict-mcp-config')).toHaveLength(1);
  }
});

it("passes the profile's reasoning effort rather than the operator's default (R-G5)", () => {
  const args = claudeCodeArguments({
    cwd: '/work/x',
    prompt: 'Go',
    permissionMode: 'auto',
    reasoningEffort: 'xhigh',
  });
  expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
  expect(
    claudeCodeArguments({ cwd: '/work/x', prompt: 'Go', permissionMode: 'auto' }),
  ).not.toContain('--effort');
});

it("reads no settings file from any scope, not even the repository's (R-G5 review, AGT-14)", () => {
  const args = claudeCodeArguments({ cwd: '/work/x', prompt: 'Go', permissionMode: 'auto' });
  expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
});

it("keeps the sandbox off the network, the Docker socket and the operator's credentials (R-G5 review)", () => {
  const settings = (permissionMode: 'auto' | 'edit-only') => {
    const args = claudeCodeArguments({ cwd: '/work/x', prompt: 'Go', permissionMode });
    return JSON.parse(args[args.indexOf('--settings') + 1]!).sandbox;
  };
  const sandbox = settings('auto');
  // The crates.io registry is the one outside host, so `cargo fetch` can download
  // dependencies (operator decision 2026-09-28); a strict allowlist keeps commands from adding
  // more.
  expect(sandbox.network).toEqual({
    allowLocalBinding: true,
    strictAllowlist: true,
    // Only what a sparse fetch reads: the index and the downloads. The apex is the write API
    // (publish, yank), a way out for data (R-G5 follow-up review).
    allowedDomains: ['index.crates.io', 'static.crates.io'],
  });
  // Cargo's registry tokens stay unreadable.
  expect(sandbox.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      join(homedir(), '.cargo', 'credentials.toml'),
      join(homedir(), '.cargo', 'credentials'),
    ]),
  );
  // What a fetch writes: Cargo's registry and Git caches, nothing else of the home directory.
  // The daemon names the run's Cargo home; without one it is Cargo's default.
  expect(sandbox.filesystem.allowWrite).toEqual([
    join(homedir(), '.cargo', 'registry'),
    join(homedir(), '.cargo', 'git'),
  ]);
  const named = claudeCodeArguments({
    cwd: '/work/x',
    prompt: 'Go',
    permissionMode: 'auto',
    environment: { CARGO_HOME: '/opt/cargo' },
  });
  expect(JSON.parse(named[named.indexOf('--settings') + 1]!).sandbox.filesystem.allowWrite).toEqual(
    ['/opt/cargo/registry', '/opt/cargo/git'],
  );
  expect(sandbox.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      `/run/user/${process.getuid?.()}`,
      '/var/run/docker.sock',
      '~/.ssh',
      '~/.codex',
      '~/.claude/.credentials.json',
    ]),
  );
  // Sandboxed Bash runs without asking only in the auto posture; edit-only keeps asking.
  expect(sandbox.autoAllowBashIfSandboxed).toBe(true);
  expect(settings('edit-only').autoAllowBashIfSandboxed).toBe(false);
});

it("keeps the daemon's own files out of the sandbox's reach: its database, backups and credentials (R-G9)", () => {
  const args = claudeCodeArguments({
    cwd: '/work/x',
    prompt: 'Go',
    permissionMode: 'auto',
    deniedReads: ['/data/state', '/data/backups', '/home/op/.config/craftingtable'],
  });
  const { denyRead } = JSON.parse(args[args.indexOf('--settings') + 1]!).sandbox.filesystem;
  expect(denyRead).toEqual(
    expect.arrayContaining(['/data/state', '/data/backups', '/home/op/.config/craftingtable']),
  );
  // The operator's credentials stay denied beside them.
  expect(denyRead).toEqual(expect.arrayContaining(['~/.ssh', '~/.claude/.credentials.json']));
  // Claude's own file tools are denied them too, not only sandboxed commands (R-G9 review), and
  // the rest of the list as well (operator decision 2026-10-12): each path itself, for a file,
  // and what lies under it, for a directory; `~/` stays home-relative, `//` is absolute.
  const { permissions } = JSON.parse(args[args.indexOf('--settings') + 1]!);
  const rule = (path: string) => (path.startsWith('~/') ? path : `/${path}`);
  expect(permissions.deny).toEqual(
    (denyRead as string[]).flatMap((path) => [
      `Read(${rule(path)})`,
      `Read(${rule(path)}/**)`,
      `Edit(${rule(path)})`,
      `Edit(${rule(path)}/**)`,
    ]),
  );
  expect(permissions.deny).toEqual(
    expect.arrayContaining([
      'Read(//data/state/**)',
      'Edit(//data/backups/**)',
      'Read(//home/op/.config/craftingtable/**)',
      'Read(~/.ssh/**)',
      'Read(~/.git-credentials)',
      'Read(~/.claude/.credentials.json)',
      'Edit(~/.aws/**)',
      'Read(//var/run/docker.sock)',
    ]),
  );
});

it("denies the whole list to every sandboxed run's file tools, read-only ones too, and an unrestricted run only the daemon's files (operator decisions 2026-10-12)", () => {
  const deniedReads = ['/data/state', '/home/op/.config/craftingtable'];
  const deny = (request: {
    readonly permissionMode: 'auto' | 'edit-only' | 'unrestricted';
    readonly readOnly?: boolean;
    readonly deniedReads?: readonly string[];
  }) => {
    const args = claudeCodeArguments({ cwd: '/work/x', prompt: 'Go', deniedReads, ...request });
    return JSON.parse(args[args.indexOf('--settings') + 1]!).permissions?.deny as
      | string[]
      | undefined;
  };
  for (const request of [
    { permissionMode: 'auto' as const },
    { permissionMode: 'edit-only' as const },
    { permissionMode: 'auto' as const, readOnly: true },
    { permissionMode: 'unrestricted' as const, readOnly: true },
  ]) {
    expect(deny(request)).toEqual(
      expect.arrayContaining(['Read(~/.ssh)', 'Read(~/.ssh/**)', 'Read(~/.codex/**)']),
    );
  }
  // An unrestricted run's commands are not sandboxed, and it has the operator's authority:
  // its file tools keep only the R-G9 denials, as a Codex unrestricted run does (review M-3).
  expect(deny({ permissionMode: 'unrestricted' })).toEqual([
    'Read(//data/state)',
    'Read(//data/state/**)',
    'Edit(//data/state)',
    'Edit(//data/state/**)',
    'Read(//home/op/.config/craftingtable)',
    'Read(//home/op/.config/craftingtable/**)',
    'Edit(//home/op/.config/craftingtable)',
    'Edit(//home/op/.config/craftingtable/**)',
  ]);
  expect(deny({ permissionMode: 'unrestricted', deniedReads: [] })).toBeUndefined();
});

it('confines Bash in the OS sandbox on every posture but unrestricted, with no way out (R-G5, SEC-02)', () => {
  const settings = (request: Partial<Parameters<typeof claudeCodeArguments>[0]>) => {
    const args = claudeCodeArguments({
      cwd: '/work/x',
      prompt: 'Go',
      permissionMode: 'auto',
      ...request,
    });
    return JSON.parse(args[args.indexOf('--settings') + 1]!) as {
      sandbox?: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        network: {
          allowLocalBinding: boolean;
          allowedDomains: string[];
          allowUnixSockets?: string[];
        };
      };
    };
  };
  for (const request of [
    { permissionMode: 'auto' as const },
    { permissionMode: 'edit-only' as const },
    { permissionMode: 'unrestricted' as const, readOnly: true },
  ]) {
    const sandbox = settings(request).sandbox!;
    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowLocalBinding: true },
    });
    expect(sandbox.network.allowUnixSockets ?? []).toEqual([]);
  }
  expect(settings({ permissionMode: 'unrestricted' }).sandbox).toBeUndefined();
});

it('reaches only the outside sources the launch names, and writes only their caches (R-G14)', () => {
  const sandbox = (outsideSources: Parameters<typeof claudeCodeArguments>[0]['outsideSources']) => {
    const args = claudeCodeArguments({
      cwd: '/work/x',
      prompt: 'Go',
      permissionMode: 'auto',
      environment: { CARGO_HOME: '/opt/cargo' },
      outsideSources,
    });
    return JSON.parse(args[args.indexOf('--settings') + 1]!).sandbox;
  };
  const named = sandbox([
    {
      kind: 'cargo',
      hosts: ['index.crates.io', 'static.crates.io', 'mirror.example.org'],
      caches: ['/data/cargo-home/registry', '/data/cargo-home/git'],
    },
  ]);
  expect(named.network).toEqual({
    allowLocalBinding: true,
    strictAllowlist: true,
    allowedDomains: ['index.crates.io', 'static.crates.io', 'mirror.example.org'],
  });
  expect(named.filesystem.allowWrite).toEqual([
    '/data/cargo-home/registry',
    '/data/cargo-home/git',
  ]);
  // No source: no host and no cache, still under a strict allowlist.
  const none = sandbox([]);
  expect(none.network).toEqual({
    allowLocalBinding: true,
    strictAllowlist: true,
    allowedDomains: [],
  });
  expect(none.filesystem.allowWrite).toEqual([]);
});

it("passes today's arguments for the cargo source in the run's Cargo home, on every posture (R-G14)", () => {
  for (const request of [
    { permissionMode: 'auto' as const },
    { permissionMode: 'edit-only' as const },
    { permissionMode: 'unrestricted' as const },
    { permissionMode: 'auto' as const, readOnly: true },
  ]) {
    const base = {
      cwd: '/work/x',
      prompt: 'Go',
      environment: { CARGO_HOME: '/opt/cargo' },
      ...request,
    };
    // Absent sources keep the arguments every run had before R-G14.
    expect(
      claudeCodeArguments({ ...base, outsideSources: [cargoOutsideSource('/opt/cargo')] }),
    ).toEqual(claudeCodeArguments(base));
  }
  expect(cargoOutsideSource('/opt/cargo')).toEqual({
    kind: 'cargo',
    hosts: ['index.crates.io', 'static.crates.io'],
    caches: ['/opt/cargo/registry', '/opt/cargo/git'],
  });
});

it("keeps Git's redirect files and info/ read-only for sandboxed commands, so a commit still works (R-G14 review MEDIUM-1)", () => {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-claude-git-'));
  try {
    const common = join(root, 'repo', '.git');
    const own = join(common, 'worktrees', 'wt-1');
    for (const directory of [
      'objects/info',
      'info',
      'refs/heads',
      'logs',
      'worktrees/wt-1',
      'worktrees/other',
    ])
      mkdirSync(join(common, directory), { recursive: true });
    const settings = (request: Partial<Parameters<typeof claudeCodeArguments>[0]>) => {
      const args = claudeCodeArguments({
        cwd: '/work/x',
        prompt: 'Go',
        permissionMode: 'auto',
        ...request,
      });
      return JSON.parse(args[args.indexOf('--settings') + 1]!) as {
        sandbox?: { filesystem: { denyWrite?: string[] } };
      };
    };
    for (const file of ['commondir', 'gitdir']) writeFileSync(join(own, file), '');
    const gitDirectories = { gitDirectory: own, gitCommonDirectory: common, worktreeConfig: false };
    for (const permissionMode of ['auto', 'edit-only'] as const)
      expect(settings({ permissionMode, gitDirectories }).sandbox?.filesystem.denyWrite).toEqual([
        // Claude Code already keeps `config` and `hooks/` read-only; `info/attributes` could pick
        // a merge driver for the daemon's merges.
        join(common, 'info'),
        // What says where the repository and its configuration are, when it exists at launch
        // (R-G19: a missing one is not denied, so no placeholder is made).
        join(common, 'objects', 'info'),
        // Every other worktree's entry (not the run's own, which a commit writes).
        join(common, 'worktrees', 'other'),
        join(own, 'commondir'),
        join(own, 'gitdir'),
      ]);
    // Without the daemon's directories, and without a sandbox, nothing is added.
    expect(settings({}).sandbox?.filesystem.denyWrite).toBeUndefined();
    expect(settings({ permissionMode: 'unrestricted', gitDirectories }).sandbox).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps every entry of the common Git directory that exists at launch read-only but what a commit writes (R-G16, operator decision 2026-10-13)', () => {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-claude-git-'));
  try {
    const common = join(root, 'repo', '.git');
    const own = join(common, 'worktrees', 'wt-1');
    for (const directory of [
      'objects/info',
      'info',
      'hooks',
      'refs/heads',
      'logs',
      'rr-cache',
      'branches',
      'worktrees/wt-1',
      'worktrees/other',
    ])
      mkdirSync(join(common, directory), { recursive: true });
    // The primary checkout's own files: Claude Code binds the whole common directory itself, so
    // today a sandboxed command could switch the operator's branch or rewrite packed refs.
    for (const file of ['HEAD', 'config', 'packed-refs', 'index', 'description', 'FETCH_HEAD'])
      writeFileSync(join(common, file), '');
    for (const file of ['commondir', 'gitdir', 'HEAD', 'index']) writeFileSync(join(own, file), '');
    const args = claudeCodeArguments({
      cwd: '/work/x',
      prompt: 'Go',
      permissionMode: 'auto',
      gitDirectories: { gitDirectory: own, gitCommonDirectory: common, worktreeConfig: false },
    });
    const denied = (
      JSON.parse(args[args.indexOf('--settings') + 1]!) as {
        sandbox: { filesystem: { denyWrite: string[] } };
      }
    ).sandbox.filesystem.denyWrite;
    // Each existing entry is denied, once.
    for (const entry of [
      'HEAD',
      'config',
      'packed-refs',
      'index',
      'description',
      'FETCH_HEAD',
      'rr-cache',
      'branches',
      'hooks',
      'info',
    ])
      expect(denied.filter((path) => path === join(common, entry))).toEqual([join(common, entry)]);
    expect(new Set(denied).size).toBe(denied.length);
    // R-G14 MEDIUM-1's names that exist at launch stay: `objects/info`, other entries, and the
    // run's `commondir` and `gitdir`.
    for (const path of [
      join(common, 'objects', 'info'),
      join(common, 'worktrees', 'other'),
      join(own, 'commondir'),
      join(own, 'gitdir'),
    ])
      expect(denied).toContain(path);
    // What a commit, a rebase and a merge write stays writable: objects/, refs/, logs/ and the
    // run's own entry; `worktrees/` itself is not denied.
    for (const path of ['objects', 'refs', 'logs', 'worktrees', 'worktrees/wt-1'])
      expect(denied).not.toContain(join(common, path));
    // A reftable repository's ref store is refs/ in another format (review L-1).
    mkdirSync(join(common, 'reftable'));
    const withReftable = claudeCodeArguments({
      cwd: '/work/x',
      prompt: 'Go',
      permissionMode: 'auto',
      gitDirectories: { gitDirectory: own, gitCommonDirectory: common, worktreeConfig: false },
    });
    expect(withReftable[withReftable.indexOf('--settings') + 1]).not.toContain(
      JSON.stringify(join(common, 'reftable')),
    );
    // No name missing at launch is denied: each would leave a placeholder.
    expect(denied).not.toContain(join(common, 'shallow'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('denies no Git name missing at launch, so Claude Code makes no placeholder for the adapter, and keeps each one that exists read-only (R-G19, ADR-075)', () => {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-claude-git-'));
  try {
    const common = join(root, 'repo', '.git');
    const own = join(common, 'worktrees', 'wt-1');
    for (const directory of ['objects/pack', 'refs/heads', 'logs', 'worktrees/wt-1'])
      mkdirSync(join(common, directory), { recursive: true });
    writeFileSync(join(common, 'HEAD'), '');
    for (const file of ['commondir', 'gitdir', 'HEAD']) writeFileSync(join(own, file), '');
    const denied = () => {
      const args = claudeCodeArguments({
        cwd: '/work/x',
        prompt: 'Go',
        permissionMode: 'auto',
        gitDirectories: { gitDirectory: own, gitCommonDirectory: common, worktreeConfig: false },
      });
      return (
        JSON.parse(args[args.indexOf('--settings') + 1]!) as {
          sandbox: { filesystem: { denyWrite: string[] } };
        }
      ).sandbox.filesystem.denyWrite;
    };
    const missing = [
      join(common, 'commondir'),
      join(common, 'config.worktree'),
      join(common, 'info'),
      join(common, 'objects', 'info'),
      join(own, 'config.worktree'),
    ];
    // Missing at launch: none is denied, and every path denied exists.
    expect(denied()).toEqual([join(common, 'HEAD'), join(own, 'commondir'), join(own, 'gitdir')]);
    for (const path of missing) expect(denied()).not.toContain(path);
    // Present at launch (a file left behind, or an agent's): each is denied once.
    mkdirSync(join(common, 'info'));
    mkdirSync(join(common, 'objects', 'info'));
    for (const file of [
      join(common, 'commondir'),
      join(common, 'config.worktree'),
      join(own, 'config.worktree'),
    ])
      writeFileSync(file, '');
    const present = denied();
    for (const path of missing) expect(present.filter((entry) => entry === path)).toEqual([path]);
    // A run whose own entry has no `commondir` or `gitdir` gets no deny of them either.
    rmSync(join(own, 'commondir'));
    rmSync(join(own, 'gitdir'));
    expect(denied()).not.toContain(join(own, 'commondir'));
    expect(denied()).not.toContain(join(own, 'gitdir'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("denies none of Git's transient names even when present at launch, since Claude Code would hold one with a placeholder once Git removes it (R-G19 review MEDIUM-1)", () => {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-claude-git-'));
  try {
    const common = join(root, 'repo', '.git');
    const own = join(common, 'worktrees', 'wt-1');
    for (const directory of [
      'objects/pack',
      'refs/heads',
      'logs',
      'worktrees/wt-1',
      'worktrees/other',
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'NOTES_MERGE_WORKTREE',
    ])
      mkdirSync(join(common, directory), { recursive: true });
    const transient = [
      'MERGE_HEAD',
      'MERGE_MSG',
      'MERGE_MODE',
      'MERGE_RR',
      'MERGE_AUTOSTASH',
      'AUTO_MERGE',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'REBASE_HEAD',
      'SQUASH_MSG',
      'CHECKOUT_AUTOSTASH_HEAD',
      'BISECT_LOG',
      'BISECT_START',
      'BISECT_TERMS',
      'NOTES_MERGE_PARTIAL',
      'NOTES_MERGE_REF',
      'index.lock',
      'HEAD.lock',
      'packed-refs.lock',
      'config.lock',
      'gc.pid',
      'gc.log',
      // Git's editor scratch files, a stash's temporary index, fsmonitor's socket and `shallow`
      // (R-G19 re-check NIT).
      'TAG_EDITMSG',
      'NOTES_EDITMSG',
      'EDIT_DESCRIPTION',
      'ADD_EDIT.patch',
      'addp-hunk-edit.diff',
      'index.stash.4242',
      'fsmonitor--daemon.ipc',
      'shallow',
    ];
    const stable = ['HEAD', 'index', 'packed-refs', 'ORIG_HEAD', 'FETCH_HEAD', 'COMMIT_EDITMSG'];
    for (const file of [...transient, ...stable]) writeFileSync(join(common, file), '');
    for (const file of ['commondir', 'gitdir']) writeFileSync(join(own, file), '');
    // A file among the worktree entries is no worktree: a placeholder a killed run left behind.
    writeFileSync(join(common, 'worktrees', 'left-behind'), '');
    const args = claudeCodeArguments({
      cwd: '/work/x',
      prompt: 'Go',
      permissionMode: 'auto',
      gitDirectories: { gitDirectory: own, gitCommonDirectory: common, worktreeConfig: false },
    });
    const denied = (
      JSON.parse(args[args.indexOf('--settings') + 1]!) as {
        sandbox: { filesystem: { denyWrite: string[] } };
      }
    ).sandbox.filesystem.denyWrite;
    for (const name of [
      ...transient,
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'NOTES_MERGE_WORKTREE',
    ])
      expect(denied, name).not.toContain(join(common, name));
    for (const name of stable) expect(denied, name).toContain(join(common, name));
    expect(denied).toContain(join(common, 'worktrees', 'other'));
    expect(denied).not.toContain(join(common, 'worktrees', 'left-behind'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
