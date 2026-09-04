import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionItem } from '../index.js';
import { ClaudeCodeBackend, resolveClaudeExecutable } from './backend.js';

/**
 * A stand-in `claude` that speaks the stream-json protocol: it emits an init
 * line, then for every user message on stdin emits an assistant text block and
 * a result line, and exits when stdin closes. `SLOW=1` makes it ignore SIGTERM
 * so the SIGKILL escalation is exercised.
 */
const FAKE_CLAUDE = `#!${process.execPath}
const readline = require('node:readline');
const args = process.argv.slice(2);
if (process.env.FAKE_IGNORE_TERM === '1') {
  process.on('SIGTERM', () => {});
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model', cwd: process.cwd() }) + '\\n');
process.stderr.write('fake claude started with ' + args.length + ' args\\n');
const rl = readline.createInterface({ input: process.stdin });
let turns = 0;
rl.on('line', (line) => {
  const message = JSON.parse(line);
  const text = message.message.content[0].text;
  turns += 1;
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + text, num_turns: turns, duration_ms: 5, total_cost_usd: 0.01, session_id: 'fake-session' }) + '\\n');
});
rl.on('close', () => {
  if (process.env.FAKE_IGNORE_TERM === '1') { setTimeout(() => {}, 60000); return; }
  process.exit(0);
});
`;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeClaude(): { executable: string; cwd: string } {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-agents-'));
  directories.push(directory);
  const executable = join(directory, 'claude');
  writeFileSync(executable, FAKE_CLAUDE);
  chmodSync(executable, 0o755);
  return { executable, cwd: directory };
}

async function collect(items: AsyncIterable<AgentSessionItem>): Promise<AgentSessionItem[]> {
  const collected: AgentSessionItem[] = [];
  for await (const item of items) {
    collected.push(item);
  }
  return collected;
}

describe('ClaudeCodeBackend', () => {
  it('launches, delivers the prompt on stdin, accepts a follow-up, and ends cleanly', async () => {
    const fake = fakeClaude();
    const backend = new ClaudeCodeBackend({ executable: fake.executable });
    const session = await backend.launch({
      cwd: fake.cwd,
      prompt: 'first',
      permissionMode: 'auto',
    });
    const collecting = collect(session.items);
    // Give the fake time to answer the first turn, then send another.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(session.send('second')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.end();
    const items = await collecting;

    const kinds = items.map((item) => (item.type === 'event' ? item.event.kind : 'exited'));
    expect(kinds).toEqual([
      'session-started',
      'assistant-message',
      'turn-completed',
      'assistant-message',
      'turn-completed',
      'stderr',
      'exited',
    ]);
    const texts = items.flatMap((item) =>
      item.type === 'event' && item.event.kind === 'assistant-message'
        ? [item.event.payload.text]
        : [],
    );
    expect(texts).toEqual(['echo: first', 'echo: second']);
    const exited = items.at(-1);
    expect(exited?.type === 'exited' && exited.exitCode).toBe(0);
    expect(session.send('too late')).toBe(false);
  });

  it('terminates a process that ignores SIGTERM', async () => {
    const fake = fakeClaude();
    const backend = new ClaudeCodeBackend({
      executable: fake.executable,
      env: { ...process.env, FAKE_IGNORE_TERM: '1' },
      terminationGraceMs: 200,
    });
    const session = await backend.launch({
      cwd: fake.cwd,
      prompt: 'first',
      permissionMode: 'edit-only',
    });
    const collecting = collect(session.items);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    session.kill();
    const items = await collecting;
    expect(Date.now() - started).toBeLessThan(5000);
    const exited = items.at(-1);
    expect(exited?.type === 'exited' && exited.signal).toBe('SIGKILL');
  });

  it('rejects an invalid launch request without spawning', async () => {
    const fake = fakeClaude();
    const backend = new ClaudeCodeBackend({ executable: fake.executable });
    await expect(
      backend.launch({ cwd: 'relative', prompt: 'x', permissionMode: 'auto' }),
    ).rejects.toMatchObject({ reason: 'invalid-request' });
  });
});

describe('resolveClaudeExecutable', () => {
  it('prefers an explicit absolute executable and rejects relative ones', () => {
    const fake = fakeClaude();
    expect(resolveClaudeExecutable(fake.executable)).toBe(fake.executable);
    expect(resolveClaudeExecutable('claude')).toBeUndefined();
    expect(resolveClaudeExecutable(join(fake.cwd, 'missing'))).toBeUndefined();
  });

  it('searches PATH when no explicit executable is configured', () => {
    const fake = fakeClaude();
    expect(resolveClaudeExecutable(undefined, { PATH: fake.cwd })).toBe(fake.executable);
    expect(resolveClaudeExecutable(undefined, { PATH: '/nonexistent-dir' })).toBe(
      resolveClaudeExecutable(undefined, { PATH: '' }),
    );
  });
});
