import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentLaunchRequest, AgentSession, AgentSessionItem } from '../../src/index.js';
import { testTimeScale } from '../test-time.js';
import { CodexBackend } from '../../src/codex/backend.js';
import { CodexRpc } from '../../src/codex/rpc.js';

const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.FAKE_MODE;
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const trace = value => fs.appendFileSync('rpc.jsonl', JSON.stringify(value) + '\\n');
trace({args: process.argv.slice(2), pid: process.pid});
if (mode === 'env-names') trace({envNames: Object.keys(process.env).sort(), path: process.env.PATH, args: process.argv.slice(2)});
if (mode === 'scratch') trace({temporaryPaths: [process.env.TMPDIR, process.env.TMP, process.env.TEMP, process.env.CARGO_TARGET_DIR]});
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
if (mode === 'shutdown-error') process.on('SIGTERM', () => process.exit(2));
let initialized = false, threadId = 'fake-thread', turns = 0, active, timer, texts = [], accountReads = 0;
const REJECTED = 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac****fvMA. You can find your API key at https://platform.openai.com/account/api-keys., url: https://chatgpt.com/backend-api/codex/responses, request id: 4d5b4d51-4051-4784-812d-b13fbc099319';
const notify = (method, params) => emit({method, params: {threadId, ...params}});
function finish(status = 'completed') {
  if (!active) return;
  clearTimeout(timer);
  const id = active;
  if (mode === 'overloaded') notify('error', { turnId: id, willRetry: false, error: { message: 'At capacity', codexErrorInfo: 'serverOverloaded' } });
  if (String(mode).startsWith('provider-401')) {
    notify('error', { turnId: id, willRetry: false, error: { message: REJECTED, codexErrorInfo: 'other' } });
    active = undefined;
    notify('turn/completed', {turn: {id, status: 'failed', error: {message: REJECTED, codexErrorInfo: 'other'}}});
    return;
  }
  if (mode === 'approval-outage') {
    process.stderr.write('ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: Rejected(Automatic approval review failed: ' + REJECTED + ') }' + String.fromCharCode(10));
    notify('item/completed', {turnId: id, item: {id: 'question-' + id, type: 'agentMessage', text: 'Can you restore the automatic approval service?', delivery: 'async', questions: [{title: 'Can you restore the automatic approval service?'}]}});
  }
  notify('item/completed', {turnId: id, item: {id: 'message-' + id, type: 'agentMessage', text: texts.join(' | ')}});
  notify('thread/tokenUsage/updated', {turnId: id, tokenUsage: {total: {inputTokens: 10 * turns, cachedInputTokens: 5 * turns, outputTokens: 2 * turns, reasoningOutputTokens: turns, totalTokens: 12 * turns}, last: {inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12}}});
  notify('model/rerouted', {turnId: id, fromModel: 'resolved', toModel: 'effective'});
  active = undefined;
  notify('turn/completed', {turn: {id, status, error: status === 'failed' ? {message: 'turn failed'} : null}});
  if (mode === 'duplicate') notify('turn/completed', {turn: {id, status}});
  if (mode === 'late-failure') process.exit(2);
}
const lines = readline.createInterface({input: process.stdin});
lines.on('line', line => {
  const msg = JSON.parse(line);
  trace(msg);
  const reply = result => emit({id: msg.id, result});
  if (msg.method === 'initialize') {
    // The configuration probe runs without the per-name switches; only the run's own
    // app-server stalls in timeout mode.
    if (mode === 'timeout' && process.argv.join(' ').includes('mcp_servers.operator_mcp')) return;
    reply({userAgent: 'fake'}); return;
  }
  if (msg.method === 'initialized') {initialized = true; return;}
  if (!msg.method) return;
  if (!initialized) {process.exit(3); return;}
  if (msg.method === 'account/read') {
    accountReads += 1;
    if (mode === 'provider-401-logged-out' && accountReads > 1) {reply({account: null}); return;}
    reply({account: {type: process.env.FAKE_API ? 'apiKey' : 'chatgpt', email: 'private@example.invalid'}}); return;
  }
  if (msg.method === 'account/usage/read') {
    if (mode === 'usage-timeout') return;
    reply(mode === 'cost' ? {threadUsage: {threadId, estimatedUsageUsdMicros: 125000}} : {}); return;
  }
  // The operator's configuration adds one user skill and one MCP server unless switched off.
  const args = process.argv.slice(2).join(' ');
  if (msg.method === 'skills/list') {
    if (mode === 'no-inventory') return;
    reply({data: [{cwd: msg.params.cwds[0], skills: [
      {name: 'operator-skill', scope: 'user', enabled: !args.includes('{name="operator-skill",enabled=false}')},
      {name: 'repo-skill', scope: 'repo', enabled: true},
    ]}]}); return;
  }
  if (msg.method === 'mcpServerStatus/list') {
    if (mode === 'odd-name') { reply({data: [{name: 'odd.name', runtimeStatus: null, tools: {}}]}); return; }
    const off = args.includes('mcp_servers.operator_mcp.enabled=false');
    reply({data: [{name: 'operator_mcp', runtimeStatus: null, tools: off ? {} : {run: {}}}]}); return;
  }
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    threadId = msg.params.threadId || threadId;
    reply({thread: {id: mode === 'wrong-thread' ? 'other' : threadId}, model: 'resolved'}); return;
  }
  if (msg.method === 'thread/name/set') {reply({}); return;}
  if (msg.method === 'turn/start') {
    if (mode === 'rpc-error') {emit({id: msg.id, error: {code: -32600, message: 'invalid model'}}); return;}
    active = 'turn-' + ++turns;
    texts = [msg.params.input[0]?.text];
    notify('turn/started', {turn: {id: active, status: 'inProgress'}});
    if (mode === 'malformed') {process.stdout.write('broken json\\n'); return;}
    if (mode === 'oversize') {process.stdout.write('x'.repeat(4 * 1024 * 1024 + 10) + '\\n'); return;}
    if (mode === 'exit-zero') {process.exit(0); return;}
    if (mode === 'requests') {
      for (const [i, method] of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request','unrecognized/request'].entries()) emit({id: 'server-' + i, method, params: {threadId}});
    }
    // A notification from a subagent or another thread must not affect the parent run.
    emit({method: 'item/completed', params: {threadId: 'unrelated', turnId: active, item: {id: 'foreign', type: 'agentMessage', text: 'FOREIGN'}}});
    const id = active;
    if (mode === 'complete-before-reply') {finish(); setTimeout(() => reply({turn: {id, status: 'completed'}}), 20); return;}
    reply({turn: {id, status: 'inProgress'}});
    // Held turns say they are under way, so a test knows the session has seen the turn begin.
    if (mode === 'hold' || mode === 'ignore-term') {notify('item/completed', {turnId: id, item: {id: 'working-' + id, type: 'agentMessage', text: 'WORKING'}}); return;}
    timer = setTimeout(() => finish(['failed', 'overloaded'].includes(mode) ? 'failed' : 'completed'), mode === 'approval-outage' ? 300 : 100);
    return;
  }
  if (msg.method === 'turn/steer') {
    if (mode === 'race') {
      finish(); emit({id: msg.id, error: {code: -32600, message: 'no active turn'}}); return;
    }
    if (mode === 'steer-timeout') return;
    texts.push(msg.params.input[0]?.text); reply({turnId: active}); return;
  }
  if (msg.method === 'turn/interrupt') {
    if (mode === 'ignore-term') return;
    reply({}); finish('interrupted'); return;
  }
});
lines.on('close', () => { if (mode === 'shutdown-error') {setInterval(() => {}, 1000); return;} if (mode !== 'ignore-term') process.exit(0); });
`;
/** Modes in which a request is never answered, so the test waits out its budget. */
const TIMED_OUT_MODES = new Set(['timeout', 'steer-timeout', 'usage-timeout', 'no-inventory']);
const directories: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.kill();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function launch(
  mode = '',
  overrides: Partial<AgentLaunchRequest> = {},
  env: Record<string, string> = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), 'craftingtable-codex-'));
  directories.push(cwd);
  const executable = join(cwd, 'codex');
  writeFileSync(executable, FAKE);
  chmodSync(executable, 0o755);
  const session = await new CodexBackend({
    executable,
    env: { FAKE_MODE: mode, ...env },
    // The fake reads its mode from the environment, which the adapter allowlists (R-G5).
    allowEnvironment: ['FAKE_MODE', ...Object.keys(env)],
    terminationGraceMs: 50,
    // The adapter's own budget, as a run has it, except where a test waits for a request to time
    // out: a loaded host can take longer than a short budget to start the fake (TS-H1).
    ...(TIMED_OUT_MODES.has(mode) ? { requestTimeoutMs: 2_000 * testTimeScale() } : {}),
  }).launch({ cwd, prompt: 'first\nmultiline', permissionMode: 'auto', ...overrides });
  sessions.push(session);
  const items: AgentSessionItem[] = [];
  const done = (async () => {
    for await (const item of session.items) items.push(item);
  })();
  const messages = (): Array<{
    id?: string | number;
    method?: string;
    args?: string[];
    params: { input: Array<{ text: string }>; name?: string };
    result?: unknown;
    error?: unknown;
  }> =>
    readFileSync(join(cwd, 'rpc.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { session, items, done, messages };
}
async function waitFor(predicate: () => boolean) {
  await expect.poll(predicate, { interval: 10 }).toBe(true);
}
const turns = (items: AgentSessionItem[]) =>
  items.flatMap((item) =>
    item.type === 'event' && item.event.kind === 'turn-completed' ? [item.event.payload] : [],
  );

it('keeps one process for multiple turns, uses resolved metadata and closes only when ended', async () => {
  const { session, items, done, messages } = await launch();
  const pid = session.pid;
  await waitFor(() => turns(items).length === 1);
  expect(session.pid).toBe(pid);
  expect(session.send('again\nsecond line')).toBe(true);
  await waitFor(() => turns(items).length === 2);
  expect(session.pid).toBe(pid);
  // A probe app-server reports the operator's configuration; the run's switches it off (R-G5).
  const isolation = [
    'app-server',
    '--stdio',
    '--disable',
    'plugins',
    '--disable',
    'apps',
    '--disable',
    'hooks',
    '--disable',
    'memories',
  ];
  expect(messages().filter((msg) => msg.args)).toEqual([
    { args: isolation, pid: expect.any(Number) },
    {
      args: [
        ...isolation,
        '-c',
        'mcp_servers.operator_mcp.enabled=false',
        '-c',
        'skills.config=[{name="operator-skill",enabled=false}]',
      ],
      pid,
    },
  ]);
  expect(
    messages()
      .filter((msg) => msg.method === 'turn/start')
      .map((msg) => msg.params.input[0]?.text),
  ).toEqual(['first\nmultiline', 'again\nsecond line']);
  expect(
    items.filter((item) => item.type === 'event' && item.event.kind === 'session-started'),
  ).toMatchObject([
    {
      event: {
        payload: {
          model: 'resolved',
          billing: 'subscription',
          backendSessionId: 'fake-thread',
          loaded: { skills: ['repo-skill'], plugins: [], mcpServers: [] },
        },
      },
    },
  ]);
  expect(turns(items)[0]).toMatchObject({ model: 'effective', tokenUsage: { totalTokens: 12 } });
  expect(turns(items)[0]).not.toHaveProperty('costUsd');
  expect(JSON.stringify(items)).not.toContain('private@example.invalid');
  expect(JSON.stringify(items)).not.toContain('FOREIGN');
  session.end();
  await done;
  expect(items.at(-1)).toEqual({ type: 'exited', exitCode: 0, signal: null });
  expect(session.send('late')).toBe(false);
});

it('steers messages accepted during startup in order and drains them before ending', async () => {
  const { session, items, done, messages } = await launch();
  session.send('second');
  session.send('third');
  session.end();
  expect(session.send('late')).toBe(false);
  await done;
  expect(
    messages()
      .filter((msg) => msg.method === 'turn/steer')
      .map((msg) => msg.params.input[0]?.text),
  ).toEqual(['second', 'third']);
  expect(turns(items)).toHaveLength(1);
  expect(turns(items)[0]?.resultText).toBe('first\nmultiline | second | third');
  expect(items.at(-1)).toMatchObject({ exitCode: 0 });
});

it.each(['race', 'complete-before-reply'])(
  'preserves input when turn completion races %s',
  async (mode) => {
    const { session, items, done, messages } = await launch(mode);
    session.send('follow-up');
    session.end();
    await done;
    expect(turns(items)).toHaveLength(2);
    expect(turns(items)[1]?.resultText).toBe('follow-up');
    expect(messages().filter((msg) => msg.method === 'turn/start')).toHaveLength(2);
    expect(items.at(-1)).toMatchObject({ exitCode: 0 });
  },
);

it('resumes the exact thread, sets the name and developer instructions, and reports only the unsupported budget', async () => {
  const { session, items, done, messages } = await launch('', {
    resumeSessionId: 'resume-id',
    sessionName: 'Test run',
    appendSystemPrompt: 'private instructions',
    maxBudgetUsd: 5,
  });
  session.end();
  await done;
  expect(messages().find((msg) => msg.method === 'thread/resume')?.params).toMatchObject({
    threadId: 'resume-id',
    developerInstructions: 'private instructions',
    excludeTurns: true,
  });
  expect(messages().find((msg) => msg.method === 'thread/name/set')?.params).toMatchObject({
    name: 'Test run',
  });
  expect(JSON.stringify(items)).not.toContain('private instructions');
  expect(JSON.stringify(items)).toContain('budget cap');
  expect(items.at(-1)).toMatchObject({ exitCode: 0 });
});

it.each(['cost', 'usage-timeout', 'duplicate'])(
  'handles optional usage and duplicate completion: %s',
  async (mode) => {
    const { session, items, done } = await launch(mode);
    session.end();
    await done;
    expect(turns(items)).toHaveLength(1);
    if (mode === 'cost') expect(turns(items)[0]?.costUsd).toBe(0.125);
    else expect(turns(items)[0]).not.toHaveProperty('costUsd');
    expect(items.at(-1)).toMatchObject({ exitCode: 0 });
  },
);

it('responds to server requests without granting permissions or inventing user input', async () => {
  const { session, items, done, messages } = await launch('requests');
  session.end();
  await done;
  expect(
    messages()
      .filter((msg) => String(msg.id).startsWith('server-'))
      .map((msg) => msg.result ?? msg.error),
  ).toEqual([
    { decision: 'decline' },
    { decision: 'decline' },
    { permissions: {}, scope: 'turn' },
    { answers: {} },
    { action: 'decline', content: null, _meta: null },
    { code: -32601, message: 'Client request is not supported by CraftingTable' },
  ]);
  expect(items.at(-1)).toMatchObject({ exitCode: 0 });
});

it.each(['hold', 'ignore-term'])(
  'interrupts active work and reaps the process, escalating when needed: %s',
  async (mode) => {
    // What the session sends, whether or not a starved app-server reads it before it is killed.
    const requests = vi.spyOn(CodexRpc.prototype, 'request');
    try {
      const { session, items, done } = await launch(mode);
      // The session has processed the turn's start (TS-H1): notifications arrive in order, and
      // this one comes after `turn/started`, so the turn is active when it is killed.
      await waitFor(() =>
        items.some(
          (item) =>
            item.type === 'event' &&
            item.event.kind === 'assistant-message' &&
            item.event.payload.text === 'WORKING',
        ),
      );
      const pid = session.pid;
      session.kill();
      session.kill();
      await done;
      expect(requests.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(1);
      expect(items.at(-1)).toMatchObject({
        type: 'exited',
        signal: mode === 'ignore-term' ? 'SIGKILL' : 'SIGTERM',
      });
      expect(() => process.kill(pid ?? 0, 0)).toThrow();
    } finally {
      requests.mockRestore();
    }
  },
);

it('cancels while idle and before initialization', async () => {
  const idle = await launch();
  await waitFor(() => turns(idle.items).length === 1);
  idle.session.kill();
  await idle.done;
  expect(idle.items.at(-1)).toMatchObject({ type: 'exited', signal: 'SIGTERM' });
  const starting = await launch('timeout');
  starting.session.kill();
  await starting.done;
  expect(starting.items.at(-1)).toMatchObject({ type: 'exited', signal: 'SIGTERM' });
});

it.each([
  'timeout',
  'rpc-error',
  'failed',
  'malformed',
  'oversize',
  'exit-zero',
  'late-failure',
  'steer-timeout',
  'wrong-thread',
])('fails closed for %s', async (mode) => {
  const { session, items, done } = await launch(
    mode,
    mode === 'wrong-thread' ? { resumeSessionId: 'requested' } : {},
  );
  if (mode === 'steer-timeout') session.send('ambiguous delivery');
  await done;
  expect(items.at(-1)).toMatchObject({ type: 'exited' });
  const last = items.at(-1);
  expect(last?.type === 'exited' && last.exitCode).not.toBe(0);
  expect(session.send('late')).toBe(false);
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

it('preserves a backend error during graceful shutdown instead of authorizing success', async () => {
  const { session, items, done } = await launch('shutdown-error');
  session.end();
  await done;
  expect(turns(items)[0]?.outcome).toBe('success');
  expect(items.at(-1)).toMatchObject({ type: 'exited', exitCode: 2 });
});

it('passes the run overlay the daemon computed into the app-server child environment', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'craftingtable-scratch-'));
  directories.push(scratch);
  const { session, items, done, messages } = await launch('scratch', {
    environment: {
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      CARGO_TARGET_DIR: `${scratch}/target`,
    },
    additionalDirectories: [scratch],
  });
  await waitFor(() => turns(items).length === 1);
  session.end();
  await done;
  expect(messages()).toContainEqual({
    temporaryPaths: [scratch, scratch, scratch, `${scratch}/target`],
  });
});

it("starts the probe and the run's app-server from named variables only, plus the run overlay (TS-M4, R-G5, SEC-02)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'craftingtable-codex-'));
  directories.push(cwd);
  const executable = join(cwd, 'codex');
  writeFileSync(executable, FAKE);
  chmodSync(executable, 0o755);
  const session = await new CodexBackend({
    executable,
    // What the daemon's own environment carries beside the named variables.
    env: {
      FAKE_MODE: 'env-names',
      HOME: '/home/operator',
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      LC_TIME: 'C',
      OPENAI_API_KEY: 'key',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-1',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      SSH_AUTH_SOCK: '/run/user/1000/ssh',
      HYPRLAND_INSTANCE_SIGNATURE: 'x',
      CRAFTINGTABLE_DATA_DIR: '/srv/craftingtable',
      OPERATOR_DECLARED: 'yes',
      OPERATOR_SECRET: 'no',
    },
    allowEnvironment: ['FAKE_MODE', 'OPERATOR_DECLARED'],
    terminationGraceMs: 50,
  }).launch({
    cwd,
    prompt: 'first',
    permissionMode: 'auto',
    environment: { CRAFTINGTABLE_RUN_NAMESPACE: 'run', TMPDIR: '/scratch' },
    pathPrefix: ['/run/bin'],
  });
  sessions.push(session);
  const items: AgentSessionItem[] = [];
  const done = (async () => {
    for await (const item of session.items) items.push(item);
  })();
  await waitFor(() => turns(items).length === 1);
  session.end();
  await done;
  const started = readFileSync(join(cwd, 'rpc.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { envNames?: string[]; path?: string; args?: string[] })
    .filter((line) => line.envNames !== undefined);
  const expected = {
    envNames: [
      'CRAFTINGTABLE_RUN_NAMESPACE',
      'FAKE_MODE',
      'HOME',
      'LANG',
      'LC_TIME',
      'OPENAI_API_KEY',
      'OPERATOR_DECLARED',
      'PATH',
      'TMPDIR',
    ],
    path: '/run/bin:/usr/bin',
  };
  // Both processes: the configuration probe (no per-name switches) and the run's app-server.
  expect(started).toEqual([
    { ...expected, args: expect.not.arrayContaining(['-c']) },
    { ...expected, args: expect.arrayContaining(['-c']) },
  ]);
});

it('retains a structured temporary failure through terminal process cleanup', async () => {
  const { session, items, done } = await launch('overloaded');
  await done;
  expect(turns(items)[0]).toMatchObject({
    outcome: 'error',
    providerFailure: { kind: 'capacity', safeToRetry: true },
  });
  expect(items.at(-1)).toMatchObject({ type: 'exited', exitCode: 1 });
  expect(session.pid).toBeUndefined();
});

it('reports a provider-side credential rejection, and fails the run it blocked (R-C11)', async () => {
  const rejected = await launch('provider-401');
  await rejected.done;
  expect(turns(rejected.items)[0]).toMatchObject({
    outcome: 'error',
    providerFailure: { kind: 'credential-rejected', safeToRetry: true },
  });
  expect(rejected.items.at(-1)).toMatchObject({ type: 'exited', exitCode: 1 });
  // A command refused because its approval review hit the same rejection: the turn keeps its
  // outcome and reports the suspected outage; the session stays usable.
  const approval = await launch('approval-outage');
  await waitFor(() => turns(approval.items).length === 1);
  expect(turns(approval.items)[0]).toMatchObject({
    outcome: 'success',
    suspectedOutage: { kind: 'credential-rejected', safeToRetry: true },
  });
  expect(turns(approval.items)[0]).not.toHaveProperty('providerFailure');
  approval.session.end();
  await approval.done;
  expect(approval.items.at(-1)).toEqual({ type: 'exited', exitCode: 0, signal: null });
});

it('asks for a new sign-in when the local login is gone or uses an API key (R-C11)', async () => {
  const loggedOut = await launch('provider-401-logged-out');
  await loggedOut.done;
  expect(turns(loggedOut.items)[0]).toMatchObject({
    providerFailure: { kind: 'authentication', safeToRetry: false },
  });
  // An API-key login, or an API key in the environment Codex runs with: the key may be sent.
  const keys: Record<string, string>[] = [
    { FAKE_API: '1' },
    { OPENAI_API_KEY: 'sk-local' },
    { CODEX_API_KEY: 'k' },
  ];
  for (const env of keys) {
    const keyed = await launch('provider-401', {}, env);
    await keyed.done;
    expect(turns(keyed.items)[0]).toMatchObject({
      providerFailure: {
        kind: 'authentication',
        message: expect.stringContaining('Sign in again'),
      },
    });
  }
});

it('does not start a run whose Codex configuration cannot be read (R-G5)', async () => {
  await expect(launch('no-inventory')).rejects.toMatchObject({
    name: 'AgentLaunchError',
    message: expect.stringContaining('could not report its configuration'),
  });
});

it('refuses a configuration name the switches cannot address as a launch error (R-G5 review)', async () => {
  await expect(launch('odd-name')).rejects.toMatchObject({
    name: 'AgentLaunchError',
    message: expect.stringContaining('cannot be switched off'),
  });
});
