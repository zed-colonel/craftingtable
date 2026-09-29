import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  const asked = message.message.content[0].text;
  const text = asked === 'ENV' ? JSON.stringify([process.env.TMPDIR, process.env.TMP, process.env.TEMP, process.env.CARGO_TARGET_DIR]) : asked === 'ENV-NAMES' ? Object.keys(process.env).sort().join(',') + ' PATH=' + process.env.PATH : asked;
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

  it('ends a session whose allowance ran out, with its background work, and reports the reset (R-C9)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'craftingtable-agents-'));
    directories.push(directory);
    const executable = join(directory, 'claude');
    // The 736446e8 shape: a rejected allowance, sub-agents still running, and results that
    // keep failing against the limit until the session is ended.
    writeFileSync(
      executable,
      `#!${process.execPath}
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
// A background shell in the session's process group.
const shell = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' });
require('node:fs').writeFileSync('background.pid', String(shell.pid));
out({ type: 'system', subtype: 'init', session_id: 'limit-session', model: 'fake-model' });
out({ type: 'system', subtype: 'task_started', task_id: 'sub-1', tool_use_id: 'toolu_1', description: 'Sub-agent' });
out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1789483800 } });
const limited = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, terminal_reason: 'api_error', result: "You've hit your session limit" };
out(limited);
setInterval(() => out(limited), 50);
`,
    );
    chmodSync(executable, 0o755);
    const started = Date.now();
    const session = await new ClaudeCodeBackend({ executable, terminationGraceMs: 100 }).launch({
      cwd: directory,
      prompt: 'review',
      permissionMode: 'auto',
    });
    const items = await collect(session.items);
    expect(Date.now() - started).toBeLessThan(5000);
    const turns = items.flatMap((item) =>
      item.type === 'event' && item.event.kind === 'turn-completed' ? [item.event.payload] : [],
    );
    expect(turns.at(-1)).toMatchObject({
      outcome: 'error',
      providerFailure: { kind: 'quota', safeToRetry: true, resetsAt: '2026-09-15T14:50:00.000Z' },
    });
    const exited = items.at(-1);
    expect(exited).toMatchObject({ type: 'exited' });
    expect(exited?.type === 'exited' && exited.reason).toBeFalsy();
    // Nothing in the process group outlives the session.
    const background = Number(readFileSync(join(directory, 'background.pid'), 'utf8'));
    await expect
      .poll(() => {
        try {
          process.kill(background, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });

  it('terminates a process that ignores SIGTERM', async () => {
    const fake = fakeClaude();
    const backend = new ClaudeCodeBackend({
      executable: fake.executable,
      env: { ...process.env, FAKE_IGNORE_TERM: '1' },
      allowEnvironment: ['FAKE_IGNORE_TERM'],
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

  it('passes the run overlay to the child instead of inherited temporary paths', async () => {
    const fake = fakeClaude();
    const backend = new ClaudeCodeBackend({
      executable: fake.executable,
      env: { ...process.env, TMPDIR: '/old-temp' },
    });
    const session = await backend.launch({
      cwd: fake.cwd,
      prompt: 'ENV',
      permissionMode: 'auto',
      environment: {
        TMPDIR: fake.cwd,
        TMP: fake.cwd,
        TEMP: fake.cwd,
        CARGO_TARGET_DIR: `${fake.cwd}/target`,
      },
    });
    const items: AgentSessionItem[] = [];
    for await (const item of session.items) {
      items.push(item);
      if (item.type === 'event' && item.event.kind === 'turn-completed') session.end();
    }
    expect(
      items.some(
        (item) =>
          item.type === 'event' &&
          item.event.kind === 'turn-completed' &&
          item.event.payload.resultText ===
            `echo: ${JSON.stringify([fake.cwd, fake.cwd, fake.cwd, `${fake.cwd}/target`])}`,
      ),
    ).toBe(true);
  });

  it('starts the agent from named variables only, plus the run overlay the daemon supplies (R-G5, SEC-02)', async () => {
    const fake = fakeClaude();
    const session = await new ClaudeCodeBackend({
      executable: fake.executable,
      env: {
        HOME: '/home/operator',
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        LC_TIME: 'C',
        ANTHROPIC_API_KEY: 'key',
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-1',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR: '/run/user/1000',
        SSH_AUTH_SOCK: '/run/user/1000/ssh',
        HYPRLAND_INSTANCE_SIGNATURE: 'x',
        OPERATOR_DECLARED: 'yes',
        OPERATOR_SECRET: 'no',
      },
      allowEnvironment: ['OPERATOR_DECLARED'],
    }).launch({
      cwd: fake.cwd,
      prompt: 'ENV-NAMES',
      permissionMode: 'auto',
      environment: { CRAFTINGTABLE_RUN_NAMESPACE: 'run', TMPDIR: '/scratch' },
      pathPrefix: ['/run/bin'],
    });
    const results: string[] = [];
    for await (const item of session.items)
      if (item.type === 'event' && item.event.kind === 'turn-completed') {
        results.push(item.event.payload.resultText);
        session.end();
      }
    expect(results).toEqual([
      'echo: ANTHROPIC_API_KEY,CRAFTINGTABLE_RUN_NAMESPACE,HOME,LANG,LC_TIME,OPERATOR_DECLARED,PATH,TMPDIR PATH=/run/bin:/usr/bin',
    ]);
  });

  it("creates the sandbox's Cargo caches before launch, so a fetch can write them (R-G5)", async () => {
    const fake = fakeClaude();
    const cargoHome = join(fake.cwd, 'cargo-home');
    const session = await new ClaudeCodeBackend({ executable: fake.executable }).launch({
      cwd: fake.cwd,
      prompt: 'ENV-NAMES',
      permissionMode: 'auto',
      environment: { CARGO_HOME: cargoHome },
    });
    // The sandbox can only make an existing directory writable; Cargo creates them itself
    // on its first download, which the sandbox would refuse.
    expect(existsSync(join(cargoHome, 'registry'))).toBe(true);
    expect(existsSync(join(cargoHome, 'git'))).toBe(true);
    // Nothing else of the Cargo home is created or made writable.
    expect(readdirSync(cargoHome).sort()).toEqual(['git', 'registry']);
    session.end();
    for await (const _ of session.items);
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

function backgroundFixture({ persistent = false, inheritPipes = false } = {}) {
  const fake = fakeClaude();
  // The worker deliberately survives the leader, as a nohup command would.
  const worker = `const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync('worker.pid', String(process.pid));
    ${persistent ? 'setInterval(() => {}, 1000);' : "setTimeout(() => { fs.writeFileSync('verified', 'passed'); process.exit(0); }, 350);"}`;
  writeFileSync(
    fake.executable,
    `#!${process.execPath}
    const fs = require('node:fs');
    const cp = require('node:child_process');
    process.stdin.once('data', () => {
      cp.spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ${JSON.stringify(inheritPipes ? 'inherit' : 'ignore')} });
      const ready = setInterval(() => {
        if (!fs.existsSync('worker.pid')) return;
        clearInterval(ready);
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Waiting for verification.', num_turns: 1, duration_ms: 1 }) + '\\n', () => process.exit(0));
      }, 5);
    });
  `,
  );
  return fake;
}
function workerRunning(cwd: string): boolean {
  try {
    const pid = readFileSync(join(cwd, 'worker.pid'), 'utf8');
    if (process.platform !== 'linux') {
      process.kill(Number(pid), 0);
      return true;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '');
  } catch {
    return false;
  }
}

describe('Claude background lifecycle', () => {
  it('recognizes a split background-wait timeout diagnostic despite exit code zero', async () => {
    const fake = fakeClaude();
    writeFileSync(
      fake.executable,
      `#!${process.execPath}
      process.stdin.once('data', () => {
        process.stderr.write('Background tasks still run');
        setTimeout(() => process.stderr.write('ning after 600s; terminating.\\n', () => process.exit(0)), 10);
      });`,
    );
    const session = await new ClaudeCodeBackend({ executable: fake.executable }).launch({
      cwd: fake.cwd,
      prompt: 'go',
      permissionMode: 'auto',
    });
    const items = await collect(session.items);
    expect(items.at(-1)).toMatchObject({
      type: 'exited',
      exitCode: 0,
      reason: 'background-work-incomplete',
    });
  });

  it.each([true, false])(
    'detects a stopped task after the result without stderr (collected afterward: %s)',
    async (collected) => {
      const fake = fakeClaude();
      const events = [
        { type: 'system', subtype: 'task_started', task_id: 'matrix', task_type: 'local_bash' },
        { type: 'result', subtype: 'success', result: 'Waiting for the matrix.' },
        { type: 'system', subtype: 'task_notification', task_id: 'matrix', status: 'stopped' },
        ...(collected
          ? [
              {
                type: 'result',
                subtype: 'success',
                result: 'Collected results; reported the incomplete checks.',
              },
            ]
          : []),
      ];
      writeFileSync(
        fake.executable,
        `#!${process.execPath}
      process.stdin.once('data', () => process.stdout.write(${JSON.stringify(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)}, () => process.exit(0)));`,
      );
      const session = await new ClaudeCodeBackend({ executable: fake.executable }).launch({
        cwd: fake.cwd,
        prompt: 'go',
        permissionMode: 'auto',
      });
      const items = await collect(session.items);
      const exit = items.at(-1);
      expect(exit).toMatchObject({ type: 'exited', exitCode: 0 });
      expect(exit?.type === 'exited' ? exit.reason : undefined).toBe(
        collected ? undefined : 'background-work-incomplete',
      );
    },
  );

  it('keeps detached background work reserved until it completes, then reports the incomplete outcome', async () => {
    const fake = backgroundFixture();
    const session = await new ClaudeCodeBackend({ executable: fake.executable }).launch({
      cwd: fake.cwd,
      prompt: 'go',
      permissionMode: 'auto',
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    });
    let sawWaiting = false;
    const items: AgentSessionItem[] = [];
    for await (const item of session.items) {
      items.push(item);
      if (item.type === 'event' && item.event.kind === 'notice') {
        sawWaiting = true;
        expect(workerRunning(fake.cwd)).toBe(true);
        expect(existsSync(join(fake.cwd, 'verified'))).toBe(false);
      }
    }
    expect(sawWaiting).toBe(true);
    expect(readFileSync(join(fake.cwd, 'verified'), 'utf8')).toBe('passed');
    expect(workerRunning(fake.cwd)).toBe(false);
    expect(items.at(-1)).toMatchObject({
      type: 'exited',
      exitCode: 0,
      reason: 'background-work-incomplete',
    });
  });

  it.each([false, true])(
    'enforces the drain deadline and kills a SIGTERM-resistant worker (inherited pipes: %s)',
    async (inheritPipes) => {
      const fake = backgroundFixture({ persistent: true, inheritPipes });
      const session = await new ClaudeCodeBackend({
        executable: fake.executable,
        terminationGraceMs: 50,
      }).launch({
        cwd: fake.cwd,
        prompt: 'go',
        permissionMode: 'auto',
        deadlineAt: new Date(Date.now() + 250).toISOString(),
      });
      const items = await collect(session.items);
      expect(items.at(-1)).toMatchObject({ type: 'exited', reason: 'background-work-timeout' });
      expect(workerRunning(fake.cwd)).toBe(false);
    },
  );

  it('cancels background work after the leader has already exited', async () => {
    const fake = backgroundFixture({ persistent: true });
    const session = await new ClaudeCodeBackend({
      executable: fake.executable,
      terminationGraceMs: 50,
    }).launch({ cwd: fake.cwd, prompt: 'go', permissionMode: 'auto' });
    let cancelled = false;
    for await (const item of session.items) {
      if (item.type === 'event' && item.event.kind === 'notice') {
        cancelled = true;
        session.kill();
      }
    }
    expect(cancelled).toBe(true);
    expect(workerRunning(fake.cwd)).toBe(false);
  });
});
