import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexDeniedReads,
  codexThreadParams,
  codexTurnParams,
  codexUnmaskableFiles,
} from '../../src/codex/arguments.js';
import { cargoOutsideSource } from '../../src/outside-sources.js';

const PROFILE = 'craftingtable';
const READ_ONLY_PROFILE = 'craftingtable-read-only';

it.each(['auto', 'edit-only', 'unrestricted'] as const)(
  'applies %s permissions to new/resumed threads and every turn, never letting a command escalate',
  (permissionMode) => {
    const request = {
      cwd: '/work/x',
      prompt: 'private brief',
      permissionMode,
      additionalDirectories: ['/work/y'],
      appendSystemPrompt: 'instructions',
      model: 'custom',
    };
    const thread = codexThreadParams(request);
    const turn = codexTurnParams(request);
    expect(thread).toMatchObject({
      cwd: '/work/x',
      model: 'custom',
      developerInstructions: 'instructions',
      // `auto` never escalates either (operator decision 2026-10-07, R-G14): leaving the sandbox
      // is only ever the operator's `unrestricted` choice.
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
    });
    expect(turn.approvalPolicy).toEqual(thread.approvalPolicy);
    expect(turn.approvalsReviewer).toEqual(thread.approvalsReviewer);
    if (permissionMode === 'unrestricted') {
      expect(thread.sandbox).toBe('danger-full-access');
      expect(turn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
      expect(thread).not.toHaveProperty('permissions');
      expect(turn).not.toHaveProperty('permissions');
    } else {
      // A sandboxed run's commands get the per-run permission profile, selected on the thread
      // and on every turn, in place of the legacy sandbox (R-G14).
      expect(thread.permissions).toBe(PROFILE);
      expect(turn.permissions).toBe(PROFILE);
      expect(thread).not.toHaveProperty('sandbox');
      expect(turn).not.toHaveProperty('sandboxPolicy');
    }
    expect(JSON.stringify(thread)).not.toContain('private brief');
  },
);

/**
 * The profile a sandboxed launch defines in its thread's configuration, with its denied reads
 * apart (the tests of the denied reads look at them; the others at what is granted).
 */
function profileOf(request: Parameters<typeof codexThreadParams>[0]) {
  const config = codexThreadParams(request).config as Record<string, unknown>;
  const full = config[`permissions.${PROFILE}`] as
    | { filesystem: Record<string, string> }
    | undefined;
  if (full === undefined) return { config, profile: undefined, denied: [] };
  const entries = Object.entries(full.filesystem);
  return {
    config,
    profile: {
      ...full,
      filesystem: Object.fromEntries(entries.filter(([, access]) => access !== 'deny')),
    },
    denied: entries.filter(([, access]) => access === 'deny').map(([path]) => path),
  };
}

it("gives a sandboxed run's commands the outside sources' hosts and caches, and its own directories (R-G14)", () => {
  for (const permissionMode of ['auto', 'edit-only'] as const) {
    const { config, profile } = profileOf({
      cwd: '/work/x',
      prompt: 'Go',
      permissionMode,
      additionalDirectories: ['/runs/r1', '/runs/r0'],
      outsideSources: [
        {
          kind: 'cargo',
          hosts: ['index.crates.io', 'static.crates.io', 'mirror.example.org'],
          caches: ['/data/cargo-home/registry', '/data/cargo-home/git'],
        },
      ],
    });
    expect(profile).toEqual({
      // The worktree (the thread's cwd) and the temporary directories, as the legacy sandbox had.
      extends: ':workspace',
      filesystem: {
        '/runs/r1': 'write',
        '/runs/r0': 'write',
        '/data/cargo-home/registry': 'write',
        '/data/cargo-home/git': 'write',
      },
      network: {
        enabled: true,
        domains: {
          'index.crates.io': 'allow',
          'static.crates.io': 'allow',
          'mirror.example.org': 'allow',
        },
      },
    });
    // Codex applies a host list through its own proxy, which this feature turns on.
    expect(config['features.network_proxy']).toBe(true);
    // The legacy sandbox's settings are gone with it.
    expect(config).not.toHaveProperty('sandbox_workspace_write.network_access');
    expect(config).not.toHaveProperty('sandbox_workspace_write.writable_roots');
  }
});

it('lists each host once across sources, and keeps the network off with no source (R-G14)', () => {
  const two = profileOf({
    cwd: '/work/x',
    prompt: 'Go',
    permissionMode: 'auto',
    outsideSources: [
      { kind: 'cargo', hosts: ['index.crates.io'], caches: ['/c/registry'] },
      { kind: 'cargo', hosts: ['index.crates.io', 'static.crates.io'], caches: ['/c/git'] },
    ],
  }).profile as unknown as { network: { domains: Record<string, string> } };
  expect(Object.keys(two.network.domains)).toEqual(['index.crates.io', 'static.crates.io']);

  const { config, profile } = profileOf({
    cwd: '/work/x',
    prompt: 'Go',
    permissionMode: 'edit-only',
    additionalDirectories: ['/runs/r1'],
    outsideSources: [],
  });
  expect(profile).toEqual({
    extends: ':workspace',
    filesystem: { '/runs/r1': 'write' },
    network: { enabled: false },
  });
  expect(config).not.toHaveProperty('features.network_proxy');
});

it("without named sources, reaches the `cargo` source in the run's Cargo home, as Claude does (R-G14)", () => {
  const request = {
    cwd: '/work/x',
    prompt: 'Go',
    permissionMode: 'auto' as const,
    environment: { CARGO_HOME: '/opt/cargo' },
  };
  expect(profileOf(request).profile).toEqual(
    profileOf({ ...request, outsideSources: [cargoOutsideSource('/opt/cargo')] }).profile,
  );
  expect(profileOf(request).profile).toMatchObject({
    filesystem: { '/opt/cargo/registry': 'write', '/opt/cargo/git': 'write' },
    network: {
      enabled: true,
      domains: { 'index.crates.io': 'allow', 'static.crates.io': 'allow' },
    },
  });
});

it('gives read-only and unrestricted runs no sources, and unrestricted runs no profile (R-G14)', () => {
  const sources = [{ kind: 'cargo' as const, hosts: ['index.crates.io'], caches: ['/c/registry'] }];
  for (const request of [
    { permissionMode: 'auto' as const, readOnly: true },
    { permissionMode: 'unrestricted' as const },
  ]) {
    const full = { cwd: '/work/x', prompt: 'Go', outsideSources: sources, ...request };
    const thread = codexThreadParams(full);
    const config = thread.config as Record<string, unknown>;
    expect(config).not.toHaveProperty('features.network_proxy');
    expect(JSON.stringify(thread)).not.toContain('index.crates.io');
    expect(JSON.stringify(thread)).not.toContain('/c/registry');
  }
  const unrestricted = {
    cwd: '/work/x',
    prompt: 'Go',
    outsideSources: sources,
    permissionMode: 'unrestricted' as const,
  };
  const config = codexThreadParams(unrestricted).config as Record<string, unknown>;
  expect(codexThreadParams(unrestricted)).not.toHaveProperty('permissions');
  expect(codexTurnParams(unrestricted)).not.toHaveProperty('permissions');
  expect(Object.keys(config).filter((key) => /permissions/.test(key))).toEqual([]);
});

it('sets explicit effort on thread creation and every turn without changing the model or permissions', () => {
  const request = {
    cwd: '/work/x',
    prompt: 'Check',
    permissionMode: 'auto' as const,
    model: 'gpt-6-sol',
    reasoningEffort: 'medium' as const,
  };
  expect(codexThreadParams(request)).toMatchObject({
    model: 'gpt-6-sol',
    config: { model_reasoning_effort: 'medium' },
  });
  expect(codexTurnParams(request)).toMatchObject({ model: 'gpt-6-sol', effort: 'medium' });
  const { reasoningEffort: _effort, ...inherit } = request;
  expect(codexTurnParams(inherit)).not.toHaveProperty('effort');
  expect(codexThreadParams(inherit).config).not.toHaveProperty('model_reasoning_effort');
});

it.each(['auto', 'edit-only', 'unrestricted'] as const)(
  'restricts a read-only run (%s) to the read-only profile on new/resumed threads and every turn, with no escalation (R-I7)',
  (permissionMode) => {
    // A decision preparation or an investigation is read-only whatever its posture.
    for (const resume of [{}, { resumeSessionId: 'thread-1' }]) {
      const request = {
        cwd: '/work/x',
        prompt: 'Prepare a decision',
        permissionMode,
        readOnly: true,
        ...resume,
      };
      const thread = codexThreadParams(request);
      const turn = codexTurnParams(request);
      expect(thread).toMatchObject({
        permissions: READ_ONLY_PROFILE,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
      });
      expect(turn).toMatchObject({
        permissions: READ_ONLY_PROFILE,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
      });
      // Not the legacy read-only sandbox, which denies no reads, nor the writable profile.
      expect(thread).not.toHaveProperty('sandbox');
      expect(turn).not.toHaveProperty('sandboxPolicy');
      const config = thread.config as Record<string, unknown>;
      expect(config).toHaveProperty([`permissions.${READ_ONLY_PROFILE}`]);
      expect(config).not.toHaveProperty([`permissions.${PROFILE}`]);
      expect(config).not.toHaveProperty('sandbox_workspace_write.writable_roots');
    }
  },
);

it("denies a read-only run's commands the sandboxed runs' reads, and grants no write and no network (R-I7, operator decision 2026-10-12)", () => {
  const git = gitLayout();
  try {
    const request = {
      cwd: '/work/x',
      prompt: 'Investigate',
      permissionMode: 'auto' as const,
      readOnly: true,
      environment: { CARGO_HOME: '/nowhere/cargo-home' },
      deniedReads: ['/data/state', '/data/backups', '/home/op/.config/craftingtable'],
      // What a sandboxed run would be granted: none of it may reach the read-only profile.
      additionalDirectories: ['/runs/r1'],
      outsideSources: [
        { kind: 'cargo' as const, hosts: ['index.crates.io'], caches: ['/data/cargo-home/git'] },
      ],
      gitDirectories: git.gitDirectories,
    };
    const config = codexThreadParams(request).config as Record<string, unknown>;
    const profile = config[`permissions.${READ_ONLY_PROFILE}`];
    expect(profile).toEqual({
      // Reads as the account can, writes nothing, the temporary directories included.
      extends: ':read-only',
      // Exactly the sandboxed runs' list, each path denied, and nothing granted.
      filesystem: Object.fromEntries(codexDeniedReads(request).map((path) => [path, 'deny'])),
      network: { enabled: false },
    });
    const denied = Object.keys((profile as { filesystem: Record<string, string> }).filesystem);
    expect(denied).toEqual(
      expect.arrayContaining([
        `/run/user/${process.getuid?.()}`,
        join(homedir(), '.ssh'),
        join(homedir(), '.codex'),
        join(homedir(), '.claude'),
        '/data/state',
        '/data/backups',
        '/home/op/.config/craftingtable',
        '/nowhere/cargo-home/credentials.toml',
      ]),
    );
    // The same list a sandboxed run with the same request denies.
    const { readOnly: _readOnly, ...sandboxed } = request;
    expect(denied).toEqual(profileOf(sandboxed).denied);
    expect(config).not.toHaveProperty('features.network_proxy');
  } finally {
    rmSync(git.root, { recursive: true, force: true });
  }
});

it('refuses a read-only run whose denied reads would need more than one existing file masked, as a sandboxed one (R-I7)', () => {
  const home = mkdtempSync(join(tmpdir(), 'craftingtable-codex-reads-'));
  try {
    const files = [join(home, 'a.db'), join(home, 'b.json')];
    for (const file of files) writeFileSync(file, '');
    const request = {
      cwd: '/work/x',
      prompt: 'Investigate',
      environment: { CARGO_HOME: home },
      deniedReads: files,
    };
    for (const permissionMode of ['auto', 'edit-only', 'unrestricted'] as const)
      expect(codexUnmaskableFiles({ ...request, permissionMode, readOnly: true })).toEqual(
        expect.arrayContaining(files),
      );
    expect(codexUnmaskableFiles({ ...request, permissionMode: 'auto' })).toEqual(
      expect.arrayContaining(files),
    );
    // An unrestricted run has no sandbox, so nothing needs masking.
    expect(codexUnmaskableFiles({ ...request, permissionMode: 'unrestricted' })).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A repository's Git directories as Git lays them out for a linked worktree, on disk. */
function gitLayout() {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-codex-git-'));
  const common = join(root, 'repo', '.git');
  const own = join(common, 'worktrees', 'wt-1');
  for (const directory of ['objects/info', 'refs', 'logs', 'hooks', 'info'])
    mkdirSync(join(common, directory), { recursive: true });
  mkdirSync(own, { recursive: true });
  writeFileSync(join(common, 'config'), '');
  writeFileSync(join(own, 'commondir'), '../..\n');
  writeFileSync(join(own, 'gitdir'), `${join(root, 'wt-1', '.git')}\n`);
  return {
    root,
    common,
    own,
    gitDirectories: { gitDirectory: own, gitCommonDirectory: common, worktreeConfig: false },
  };
}

it("lets a sandboxed run's commands commit, through Git's objects, refs and logs and its own Git directory only (R-G14, operator decisions 2026-10-08)", () => {
  const git = gitLayout();
  try {
    for (const permissionMode of ['auto', 'edit-only'] as const) {
      const { profile } = profileOf({
        cwd: '/work/x',
        prompt: 'Go',
        permissionMode,
        outsideSources: [],
        gitDirectories: git.gitDirectories,
      });
      expect((profile as { filesystem: Record<string, string> }).filesystem).toEqual({
        // What staging and committing write in the common directory.
        [join(git.common, 'objects')]: 'write',
        [join(git.common, 'refs')]: 'write',
        [join(git.common, 'logs')]: 'write',
        // Not alternates, which would make Git read objects from elsewhere.
        [join(git.common, 'objects', 'info')]: 'read',
        // The run's own Git directory (index, HEAD), but not the files that say where the
        // repository is. The common directory itself (its config, hooks, info, commondir,
        // config.worktree, packed-refs, other worktrees) is not granted, so it stays read-only
        // without masking a path that does not exist (Codex 0.160.0 masks at most one).
        [git.own]: 'write',
        [join(git.own, 'commondir')]: 'read',
        [join(git.own, 'gitdir')]: 'read',
      });
    }
    // Without the daemon's resolved directories, nothing of Git is granted.
    expect(
      (
        profileOf({ cwd: '/work/x', prompt: 'Go', permissionMode: 'auto', outsideSources: [] })
          .profile as { filesystem: Record<string, string> }
      ).filesystem,
    ).toEqual({});
    // Read-only and unrestricted runs are unchanged.
    for (const request of [
      { permissionMode: 'auto' as const, readOnly: true },
      { permissionMode: 'unrestricted' as const },
    ])
      expect(
        JSON.stringify(
          codexThreadParams({
            cwd: '/work/x',
            prompt: 'Go',
            gitDirectories: git.gitDirectories,
            ...request,
          }),
        ),
      ).not.toContain(git.common);
  } finally {
    rmSync(git.root, { recursive: true, force: true });
  }
});

it("grants a reftable repository's ref store as it grants refs/, and only where it exists (R-G16 review L-1)", () => {
  const git = gitLayout();
  try {
    const filesystem = () =>
      (
        profileOf({
          cwd: '/work/x',
          prompt: 'Go',
          permissionMode: 'auto',
          outsideSources: [],
          gitDirectories: git.gitDirectories,
        }).profile as { filesystem: Record<string, string> }
      ).filesystem;
    // No rule for a path that does not exist: Codex would mask it.
    expect(filesystem()).not.toHaveProperty(join(git.common, 'reftable'));
    mkdirSync(join(git.common, 'reftable'));
    expect(filesystem()[join(git.common, 'reftable')]).toBe('write');
  } finally {
    rmSync(git.root, { recursive: true, force: true });
  }
});

it('grants no Git at all for a repository that enables per-worktree configuration (R-G14, operator decision 2026-10-08)', () => {
  const git = gitLayout();
  try {
    const { profile } = profileOf({
      cwd: '/work/x',
      prompt: 'Go',
      permissionMode: 'auto',
      outsideSources: [],
      gitDirectories: { ...git.gitDirectories, worktreeConfig: true },
    });
    expect((profile as { filesystem: Record<string, string> }).filesystem).toEqual({});
  } finally {
    rmSync(git.root, { recursive: true, force: true });
  }
});

it('grants no Git directory whose read-only part is missing, rather than mask a missing path (R-G14, operator decision 2026-10-08)', () => {
  for (const missing of ['objects/info', 'worktrees/wt-1/commondir', 'worktrees/wt-1/gitdir']) {
    const git = gitLayout();
    try {
      rmSync(join(git.common, missing), { recursive: true });
      const { profile } = profileOf({
        cwd: '/work/x',
        prompt: 'Go',
        permissionMode: 'auto',
        outsideSources: [],
        gitDirectories: git.gitDirectories,
      });
      expect((profile as { filesystem: Record<string, string> }).filesystem).toEqual({});
    } finally {
      rmSync(git.root, { recursive: true, force: true });
    }
  }
});

it("denies a sandboxed run's commands the reads Claude's sandbox denies, in the form Codex can mask (R-G14, operator decision 2026-10-08)", () => {
  const home = homedir();
  const request = {
    cwd: '/work/x',
    prompt: 'Go',
    permissionMode: 'auto' as const,
    environment: { CARGO_HOME: '/nowhere/cargo-home' },
    deniedReads: ['/data/state', '/data/backups', '/home/op/.config/craftingtable'],
  };
  const { denied } = profileOf(request);
  // Every directory on Claude's list, and the daemon's own files.
  expect(denied).toEqual(
    expect.arrayContaining([
      `/run/user/${process.getuid?.()}`,
      join(home, '.ssh'),
      join(home, '.gnupg'),
      join(home, '.aws'),
      join(home, '.docker'),
      join(home, '.config', 'gh'),
      join(home, '.codex'),
      '/data/state',
      '/data/backups',
      '/home/op/.config/craftingtable',
      // Missing files are passed through: Codex masks a path that does not exist.
      join(home, '.git-credentials'),
      '/nowhere/cargo-home/credentials.toml',
      '/nowhere/cargo-home/credentials',
    ]),
  );
  // All of `~/.claude`, in place of its credentials file: Codex 0.160.0 masks only one file.
  expect(denied).toContain(join(home, '.claude'));
  expect(denied.some((path) => path.endsWith('.credentials.json'))).toBe(false);
  // Nothing is denied twice, and an unrestricted run, with no sandbox, gets no list.
  expect(new Set(denied).size).toBe(denied.length);
  expect(
    JSON.stringify(codexThreadParams({ ...request, permissionMode: 'unrestricted' as const })),
  ).not.toContain('/data/state');
});

it('denies the Docker socket once, resolved through links (R-G14, operator decision 2026-10-08)', () => {
  const links: Record<string, string> = { '/var/run/docker.sock': '/run/docker.sock' };
  const denied = codexDeniedReads(
    { cwd: '/work/x', prompt: 'Go', permissionMode: 'auto' },
    (path) => links[path] ?? path,
  );
  expect(denied.filter((path) => path.endsWith('docker.sock'))).toEqual(['/run/docker.sock']);
  // Without the link, both are listed: each is a path of its own.
  const separate = codexDeniedReads(
    { cwd: '/work/x', prompt: 'Go', permissionMode: 'auto' },
    (path) => path,
  );
  expect(separate.filter((path) => path.endsWith('docker.sock'))).toEqual([
    '/var/run/docker.sock',
    '/run/docker.sock',
  ]);
});
