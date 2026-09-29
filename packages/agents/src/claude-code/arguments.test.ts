import { expect, it } from 'vitest';
import { claudeCodeArguments } from './arguments.js';
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
  expect(sandbox.network).toEqual({
    allowLocalBinding: true,
    strictAllowlist: true,
    allowedDomains: [],
  });
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
