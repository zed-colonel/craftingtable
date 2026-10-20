import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
import { afterEach, expect, inject, it } from 'vitest';
import { createServices, type ServiceSet } from '../src/composition.js';
import { configFromEnv } from '../src/config.js';
import { openDaemonStorage } from '../src/persisted-records.js';
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
import { FastTestPasswordHasher, testDataRoot } from './test-support.js';

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
  /** Lets what the agent did reach the first daemon again, so its cleanup can finish. */
  revive: () => void = () => undefined;
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
/** Each test's first daemon, revived at cleanup so its close never waits on what it froze. */
const firstDaemons: KilledDaemonBackend[] = [];
/** Process groups this test's daemons started, ended whatever the test did. */
const groups: { readonly pid: number; readonly startTime: string }[] = [];
const members: { readonly pid: number; readonly startTime: string }[] = [];
const directories: string[] = [];
/** A process's start time, or nothing once it is gone. */
function startedAt(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}
afterEach(async () => {
  for (const services of restarted.splice(0)) {
    await services.daemonDrain.drain(0);
    await services.checkRequestService.closeAll();
  }
  // Only while the leader is still the process the daemon started, never a reused pid.
  for (const { pid, startTime } of groups.splice(0))
    if (startedAt(pid) === startTime) process.kill(-pid, 'SIGKILL');
  // Members a test started, alone: one whose leader has exited leaves no leader to check.
  for (const { pid, startTime } of members.splice(0))
    if (startedAt(pid) === startTime) process.kill(pid, 'SIGKILL');
  // A test that failed before reviving its first daemon would leave that daemon's close waiting
  // for an exit it can no longer hear, past the server's close timeout.
  for (const daemon of firstDaemons.splice(0)) daemon.revive();
  await cleanupExecutionFixtures();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * A stand-in `claude` whose group outlives the daemon: it ignores SIGTERM, ignores the end of
 * its input, and starts a member of its own group that ignores SIGTERM too. The member writes
 * `member.pid` itself, once it ignores SIGTERM: a test waits for that file, so a signal the
 * daemon sends after it never finds the member still starting (R-I12: under load a new Node
 * process took over 50 ms to reach its handler, and the group's SIGTERM killed it first).
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
fs.writeFileSync('member.pid', String(process.pid));
const root = process.env.BUSY_ROOT;
const used = root ? fs.readdirSync(root).filter((name) => /^[0-9a-f]+$/.test(name)) : [];
setInterval(() => {
  for (const name of used) fs.mkdirSync(path.join(root, name, 'busy'), { recursive: true });
}, 5);`)};
// With POLITE, an ordinary agent instead: no member, and it ends with its input.
if (!process.env.POLITE) process.on('SIGTERM', () => {});
if (process.env.POLITE) fs.writeFileSync('member.pid', String(process.pid));
else require('node:child_process').spawn(process.execPath, ['-e', MEMBER], { stdio: 'ignore' });
// A \`speak\` file in its directory makes it say something more.
setInterval(() => {
  if (!fs.existsSync('speak')) return;
  fs.unlinkSync('speak');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'again' }] } }) + '\\n');
}, 50);
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake', model: 'fake-model' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) + '\\n');
  // With LEADER_EXITS, the agent itself goes once the daemon has heard it, leaving its member.
  if (process.env.LEADER_EXITS) setTimeout(() => process.exit(0), 300);
});
process.stdin.on('end', () => {
  if (process.env.POLITE) process.exit(0);
});
setInterval(() => {}, 1000);
`;

/** A daemon running one live review whose agent is the stubborn stand-in. */
async function liveRun(
  options: {
    readonly busyTemporaryDirectories?: boolean;
    readonly leaderExits?: boolean;
    readonly polite?: boolean;
    /** The first daemon goes on hearing its agent: it is not the killed one. */
    readonly daemonLives?: boolean;
    /** How long the first daemon's own kill waits before SIGKILL. */
    readonly terminationGraceMs?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-reaping-'));
  directories.push(directory);
  const executable = join(directory, 'claude');
  writeFileSync(executable, STUBBORN_AGENT);
  chmodSync(executable, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.leaderExits ? { LEADER_EXITS: '1' } : {}),
    ...(options.polite ? { POLITE: '1' } : {}),
  };
  const killed = new KilledDaemonBackend(
    new ClaudeCodeBackend({
      executable,
      env,
      allowEnvironment: ['BUSY_ROOT', 'LEADER_EXITS', 'POLITE'],
      ...(options.terminationGraceMs === undefined
        ? {}
        : { terminationGraceMs: options.terminationGraceMs }),
    }),
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
  // The member's pid, once the member has written all of it, which it does only once it ignores
  // SIGTERM (a polite stand-in writes its own): the file exists, empty, for a moment before its
  // digits land, and a busy host can catch that moment.
  const memberFile = join(worktree.path, 'member.pid');
  const writtenMember = () => {
    try {
      const text = readFileSync(memberFile, 'utf8');
      return /^\d+$/.test(text) ? Number(text) : undefined;
    } catch {
      return undefined;
    }
  };
  // Records are replaced whole, so one that exists is complete.
  const records = state.context.config.execution.processRecordRoot ?? '';
  const identityPath = join(records, `${runId}.json`);
  await waitFor(() => {
    const member = writtenMember();
    return (
      state.context.storage.execution.runs.find(state.workspaceId, runId)?.status === 'running' &&
      member !== undefined &&
      processRunning(member) &&
      existsSync(identityPath)
    );
  }, 'the agent at work, its member running and its group recorded');
  const memberPid = writtenMember() ?? 0;
  // Daemon-private (operator decision 2026-10-07): under the database's directory.
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as {
    pid: number;
    startTime: string;
    bootId: string;
  };
  groups.push(identity);
  const memberStart = startedAt(memberPid);
  if (memberStart) members.push({ pid: memberPid, startTime: memberStart });
  firstDaemons.push(killed);
  if (!options.daemonLives) killed.die();
  return {
    worktreePath: worktree.path,
    /** The first daemon's backend: `die()` stands for its hard kill. */
    firstDaemon: killed,
    state,
    runId,
    runDirectory: join(state.context.config.execution.runsRoot, runId),
    // The next daemon's own backend, with the same stand-in.
    backends: new Map([['claude-code' as const, new ClaudeCodeBackend({ executable })]]),
    identity,
    identityPath,
    member: memberPid,
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

it('leaves alone a group that started before the run, whatever its record says (R-G11)', async () => {
  // A record naming a group older than its run, however it came to (a daemon fault, a hand
  // edit): a group that started before the run cannot be the run's.
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
  // The run's own record, naming that group instead.
  writeFileSync(
    identityPath,
    JSON.stringify({ ...JSON.parse(readFileSync(identityPath, 'utf8')), ...forged }),
  );

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

it('ends a group whose agent has exited, leaving a member that started with the run (R-G11, operator 2026-10-07)', async () => {
  const { state, runId, backends, identity, member } = await liveRun({ leaderExits: true });
  await waitFor(() => !processRunning(identity.pid), 'the agent itself to exit');
  expect(processRunning(member)).toBe(true);

  await restart(state, backends);

  await waitFor(() => !processRunning(member), 'the member to be gone');
  const events = journal(state, runId);
  const reaped = events.findIndex(
    (event) =>
      event.kind === 'notice' && event.payload.message.includes(`process group ${identity.pid}`),
  );
  expect(reaped).toBeGreaterThan(-1);
  expect(reaped).toBeLessThan(events.findIndex((event) => event.kind === 'run-finished'));
  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
    'interrupted',
  );
});

it('leaves alone a leaderless group with a member older than the run (R-G11, operator 2026-10-07)', async () => {
  // A group the test starts before the run: its leader starts a member, then the test ends
  // the leader alone.
  const leader = spawn(
    process.execPath,
    [
      '-e',
      // The pid as plain text: under FORCE_COLOR, console.log colours a number (ANSI codes).
      "const m = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(m.pid) + '\\n'); setInterval(() => {}, 1000)",
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const older = processGroupIdentity(leader.pid);
  if (!older) throw new Error('no identity for the older group');
  const olderMember = Number(
    await new Promise<string>((resolve) =>
      leader.stdout?.once('data', (data) => resolve(String(data))),
    ),
  );
  const olderStart = startedAt(olderMember);
  if (olderStart) members.push({ pid: olderMember, startTime: olderStart });
  leader.kill('SIGKILL');
  await waitFor(() => !processRunning(older.pid), 'the older leader to exit');
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const { state, runId, backends, identityPath } = await liveRun();
  // The run's own record, naming that group instead.
  writeFileSync(
    identityPath,
    JSON.stringify({ ...JSON.parse(readFileSync(identityPath, 'utf8')), ...older }),
  );

  await restart(state, backends);

  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
    'interrupted',
  );
  expect(processRunning(olderMember)).toBe(true);
});

it('keeps the record until the agent has exited, and then removes it (R-G11 review LOW-4)', async () => {
  const { state, runId, identityPath } = await liveRun({ polite: true, daemonLives: true });
  expect(existsSync(identityPath)).toBe(true);
  const ended = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${runId}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'end' },
  });
  expect(ended.statusCode, ended.body).toBe(200);
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(state.workspaceId, runId)?.status === 'finished',
    'the run to finish',
  );
  expect(existsSync(identityPath)).toBe(false);
});

/** Makes the daemon's supervision of its run fail at the agent's next message ("again"). */
function failSupervision(state: Ready, worktreePath: string) {
  // The journal's, which supervision appends to (R-B7 increment 10).
  const service = (
    state.context.services.agentRunService as unknown as {
      journal: {
        appendEvent: (
          workspaceId: string,
          runId: string,
          event: { kind: string; payload: unknown },
        ) => void;
      };
    }
  ).journal;
  const append = service.appendEvent.bind(service);
  service.appendEvent = (workspaceId, id, event) => {
    if (event.kind === 'assistant-message' && JSON.stringify(event.payload).includes('again'))
      throw new Error('journal unavailable');
    append(workspaceId, id, event);
  };
  writeFileSync(join(worktreePath, 'speak'), '');
}

it('keeps the record of a run ended before its agent exits, until it has (R-G11 review LOW-4)', async () => {
  const { state, runId, identity, identityPath, worktreePath } = await liveRun({
    daemonLives: true,
  });
  // The run is ended at once and its agent, which ignores SIGTERM, is killed only after the
  // grace period.
  failSupervision(state, worktreePath);
  await waitFor(
    () => state.context.storage.execution.runs.find(state.workspaceId, runId)?.status === 'failed',
    'the run to end',
  );
  expect(processRunning(identity.pid)).toBe(true);
  expect(existsSync(identityPath)).toBe(true);
  await waitFor(() => !existsSync(identityPath), 'the record to go once the agent has exited');
  expect(processRunning(identity.pid)).toBe(false);
});

it('ends at start the group of a run already ended whose agent outlived a hard kill (R-G11 re-check LOW-4)', async () => {
  const { state, runId, identity, identityPath, member, worktreePath, firstDaemon, backends } =
    // The first daemon's own SIGKILL waits far longer than the test can take, at any load.
    await liveRun({ daemonLives: true, terminationGraceMs: 120_000 * inject('testTimeScale') });
  failSupervision(state, worktreePath);
  await waitFor(
    () => state.context.storage.execution.runs.find(state.workspaceId, runId)?.status === 'failed',
    'the run to end',
  );
  // The daemon is hard-killed while its killed agent still runs (it ignores SIGTERM).
  firstDaemon.die();
  expect(processRunning(identity.pid) && processRunning(member)).toBe(true);
  expect(existsSync(identityPath)).toBe(true);

  await restart(state, backends);

  await waitFor(
    () => !processRunning(identity.pid) && !processRunning(member),
    'the group to be gone',
  );
  expect(
    journal(state, runId).some(
      (event) =>
        event.kind === 'notice' && event.payload.message.includes(`process group ${identity.pid}`),
    ),
  ).toBe(true);
  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
    'failed',
  );
  expect(existsSync(identityPath)).toBe(false);
  // The first daemon's supervision still waits to hear its agent exit before it can close.
  firstDaemon.revive();
});

it('leaves alone the agents of the installation whose data directory it was copied from (R-G11 re-check LOW-6)', async () => {
  const { state, runId, identity, member } = await liveRun();
  // A copy of the data directory, taken while the original daemon's run is live.
  const copy = mkdtempSync(join(testDataRoot(), 'craftingtable-copy-'));
  directories.push(copy);
  cpSync(join(state.context.config.dataDir, 'state'), join(copy, 'state'), { recursive: true });
  const config = configFromEnv({
    CRAFTINGTABLE_DATA_DIR: copy,
    CRAFTINGTABLE_CONFIG_DIR: join(copy, 'config'),
    CRAFTINGTABLE_LOG_LEVEL: 'silent',
    CRAFTINGTABLE_WEB_DIST: '',
    CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '0',
    CRAFTINGTABLE_CHECK_CONFINEMENT: 'none',
  });
  const storage = openDaemonStorage(config.databasePath);
  let services: ServiceSet | undefined;
  try {
    services = await createServices(storage, config, {
      notificationTransport: { send: async () => ({ status: 'accepted' }) },
      passwordHasher: new FastTestPasswordHasher(),
      gitOperations: createGitOperations({ gitExecutable: 'git' }),
      agentBackends: new Map(),
      recoveryTerminationGraceMs: 300,
    });
    // The copy marks its own record of the run interrupted, and leaves the original's agent.
    expect(storage.execution.runs.find(state.workspaceId, runId)?.status).toBe('interrupted');
    expect(
      storage.execution.runEvents
        .listAfter({ workspaceId: state.workspaceId, runId, after: 0, limit: 500 })
        .some(
          (event) =>
            event.kind === 'notice' && event.payload.message.includes('another installation'),
        ),
    ).toBe(true);
    expect(processRunning(identity.pid) && processRunning(member)).toBe(true);
    expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
      'running',
    );
  } finally {
    // The copy's daemon stops before its database closes.
    await services?.daemonDrain.drain(0);
    await services?.checkRequestService.closeAll();
    storage.close();
  }
});

it('clears leftover records at start (R-G11 review)', async () => {
  const { state, backends } = await liveRun();
  const records = state.context.config.execution.processRecordRoot ?? '';
  writeFileSync(join(records, '00000000-0000-4000-8000-000000000000.json'), '{}');
  writeFileSync(join(records, '00000000-0000-4000-8000-000000000000.json.0123456789abcdef'), '');
  writeFileSync(join(records, 'operator-notes.txt'), 'kept');
  await restart(state, backends);
  expect(readdirSync(records)).toEqual(['operator-notes.txt']);
});

it.each([
  ['a link to a true record', 'link'],
  ['a true record padded past 4 KiB', 'oversize'],
] as const)('reaps nothing when the record is %s (R-G11 review)', async (_, kind) => {
  const { state, runId, runDirectory, backends, identity, identityPath, member } = await liveRun();
  const truth = JSON.stringify(identity);
  rmSync(identityPath);
  if (kind === 'link') {
    writeFileSync(join(runDirectory, 'elsewhere.json'), truth);
    symlinkSync(join(runDirectory, 'elsewhere.json'), identityPath);
  } else writeFileSync(identityPath, truth + ' '.repeat(4096));
  await restart(state, backends);
  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.status).toBe(
    'interrupted',
  );
  expect(processRunning(identity.pid) && processRunning(member)).toBe(true);
});
