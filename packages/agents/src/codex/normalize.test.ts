import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RAW_LINE_LIMIT_BYTES, TOOL_RESULT_LIMIT_BYTES } from '../bounded.js';
import { CodexStreamNormalizer } from './normalize.js';

it('normalizes tool lifecycle once, ignores deltas and user echoes, and keeps final text and per-turn usage', () => {
  const normalizer = new CodexStreamNormalizer();
  normalizer.beginTurn();
  const item = { type: 'commandExecution', id: 'cmd', command: 'ls' };
  expect(normalizer.normalize('item/started', { item })[0]?.kind).toBe('tool-call');
  expect(normalizer.normalize('item/agentMessage/delta', { delta: 'partial' })).toEqual([]);
  expect(
    normalizer.normalize('item/completed', {
      item: { type: 'userMessage', id: 'user', text: 'echo' },
    }),
  ).toEqual([]);
  const completed = {
    item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'file' },
  };
  expect(normalizer.normalize('item/completed', completed)).toMatchObject([
    { kind: 'tool-result', payload: { content: 'file', isError: false } },
  ]);
  expect(normalizer.normalize('item/completed', completed)).toEqual([]);
  normalizer.normalize('item/completed', {
    item: { type: 'agentMessage', id: 'final', text: 'VERDICT: mergeable' },
  });
  const usage = {
    inputTokens: 50,
    cachedInputTokens: 30,
    outputTokens: 10,
    reasoningOutputTokens: 5,
    totalTokens: 60,
  };
  normalizer.normalize('thread/tokenUsage/updated', { tokenUsage: { last: usage, total: usage } });
  expect(normalizer.complete({ status: 'completed' }, 'resolved', 0.04)).toMatchObject({
    kind: 'turn-completed',
    payload: {
      resultText: 'VERDICT: mergeable',
      turns: 1,
      model: 'resolved',
      tokenUsage: usage,
      costUsd: 0.04,
    },
  });
  normalizer.beginTurn();
  expect(normalizer.complete({ status: 'completed' }, 'resolved').payload).toMatchObject({
    resultText: '',
    turns: 2,
  });
  expect(normalizer.complete({ status: 'completed' }, 'resolved').payload).not.toHaveProperty(
    'tokenUsage',
  );
});

it('bounds multibyte content and raw output including the truncation marker', () => {
  const normalizer = new CodexStreamNormalizer();
  const events = normalizer.normalize('item/completed', {
    item: {
      id: 'command',
      type: 'commandExecution',
      command: 'ls',
      aggregatedOutput: '😀'.repeat(100000),
      exitCode: 2,
    },
  });
  const result = events[1];
  if (result?.kind !== 'tool-result') throw new Error('Missing result');
  expect(result.payload.isError).toBe(true);
  expect(result.payload.truncated).toBe(true);
  expect(Buffer.byteLength(result.payload.content)).toBeLessThanOrEqual(TOOL_RESULT_LIMIT_BYTES);
  expect(Buffer.byteLength(result.raw ?? '')).toBeLessThanOrEqual(RAW_LINE_LIMIT_BYTES);
  expect(result.payload.content).not.toContain('�');
});

it('handles tools, compaction, failures and malformed optional usage without inventing metadata', () => {
  const normalizer = new CodexStreamNormalizer();
  for (const type of [
    'mcpToolCall',
    'webSearch',
    'fileChange',
    'dynamicToolCall',
    'collabAgentToolCall',
  ]) {
    expect(
      normalizer
        .normalize('item/completed', { item: { type, id: type } })
        .map((event) => event.kind),
    ).toEqual(['tool-call', 'tool-result']);
  }
  expect(
    normalizer.normalize('error', { error: { message: 'rate limit reached' } })[0]?.payload,
  ).toMatchObject({ category: 'rate-limit' });
  expect(
    normalizer.normalize('item/completed', {
      item: { type: 'contextCompaction', id: 'compact' },
    })[0]?.payload,
  ).toMatchObject({ category: 'compaction' });
  normalizer.normalize('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: -1 } } });
  const result = normalizer.complete({ status: 'failed', error: { message: 'failed' } }, 'model');
  expect(result.payload).toMatchObject({ outcome: 'error', resultText: 'failed' });
  expect(result.payload).not.toHaveProperty('costUsd');
  expect(result.payload).not.toHaveProperty('tokenUsage');
});

it('replays two captured app-server turns and counts all model responses once', () => {
  const normalizer = new CodexStreamNormalizer();
  const events = [];
  const fixture = readFileSync(
    new URL('../../fixtures/codex-app-server.jsonl', import.meta.url),
    'utf8',
  );
  for (const line of fixture.trim().split('\n')) {
    const { method, params } = JSON.parse(line);
    if (method === 'turn/started') normalizer.beginTurn();
    else if (method === 'turn/completed')
      events.push(normalizer.complete(params.turn, 'gpt-5.6-luna'));
    else {
      events.push(...normalizer.normalize(method, params));
      if (method === 'thread/tokenUsage/updated') normalizer.normalize(method, params);
    }
  }
  const turns = events.filter((event) => event.kind === 'turn-completed');
  expect(turns.map((event) => event.payload.tokenUsage?.totalTokens)).toEqual([32304, 32782]);
  expect(turns[1]?.payload.resultText).toContain('app server verified');
  expect(
    events.filter((event) => event.kind === 'tool-call').map((event) => event.payload.name),
  ).toEqual(['file-change', 'command', 'command']);
  expect(
    events.filter((event) => event.kind === 'tool-result').every((event) => !event.payload.isError),
  ).toBe(true);
  expect(
    new Set(
      events.filter((event) => event.kind === 'tool-call').map((event) => event.payload.toolUseId),
    ).size,
  ).toBe(3);
});

it('excludes previous history from a resumed thread and marks declined commands as errors', () => {
  const normalizer = new CodexStreamNormalizer(true);
  normalizer.beginTurn();
  const last = {
    inputTokens: 10,
    cachedInputTokens: 5,
    outputTokens: 2,
    reasoningOutputTokens: 1,
    totalTokens: 12,
  };
  const total = {
    inputTokens: 110,
    cachedInputTokens: 55,
    outputTokens: 22,
    reasoningOutputTokens: 11,
    totalTokens: 132,
  };
  normalizer.normalize('thread/tokenUsage/updated', { tokenUsage: { last, total } });
  expect(normalizer.complete({ status: 'completed' }, 'model').payload).toMatchObject({
    tokenUsage: last,
  });
  expect(
    normalizer.normalize('item/completed', {
      item: { type: 'commandExecution', id: 'denied', status: 'declined', exitCode: null },
    })[1]?.payload,
  ).toMatchObject({ isError: true });
});
