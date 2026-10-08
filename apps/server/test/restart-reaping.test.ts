import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentBackend,
  type AgentLaunchRequest,
  type AgentSession,
  type AgentSessionItem,
  ClaudeCodeBackend,
  processGroupIdentity,
} from '@craftingtable/agents';
import { startAgentRunResponseSchema } from '@craftingtable/contracts';
import type { AgentRunId } from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { afterEach, expect, it } from 'vitest';
import { createServices, type ServiceSet } from '../src/composition.js';
import {
  cleanupExecutionFixtures,
  fixtureRepository,
  mutationHeaders,
  processRunning,
  type Ready,
  ready,
  registerAndWorktree,
  stepUp,
  waitFor,
} from './execution-test-support.js';
import { FastTestPasswordHasher } from './test-support.js';

/**
 * R-G11 (AGT-02): a daemon that stops without draining (a hard kill outside systemd, such as
 * the dev daemon's `tsx watch`) leaves its agents' process groups running. The next daemon
 * reads each live run's recorded process identity and ends the group before it marks the run
 * interrupted, but only when the identity proves the group is the run's. The first daemon here
 * is never closed before the second starts on its database: it stands for the killed one, and
 * its backend stops passing on what the agent does, as a killed daemon hears nothing more.
 */
class KilledDaemonBackend implements AgentBackend {
  readonly kind = 'claude-code' as const;
  /** Set once the daemon "dies": nothing more reaches it until its session is killed. */
  private dead: Promise<void> | undefined;
  private revive: () => void = () => undefined;
  constructor(private readonly inner: ClaudeCodeBackend) {}
  describe() {
    return this.inner.describe();
  }
  listModels() {
    return this.inner.listModels();
  }
  die(): void {
    this.dead = new Promise((resolve) => {
      this.revive = resolve;
    });
  }
  async launch(request: AgentLaunchRequest): Promise<AgentSession> {
    const session = await this.inner.launch(request);
    const backend = this;
    const items = (async function* (): AsyncGenerator<AgentSessionItem> {
      for await (const item of session.items) {
        await backend.dead;
        yield item;
      }
    })();
    return {
      get backgroundWorkPending() {
        return session.backgroundWorkPending;
      },
      pid: session.pid,
      items,
      send: (text) => session.send(text),
      end: () => session.end(),
      // The test's cleanup closes the first daemon too; it hears its session end then.
      kill: () => {
        this.revive();
        session.kill();
      },
    };
  }
}
const restarted: ServiceSet[] = [];
/** Process groups this test's daemons started, ended whatever the test did. */
const groups: { readonly pid: number; readonly startTime: string }[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const services of restarted.splice(0)) {
    await services.daemonDrain.drain(0);
    await services.checkRequestService.closeAll();
  }
  // Only while the leader is still the process the daemon started, never a reused pid.
  for (const { pid, startTime } of groups.splice(0))
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === startTime)
        process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  await cleanupExecutionFixtures();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * A stand-in `claude` whose group outlives the daemon: it ignores SIGTERM, ignores the end of
 * its input, and starts a member of its own group that ignores SIGTERM too.
 */
const STUBBORN_AGENT = `#!${process.execPath}
// The daemon reads the CLI's version at start (R-G15): answer it and start nothing.
if (process.argv[2] === '--version') {
  console.log('2.1.300 (Claude Code)');
  process.exit(0);
}
const fs = require('node:fs');
// With BUSY_ROOT, the member keeps using the agents' temporary directories there, as a
// background build keeps writing its TMPDIR, recreating them if they are removed.
const MEMBER = ${JSON.stringify(`
const fs = require('node:fs');
const path = require('node:path');
process.on('SIGTERM', () => {});
const root = process.env.BUSY_ROOT;
const used = root ? fs.readdirSync(root).filter((name) => /^[0-9a-f]+$/.test(name)) : [];
setInterval(() => {
  for (const name of used) fs.mkdirSync(path.join(root, name, 'busy'), { recursive: true });
}, 5);`)};
process.on('SIGTERM', () => {});
const member = require('node:child_process').spawn(process.execPath, ['-e', MEMBER], { stdio: 'ignore' });
fs.writeFileSync('member.pid', String(member.pid));
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake', model: 'fake-model' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) + '\\n');
});
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
`;

/** A daemon running one live review whose agent is the stubborn stand-in. */
async function liveRun(options: { readonly busyTemporaryDirectories?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-reaping-'));
  directories.push(directory);
  const executable = join(directory, 'claude');
  writeFileSync(executable, STUBBORN_AGENT);
  chmodSync(executable, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env };
  const killed = new KilledDaemonBackend(
    new ClaudeCodeBackend({ executable, env, allowEnvironment: ['BUSY_ROOT'] }),
  );
  const state = await ready({ backends: new Map([['claude-code', killed]]) });
  if (options.busyTemporaryDirectories)
    env.BUSY_ROOT = state.context.config.execution.agentTemporaryRoot;
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  // Unrestricted, which needs a fresh password: the stand-in needs no command sandbox.
  await stepUp(state);
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'review', permissionMode: 'unrestricted' },
  });
  expect(started.statusCode, started.body).toBe(200);
  const runId = startAgentRunResponseSchema.parse(started.json()).run.id;
  const memberFile = join(worktree.path, 'member.pid');
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(state.workspaceId, runId)?.status === 'running' &&
      existsSync(memberFile),
    'the agent at work',
  );
  // Daemon-private (operator decision 2026-10-07): under the database's directory.
  const records = state.context.config.execution.processRecordRoot ?? '';
  const identityPath = join(records, `${runId}.json`);
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as {
    pid: number;
    startTime: string;
    bootId: string;
  };
  groups.push(identity);
  killed.die();
  return {
    state,
    runId,
    runDirectory: join(state.context.config.execution.runsRoot, runId),
    // The next daemon's own backend, with the same stand-in.
    backends: new Map([['claude-code' as const, new ClaudeCodeBackend({ executable })]]),
    identity,
    identityPath,
    member: Number(readFileSync(memberFile, 'utf8')),
  };
}

/** Starts a second daemon on the same database, as the next start after a hard kill does. */
async function restart(state: Ready, backends: ReadonlyMap<'claude-code', ClaudeCodeBackend>) {
  const services = await createServices(state.context.storage, state.context.config, {
    notificationTransport: { send: async () => ({ status: 'accepted' }) },
    passwordHasher: new FastTestPasswordHasher(),
    gitOperations: createGitOperations({ gitExecutable: 'git' }),
    agentBackends: backends,
    recoveryTerminationGraceMs: 300,
  });
  restarted.push(services);
  return services;
}

function journal(state: Ready, runId: AgentRunId) {
  return state.context.storage.execution.runEvents.listAfter({
    workspaceId: state.workspaceId,
    runId,
    after: 0,
    limit: 500,
  });
}

it('ends a run’s surviving process group, journals it, then marks the run interrupted (R-G11, AGT-02)', async () => {
  const { state, runId, backends, identity, member } = await liveRun();
  expect(identity.pid).toBeGreaterThan(1);
  expect(processRunning(identity.pid) && processRunning(member)).toBe(true);

  await restart(state, backends);

  // Both ignored SIGTERM: the grace period passed and the group was killed.
  await waitFor(
    () => !processRunning(identity.pid) && !processRunning(member),
    'the group to be gone',
  );
  const events = journal(state, runId);
  const reaped = events.findIndex(
    (event) =>
      event.kind === 'notice' && event.payload.message.includes(`process group ${identity.pid}`),
  );
  const finished = events.findIndex((event) => event.kind === 'run-finished');
  expect(reaped).toBeGreaterThan(-1);
  expect(reaped).toBeLessThan(finished);
  expect(events[reaped]).toMatchObject({
    payload: { message: expect.stringContaining('SIGKILL') },
  });
  expect(events[finished]).toMatchObject({ payload: { status: 'interrupted' } });
});

it.each([
  ['another start time', { startTime: '1' }],
  ['another boot', { bootId: '00000000-0000-4000-8000-000000000000' }],
])('leaves alone a group whose recorded identity names %s (R-G11, AGT-02)', async (_, changed) => {
  const { state, runId, backends, identity, identityPath, member } = await liveRun();
  // The pid now belongs to some other process, as far as the record can tell.
  writeFileSync(identityPath, JSON.stringify({ ...identity, ...changed }));

  await restart(state, backends);

  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
    'interrupted',
  );
  expect(processRunning(identity.pid) && processRunning(member)).toBe(true);
  expect(
    journal(state, runId).some(
      (event) => event.kind === 'notice' && event.payload.message.includes('process group'),
    ),
  ).toBe(false);
});

it('leaves alone a group that started before the run, whatever the run directory says (R-G11)', async () => {
  // The record is in the run directory, which the agent can write: it could name any group.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const forged = processGroupIdentity(bystander.pid);
  if (!forged) throw new Error('no identity for the bystander');
  groups.push(forged);
  // The run is created at least a slack's worth after the bystander started.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const { state, runId, backends, identityPath } = await liveRun();
  writeFileSync(identityPath, JSON.stringify(forged));

  await restart(state, backends);

  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
    'interrupted',
  );
  expect(processRunning(forged.pid)).toBe(true);
});

it('starts at once when a pipe stands where the record should be (R-G11)', async () => {
  const { state, runId, backends, identityPath } = await liveRun();
  // A reader that waited on this pipe would hold the daemon's start until the helper below
  // writes to it.
  rmSync(identityPath);
  execFileSync('mkfifo', [identityPath]);
  const writer = spawn('sh', ['-c', 'sleep 5; printf x > "$1"', 'sh', identityPath], {
    detached: true,
    stdio: 'ignore',
  });
  const helper = processGroupIdentity(writer.pid);
  if (helper) groups.push(helper);
  const started = Date.now();
  await restart(state, backends);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
    'interrupted',
  );
});

it("ends a surviving group before it removes the agents' temporary directories it used (R-G11)", async () => {
  const { state, backends, identity } = await liveRun({ busyTemporaryDirectories: true });
  const root = state.context.config.execution.agentTemporaryRoot;
  const runDirectories = () => readdirSync(root).filter((name) => /^[0-9a-f]+$/.test(name));
  expect(runDirectories()).toHaveLength(1);
  await waitFor(
    () => runDirectories().every((name) => existsSync(join(root, name, 'busy'))),
    'the member at work in its temporary directory',
  );

  const services = await restart(state, backends);
  await services.agentRunService.quiesce();

  expect(processRunning(identity.pid)).toBe(false);
  // Removed after the group that used it was gone, so nothing recreated it.
  expect(runDirectories()).toEqual([]);
});

it('keeps the record where no sandboxed agent reaches, and ignores one in the run directory (R-G11, operator 2026-10-07)', async () => {
  const { state, runId, runDirectory, backends, identity, identityPath, member } = await liveRun();
  const execution = state.context.config.execution;
  // The daemon's own directory, which R-G9's protected reads keep from sandboxed commands.
  expect(execution.protectedReads?.some((root) => identityPath.startsWith(`${root}/`))).toBe(true);
  expect(statSync(identityPath).mode & 0o777).toBe(0o600);
  expect(statSync(execution.processRecordRoot ?? '').mode & 0o777).toBe(0o700);
  expect(existsSync(join(runDirectory, 'process.json'))).toBe(false);
  // An agent writes a true identity in its run directory, as runs before this change had it.
  rmSync(identityPath);
  writeFileSync(join(runDirectory, 'process.json'), JSON.stringify(identity));

  await restart(state, backends);

  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
    'interrupted',
  );
  expect(processRunning(identity.pid) && processRunning(member)).toBe(true);
});
