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
