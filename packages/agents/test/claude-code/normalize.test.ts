import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCodeArguments, claudeUserMessageLine } from '../../src/claude-code/arguments.js';
import {
  ClaudeStreamNormalizer,
  summarizeToolCall,
  TOOL_RESULT_LIMIT_BYTES,
} from '../../src/claude-code/normalize.js';

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
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--settings',
      JSON.stringify({
        autoMemoryEnabled: false,
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          autoAllowBashIfSandboxed: true,
          filesystem: {
            denyRead: [
              `/run/user/${process.getuid?.()}`,
              '/var/run/docker.sock',
              '/run/docker.sock',
              '~/.ssh',
              '~/.gnupg',
              '~/.aws',
              '~/.docker',
              '~/.config/gh',
              '~/.git-credentials',
              '~/.codex',
              '~/.claude/.credentials.json',
              join(homedir(), '.cargo', 'credentials.toml'),
              join(homedir(), '.cargo', 'credentials'),
            ],
            allowWrite: [join(homedir(), '.cargo', 'registry'), join(homedir(), '.cargo', 'git')],
          },
          network: {
            allowLocalBinding: true,
            strictAllowlist: true,
            allowedDomains: ['index.crates.io', 'static.crates.io'],
          },
        },
      }),
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
    // Every line here normalized fully, so none keeps its vendor line (R-H2).
    expect(events.filter((event) => event.raw !== undefined)).toEqual([]);
  });

  it('emits session-started once even though every turn re-inits', () => {
    const subject = normalizer();
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
    expect(subject.normalizeLine(init)).toHaveLength(1);
    expect(subject.normalizeLine(init)).toHaveLength(0);
  });

  it('records the skills, plugins and MCP servers the session loaded (R-G5)', () => {
    const [started] = normalizer().normalizeLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        model: 'm',
        skills: ['review'],
        plugins: [{ name: 'agents-md', path: '/x' }],
        mcp_servers: [{ name: 'docs', status: 'connected' }],
      }),
    );
    expect(started?.kind === 'session-started' && started.payload.loaded).toEqual({
      skills: ['review'],
      plugins: ['agents-md'],
      mcpServers: ['docs'],
    });
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
    // A line the normalizer cannot represent keeps its raw text for diagnosis (R-H2).
    expect(garbage[0]?.raw).toBe('{not json');
    const unknown = subject.normalizeLine(
      JSON.stringify({ type: 'mystery', big: 'x'.repeat(100_000) }),
    );
    expect(unknown[0]?.kind).toBe('notice');
    expect(unknown[0]?.raw).toMatch(/^\{"type":"mystery"/);
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

describe('recorded provider failures', () => {
  function replay(name: string) {
    const subject = normalizer();
    const lines = readFileSync(
      fileURLToPath(new URL(`../../fixtures/provider-failures/${name}.jsonl`, import.meta.url)),
      'utf8',
    )
      .trim()
      .split('\n');
    const events = lines.flatMap((line) => subject.normalizeLine(line));
    const turn = events.at(-1);
    if (turn?.kind !== 'turn-completed') throw new Error(`${name} did not end a turn`);
    return turn.payload;
  }

  it.each([
    ['claude-overloaded', 'capacity', true],
    ['claude-server-error', 'unavailable', true],
    ['claude-error-during-execution', 'unavailable', true],
    ['claude-overloaded-pending-tool', 'capacity', false],
    ['claude-session-limit', 'quota', true],
    ['claude-authentication', 'authentication', false],
    ['claude-invalid-request', 'unknown', false],
  ] as const)('%s is classified as %s (retry %s)', (name, kind, safeToRetry) => {
    expect(replay(name)).toMatchObject({
      outcome: 'error',
      providerFailure: { kind, safeToRetry },
    });
  });

  it('ends the recorded 736446e8 session at its first quota result, with the reset (R-C9)', () => {
    // The recorded stream: a review whose five-hour allowance ran out while 20 sub-agents and
    // a background shell were still working. Replayed whole, every result stays unsafe.
    const lines = readFileSync(
      fileURLToPath(
        new URL(
          '../../fixtures/provider-failures/claude-session-limit-background-736446e8.jsonl',
          import.meta.url,
        ),
      ),
      'utf8',
    )
      .trim()
      .split('\n');
    const whole = normalizer();
    const results = lines
      .flatMap((line) => whole.normalizeLine(line))
      .filter((event) => event.kind === 'turn-completed');
    expect(results).toHaveLength(9);
    expect(
      results.map((event) =>
        event.kind === 'turn-completed' ? event.payload.providerFailure?.safeToRetry : undefined,
      ),
    ).not.toContain(true);
    // The session ends as soon as a quota result meets a known reset: the first result.
    const subject = normalizer();
    let fed = 0;
    for (const line of lines) {
      subject.normalizeLine(line);
      fed += 1;
      if (subject.quotaExhausted) break;
    }
    expect(lines[fed - 1]).toContain('session limit');
    expect(subject.endedForQuota()).toMatchObject({
      kind: 'turn-completed',
      payload: {
        outcome: 'error',
        providerFailure: { kind: 'quota', safeToRetry: true, resetsAt: '2026-09-15T14:50:00.000Z' },
      },
    });
  });

  it('ends the session only at a failed result with its own rejected report (R-C9)', () => {
    const limited = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      terminal_reason: 'api_error',
    };
    const rejected = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1789483800 },
    };
    const ends = (...messages: unknown[]) => {
      const subject = normalizer();
      for (const message of messages) subject.normalizeLine(JSON.stringify(message));
      return subject;
    };
    expect(ends(rejected, limited).endedForQuota().payload).toMatchObject({
      providerFailure: { safeToRetry: true, resetsAt: '2026-09-15T14:50:00.000Z' },
    });
    // A rejection the session got past does not end it at a later rate limit.
    const warning = (rateLimitType: string) => ({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType, resetsAt: 1789483800 },
    });
    const fiveHour = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1789483800 },
    };
    expect(ends(fiveHour, warning('five_hour'), limited).quotaExhausted).toBe(false);
    // A warning about another window leaves the rejected one in force.
    expect(ends(fiveHour, warning('seven_day'), limited).quotaExhausted).toBe(true);
    expect(ends(rejected, limited, limited).quotaExhausted).toBe(true);
    const unusable = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } };
    expect(
      ends(rejected, { ...limited, subtype: 'error_during_execution', is_error: true }, unusable)
        .quotaExhausted,
    ).toBe(true);
    expect(ends(unusable, limited).quotaExhausted).toBe(false);
    expect(
      ends(rejected, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, limited)
        .quotaExhausted,
    ).toBe(false);
    // A result that did not fail does not end the session.
    expect(ends(rejected, { ...limited, is_error: false }).quotaExhausted).toBe(false);
    // Denied permissions keep the retry with the operator.
    expect(
      ends(rejected, { ...limited, permission_denials: [{ tool_name: 'Bash' }] }).endedForQuota()
        .payload,
    ).toMatchObject({ providerFailure: { safeToRetry: false } });
  });

  it('carries the reset time of a rejected allowance so the controller can wait for it', () => {
    expect(replay('claude-session-limit')).toMatchObject({
      providerFailure: { kind: 'quota', safeToRetry: true, resetsAt: '2026-09-15T14:50:00.000Z' },
    });
    const subject = normalizer();
    const send = (message: unknown) => subject.normalizeLine(JSON.stringify(message));
    const limited = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      terminal_reason: 'api_error',
    };
    // Without a reported reset, or after the allowance is restored, the operator decides.
    expect(send(limited)[0]?.payload).toMatchObject({
      providerFailure: { kind: 'quota', safeToRetry: false },
    });
    send({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1789483800 },
    });
    send({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    expect(send(limited)[0]?.payload).not.toHaveProperty('providerFailure.resetsAt');
    // A reset applies to one result only.
    send({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1789483800 },
    });
    expect(send(limited)[0]?.payload).toHaveProperty('providerFailure.resetsAt');
    expect(send(limited)[0]?.payload).not.toHaveProperty('providerFailure.resetsAt');
    // A billing failure with no reset stays with the operator.
    send({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    expect(send({ ...limited, api_error_status: 402 })[0]?.payload).toMatchObject({
      providerFailure: { kind: 'quota', safeToRetry: false },
    });
    // Nor does a billing failure that follows a reported reset: it does not end at a reset.
    const rejected = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1789483800 },
    };
    send(rejected);
    expect(send({ ...limited, api_error_status: 402 })[0]?.payload).toMatchObject({
      providerFailure: { kind: 'quota', safeToRetry: false },
    });
    send(rejected);
    send({ type: 'assistant', message: { content: [] }, error: 'billing_error' });
    const billed = send(limited).at(-1)?.payload;
    expect(billed).toMatchObject({ providerFailure: { kind: 'quota', safeToRetry: false } });
    expect(billed).not.toHaveProperty('providerFailure.resetsAt');
    // A reset reported in milliseconds is not a usable time.
    send({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1789483800000 },
    });
    expect(send(limited)[0]?.payload).not.toHaveProperty('providerFailure.resetsAt');
  });

  it('classifies a success-subtype API error from its HTTP status alone', () => {
    const subject = normalizer();
    const result = (status: number) =>
      subject.normalizeLine(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: status,
          terminal_reason: 'api_error',
        }),
      )[0]?.payload;
    expect(result(503)).toMatchObject({
      providerFailure: { kind: 'unavailable', safeToRetry: true },
    });
    subject.normalizeLine(JSON.stringify({ type: 'assistant', error: 'unknown', message: {} }));
    expect(result(529)).toMatchObject({ providerFailure: { kind: 'capacity', safeToRetry: true } });
    // An allowance classification from the assistant record is never overridden by a 5xx.
    subject.normalizeLine(JSON.stringify({ type: 'assistant', error: 'rate_limit', message: {} }));
    expect(result(500)).toMatchObject({ providerFailure: { kind: 'quota', safeToRetry: false } });
    for (const status of [402, 429]) {
      expect(result(status)).toMatchObject({
        providerFailure: { kind: 'quota', safeToRetry: false },
      });
    }
    // A success result without an API failure carries no provider failure.
    expect(
      subject.normalizeLine(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
      )[0]?.payload,
    ).not.toHaveProperty('providerFailure');
  });

  it('keeps a main-thread service failure when a sub-agent message follows it', () => {
    const subject = normalizer();
    const send = (message: unknown) => subject.normalizeLine(JSON.stringify(message));
    send({ type: 'assistant', error: 'server_error', parent_tool_use_id: null, message: {} });
    send({
      type: 'assistant',
      parent_tool_use_id: 'toolu_task',
      message: { content: [{ type: 'text', text: 'sub-agent progress' }] },
    });
    // A sub-agent's own API error does not classify the main turn either.
    send({ type: 'assistant', error: 'rate_limit', parent_tool_use_id: 'toolu_task', message: {} });
    expect(
      send({ type: 'result', subtype: 'error_during_execution', is_error: true })[0]?.payload,
    ).toMatchObject({ providerFailure: { kind: 'unavailable', safeToRetry: true } });
  });

  it('reports each unknown message kind once per run', () => {
    const subject = normalizer();
    const progress = JSON.stringify({ type: 'system', subtype: 'task_progress', detail: 'x' });
    expect(subject.normalizeLine(progress)).toHaveLength(1);
    expect(subject.normalizeLine(progress)).toEqual([]);
    expect(subject.normalizeLine(JSON.stringify({ type: 'tool_progress' }))).toHaveLength(1);
    expect(subject.normalizeLine(JSON.stringify({ type: 'tool_progress' }))).toEqual([]);
  });
});
