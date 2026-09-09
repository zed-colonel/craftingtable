import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentLaunchRequest, AgentSession, AgentSessionItem } from '../index.js';
import { CodexBackend } from './backend.js';

const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => {});
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text) => prompt += text);
process.stdin.on('end', () => {
  fs.appendFileSync('launches.jsonl', JSON.stringify({args, prompt}) + '\\n');
  emit({type: 'thread.started', thread_id: 'fake-thread'});
  emit({type: 'turn.started'});
  if (process.env.FAKE_IGNORE_TERM) { setInterval(() => {}, 1000); return; }
  if (process.env.FAKE_EXIT) { process.stderr.write('broken process'); process.exit(2); }
  if (process.env.FAKE_MISSING_TURN) return;
  setTimeout(() => {
    emit({type: 'item.completed', item: {id: 'item_0', type: 'agent_message', text: 'echo: ' + prompt}});
    emit(process.env.FAKE_TURN_FAILED ? {type: 'turn.failed', error: {message: 'turn failed'}} : {type: 'turn.completed', usage: {input_tokens: 1}});
    process.exit(process.env.FAKE_LATE_FAILURE ? 2 : 0);
  }, 30);
});
`;
const directories: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.kill();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function launch(env: NodeJS.ProcessEnv = {}, overrides: Partial<AgentLaunchRequest> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'craftingtable-codex-'));
  directories.push(cwd);
  const executable = join(cwd, 'codex');
  writeFileSync(executable, FAKE);
  chmodSync(executable, 0o755);
  const backend = new CodexBackend({ executable, env, terminationGraceMs: 50 });
  const session = await backend.launch({
    cwd,
    prompt: 'first\nmultiline',
    permissionMode: 'auto',
    ...overrides,
  });
  sessions.push(session);
  const items: AgentSessionItem[] = [];
  const done = (async () => {
    for await (const item of session.items) items.push(item);
  })();
  return { session, items, done, cwd, executable };
}
async function waitFor(predicate: () => boolean) {
  await expect.poll(predicate, { timeout: 5000, interval: 10 }).toBe(true);
}
const turns = (items: AgentSessionItem[]) =>
  items.filter((item) => item.type === 'event' && item.event.kind === 'turn-completed');

it('keeps a completed process session open, resumes by thread id, and ends while idle', async () => {
  const { session, items, done, cwd } = await launch();
  await waitFor(() => session.pid === undefined);
  expect(turns(items)).toHaveLength(1);
  expect(items.some((item) => item.type === 'exited')).toBe(false);
  expect(session.send('again\nsecond line')).toBe(true);
  await waitFor(() => turns(items).length === 2 && session.pid === undefined);
  const launches = readFileSync(join(cwd, 'launches.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(launches.map((entry) => entry.prompt)).toEqual(['first\nmultiline', 'again\nsecond line']);
  expect(launches[1].args).toEqual([
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'approval_policy="never"',
    'fake-thread',
    '-',
  ]);
  expect(
    items.filter((item) => item.type === 'event' && item.event.kind === 'session-started'),
  ).toHaveLength(1);
  session.end();
  await done;
  expect(items.at(-1)).toEqual({ type: 'exited', exitCode: 0, signal: null });
  expect(session.send('late')).toBe(false);
});

it('queues messages during a turn and drains accepted messages before ending', async () => {
  const { session, items, done, cwd } = await launch();
  expect(session.send('second')).toBe(true);
  expect(session.send('third')).toBe(true);
  session.end();
  expect(session.send('too late')).toBe(false);
  await done;
  expect(turns(items)).toHaveLength(3);
  expect(
    readFileSync(join(cwd, 'launches.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).prompt),
  ).toEqual(['first\nmultiline', 'second', 'third']);
  expect(items.at(-1)).toMatchObject({ type: 'exited', exitCode: 0 });
});

it('ends after the running turn and reports unsupported options without exposing their contents', async () => {
  const { session, items, done } = await launch(
    {},
    { appendSystemPrompt: 'secret prompt', maxBudgetUsd: 5 },
  );
  session.end();
  await done;
  expect(turns(items)).toHaveLength(1);
  expect(items.slice(0, 2).map((item) => item.type === 'event' && item.event.kind)).toEqual([
    'notice',
    'notice',
  ]);
  expect(JSON.stringify(items)).not.toContain('secret prompt');
  expect(items.at(-1)).toMatchObject({ exitCode: 0 });
});

it('kills an uncooperative running child, drops queued messages and reaps it before closing', async () => {
  const { session, items, done, cwd } = await launch({ FAKE_IGNORE_TERM: '1' });
  await waitFor(() =>
    items.some((item) => item.type === 'event' && item.event.kind === 'session-started'),
  );
  const pid = session.pid;
  session.send('queued');
  session.kill();
  session.kill();
  expect(session.send('late')).toBe(false);
  await done;
  expect(items.at(-1)).toEqual({ type: 'exited', exitCode: null, signal: 'SIGKILL' });
  expect(() => process.kill(pid ?? 0, 0)).toThrow();
  expect(readFileSync(join(cwd, 'launches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

it('can cancel between turns without starting another process', async () => {
  const { session, items, done } = await launch();
  await waitFor(() => session.pid === undefined);
  session.kill();
  await done;
  expect(items.at(-1)).toEqual({ type: 'exited', exitCode: null, signal: 'SIGTERM' });
});

it.each([
  [{ FAKE_EXIT: '1' }, 2, 'error'],
  [{ FAKE_MISSING_TURN: '1' }, 1, 'error'],
  [{ FAKE_TURN_FAILED: '1' }, 1, 'error'],
  [{ FAKE_LATE_FAILURE: '1' }, 2, 'success'],
] as const)('fails closed for process/protocol errors: %j', async (env, exitCode, outcome) => {
  const { items, done } = await launch(env);
  await done;
  expect(turns(items)).toHaveLength(1);
  const turn = turns(items)[0];
  expect(turn?.type === 'event' && turn.event.payload).toMatchObject({ outcome });
  expect(items.at(-1)).toEqual({ type: 'exited', exitCode, signal: null });
});

it('closes with an error if the executable disappears before resume', async () => {
  const { session, items, done, executable } = await launch();
  await waitFor(() => session.pid === undefined);
  rmSync(executable);
  expect(session.send('again')).toBe(true);
  await done;
  expect(turns(items)).toHaveLength(2);
  expect(items.at(-1)?.type).toBe('exited');
  const exited = items.at(-1);
  expect(exited?.type === 'exited' && exited.exitCode).not.toBe(0);
});

it('rejects an invalid request before spawning', async () => {
  await expect(
    new CodexBackend({ executable: '/missing' }).launch({
      cwd: 'relative',
      prompt: 'x',
      permissionMode: 'auto',
    }),
  ).rejects.toMatchObject({ reason: 'invalid-request' });
});
