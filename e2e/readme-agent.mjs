#!/usr/bin/env node
/**
 * The stand-in for the `claude` CLI behind the README's screenshots (`pnpm docs:screenshots`).
 *
 * It speaks the same stream-json protocol as `fake-claude.mjs`, but its output reads like a real
 * session on the Lantern fixture (`fixtures/plan-bundles/lantern`), and each work item takes the
 * path its screenshot needs: LN-02's design asks a question, LN-03's review requests changes,
 * LN-04's implementation asks a question, and every other step succeeds. No network, no model,
 * deterministic output. The browser suite keeps using `fake-claude.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

// The daemon reads the CLI's version with its model catalog (R-G15).
if (process.argv[2] === '--version') {
  process.stdout.write('2.1.288 (Claude Code)\n');
  process.exit(0);
}

const cwd = process.cwd();
const SESSION = 'readme-session-0001';
let turns = 0;
let role = '';
let automated = false;
let item = '';
let tools = 0;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({
  type: 'system',
  subtype: 'init',
  session_id: SESSION,
  model: 'claude-opus-5-5',
  cwd,
  permissionMode: 'auto',
  apiKeySource: 'none',
});

/** What each work item's implementation writes: one file of its own, so siblings never conflict. */
const CHANGES = {
  'LN-01': ['src/record.rs', 'record model and line parser'],
  'LN-02': ['src/segment/format.rs', 'segment header and block layout'],
  'LN-03': ['src/tokenizer.rs', 'field tokenizer'],
  'LN-04': ['src/query/grammar.rs', 'query grammar'],
  'LN-05': ['src/bin/lantern.rs', 'command-line interface'],
  'LN-06': ['src/segment/writer.rs', 'segment writer'],
  'LN-07': ['src/compaction.rs', 'background segment merger'],
  'LN-08': ['src/query/executor.rs', 'query executor'],
  'LN-09': ['src/ranking.rs', 'ranking and highlighting'],
};

function git(args) {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Claude',
      GIT_AUTHOR_EMAIL: 'agent@example.invalid',
      GIT_COMMITTER_NAME: 'Claude',
      GIT_COMMITTER_EMAIL: 'agent@example.invalid',
    },
    stdio: 'ignore',
  });
}

function say(text) {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

/** One tool call and its result, as the real CLI streams them. */
function tool(name, input, result) {
  tools += 1;
  const id = `toolu_${String(tools).padStart(4, '0')}`;
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
  });
}

function finish(result, cost = 0.18) {
  say(result);
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    num_turns: turns,
    duration_ms: 48_000 + turns * 9_000,
    total_cost_usd: cost * turns,
    session_id: SESSION,
  });
}

function design() {
  tool('Read', { file_path: 'docs/plan.md' }, 'Lantern 0.1 Implementation Plan (63 lines)');
  tool('Grep', { pattern: 'Segment', path: 'src' }, 'src/lib.rs:4: pub mod segment;');
  if (item === 'LN-02' && !/bounded design-question recovery/.test(text0))
    return finish(
      'I sketched two layouts for the segment format: immutable segments that compaction ' +
        'replaces whole, and segments the compactor rewrites in place. The plan allows both.\n\n' +
        '## Open questions\n' +
        'Should a flushed segment be immutable? Immutable segments make readers lock-free but ' +
        'double the disk space during compaction; in-place rewrites need a reader lock.',
    );
  finish(
    'Design: one module per concern, with the public type in `src/lib.rs` and tests beside ' +
      'the code. No change to the segment format.\n\n## Open questions\nnone',
  );
}

function review() {
  tool('Bash', { command: 'git diff --stat develop...HEAD' }, ' 1 file changed, 86 insertions(+)');
  tool(
    'Bash',
    { command: 'cargo test --quiet' },
    'running 18 tests\n..................\ntest result: ok. 18 passed; 0 failed',
  );
  const changes = item === 'LN-03';
  const verdict = changes ? 'changes-requested' : 'mergeable';
  const findings = changes
    ? [
        {
          id: 'F-001',
          severity: 'major',
          status: 'open',
          title: 'Quoted values lose escaped quotes',
          location: { path: 'src/tokenizer.rs', line: 41 },
          explanation:
            'A value such as msg="say \\"hi\\"" is cut at the first escaped quote, so the field ' +
            'indexes as `say \\` and searches for the full message never match.',
          recommendation: 'Handle backslash escapes inside quoted values and add a test for them.',
        },
      ]
    : [];
  const block = {
    version: 1,
    complete: true,
    verdict,
    exitGate: {
      met: !changes,
      evidence: changes ? 'Escaped quotes are not tokenized.' : 'cargo test and clippy are green.',
    },
    findings,
  };
  const summary = changes
    ? 'The tokenizer handles plain and Unicode fields, but quoted values with escapes break.'
    : 'The change meets its exit gate; tests and clippy are green.';
  finish(
    `${summary}\n\n\`\`\`craftingtable-review\n${JSON.stringify(block)}\n\`\`\`\nVERDICT: ${verdict}`,
  );
}

function implement(text) {
  const [path, what] = CHANGES[item] ?? ['src/lib.rs', 'change'];
  if (automated && item === 'LN-04' && !/should search every field|only `message`/.test(text)) {
    tool('Read', { file_path: 'docs/plan.md' }, 'Lantern 0.1 Implementation Plan (63 lines)');
    return finish(
      'The grammar parses fields, phrases and boolean operators. One rule is not settled by the ' +
        'plan.\n\n## Open questions\n' +
        'Should a bare term like `timeout` search every field, or only `message`? Every field ' +
        'is more forgiving; `message` keeps queries fast and results predictable.',
    );
  }
  if (turns === 1) say(`I'll start with the existing modules, then add the ${what}.`);
  tool('Read', { file_path: 'src/lib.rs' }, 'pub mod record;\npub mod segment;\n(12 lines)');
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  const body = `//! The ${what} (${item}, turn ${turns}).\n\npub fn placeholder() {}\n`;
  writeFileSync(absolute, body);
  tool('Write', { file_path: path, content: body }, `File created successfully at: ${path}`);
  tool(
    'Bash',
    { command: 'cargo test --quiet' },
    `running ${12 + turns * 6} tests\n${'.'.repeat(12 + turns * 6)}\ntest result: ok. ${12 + turns * 6} passed; 0 failed`,
  );
  git(['add', '--all']);
  git(['commit', '--allow-empty', '--no-gpg-sign', '-q', '-m', `${item}: ${what} (turn ${turns})`]);
  finish(
    turns === 1 && !automated
      ? `Added the ${what} in \`${path}\`; \`cargo test\` passes (${12 + turns * 6} tests). ` +
          'Should `lantern search` print matches as plain lines by default, or as JSON?'
      : `Added the ${what} in \`${path}\`; \`cargo test\` passes.`,
  );
}

let text0 = '';
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
    text0 = text;
    automated = text.includes('one step of an operator-authorized automated cycle');
    role = /^Role: (\w+)$/m.exec(text)?.[1] ?? 'implement';
    item = /^# Work item ([A-Z0-9-]+)/m.exec(text)?.[1] ?? '';
  }
  if (automated && role === 'design') return design();
  if (role === 'review') return review();
  implement(text);
});
lines.on('close', () => process.exit(0));
