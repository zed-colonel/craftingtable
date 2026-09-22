import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCodeArguments, claudeUserMessageLine } from './arguments.js';
import { ClaudeStreamNormalizer, summarizeToolCall, TOOL_RESULT_LIMIT_BYTES } from './normalize.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/claude-stream.jsonl', import.meta.url));
const fixtureLines = readFileSync(fixturePath, 'utf8').split('\n');

function normalizer(): ClaudeStreamNormalizer {
  return new ClaudeStreamNormalizer({ permissionMode: 'auto', cwd: '/work/example' });
}

describe('claudeCodeArguments', () => {
  it('builds a discrete argument vector for a headless multi-turn session', () => {
    expect(
      claudeCodeArguments({
        cwd: '/work/example',
        prompt: 'do the thing',
        permissionMode: 'auto',
        model: 'opus',
        additionalDirectories: ['/data/runs/run-1'],
        appendSystemPrompt: 'Be brief.',
        maxBudgetUsd: 5,
        sessionName: 'ct: AQ-01',
      }),
    ).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompts',
      'none',
      '--permission-mode',
      'auto',
      '--model',
      'opus',
      '--append-system-prompt',
      'Be brief.',
      '--add-dir',
      '/data/runs/run-1',
      '--max-budget-usd',
      '5',
      '--name',
      'ct: AQ-01',
    ]);
  });

  it('maps each permission posture and never puts the prompt in argv', () => {
    const base = {
      cwd: '/w',
      prompt: 'rm -rf / ; echo pwned',
      permissionMode: 'edit-only',
    } as const;
    expect(claudeCodeArguments(base)).toContain('acceptEdits');
    expect(claudeCodeArguments({ ...base, permissionMode: 'unrestricted' })).toContain(
      '--dangerously-skip-permissions',
    );
    expect(claudeCodeArguments(base).join(' ')).not.toContain('pwned');
    expect(claudeCodeArguments({ ...base, resumeSessionId: 'abc' })).toContain('--resume');
  });

  it('serialises a user message as one stream-json line', () => {
    const line = claudeUserMessageLine('hello\nworld');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello\nworld' }] },
    });
    expect(line.slice(0, -1)).not.toContain('\n');
  });
});

describe('ClaudeStreamNormalizer', () => {
  it('translates a real captured session into normalized events in order', () => {
    const subject = normalizer();
    const events = fixtureLines.flatMap((line) => subject.normalizeLine(line));
    expect(events.map((event) => event.kind)).toEqual([
      'session-started',
      'assistant-message',
      'tool-call',
      'tool-result',
      'tool-call',
      'tool-result',
      'assistant-message',
      'turn-completed',
    ]);
    const started = events[0];
    expect(started?.kind === 'session-started' && started.payload).toMatchObject({
      backend: 'claude-code',
      backendSessionId: '359953b9-dd4b-4188-ae34-dc57e2d117c5',
      model: 'claude-fable-5-1',
      permissionMode: 'auto',
      cwd: '/work/example',
      billing: 'subscription',
    });
    expect(subject.backendSessionId).toBe('359953b9-dd4b-4188-ae34-dc57e2d117c5');

    const firstCall = events[2];
    expect(firstCall?.kind === 'tool-call' && firstCall.payload).toMatchObject({
      toolUseId: 'toolu_01A1CmvSZ1pLoL3ZmtmZVqkX',
      name: 'Bash',
      summary: 'List files in current directory',
    });
    const firstResult = events[3];
    expect(firstResult?.kind === 'tool-result' && firstResult.payload).toEqual({
      toolUseId: 'toolu_01A1CmvSZ1pLoL3ZmtmZVqkX',
      content: 'note.txt\nstream.err\nstream.jsonl',
      isError: false,
      truncated: false,
    });
    const completed = events.at(-1);
    expect(completed?.kind === 'turn-completed' && completed.payload).toMatchObject({
      outcome: 'success',
      resultText: 'done',
      turns: 3,
    });
    expect(completed?.raw).toBeDefined();
  });

  it('emits session-started once even though every turn re-inits', () => {
    const subject = normalizer();
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
    expect(subject.normalizeLine(init)).toHaveLength(1);
    expect(subject.normalizeLine(init)).toHaveLength(0);
  });

  it('reports the billing source from the init message', () => {
    const withKey = normalizer().normalizeLine(
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }),
    )[0];
    expect(withKey?.kind === 'session-started' && withKey.payload.billing).toBe('api-key');
    const unknown = normalizer().normalizeLine(
      JSON.stringify({ type: 'system', subtype: 'init' }),
    )[0];
    expect(unknown?.kind === 'session-started' && unknown.payload.billing).toBe('unknown');
  });

  it('drops thinking-token pings and task bookkeeping, keeps task lifecycle notices', () => {
    const subject = normalizer();
    expect(
      subject.normalizeLine(
        JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 }),
      ),
    ).toEqual([]);
    expect(
      subject.normalizeLine(
        JSON.stringify({ type: 'system', subtype: 'task_updated', patch: { status: 'done' } }),
      ),
    ).toEqual([]);
    expect(
      subject.normalizeLine(
        JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }),
      ),
    ).toEqual([]);
    const [started] = subject.normalizeLine(
      JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        task_type: 'local_bash',
        description: 'Run the test suite in background',
      }),
    );
    expect(started?.kind === 'notice' && started.payload).toEqual({
      category: 'task',
      message: 'Background task started: Run the test suite in background',
    });
    const [finished] = subject.normalizeLine(
      JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        status: 'completed',
        summary: 'Background command "Run the test suite" completed (exit code 0)',
      }),
    );
    expect(finished?.kind === 'notice' && finished.payload.message).toBe(
      'Background task completed: Background command "Run the test suite" completed (exit code 0)',
    );
  });

  it('turns malformed or unknown lines into bounded notices instead of throwing', () => {
    const subject = normalizer();
    const garbage = subject.normalizeLine('{not json');
    expect(garbage[0]?.kind).toBe('notice');
    const unknown = subject.normalizeLine(
      JSON.stringify({ type: 'mystery', big: 'x'.repeat(100_000) }),
    );
    expect(unknown[0]?.kind).toBe('notice');
    expect(Buffer.byteLength(unknown[0]?.raw ?? '', 'utf8')).toBeLessThan(70_000);
    expect(subject.normalizeLine('')).toEqual([]);
    expect(subject.normalizeLine('[1,2,3]')).toEqual([]);
  });

  it('bounds oversized tool results and flags truncation', () => {
    const subject = normalizer();
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'y'.repeat(TOOL_RESULT_LIMIT_BYTES * 2),
            is_error: true,
          },
        ],
      },
    });
    const [event] = subject.normalizeLine(line);
    expect(event?.kind === 'tool-result' && event.payload.truncated).toBe(true);
    expect(event?.kind === 'tool-result' && event.payload.isError).toBe(true);
    expect(
      event?.kind === 'tool-result' && Buffer.byteLength(event.payload.content, 'utf8'),
    ).toBeLessThan(TOOL_RESULT_LIMIT_BYTES + 100);
  });

  it('classifies a failed turn and reports rate-limit notices only when not allowed', () => {
    const subject = normalizer();
    const [failed] = subject.normalizeLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9 }),
    );
    expect(failed?.kind === 'turn-completed' && failed.payload).toMatchObject({
      outcome: 'error',
      turns: 9,
      resultText: 'Turn ended: error_max_turns',
    });
    expect(
      subject.normalizeLine(
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
      ),
    ).toEqual([]);
    const [limited] = subject.normalizeLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
      }),
    );
    expect(limited?.kind === 'notice' && limited.payload.category).toBe('rate-limit');
  });

  it('summarises tool calls by their most useful field', () => {
    expect(summarizeToolCall('Bash', { command: 'pnpm test', description: 'Run tests' })).toBe(
      'Run tests',
    );
    expect(summarizeToolCall('Edit', { file_path: '/w/a.ts' })).toBe('/w/a.ts');
    expect(summarizeToolCall('Grep', { pattern: 'foo' })).toBe('foo');
    expect(summarizeToolCall('Custom', { alpha: 1, beta: 'two' })).toBe('alpha=1 beta=two');
    expect(summarizeToolCall('Custom', 'not-an-object')).toBe('Custom');
  });
});

it('marks oversized assistant messages and final results as truncated', () => {
  const subject = normalizer();
  const text = '😀'.repeat(70000);
  const assistant = subject.normalizeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  );
  expect(assistant[0]).toMatchObject({ kind: 'assistant-message', payload: { truncated: true } });
  const final = subject.normalizeLine(
    JSON.stringify({ type: 'result', result: text, subtype: 'success', is_error: false }),
  );
  expect(final[0]).toMatchObject({ kind: 'turn-completed', payload: { truncated: true } });
});

it('normalizes Claude service errors conservatively and requires settled tool results', () => {
  const n = normalizer();
  const send = (message: unknown) => n.normalizeLine(JSON.stringify(message));
  const result = () => send({ type: 'result', subtype: 'error_during_execution', is_error: true });
  send({ type: 'assistant', error: 'server_error', message: { content: [] } });
  expect(result()[0]?.payload).toMatchObject({
    providerFailure: { kind: 'unavailable', safeToRetry: true },
  });
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash' }] } });
  send({ type: 'assistant', error: 'server_error', message: { content: [] } });
  expect(result()[0]?.payload).toMatchObject({ providerFailure: { safeToRetry: false } });
  send({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] },
  });
  send({ type: 'assistant', error: 'server_error', message: { content: [] } });
  expect(result()[0]?.payload).toMatchObject({ providerFailure: { safeToRetry: true } });
  expect(result()[0]?.payload).not.toHaveProperty('providerFailure');
  for (const error of ['authentication_failed', 'billing_error', 'rate_limit', 'unknown']) {
    send({ type: 'assistant', error, message: { content: [] } });
    expect(result()[0]?.payload).toMatchObject({ providerFailure: { safeToRetry: false } });
  }
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'server_error' }] } });
  expect(result()[0]?.payload).not.toHaveProperty('providerFailure');
});
