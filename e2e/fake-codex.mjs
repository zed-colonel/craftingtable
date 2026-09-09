#!/usr/bin/env node
/** Deterministic Codex exec/resume peer; state lives in Git metadata, outside the diff. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const resume = args[1] === 'resume';
const threadId = resume ? args.at(-2) : randomUUID();
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
const statePath = resolve(
  cwd,
  git(['rev-parse', '--git-path', `fake-codex-${threadId}.json`]).trim(),
);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
const state = resume
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { turns: 0, reviewing: /^Role: review$/m.test(prompt) };
state.turns += 1;
writeFileSync(statePath, JSON.stringify(state));
emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'turn.started' });
const command = {
  id: 'item_0',
  type: 'command_execution',
  command: 'git status --short',
  aggregated_output: '',
  exit_code: null,
  status: 'in_progress',
};
emit({ type: 'item.started', item: command });
emit({
  type: 'item.completed',
  item: {
    ...command,
    aggregated_output: git(['status', '--short']),
    exit_code: 0,
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
    type: 'file_change',
    changes: [{ path: filename, kind: 'add' }],
    status: 'in_progress',
  };
  emit({ type: 'item.started', item: change });
  writeFileSync(resolve(cwd, filename), `Codex turn ${state.turns}: ${prompt.split('\n')[0]}\n`);
  git(['add', '--', filename]);
  git(['commit', '--no-gpg-sign', '--allow-empty', '-q', '-m', `fake Codex turn ${state.turns}`]);
  emit({ type: 'item.completed', item: { ...change, status: 'completed' } });
  text = `fake Codex finished turn ${state.turns}`;
}
emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text } });
emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } });
