#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI used by the browser end-to-end suite.
 *
 * It speaks enough of the stream-json protocol for CraftingTable's adapter:
 * one init line, then for each user message on stdin a tool call that writes
 * a file in the worktree, its result, an assistant reply, and a result line.
 * It exits when stdin closes. No network, no model, deterministic output.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const cwd = process.cwd();
let turns = 0;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-session-0001',
  model: 'fake-model',
  cwd,
  permissionMode: 'auto',
});

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let text = '';
  try {
    text = JSON.parse(line).message.content[0].text;
  } catch {
    text = line;
  }
  turns += 1;
  const filename = `SMOKE-${turns}.md`;
  writeFileSync(join(cwd, filename), `turn ${turns}: ${text.split('\n')[0]}\n`);
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
