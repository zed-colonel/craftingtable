import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RAW_LINE_LIMIT_BYTES, TOOL_RESULT_LIMIT_BYTES } from '../bounded.js';
import { CodexStreamNormalizer } from './normalize.js';

const subject = () =>
  new CodexStreamNormalizer({ cwd: '/work/x', permissionMode: 'auto', billing: 'unknown' });
const fixture = readFileSync(new URL('../../fixtures/codex-stream.jsonl', import.meta.url), 'utf8');

it('normalizes two captured real turns with stable session identity and distinct tool identities', () => {
  const normalizer = subject();
  const events = fixture
    .trim()
    .split('\n')
    .flatMap((line) => normalizer.normalizeLine(line));
  expect(events.map((event) => event.kind)).toEqual([
    'session-started',
    'assistant-message',
    'tool-call',
    'tool-result',
    'tool-call',
    'tool-result',
    'assistant-message',
    'turn-completed',
    'assistant-message',
    'tool-call',
    'tool-result',
    'tool-call',
    'tool-result',
    'assistant-message',
    'turn-completed',
  ]);
  expect(events[0]?.payload).toMatchObject({
    backend: 'codex',
    backendSessionId: normalizer.threadId(),
    model: 'default',
    billing: 'unknown',
    permissionMode: 'auto',
    cwd: '/work/x',
  });
  const turns = events.filter((event) => event.kind === 'turn-completed');
  expect(turns.map((event) => event.payload.turns)).toEqual([1, 2]);
  expect(turns.map((event) => event.payload.resultText)).toEqual([
    'Created `HELLO.md` with `hello`. `ls` and outside-cwd read access verified.',
    'Appended `world` to `HELLO.md`; `ls` confirms the file exists.',
  ]);
  expect(turns.every((event) => event.payload.costUsd === undefined)).toBe(true);
  const calls = events.filter((event) => event.kind === 'tool-call');
  expect(calls[0]?.payload.summary).toContain('HELLO.md');
  expect(new Set(calls.map((event) => event.payload.toolUseId)).size).toBe(4);
  expect(
    events.filter((event) => event.kind === 'tool-result').every((event) => !event.payload.isError),
  ).toBe(true);
  expect(normalizer.turnEnded()).toBe(true);
  normalizer.beginTurn();
  expect(normalizer.turnEnded()).toBe(false);
  expect(normalizer.normalizeLine('{"type":"turn.completed"}')[0]?.payload).toMatchObject({
    resultText: '',
    turns: 3,
  });
});

it('bounds multibyte content and raw output including the truncation marker', () => {
  const normalizer = subject();
  const events = normalizer.normalizeLine(
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'command',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: '😀'.repeat(100000),
        exit_code: 2,
      },
    }),
  );
  expect(events[0]?.kind).toBe('tool-call');
  const result = events[1];
  expect(result?.kind).toBe('tool-result');
  if (result?.kind !== 'tool-result') throw new Error('Missing result');
  expect(result.payload.isError).toBe(true);
  expect(result.payload.truncated).toBe(true);
  expect(Buffer.byteLength(result.payload.content)).toBeLessThanOrEqual(TOOL_RESULT_LIMIT_BYTES);
  expect(Buffer.byteLength(result.raw ?? '')).toBeLessThanOrEqual(RAW_LINE_LIMIT_BYTES);
  expect(result.payload.content).not.toContain('�');
});

it('handles malformed and unknown output, tool variants, failures and missing fields without throwing', () => {
  const normalizer = subject();
  for (const value of [
    'not json',
    'null',
    '[]',
    '{"type":"item.completed"}',
    JSON.stringify({ type: 'new'.repeat(10000) }),
  ]) {
    const event = normalizer.normalizeLine(value)[0];
    expect(event?.kind).toBe('notice');
    if (event?.kind === 'notice') expect(event.payload.message.length).toBeLessThanOrEqual(4000);
  }
  for (const type of ['mcp_tool_call', 'web_search', 'file_change']) {
    expect(
      normalizer
        .normalizeLine(JSON.stringify({ type: 'item.completed', item: { type, id: type } }))
        .map((event) => event.kind),
    ).toEqual(['tool-call', 'tool-result']);
  }
  expect(
    normalizer.normalizeLine('{"type":"error","message":"rate limit reached"}')[0]?.payload,
  ).toMatchObject({ category: 'rate-limit' });
  expect(
    normalizer.normalizeLine('{"type":"turn.failed","error":{"message":"failed"}}')[0]?.payload,
  ).toMatchObject({ outcome: 'error', resultText: 'failed' });
  expect(normalizer.turnFailed()).toBe(true);
});

it('records a requested model and only emits one session-started', () => {
  const normalizer = new CodexStreamNormalizer({
    cwd: '/work/x',
    permissionMode: 'edit-only',
    requestedModel: 'custom',
    billing: 'api-key',
  });
  const line = '{"type":"thread.started","thread_id":"thread-1"}';
  expect(normalizer.normalizeLine(line)[0]?.payload).toMatchObject({
    model: 'custom',
    billing: 'api-key',
  });
  expect(normalizer.normalizeLine(line)).toEqual([]);
});
