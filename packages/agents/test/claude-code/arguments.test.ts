import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claudeCodeArguments } from '../../src/claude-code/arguments.js';
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
