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

it('requires one unambiguous work-item or plan-version execution subject', async () => {
  const { worktreeSummarySchema, agentRunSummarySchema } = await import('./execution.js');
  const common = {
    id: 'tree-1',
    workspaceId: 'workspace-1',
    repositoryId: 'repo-1',
    projectId: 'project-1',
    createdAt: '2026-09-12T00:00:00.000Z',
    createdByUserId: 'user-1',
    version: 1,
  };
  const records = [
    {
      schema: worktreeSummarySchema,
      value: {
        ...common,
        branchName: 'candidate',
        baseSha: '1'.repeat(40),
        baseBranch: 'revision',
        path: '/worktrees/candidate',
        status: 'active',
      },
    },
    {
      schema: agentRunSummarySchema,
      value: {
        ...common,
        worktreeId: 'tree-1',
        backend: 'claude-code',
        role: 'review',
        status: 'running',
        permissionMode: 'auto',
        turnCount: 0,
      },
    },
  ];
  for (const { schema, value } of records) {
    expect(schema.safeParse({ ...value, workItemId: 'item-1' }).success).toBe(true);
    expect(schema.safeParse({ ...value, planVersionId: 'plan-1' }).success).toBe(true);
    expect(schema.safeParse(value).success).toBe(false);
    expect(
      schema.safeParse({ ...value, workItemId: 'item-1', planVersionId: 'plan-1' }).success,
    ).toBe(false);
  }
});
