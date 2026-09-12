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
let automated = false;
let designing = false;
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
  if (turns === 1) {
    automated = text.includes('one step of an operator-authorized automated cycle');
    designing = /^Role: design$/m.test(text);
  }
  if (automated && designing) {
    const result = 'Design complete.\n\n## Open questions\nnone';
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: result }] },
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result,
      num_turns: turns,
      duration_ms: 25,
      total_cost_usd: 0.01,
      session_id: 'fake-session-0001',
    });
    return;
  }
  if (/## Your role\n\nResolve the daemon-prepared integration merge/.test(text)) {
    writeFileSync(join(cwd, 'README.md'), 'Combined AQ-02 and AQ-03 behavior.\n');
    git(['add', 'README.md']);
    const result =
      'Resolved both work items and verified the combined fixture.\n\n## Resolution status\nready';
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: result }] },
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result,
      num_turns: turns,
      duration_ms: 25,
      total_cost_usd: 0.01,
      session_id: 'fake-session-0001',
    });
    return;
  }
  // A review brief is read-only and ends with a verdict, like the real thing.
  if (turns === 1 && /^Role: review$/m.test(text)) {
    reviewing = true;
  }
  if (reviewing) {
    const verdict = text.includes('VERDICT-CHANGES') ? 'changes-requested' : 'mergeable';
    const findings = text.includes('MOBILE-FINDINGS')
      ? [
          {
            id: 'F-001',
            severity: 'nit',
            status: 'open',
            title: 'Clarify the example in the integration guide',
            location: {
              path: `docs/${'long-directory-name/'.repeat(8)}integration-guide.md`,
              line: 12,
            },
            explanation:
              'The behavior is correct, but the example could explain the integration target more clearly.',
            recommendation: 'Add a short explanation alongside the example.',
          },
        ]
      : [];
    const reviewResult =
      automated || findings.length > 0
        ? `\`\`\`craftingtable-review\n${JSON.stringify({ version: 1, complete: true, verdict, exitGate: { met: verdict === 'mergeable', evidence: 'Fixture checks passed.' }, findings })}\n\`\`\`\nVERDICT: ${verdict}`
        : `fake review turn ${turns}\n\nVERDICT: ${verdict}`;
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: reviewResult }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: reviewResult,
      num_turns: turns,
      duration_ms: 25,
      total_cost_usd: 0.01 * turns,
      session_id: 'fake-session-0001',
    });
    return;
  }
  const itemSuffix = text.includes('PARALLEL-ROADMAP')
    ? `-${/^# Work item ([A-Z0-9-]+)/m.exec(text)?.[1] ?? 'fixture'}`
    : '';
  const filename = `SMOKE${itemSuffix}-${turns}.md`;
  writeFileSync(join(cwd, filename), `turn ${turns}: ${text.split('\n')[0]}\n`);
  if (text.includes('MOBILE-FINDINGS')) {
    writeFileSync(join(cwd, 'mobile-layout.md'), `${'Long diff line '.repeat(50)}\n`);
  }
  if (text.includes('CONFLICT-RESOLUTION')) {
    const item = /^# Work item (AQ-\d+)/m.exec(text)?.[1];
    if (item === 'AQ-02' || item === 'AQ-03')
      writeFileSync(join(cwd, 'README.md'), `${item} behavior.\n`);
  }
  // Commit the file the way the implement brief asks for, so a later merge is clean.
  git(['add', '--all']);
  git(['commit', '--allow-empty', '--no-gpg-sign', '-q', '-m', `fake agent turn ${turns}`]);
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
