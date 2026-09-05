#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI used by the browser end-to-end suite.
 *
 * It speaks enough of the stream-json protocol for CraftingTable's adapter:
 * one init line, then for each user message on stdin a tool call that writes
 * a file in the worktree, its result, an assistant reply, and a result line.
 * It exits when stdin closes. No network, no model, deterministic output.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const cwd = process.cwd();
let turns = 0;
let reviewing = false;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-session-0001',
  model: 'fake-model',
  cwd,
  permissionMode: 'auto',
  apiKeySource: 'none',
});
// The real CLI emits these too; the adapter must keep them out of the journal.
emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 });

function git(args) {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fake Agent',
      GIT_AUTHOR_EMAIL: 'fake@example.invalid',
      GIT_COMMITTER_NAME: 'Fake Agent',
      GIT_COMMITTER_EMAIL: 'fake@example.invalid',
    },
    stdio: 'ignore',
  });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let text = '';
  try {
    text = JSON.parse(line).message.content[0].text;
  } catch {
    text = line;
  }
  turns += 1;
  // A review brief is read-only and ends with a verdict, like the real thing.
  if (turns === 1 && /^Role: review$/m.test(text)) {
    reviewing = true;
  }
  if (reviewing) {
    const verdict = text.includes('VERDICT-CHANGES') ? 'changes-requested' : 'mergeable';
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `fake review turn ${turns}\n\nVERDICT: ${verdict}` }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `fake review turn ${turns}\n\nVERDICT: ${verdict}`,
      num_turns: turns,
      duration_ms: 25,
      total_cost_usd: 0.01 * turns,
      session_id: 'fake-session-0001',
    });
    return;
  }
  const filename = `SMOKE-${turns}.md`;
  writeFileSync(join(cwd, filename), `turn ${turns}: ${text.split('\n')[0]}\n`);
  // Commit the file the way the implement brief asks for, so a later merge is clean.
  git(['add', '--all']);
  git(['commit', '--no-gpg-sign', '-q', '-m', `fake agent turn ${turns}`]);
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `toolu_${turns}`,
          name: 'Write',
          input: { file_path: join(cwd, filename), content: `turn ${turns}` },
        },
      ],
    },
  });
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: `toolu_${turns}`, content: `wrote ${filename}` },
      ],
    },
  });
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `fake agent finished turn ${turns}` }],
    },
  });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `fake agent finished turn ${turns}`,
    num_turns: turns,
    duration_ms: 25,
    total_cost_usd: 0.01 * turns,
    session_id: 'fake-session-0001',
  });
});
lines.on('close', () => process.exit(0));
