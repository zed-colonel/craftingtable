#!/usr/bin/env node
/** Deterministic app-server peer; one thread and process across follow-up turns. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

let threadId = randomUUID();
let active;
let initialized = false;
const state = { turns: 0, reviewing: false };
const cwd = process.cwd();
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
function git(args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fake Codex',
      GIT_AUTHOR_EMAIL: 'fake@example.invalid',
      GIT_COMMITTER_NAME: 'Fake Codex',
      GIT_COMMITTER_EMAIL: 'fake@example.invalid',
    },
  });
}
const notify = (method, params) =>
  emit({ method, params: { threadId, turnId: active, ...params } });
function runTurn(prompt) {
  state.turns += 1;
  if (state.turns === 1) state.reviewing = /^Role: review$/m.test(prompt);
  const command = {
    id: 'item_0',
    type: 'commandExecution',
    command: 'git status --short',
    aggregatedOutput: '',
    exitCode: null,
    status: 'inProgress',
  };
  notify('item/started', { item: command });
  notify('item/completed', {
    item: {
      ...command,
      aggregatedOutput: git(['status', '--short']),
      exitCode: 0,
      status: 'completed',
    },
  });
  let text;
  if (state.reviewing) {
    text = `fake Codex review turn ${state.turns}\n\nVERDICT: ${prompt.includes('VERDICT-CHANGES') ? 'changes-requested' : 'mergeable'}`;
  } else {
    const filename = `SMOKE-${state.turns}.md`;
    const change = {
      id: 'item_1',
      type: 'fileChange',
      changes: [{ path: filename, kind: 'add' }],
      status: 'inProgress',
    };
    notify('item/started', { item: change });
    writeFileSync(resolve(cwd, filename), `Codex turn ${state.turns}: ${prompt.split('\n')[0]}\n`);
    git(['add', '--', filename]);
    git(['commit', '--no-gpg-sign', '--allow-empty', '-q', '-m', `fake Codex turn ${state.turns}`]);
    notify('item/completed', { item: { ...change, status: 'completed' } });
    text = `fake Codex finished turn ${state.turns}`;
  }
  notify('item/completed', { item: { id: 'item_2', type: 'agentMessage', text } });
  notify('thread/tokenUsage/updated', {
    tokenUsage: {
      total: {
        inputTokens: 10 * state.turns,
        cachedInputTokens: 5 * state.turns,
        outputTokens: 10 * state.turns,
        reasoningOutputTokens: 0,
        totalTokens: 20 * state.turns,
      },
      last: {
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 10,
        reasoningOutputTokens: 0,
        totalTokens: 20,
      },
    },
  });
  notify('turn/completed', { turn: { id: active, status: 'completed' } });
  active = undefined;
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (result) => emit({ id: message.id, result });
  if (message.method === 'initialize') {
    reply({ userAgent: 'fake-codex' });
    return;
  }
  if (message.method === 'initialized') {
    initialized = true;
    return;
  }
  if (!initialized) throw new Error('Initialize app-server first');
  switch (message.method) {
    case 'account/read':
      reply({ account: { type: 'chatgpt', planType: 'plus' } });
      break;
    case 'account/usage/read':
      reply({});
      break;
    case 'thread/start':
    case 'thread/resume':
      threadId = message.params.threadId ?? threadId;
      reply({ thread: { id: threadId }, model: message.params.model ?? 'gpt-5.6-luna' });
      break;
    case 'thread/name/set':
      reply({});
      break;
    case 'turn/start':
      active = randomUUID();
      notify('turn/started', { turn: { id: active, status: 'inProgress' } });
      reply({ turn: { id: active, status: 'inProgress' } });
      runTurn(message.params.input[0].text);
      break;
    case 'turn/steer':
      emit({ id: message.id, error: { code: -32600, message: 'no active turn' } });
      break;
    case 'turn/interrupt':
      reply({});
      break;
    default:
      emit({ id: message.id, error: { code: -32601, message: 'Unknown request' } });
  }
});
lines.on('close', () => process.exit(0));
