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

it('bounds multibyte content including the truncation marker, keeping no raw line', () => {
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
  expect(result.payload.content).not.toContain('�');
  // A normalized tool call and result carry no copy of the vendor notification (R-H2).
  expect(events.map((event) => event.raw)).toEqual([undefined, undefined]);
});

it('keeps a bounded raw notification only for an item it cannot represent (R-H2)', () => {
  const normalizer = new CodexStreamNormalizer();
  const [unknown] = normalizer.normalize('item/completed', {
    item: { id: 'new', type: 'hologram', payload: 'x'.repeat(100_000) },
  });
  expect(unknown?.kind === 'notice' && unknown.payload.message).toBe('Backend item: hologram');
  expect(unknown?.raw).toMatch(/^\{"method":"item\/completed"/);
  expect(Buffer.byteLength(unknown?.raw ?? '')).toBeLessThanOrEqual(RAW_LINE_LIMIT_BYTES);
  const [failure] = normalizer.normalize('error', { error: { message: 'boom' }, willRetry: true });
  expect(failure?.raw).toBeUndefined();
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

it('marks oversized assistant and final messages so downstream reports cannot appear complete', () => {
  const normalizer = new CodexStreamNormalizer();
  normalizer.beginTurn();
  const events = normalizer.normalize('item/completed', {
    item: { type: 'agentMessage', id: 'large', text: '😀'.repeat(70000) },
  });
  expect(events[0]).toMatchObject({ kind: 'assistant-message', payload: { truncated: true } });
  expect(normalizer.complete({ status: 'completed' }, 'model')).toMatchObject({
    kind: 'turn-completed',
    payload: { truncated: true },
  });
  normalizer.beginTurn();
  normalizer.normalize('item/completed', {
    item: { type: 'agentMessage', id: 'small', text: 'Complete report.' },
  });
  expect(normalizer.complete({ status: 'completed' }, 'model').payload).not.toHaveProperty(
    'truncated',
  );
});

it('classifies terminal service errors from structured fields, never assistant prose', () => {
  const n = new CodexStreamNormalizer();
  n.beginTurn();
  n.normalize('item/completed', {
    item: { type: 'agentMessage', id: 'a', text: 'serverOverloaded: retry me' },
  });
  expect(
    n.complete({ status: 'failed', error: { message: 'serverOverloaded' } }, 'model').payload,
  ).toMatchObject({ providerFailure: { kind: 'unknown', safeToRetry: false } });
  n.normalize('error', { error: { codexErrorInfo: 'serverOverloaded' }, willRetry: false });
  expect(n.complete({ status: 'failed' }, 'model').payload).toMatchObject({
    providerFailure: { kind: 'capacity', safeToRetry: true },
  });
  n.normalize('error', { error: { codexErrorInfo: 'serverOverloaded' }, willRetry: true });
  expect(n.complete({ status: 'failed' }, 'model').payload).toMatchObject({
    providerFailure: { safeToRetry: false },
  });
});

it('does not retry ambiguous tools, interactive requests, auth, quotas or unknown failures', () => {
  const n = new CodexStreamNormalizer();
  const error = { codexErrorInfo: 'serverOverloaded' };
  n.beginTurn();
  const item = { type: 'commandExecution', id: 'cmd', command: 'do work' };
  n.normalize('item/started', { item });
  expect(n.complete({ status: 'failed', error }, 'model').payload).toMatchObject({
    providerFailure: { safeToRetry: false },
  });
  n.beginTurn();
  n.normalize('item/started', { item });
  n.normalize('item/completed', { item: { ...item, exitCode: 1, status: 'completed' } });
  expect(n.complete({ status: 'failed', error }, 'model').payload).toMatchObject({
    providerFailure: { safeToRetry: true },
  });
  n.requireOperator();
  expect(n.complete({ status: 'failed', error }, 'model').payload).toMatchObject({
    providerFailure: { safeToRetry: false },
  });
  for (const codexErrorInfo of [
    'unauthorized',
    'usageLimitExceeded',
    'rateLimitExceeded',
    'badRequest',
    { httpConnectionFailed: { httpStatusCode: 429 } },
  ]) {
    n.beginTurn();
    expect(
      n.complete({ status: 'failed', error: { codexErrorInfo } }, 'model').payload,
    ).toMatchObject({ providerFailure: { safeToRetry: false } });
  }
  for (const codexErrorInfo of [
    'internalServerError',
    { responseStreamDisconnected: { httpStatusCode: null } },
    { httpConnectionFailed: { httpStatusCode: 503 } },
  ]) {
    n.beginTurn();
    expect(
      n.complete({ status: 'failed', error: { codexErrorInfo } }, 'model').payload,
    ).toMatchObject({ providerFailure: { safeToRetry: true } });
  }
});

function replayFixture(name: string) {
  const normalizer = new CodexStreamNormalizer();
  const events = [];
  const fixture = readFileSync(
    new URL(`../../fixtures/provider-failures/${name}.jsonl`, import.meta.url),
    'utf8',
  );
  for (const line of fixture.trim().split('\n')) {
    const { method, params } = JSON.parse(line);
    if (method === 'turn/started') normalizer.beginTurn();
    else if (method === 'turn/completed') events.push(normalizer.complete(params.turn, 'model'));
    else events.push(...normalizer.normalize(method, params));
  }
  return events;
}

it.each([
  ['codex-sleep-then-overloaded', 'capacity', true],
  ['codex-internal-server-error', 'unavailable', true],
  ['codex-stream-disconnected', 'transport', true],
  ['codex-overloaded-pending-command', 'capacity', false],
  ['codex-delegated-then-overloaded', 'capacity', false],
  ['codex-usage-limit', 'quota', false],
  ['codex-rate-limit-http', 'quota', false],
  ['codex-unauthorized', 'authentication', false],
  ['codex-bad-request', 'unknown', false],
] as const)('recorded %s is classified as %s (retry %s)', (name, kind, safeToRetry) => {
  const turn = replayFixture(name).at(-1);
  expect(turn).toMatchObject({
    kind: 'turn-completed',
    payload: { outcome: 'error', providerFailure: { kind, safeToRetry } },
  });
});

it('treats waits and other informational items as benign and silent', () => {
  const events = replayFixture('codex-sleep-then-overloaded');
  expect(events.some((e) => e.kind === 'notice' && /Backend item/.test(e.payload.message))).toBe(
    false,
  );
  const n = new CodexStreamNormalizer();
  n.beginTurn();
  for (const type of ['sleep', 'plan', 'imageView', 'enteredReviewMode', 'exitedReviewMode'])
    expect(n.normalize('item/completed', { item: { type, id: type } })).toEqual([]);
  n.normalize('error', { error: { codexErrorInfo: 'serverOverloaded' }, willRetry: false });
  expect(n.complete({ status: 'failed' }, 'model').payload).toMatchObject({
    providerFailure: { kind: 'capacity', safeToRetry: true },
  });
});

it('keeps unknown items conservative but reports each type once per run', () => {
  const n = new CodexStreamNormalizer();
  n.beginTurn();
  const item = (id: string) => ({ item: { type: 'subAgentActivity', id } });
  expect(n.normalize('item/completed', item('a'))).toHaveLength(1);
  expect(n.normalize('item/completed', item('b'))).toEqual([]);
  n.normalize('error', { error: { codexErrorInfo: 'serverOverloaded' }, willRetry: false });
  expect(n.complete({ status: 'failed' }, 'model').payload).toMatchObject({
    providerFailure: { kind: 'capacity', safeToRetry: false },
  });
  n.beginTurn();
  expect(n.normalize('item/completed', item('c'))).toEqual([]);
});
