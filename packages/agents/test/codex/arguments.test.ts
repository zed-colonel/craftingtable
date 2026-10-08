import { expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexDeniedReads, codexThreadParams, codexTurnParams } from '../../src/codex/arguments.js';
import { cargoOutsideSource } from '../../src/outside-sources.js';

const PROFILE = 'craftingtable';

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

it('gives read-only and unrestricted runs no sources and no profile (R-G14)', () => {
  const sources = [{ kind: 'cargo' as const, hosts: ['index.crates.io'], caches: ['/c/registry'] }];
  for (const request of [
    { permissionMode: 'auto' as const, readOnly: true },
    { permissionMode: 'unrestricted' as const },
  ]) {
    const full = { cwd: '/work/x', prompt: 'Go', outsideSources: sources, ...request };
    const thread = codexThreadParams(full);
    const config = thread.config as Record<string, unknown>;
    expect(thread).not.toHaveProperty('permissions');
    expect(codexTurnParams(full)).not.toHaveProperty('permissions');
    expect(Object.keys(config).filter((key) => /permissions|network_proxy/.test(key))).toEqual([]);
    expect(JSON.stringify(thread)).not.toContain('index.crates.io');
  }
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

it('restricts decision preparation to read-only with no escalation on every turn', () => {
  const request = {
    cwd: '/work/x',
    prompt: 'Prepare a decision',
    permissionMode: 'unrestricted' as const,
    readOnly: true,
  };
  expect(codexThreadParams(request)).toMatchObject({
    sandbox: 'read-only',
    approvalPolicy: 'never',
  });
  expect(codexTurnParams(request)).toMatchObject({
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'never',
  });
});

it("lets a sandboxed run's commands commit: its Git directories writable, but not the repository's config, hooks or info (R-G14, operator decision 2026-10-08)", () => {
  const gitDirectories = {
    gitDirectory: '/src/repo/.git/worktrees/wt-1',
    gitCommonDirectory: '/src/repo/.git',
  };
  for (const permissionMode of ['auto', 'edit-only'] as const) {
    const { profile } = profileOf({
      cwd: '/work/x',
      prompt: 'Go',
      permissionMode,
      outsideSources: [],
      gitDirectories,
    });
    expect((profile as { filesystem: Record<string, string> }).filesystem).toEqual({
      '/src/repo/.git': 'write',
      // Codex keeps the worktree's own Git directory read-only unless it is named itself.
      '/src/repo/.git/worktrees/wt-1': 'write',
      // The daemon's own Git reads them: settings, hook programs, and attributes (which could pick
      // another merge driver for its merges) stay as the repository has them.
      '/src/repo/.git/config': 'read',
      '/src/repo/.git/hooks': 'read',
      '/src/repo/.git/info': 'read',
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
        codexThreadParams({ cwd: '/work/x', prompt: 'Go', gitDirectories, ...request }),
      ),
    ).not.toContain('/src/repo/.git');
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
  // Nothing is denied twice, and only sandboxed runs get the list.
  expect(new Set(denied).size).toBe(denied.length);
  for (const other of [
    { ...request, readOnly: true },
    { ...request, permissionMode: 'unrestricted' as const },
  ])
    expect(JSON.stringify(codexThreadParams(other))).not.toContain('/data/state');
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
