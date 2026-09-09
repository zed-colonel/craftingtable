import { expect, it } from 'vitest';
import { startAgentRunRequestSchema } from './execution.js';

it('accepts an optional known backend and rejects unknown backends', () => {
  const input = { worktreeId: 'worktree-1' };
  expect(startAgentRunRequestSchema.parse(input).backend).toBeUndefined();
  expect(startAgentRunRequestSchema.parse({ ...input, backend: 'codex' }).backend).toBe('codex');
  expect(startAgentRunRequestSchema.safeParse({ ...input, backend: 'gemini' }).success).toBe(false);
});

it('validates optional turn telemetry while keeping historical events readable', async () => {
  const { runEventEnvelopeSchema } = await import('./execution.js');
  const base = {
    sequence: 1,
    id: 'event-1',
    workspaceId: 'ws-1',
    runId: 'run-1',
    occurredAt: '2026-09-09T00:00:00.000Z',
    kind: 'turn-completed',
    payload: { outcome: 'success', resultText: 'done', turns: 1, durationMs: 100 },
  };
  expect(runEventEnvelopeSchema.safeParse(base).success).toBe(true);
  const tokenUsage = {
    inputTokens: 10,
    cachedInputTokens: 5,
    outputTokens: 2,
    reasoningOutputTokens: 1,
    totalTokens: 12,
  };
  const enriched = { ...base, payload: { ...base.payload, model: 'resolved', tokenUsage } };
  expect(runEventEnvelopeSchema.safeParse(enriched).success).toBe(true);
  for (const totalTokens of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      runEventEnvelopeSchema.safeParse({
        ...enriched,
        payload: { ...enriched.payload, tokenUsage: { ...tokenUsage, totalTokens } },
      }).success,
    ).toBe(false);
  }
});
