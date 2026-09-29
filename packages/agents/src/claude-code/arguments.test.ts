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
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
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
