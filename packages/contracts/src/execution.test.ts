import { expect, it } from 'vitest';
import { startAgentRunRequestSchema } from './execution.js';

it('accepts an optional known backend and rejects unknown backends', () => {
  const input = { worktreeId: 'worktree-1' };
  expect(startAgentRunRequestSchema.parse(input).backend).toBeUndefined();
  expect(startAgentRunRequestSchema.parse({ ...input, backend: 'codex' }).backend).toBe('codex');
  expect(startAgentRunRequestSchema.safeParse({ ...input, backend: 'gemini' }).success).toBe(false);
});
