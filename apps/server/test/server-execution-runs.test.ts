import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type {
  AgentBackend,
  AgentLaunchRequest,
  AgentSession,
  AgentSessionItem,
} from '@craftingtable/agents';
import {
  agentRunCommandResponseSchema,
  agentRunDetailResponseSchema,
  apiErrorResponseSchema,
  executionStatusResponseSchema,
  registerSourceRepositoryResponseSchema,
  removeWorktreeResponseSchema,
  runEventPageResponseSchema,
  runProfilesResponseSchema,
  sourceRepositoryListResponseSchema,
  startAgentRunResponseSchema,
  workItemExecutionResponseSchema,
  workspaceRunsResponseSchema,
  worktreeDiffResponseSchema,
} from '@craftingtable/contracts';
import {
  AGENT_PROFILE_PURPOSES,
  type AgentBackendKind,
  asAgentRunEventId,
  asWorktreeId,
  TOOL_RESULT_PREVIEW_BYTES,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { recordedFindings } from '../src/services/run-handoff.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  admit,
  branchCommand,
  cleanupExecutionFixtures,
  controlCycle,
  cycleProfiles,
  directories,
  fixtureRepository,
  git,
  merge,
  mergeGate,
  mutationHeaders,
  present,
  type Ready,
  ready,
  registerAndWorktree,
  reviewText,
  runDetail,
  runToFinish,
  ScriptedBackend,
  startCycle,
  stepUp,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * A session whose second event cannot be journaled (a BigInt payload makes the
 * storage append throw inside the run consumer), and whose process keeps
 * running after kill() until the test lets it exit, like a process group that
 * takes time to drain.
 */
class UnsupervisableSession implements AgentSession {
  readonly pid = 4343;
  killCount = 0;
  private readonly queue: AgentSessionItem[] = [];
  private waiter: ((item: IteratorResult<AgentSessionItem>) => void) | undefined;
  private closed = false;

  constructor(request: AgentLaunchRequest) {
    this.push({
      type: 'event',
      event: {
        kind: 'session-started',
        payload: {
          backend: 'claude-code',
          backendSessionId: 'unsupervisable-session',
          model: 'scripted-model',
          permissionMode: request.permissionMode,
          cwd: request.cwd,
          billing: 'subscription',
        },
      },
    });
    this.push({
      type: 'event',
      event: { kind: 'assistant-message', payload: { text: 1n as unknown as string } },
    });
  }

  readonly items: AsyncIterable<AgentSessionItem> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<AgentSessionItem>> => {
        const item = this.queue.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    }),
  };

  private push(item: AgentSessionItem): void {
    const resolve = this.waiter;
    this.waiter = undefined;
    if (resolve !== undefined) resolve({ value: item, done: false });
    else this.queue.push(item);
  }

  send(): boolean {
    return !this.closed;
  }

  end(): void {}

  kill(): void {
    this.killCount++;
  }

  exitNow(): void {
    this.push({ type: 'exited', exitCode: null, signal: 'SIGTERM' });
    this.closed = true;
  }
}

class UnsupervisableBackend extends ScriptedBackend {
  stalled: UnsupervisableSession | undefined;
  override launch(request: AgentLaunchRequest): Promise<AgentSession> {
    if (this.stalled !== undefined) return super.launch(request);
    this.launches.push(request);
    this.stalled = new UnsupervisableSession(request);
    return Promise.resolve(this.stalled);
  }
}

describe('repository registration', () => {
  it('registers a real Git top level once, lists it, and rejects non-repositories', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const first = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/repositories`,
      headers: mutationHeaders(state),
      payload: { rootPath: repositoryPath },
    });
    expect(first.statusCode, first.body).toBe(200);
    const created = registerSourceRepositoryResponseSchema.parse(first.json());
    expect(created.created).toBe(true);
    expect(created.repository.rootPath).toBe(repositoryPath);
    expect(created.repository.defaultBranch).toBe('main');
    expect(created.repository.registeredHeadSha).toMatch(/^[0-9a-f]{40}$/);

    const again = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/repositories`,
      headers: mutationHeaders(state),
      payload: { rootPath: `${repositoryPath}/` },
    });
    expect(registerSourceRepositoryResponseSchema.parse(again.json()).created).toBe(false);

    const plain = mkdtempSync(join(tmpdir(), 'craftingtable-plain-'));
    directories.push(plain);
    const rejected = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/repositories`,
      headers: mutationHeaders(state),
      payload: { rootPath: plain },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'invalid-request' } });

    const list = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/repositories`,
      headers: { cookie: state.cookie },
    });
    expect(sourceRepositoryListResponseSchema.parse(list.json()).repositories).toHaveLength(1);

    const status = await state.context.app.inject({
      method: 'GET',
      url: '/api/execution-status',
      headers: { cookie: state.cookie },
    });
    expect(executionStatusResponseSchema.parse(status.json())).toMatchObject({
      git: { available: true },
      backends: [
        {
          kind: 'claude-code',
          available: true,
          models: [{ id: 'scripted-model', label: 'Scripted model' }],
        },
        { kind: 'codex', available: false, models: [] },
      ],
    });

    const audit = state.context.storage.audit.listWorkspace({
      workspaceId: state.workspaceId,
      limit: 10,
    });
    expect(audit.map((row) => row.action)).toContain('source-repository.register');
    const events = state.context.storage.workspaceEvents.listAfter({
      workspaceId: state.workspaceId,
      after: 0,
      limit: 10,
    });
    expect(events.map((event) => event.kind)).toContain('source-repository-registered');
  });

  it('knows a merge into the repository default branch, and a cycle whose profiles grant unrestricted (R-G9 review)', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository(), 'main');
    const execution = state.context.services.executionService;
    expect(execution.mergesIntoDefaultBranch(state.workspaceId, worktree.id)).toBe(true);
    const other = await ready();
    const released = fixtureRepository();
    git(['branch', 'release'], released);
    const { worktree: elsewhere } = await registerAndWorktree(other, released, 'release');
    expect(
      other.context.services.executionService.mergesIntoDefaultBranch(
        other.workspaceId,
        elsewhere.id,
      ),
    ).toBe(false);
    expect(execution.mergesIntoDefaultBranch(state.workspaceId, 'missing')).toBe(false);
    // A cycle started with an unrestricted step asks again to resume, from another session.
    await admit(state);
    await stepUp(state);
    const cycle = await startCycle(state, worktree.id, {
      profiles: {
        ...cycleProfiles,
        implement: { ...cycleProfiles.implement, permissionMode: 'unrestricted' },
      },
    });
    const paused = await controlCycle(state, cycle, 'pause');
    const another = await state.context.login();
    const resumed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders({ ...state, ...another }),
      payload: { action: 'resume', expectedVersion: paused.version },
    });
    expect(resumed.statusCode).toBe(403);
    expect(resumed.json().error.reason).toBe('step-up-required');
  });

  it('registers a repository only under a configured root (R-G9)', async () => {
    const repository = fixtureRepository();
    const register = (state: Ready) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/repositories`,
        headers: mutationHeaders(state),
        payload: { rootPath: repository },
      });
    const outside = (response: { statusCode: number; json: () => unknown }) =>
      response.statusCode === 400 &&
      (response.json() as { error?: { reason?: string } }).error?.reason ===
        'repository-outside-roots';
    // No roots set: nothing can be registered.
    expect(
      outside(await register(await ready({ env: { CRAFTINGTABLE_REPOSITORY_ROOTS: '' } }))),
    ).toBe(true);
    // A root that shares only a prefix with the repository's path does not hold it.
    expect(
      outside(
        await register(
          await ready({ env: { CRAFTINGTABLE_REPOSITORY_ROOTS: repository.slice(0, -2) } }),
        ),
      ),
    ).toBe(true);
    // A path outside every root is refused before Git reads it: a plain directory says so too.
    const plain = mkdtempSync(join(tmpdir(), 'craftingtable-plain-outside-'));
    directories.push(plain);
    const elsewhere = await ready({ env: { CRAFTINGTABLE_REPOSITORY_ROOTS: repository } });
    const outsideDirectory = await elsewhere.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${elsewhere.workspaceId}/repositories`,
      headers: mutationHeaders(elsewhere),
      payload: { rootPath: plain },
    });
    expect(outside(outsideDirectory)).toBe(true);
    // A root that is the repository itself holds it.
    expect((await register(elsewhere)).statusCode).toBe(200);
    // A link under a root to a repository elsewhere is where it leads.
    const linkRoot = mkdtempSync(join(tmpdir(), 'craftingtable-link-root-'));
    directories.push(linkRoot);
    symlinkSync(repository, join(linkRoot, 'linked'));
    const linked = await ready({ env: { CRAFTINGTABLE_REPOSITORY_ROOTS: linkRoot } });
    const throughLink = await linked.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${linked.workspaceId}/repositories`,
      headers: mutationHeaders(linked),
      payload: { rootPath: join(linkRoot, 'linked') },
    });
    expect(outside(throughLink)).toBe(true);
    // Its parent, among other roots, holds it.
    const admitted = await register(
      await ready({
        env: { CRAFTINGTABLE_REPOSITORY_ROOTS: `/nonexistent-root:${dirname(repository)}` },
      }),
    );
    expect(admitted.statusCode, admitted.body).toBe(200);
  });

  it('requires CSRF and origin for mutations and hides other workspaces', async () => {
    const state = await ready();
    const noCsrf = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/repositories`,
      headers: { cookie: state.cookie, 'content-type': 'application/json' },
      payload: { rootPath: '/tmp' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const foreign = await state.context.app.inject({
      method: 'GET',
      url: '/api/workspaces/not-mine/repositories',
      headers: { cookie: state.cookie },
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('worktrees and diffs', () => {
  it('creates a linked worktree on a fresh branch and reports its diff', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    expect(worktree.branchName).toMatch(/^ct\/aq-01-[0-9a-f]{8}$/);
    expect(worktree.path.startsWith(state.context.config.execution.worktreeRoot)).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree.path).trim()).toBe(
      worktree.branchName,
    );

    writeFileSync(join(worktree.path, 'README.md'), '# fixture\nchanged\n');
    git(['commit', '--no-gpg-sign', '-am', 'change readme'], worktree.path);
    writeFileSync(join(worktree.path, 'new.txt'), 'new\n');
    const diff = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/diff`,
      headers: { cookie: state.cookie },
    });
    expect(diff.statusCode, diff.body).toBe(200);
    const parsed = worktreeDiffResponseSchema.parse(diff.json());
    expect(parsed.files.map((file) => [file.path, file.status])).toEqual([
      ['README.md', 'modified'],
      ['new.txt', 'untracked'],
    ]);
    expect(parsed.patch).toContain('+changed');
    expect(parsed.commits.map((commit) => commit.subject)).toEqual(['change readme']);

    const execution = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/execution`,
      headers: { cookie: state.cookie },
    });
    const summary = workItemExecutionResponseSchema.parse(execution.json());
    expect(summary.worktrees).toHaveLength(1);
    expect(summary.runs).toHaveLength(0);

    // Removing a worktree with uncommitted work is refused with the paths at
    // risk until the operator explicitly chooses to discard them (GIT-02).
    const refused = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/remove`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(refused.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(refused.json()).error).toMatchObject({
      code: 'conflict',
      reason: 'worktree-has-changes',
      paths: ['new.txt'],
      pathCount: 1,
    });
    expect(existsSync(join(worktree.path, 'new.txt'))).toBe(true);
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');

    const removed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/remove`,
      headers: mutationHeaders(state),
      payload: { discardChanges: true },
    });
    expect(removeWorktreeResponseSchema.parse(removed.json())).toMatchObject({
      changed: true,
      worktree: { status: 'removed' },
    });
    expect(git(['worktree', 'list'], repositoryPath)).not.toContain(worktree.path);
    const audit = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 50 })
      .find((row) => row.action === 'worktree.remove');
    expect(audit?.metadata).toMatchObject({ discardChanges: true });
  });

  it('removes a clean worktree without asking to discard anything', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    const removed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/remove`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(removeWorktreeResponseSchema.parse(removed.json())).toMatchObject({
      changed: true,
      worktree: { status: 'removed' },
    });
    expect(git(['worktree', 'list'], repositoryPath)).not.toContain(worktree.path);
  });
});

describe('agent runs', () => {
  it('starts a run with a composed brief, streams events, accepts follow-ups, and finishes', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());

    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, role: 'implement', instructions: 'Keep it small.' },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { run } = startAgentRunResponseSchema.parse(started.json());
    expect(run.status).toBe('running');
    expect(run.permissionMode).toBe('auto');

    const launch = state.backend.launches[0];
    // The run's event stream writes its own response, with the security headers (R-G9 review).
    await state.context.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = state.context.app.server.address() as { port: number };
    const stream = new AbortController();
    const streamed = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${state.workspaceId}/runs/${run.id}/events`,
      { headers: { cookie: state.cookie }, signal: stream.signal },
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(streamed.headers.get('x-frame-options')).toBe('DENY');
    stream.abort();
    // Another site's page cannot open it.
    const crossSite = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${state.workspaceId}/runs/${run.id}/events`,
      { headers: { cookie: state.cookie, origin: 'https://evil.example' } },
    );
    expect(crossSite.status).toBe(403);
    expect(launch?.cwd).toBe(worktree.path);
    expect(launch?.prompt).toContain('# Work item AQ-01: Establish the queue');
    expect(launch?.prompt).toContain('Keep it small.');
    expect(launch?.prompt).toContain(worktree.branchName);
    expect(launch?.additionalDirectories?.[0]).toBe(
      join(state.context.config.execution.runsRoot, run.id),
    );
    // The daemon's database, backups and credentials stay out of a sandboxed command's reach,
    // wherever the backups were moved to (R-G9).
    const { dataDir, configDir } = state.context.config;
    expect(launch?.deniedReads).toEqual([
      join(dataDir, 'state'),
      join(dataDir, 'backups'),
      configDir,
    ]);

    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'waiting',
      'first turn to complete',
    );
    const detail = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}`,
      headers: { cookie: state.cookie },
    });
    const parsedDetail = agentRunDetailResponseSchema.parse(detail.json());
    expect(parsedDetail.run).toMatchObject({
      status: 'waiting',
      turnCount: 1,
      costUsd: 0.5,
      backendSessionId: 'scripted-session',
      resolvedModel: 'scripted-model',
      billing: 'subscription',
      outcomeSummary: 'done turn 1',
    });
    expect(parsedDetail.run.verdict).toBeUndefined();
    expect(parsedDetail.brief).toContain('Exit gate: Queue accepts and drains one job.');

    const message = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/messages`,
      headers: mutationHeaders(state),
      payload: { text: 'Now add a test.' },
    });
    expect(agentRunCommandResponseSchema.parse(message.json()).accepted).toBe(true);
    expect(state.backend.sessions[0]?.sent).toEqual(['Now add a test.']);
    await waitFor(
      () =>
        (state.context.storage.execution.runs.find(state.workspaceId, run.id)?.turnCount ?? 0) ===
        2,
      'second turn',
    );

    const ended = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/end`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(agentRunCommandResponseSchema.parse(ended.json()).accepted).toBe(true);
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'finished',
      'run to finish',
    );

    const page = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/event-page`,
      headers: { cookie: state.cookie },
    });
    const events = runEventPageResponseSchema.parse(page.json()).events;
    expect(events.map((event) => event.kind)).toEqual([
      'user-message',
      'session-started',
      'tool-call',
      'tool-result',
      'assistant-message',
      'turn-completed',
      'user-message',
      'tool-call',
      'tool-result',
      'assistant-message',
      'turn-completed',
      'run-finished',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ status: 'finished', exitCode: 0 });

    const kinds = state.context.storage.workspaceEvents
      .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 50 })
      .map((event) => event.kind);
    expect(kinds).toContain('agent-run-started');
    expect(kinds.filter((kind) => kind === 'agent-run-status-changed').length).toBeGreaterThan(2);
    const actions = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 50 })
      .map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'agent-run.start',
        'agent-run.message',
        'agent-run.end',
        'agent-run.finished',
      ]),
    );

    const late = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/messages`,
      headers: mutationHeaders(state),
      payload: { text: 'too late' },
    });
    expect(agentRunCommandResponseSchema.parse(late.json()).accepted).toBe(false);
  });

  it('serves a session-started event recorded before billing was observed (R-H1)', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, role: 'implement' },
    });
    const { run } = startAgentRunResponseSchema.parse(started.json());
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'waiting',
      'first turn',
    );
    // The first live run (2026-09-04) predates billing detection: its stored
    // session-started payload has no `billing` field at all.
    // The guarded repository refuses that shape now, so the row is planted directly.
    const database = openDatabase(state.context.config.databasePath);
    try {
      database
        .prepare(
          `INSERT INTO agent_run_events (id, workspace_id, run_id, occurred_at, kind, payload_json)
           VALUES (?, ?, ?, ?, 'session-started', ?)`,
        )
        .run(
          `legacy-${randomUUID()}`,
          state.workspaceId,
          run.id,
          '2026-09-04T00:00:01.000Z',
          JSON.stringify({
            backend: 'claude-code',
            backendSessionId: 'legacy-session',
            model: 'legacy-model',
            permissionMode: 'auto',
            cwd: worktree.path,
          }),
        );
    } finally {
      database.close();
    }

    const page = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/event-page`,
      headers: { cookie: state.cookie },
    });
    expect(page.statusCode, page.body).toBe(200);
    const legacy = runEventPageResponseSchema
      .parse(page.json())
      .events.find(
        (event) =>
          event.kind === 'session-started' && event.payload.backendSessionId === 'legacy-session',
      );
    expect(legacy?.payload).toMatchObject({ billing: 'unknown' });
  });

  it('kills an agent whose supervision fails and holds its worktree until it exits (AGT-01)', async () => {
    const backend = new UnsupervisableBackend();
    const state = await ready({ backend });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const launch = () =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
        headers: mutationHeaders(state),
        payload: { worktreeId: worktree.id, role: 'implement' },
      });
    const started = await launch();
    expect(started.statusCode, started.body).toBe(200);
    const { run } = startAgentRunResponseSchema.parse(started.json());
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'failed',
      'supervision failure',
    );
    expect(state.context.storage.execution.runs.find(state.workspaceId, run.id)).toMatchObject({
      outcomeSummary: 'Run supervision failed',
    });
    const stalled = backend.stalled;
    expect(stalled?.killCount).toBeGreaterThan(0);

    // The killed process has not exited yet: nothing else may launch into its checkout.
    const refused = await launch();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: 'conflict', message: expect.stringMatching(/lost supervision/) },
    });
    expect(backend.launches).toHaveLength(1);

    stalled?.exitNow();
    let relaunched = await launch();
    // Each step retries the launch until the daemon has seen the exit (R-I2: steps, not time).
    await waitFor(() => relaunched.statusCode !== 409, 'a launch once the process exited', {
      step: async () => {
        relaunched = await launch();
      },
    });
    expect(relaunched.statusCode, relaunched.body).toBe(200);
    expect(backend.launches).toHaveLength(2);
  });

  it('refuses a second manual run while another is live in the worktree (AGT-13)', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const launch = (payload: Record<string, unknown>) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
        headers: mutationHeaders(state),
        payload: { worktreeId: worktree.id, ...payload },
      });
    const first = await launch({ role: 'implement' });
    const { run } = startAgentRunResponseSchema.parse(first.json());
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'waiting',
      'first turn',
    );
    for (const payload of [{ role: 'implement' }, { role: 'review', parentRunId: run.id }]) {
      const second = await launch(payload);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: { code: 'conflict' } });
    }
    expect(state.backend.launches).toHaveLength(1);

    await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/end`,
      headers: mutationHeaders(state),
      payload: {},
    });
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'finished',
      'first run to finish',
    );
    const after = await launch({ role: 'review', parentRunId: run.id });
    expect(after.statusCode, after.body).toBe(200);
  });

  it('cancels a live run and records a launch failure as failed', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, role: 'review', permissionMode: 'edit-only' },
    });
    const { run } = startAgentRunResponseSchema.parse(started.json());
    const cancelled = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/cancel`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(agentRunCommandResponseSchema.parse(cancelled.json()).accepted).toBe(true);
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status ===
        'cancelled',
      'cancellation',
    );

    state.backend.failNextLaunch = true;
    const failed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id },
    });
    expect(startAgentRunResponseSchema.parse(failed.json()).run).toMatchObject({
      status: 'failed',
      outcomeSummary: 'scripted launch failure',
    });

    const removal = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/remove`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(removal.statusCode).toBe(200);
  });

  it('refuses to remove a worktree with a live run and reports a missing backend', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id },
    });
    expect(started.statusCode).toBe(200);
    const blocked = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/remove`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(blocked.statusCode).toBe(409);

    const noBackend = await ready({ backend: null });
    const { worktree: other } = await registerAndWorktree(noBackend, fixtureRepository());
    const unavailable = await noBackend.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${noBackend.workspaceId}/work-items/${noBackend.workItemId}/runs`,
      headers: mutationHeaders(noBackend),
      payload: { worktreeId: other.id },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('bounds the outcome summary in bytes so a multibyte result never breaks the run routes', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, instructions: 'MULTIBYTE-RESULT' },
    });
    const { run } = startAgentRunResponseSchema.parse(started.json());
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'waiting',
      'turn',
    );
    const stored = state.context.storage.execution.runs.find(state.workspaceId, run.id);
    expect(Buffer.byteLength(stored?.outcomeSummary ?? '', 'utf8')).toBeLessThanOrEqual(4000);
    expect(stored?.outcomeSummary?.endsWith('…')).toBe(true);
    expect(stored?.outcomeSummary).not.toContain('\uFFFD');

    for (const url of [
      `/api/workspaces/${state.workspaceId}/runs/${run.id}`,
      `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/execution`,
      `/api/workspaces/${state.workspaceId}/runs`,
    ]) {
      const response = await state.context.app.inject({
        method: 'GET',
        url,
        headers: { cookie: state.cookie },
      });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it('keeps a large tool output out of the journal and serves it from the run directory (R-H2)', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const output = `${'line of test output →\n'.repeat(900)}done`;
    state.backend.repliesForNextRun = [{ resultText: 'done', toolOutput: output }];
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, instructions: 'Print a lot.' },
    });
    const { run } = startAgentRunResponseSchema.parse(started.json());
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'waiting',
      'turn',
    );
    const page = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/event-page?includeRaw=true`,
      headers: { cookie: state.cookie },
    });
    const events = runEventPageResponseSchema.parse(page.json()).events;
    const result = events.find((event) => event.kind === 'tool-result');
    if (result?.kind !== 'tool-result') throw new Error('Missing tool result');
    const digest = createHash('sha256').update(output).digest('hex');
    expect(result.payload.body).toEqual({ digest, bytes: Buffer.byteLength(output) });
    expect(Buffer.byteLength(result.payload.content)).toBeLessThanOrEqual(
      TOOL_RESULT_PREVIEW_BYTES,
    );
    expect(output.startsWith(result.payload.content.slice(0, -1))).toBe(true);
    // Normalized events keep no vendor line.
    expect(events.filter((event) => event.raw !== undefined)).toEqual([]);

    const directory = join(state.context.config.execution.runsRoot, run.id, 'tool-results');
    expect(readdirSync(directory)).toEqual([`${digest}.txt.gz`]);
    const full = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/tool-results/${digest}`,
      headers: { cookie: state.cookie },
    });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(full.headers['x-content-type-options']).toBe('nosniff');
    expect(full.body).toBe(output);

    // A body altered on disk, a digest that is not stored, and a malformed one read as absent.
    writeFileSync(join(directory, `${digest}.txt.gz`), gzipSync('tampered'));
    for (const suffix of [digest, 'd'.repeat(64), 'not-a-digest']) {
      const missing = await state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/tool-results/${suffix}`,
        headers: { cookie: state.cookie },
      });
      expect(missing.statusCode, suffix).toBe(404);
    }
  });

  it('flags a protected branch moved during a run by something other than the daemon (R-G5, SEC-02)', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, root);
    let release!: () => void;
    state.backend.repliesForNextRun = [
      { resultText: 'done', release: new Promise<void>((resolve) => (release = resolve)) },
    ];
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, instructions: 'Work.' },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { run } = startAgentRunResponseSchema.parse(started.json());
    // While the agent works, something other than CraftingTable moves main.
    const tree = git(['rev-parse', 'main^{tree}'], root).trim();
    const moved = git(['commit-tree', tree, '-p', 'main', '-m', 'outside'], root).trim();
    const before = git(['rev-parse', 'main'], root).trim();
    git(['update-ref', 'refs/heads/main', moved], root);
    release();
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'waiting',
      'turn',
    );
    await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/end`,
      headers: mutationHeaders(state),
      payload: {},
    });
    const audited = () => {
      const db = openDatabase(state.context.storage.databasePath);
      try {
        return db
          .prepare(
            "SELECT target_id, metadata_json FROM audit_events WHERE action = 'agent-run.protected-ref-moved'",
          )
          .all() as { target_id: string; metadata_json: string }[];
      } finally {
        db.close();
      }
    };
    await waitFor(() => audited().length === 1, 'protected-ref audit');
    const [row] = audited();
    expect(row?.target_id).toBe(run.id);
    expect(JSON.parse(row!.metadata_json).moves).toEqual([
      { branch: 'main', before, after: moved },
    ]);
    const events = state.context.storage.execution.runEvents.listAfter({
      workspaceId: state.workspaceId,
      runId: run.id,
      after: 0,
      limit: 500,
    });
    expect(
      events.some(
        (e) =>
          e.kind === 'notice' &&
          (e.payload as { message: string }).message.includes('Protected branches moved'),
      ),
    ).toBe(true);
  });

  it('keeps a protected-ref move in the inbox until the operator acknowledges it (R-G5, SEC-02)', async () => {
    const state = await ready();
    const ws = state.workspaceId;
    const root = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, root);
    // A run during which something other than CraftingTable moves main.
    const moveMainDuringRun = async (message: string) => {
      let release!: () => void;
      state.backend.repliesForNextRun = [
        { resultText: 'done', release: new Promise<void>((resolve) => (release = resolve)) },
      ];
      const started = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/work-items/${state.workItemId}/runs`,
        headers: mutationHeaders(state),
        payload: { worktreeId: worktree.id, instructions: 'Work.' },
      });
      expect(started.statusCode, started.body).toBe(200);
      const { run } = startAgentRunResponseSchema.parse(started.json());
      const before = git(['rev-parse', 'main'], root).trim();
      const tree = git(['rev-parse', 'main^{tree}'], root).trim();
      const moved = git(['commit-tree', tree, '-p', 'main', '-m', message], root).trim();
      git(['update-ref', 'refs/heads/main', moved], root);
      release();
      await waitFor(
        () => state.context.storage.execution.runs.find(ws, run.id)?.status === 'waiting',
        'turn',
      );
      await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/runs/${run.id}/end`,
        headers: mutationHeaders(state),
        payload: {},
      });
      return { runId: run.id, before, moved };
    };
    const item = () =>
      state.context.storage.attention.open(ws).find((i) => i.code === 'protected-ref-moved');
    const acknowledge = (moveIds: readonly string[]) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/protected-ref-moves/acknowledge`,
        headers: mutationHeaders(state),
        payload: { moveIds },
      });

    const first = await moveMainDuringRun('outside');
    await waitFor(() => item() !== undefined, 'protected-ref item');
    const opened = item()!;
    expect(opened).toMatchObject({
      kind: 'attention',
      subjectKey: expect.stringMatching(/^protected-refs:/),
      path: `/workspaces/${ws}/runs/${first.runId}`,
      refs: { runId: first.runId, worktreeId: worktree.id },
    });
    expect(opened.message).toContain(
      `main ${first.before.slice(0, 12)} → ${first.moved.slice(0, 12)}`,
    );
    expect(opened.members).toHaveLength(1);
    const [firstMove] = opened.members!;

    // A second move joins the item. Acknowledging only what was seen leaves the new one open.
    const second = await moveMainDuringRun('outside again');
    await waitFor(() => item()?.members?.length === 2, 'second move');
    expect(item()!.message).toContain(
      `main ${second.before.slice(0, 12)} → ${second.moved.slice(0, 12)}`,
    );
    const partial = await acknowledge([firstMove!]);
    expect(partial.statusCode, partial.body).toBe(200);
    expect(item()?.members).toEqual([expect.not.stringMatching(firstMove!)]);
    const rest = await acknowledge(item()!.members!);
    expect(rest.statusCode, rest.body).toBe(200);
    expect(item()).toBeUndefined();
    expect(
      state.context.storage.attention.latest(ws, opened.subjectKey, 'protected-ref-moved')
        ?.resolvedBy,
    ).toBe('operator');
    expect(
      state.context.storage.audit
        .listWorkspace({ workspaceId: ws, limit: 20 })
        .filter((e) => e.action === 'protected-refs.acknowledged'),
    ).toHaveLength(2);

    // An acknowledged move stays recorded as it was: not acknowledged twice, not changed, not
    // deleted.
    expect((await acknowledge([firstMove!])).statusCode).toBe(409);
    const db = openDatabase(state.context.storage.databasePath);
    try {
      expect(() =>
        db
          .prepare(
            "UPDATE protected_ref_moves SET record_json = json_set(record_json, '$.moves', json('[]')) WHERE id = ?",
          )
          .run(firstMove),
      ).toThrow('acknowledged');
      expect(() =>
        db.prepare('DELETE FROM protected_ref_moves WHERE id = ?').run(firstMove),
      ).toThrow('cannot be deleted');
    } finally {
      db.close();
    }
  });

  it('gives every run in a worktree the same build cache, outside each run directory (R-G7)', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const first = await runToFinish(state, worktree.id, { instructions: 'Build.' });
    const second = await runToFinish(state, worktree.id, { instructions: 'Build again.' });
    const caches = state.backend.launches.map((launch) => launch.buildCacheDirectory);
    const registered = state.context.storage.maintenance.worktreeCache(worktree.id);
    expect(registered?.path).toBeDefined();
    expect(caches).toEqual([registered?.path, registered?.path]);
    // The daemon points Cargo at it in the run's overlay; the adapter adds nothing (R-G5).
    expect(state.backend.launches.map((launch) => launch.environment?.CARGO_TARGET_DIR)).toEqual([
      registered?.path,
      registered?.path,
    ]);
    // It names Cargo's home, the one the check units use, so a sandboxed fetch writes where
    // the sandbox allows (R-G5, operator decision 2026-09-28).
    // It is the daemon's own, never the operator's (R-G5 review).
    const cargoHome = state.context.config.execution.cargoHome;
    expect(cargoHome.startsWith(state.context.directory)).toBe(true);
    expect(state.backend.launches.map((launch) => launch.environment?.CARGO_HOME)).toEqual([
      cargoHome,
      cargoHome,
    ]);
    // A sandboxed agent (Codex workspace-write) may write only to the listed directories.
    for (const launch of state.backend.launches)
      expect(launch.additionalDirectories).toContain(registered?.path);
    // Cargo creates it on its first build; a worktree that never builds Rust leaves nothing.
    expect(existsSync(registered?.path ?? '')).toBe(false);
    for (const runId of [first, second]) {
      expect(
        registered?.path.startsWith(join(state.context.config.execution.runsRoot, runId)),
      ).toBe(false);
      expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.brief).toContain(
        `CARGO_TARGET_DIR points to ${registered?.path}, this worktree’s build cache.`,
      );
    }
  });

  it('lists live and recent runs across the workspace with their work item context', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id },
    });
    const { run } = startAgentRunResponseSchema.parse(started.json());
    const listed = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs`,
      headers: { cookie: state.cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const overview = workspaceRunsResponseSchema.parse(listed.json());
    expect(overview.liveCount).toBe(1);
    expect(overview.runs).toHaveLength(1);
    expect(overview.runs[0]).toMatchObject({
      id: run.id,
      workItemSourceId: 'AQ-01',
      workItemTitle: 'Establish the queue',
      projectName: 'Exec project',
      branchName: worktree.branchName,
    });
    const snapshot = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/snapshot`,
      headers: { cookie: state.cookie },
    });
    expect(
      (snapshot.json() as { statusSummary: { liveRuns: number } }).statusSummary.liveRuns,
    ).toBe(1);
  });

  it('marks runs that were live at shutdown as interrupted on the next start', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id },
    });
    const { run } = startAgentRunResponseSchema.parse(started.json());
    // Simulate a hard daemon death: the row stays live while the session is gone.
    const service = state.context.services.agentRunService;
    expect(service.liveCount()).toBe(1);
    (service as unknown as { live: Map<string, unknown> }).live.clear();
    expect(service.recoverInterrupted()).toBe(1);
    const recovered = state.context.storage.execution.runs.find(state.workspaceId, run.id);
    expect(recovered?.status).toBe('interrupted');
    const last = state.context.storage.execution.runEvents
      .listAfter({ workspaceId: state.workspaceId, runId: run.id, after: 0, limit: 100 })
      .at(-1);
    expect(last?.kind === 'run-finished' && last.payload).toMatchObject({ status: 'interrupted' });
    expect(last?.kind === 'run-finished' && last.payload.message).toContain('restarted');
    expect(service.recoverInterrupted()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Review-gated merge                                                          */
/* -------------------------------------------------------------------------- */

describe('backend selection', () => {
  it.each([
    { kinds: ['codex', 'claude-code'], requested: undefined, expected: 'claude-code' },
    { kinds: ['claude-code', 'codex'], requested: 'codex', expected: 'codex' },
    { kinds: ['codex'], requested: undefined, expected: 'codex' },
  ] as const)(
    'selects $expected from $kinds (requested $requested)',
    async ({ kinds, requested, expected }) => {
      const backends = new Map<AgentBackendKind, AgentBackend>(
        kinds.map((kind) => [kind, new ScriptedBackend(kind)]),
      );
      const state = await ready({ backends });
      const { worktree } = await registerAndWorktree(state, fixtureRepository());
      const response = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
        headers: mutationHeaders(state),
        payload: {
          worktreeId: worktree.id,
          ...(requested === undefined ? {} : { backend: requested }),
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const { run } = startAgentRunResponseSchema.parse(response.json());
      expect(run.backend).toBe(expected);
      expect((backends.get(expected) as ScriptedBackend).launches).toHaveLength(1);
      const status = await state.context.app.inject({
        method: 'GET',
        url: '/api/execution-status',
        headers: { cookie: state.cookie },
      });
      expect(
        executionStatusResponseSchema
          .parse(status.json())
          .backends.map(({ kind, available }) => ({ kind, available })),
      ).toEqual([
        { kind: 'claude-code', available: kinds.some((kind) => kind === 'claude-code') },
        { kind: 'codex', available: true },
      ]);
      const audit = state.context.storage.audit.listWorkspace({
        workspaceId: state.workspaceId,
        limit: 100,
      });
      expect(audit.find((event) => event.action === 'agent-run.start')?.metadata).toMatchObject({
        backend: expected,
      });
      const events = state.context.storage.workspaceEvents.listAfter({
        workspaceId: state.workspaceId,
        after: 0,
        limit: 100,
      });
      expect(events.find((event) => event.kind === 'agent-run-started')?.payload).toMatchObject({
        backend: expected,
      });
    },
  );

  it('names an explicitly selected unavailable backend without falling back', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, backend: 'codex' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain('Codex was not found');
    expect(state.backend.launches).toHaveLength(0);
  });
});

it('counts and displays a follow-up queued before the preceding turn completes', async () => {
  const state = await ready({ backend: new ScriptedBackend('codex') });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, instructions: 'DEFER-TURNS' },
  });
  const { run } = startAgentRunResponseSchema.parse(response.json());
  const sent = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/messages`,
    headers: mutationHeaders(state),
    payload: { text: 'second' },
  });
  expect(sent.statusCode, sent.body).toBe(200);
  await waitFor(
    () => state.context.storage.execution.runs.find(state.workspaceId, run.id)?.turnCount === 2,
    'both queued turns counted',
  );
  expect(state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status).toBe(
    'waiting',
  );
});

it('persists reported model changes and replays neutral token usage over HTTP', async () => {
  const state = await ready({ backend: new ScriptedBackend('codex') });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const runId = await runToFinish(state, worktree.id, { instructions: 'TELEMETRY' });
  expect(state.context.storage.execution.runs.find(state.workspaceId, runId)?.resolvedModel).toBe(
    'rerouted-model',
  );
  const page = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/runs/${runId}/event-page`,
    headers: { cookie: state.cookie },
  });
  const event = runEventPageResponseSchema
    .parse(page.json())
    .events.find((event) => event.kind === 'turn-completed');
  expect(event?.payload).toMatchObject({
    model: 'rerouted-model',
    tokenUsage: { totalTokens: 12 },
  });
});

describe('run profiles', () => {
  it('defaults every role to the daemon default backend and auto, then stores the saved set', async () => {
    const backends = new Map<AgentBackendKind, AgentBackend>([
      ['codex', new ScriptedBackend('codex')],
      ['claude-code', new ScriptedBackend('claude-code')],
    ]);
    const state = await ready({ backends });
    const url = `/api/workspaces/${state.workspaceId}/run-profiles`;

    const initial = await state.context.app.inject({
      method: 'GET',
      url,
      headers: { cookie: state.cookie },
    });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(runProfilesResponseSchema.parse(initial.json())).toEqual({
      profiles: AGENT_PROFILE_PURPOSES.map((role) => ({
        role,
        backend: 'claude-code',
        permissionMode: 'auto',
        stored: false,
      })),
    });

    const saved = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        profiles: [
          { role: 'implement', backend: 'codex', model: 'gpt-5', permissionMode: 'auto' },
          { role: 'review', backend: 'claude-code', model: 'opus', permissionMode: 'edit-only' },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = runProfilesResponseSchema.parse(saved.json());
    expect(
      after.profiles.filter((p) => ['design', 'implement', 'review'].includes(p.role)),
    ).toEqual([
      { role: 'design', backend: 'claude-code', permissionMode: 'auto', stored: false },
      { role: 'implement', backend: 'codex', model: 'gpt-5', permissionMode: 'auto', stored: true },
      {
        role: 'review',
        backend: 'claude-code',
        model: 'opus',
        permissionMode: 'edit-only',
        stored: true,
      },
    ]);
    expect(after.profiles.find((p) => p.role === 'remediate')).toMatchObject({
      backend: 'codex',
      model: 'gpt-5',
      stored: false,
    });
    expect(after.profiles.find((p) => p.role === 'security')).toMatchObject({
      backend: 'claude-code',
      model: 'opus',
      stored: false,
    });
    const reread = await state.context.app.inject({
      method: 'GET',
      url,
      headers: { cookie: state.cookie },
    });
    expect(runProfilesResponseSchema.parse(reread.json())).toEqual(after);

    const audit = state.context.storage.audit.listWorkspace({
      workspaceId: state.workspaceId,
      limit: 5,
    });
    expect(audit.some((event) => event.action === 'run-profiles.updated')).toBe(true);
  });

  it('gives Claude profiles and runs a reasoning effort, as Codex has (operator decision 2026-09-28)', async () => {
    const state = await ready();
    const saved = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/run-profiles`,
      headers: mutationHeaders(state),
      payload: {
        profiles: [
          {
            role: 'review',
            backend: 'claude-code',
            reasoningEffort: 'high',
            permissionMode: 'auto',
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      runProfilesResponseSchema.parse(saved.json()).profiles.find((p) => p.role === 'review'),
    ).toMatchObject({ backend: 'claude-code', reasoningEffort: 'high', stored: true });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const runId = await runToFinish(state, worktree.id, {
      instructions: 'Think hard.',
      backend: 'claude-code',
      reasoningEffort: 'xhigh',
    });
    expect(state.backend.launches.at(-1)?.reasoningEffort).toBe('xhigh');
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, runId)?.reasoningEffort,
    ).toBe('xhigh');
  });

  it('rejects a duplicate role and an unknown backend', async () => {
    const state = await ready();
    const url = `/api/workspaces/${state.workspaceId}/run-profiles`;
    const duplicate = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        profiles: [
          { role: 'review', backend: 'claude-code', permissionMode: 'auto' },
          { role: 'review', backend: 'codex', permissionMode: 'auto' },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);
    const unknown = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: { profiles: [{ role: 'review', backend: 'gemini', permissionMode: 'auto' }] },
    });
    expect(unknown.statusCode).toBe(400);
  });
});

describe('complete review handoffs', () => {
  it('hands off earlier messages across journal pages and the full final message beyond the old ceiling', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    const longFinal = `${'→'.repeat(60000)}\nLast finding after 180,000 bytes.\nVERDICT: mergeable`;
    state.backend.repliesForNextRun = [
      {
        messages: [
          'Earlier finding: missing race coverage.',
          ...Array.from({ length: 120 }, (_, index) => `Review observation ${index}`),
        ],
        resultText: longFinal,
      },
    ];
    const review = await runToFinish(state, worktree.id, { role: 'review' });
    const child = await runToFinish(state, worktree.id, { role: 'implement', parentRunId: review });
    const detail = await runDetail(state, child);
    expect(detail.brief).toContain('Last finding after 180,000 bytes.');
    const root = state.backend.launches.at(-1)?.additionalDirectories?.[0];
    if (root === undefined) throw new Error('Missing run directory');
    const handoff = join(root, 'handoff');
    const manifest = JSON.parse(readFileSync(join(handoff, 'manifest.json'), 'utf8'));
    expect(manifest.sourceRunId).toBe(review);
    expect(manifest.sources[0].messageCount).toBeGreaterThan(120);
    const conversation = readFileSync(join(handoff, manifest.sources[0].conversation), 'utf8');
    expect(conversation).toContain('Earlier finding: missing race coverage.');
    expect(conversation).toContain('Review observation 119');
    expect(readFileSync(join(handoff, manifest.sources[0].finalMessage), 'utf8')).toBe(longFinal);
    expect(manifest.warnings.join(' ')).toContain('No structured findings report');
  });

  it('preserves operator corrections, prior turns, and the review report through remediation', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    state.backend.repliesForNextRun = [{ resultText: reviewText([structuredFinding]) }];
    const review = await runToFinish(state, worktree.id, { role: 'review' });
    expect((await runDetail(state, review)).reviewReport).toMatchObject({
      status: 'complete',
      report: { findings: [structuredFinding] },
    });
    state.backend.repliesForNextRun = [{ resultText: 'F-001: fixed, added boundary test.' }];
    const implement = await runToFinish(state, worktree.id, {
      role: 'implement',
      parentRunId: review,
    });
    state.backend.repliesForNextRun = [{ resultText: reviewText([]) }];
    const missing = await runToFinish(state, worktree.id, {
      role: 'review',
      parentRunId: implement,
    });
    expect((await runDetail(state, missing)).reviewReport).toMatchObject({
      status: 'invalid',
      issues: [expect.stringContaining('F-001')],
    });
    expect((await runDetail(state, missing)).run.verdict).toBeUndefined();
    expect((await mergeGate(state, worktree.id))?.mergeable).toBe(false);
    const root = state.backend.launches.at(-1)?.additionalDirectories?.[0];
    if (root === undefined) throw new Error('Missing run directory');
    const manifest = JSON.parse(readFileSync(join(root, 'handoff/manifest.json'), 'utf8'));
    expect(manifest.sources.map((source: { runId: string }) => source.runId)).toEqual([
      implement,
      review,
    ]);
    const inherited = JSON.parse(
      readFileSync(join(root, 'handoff', manifest.sources[1].report), 'utf8'),
    );
    expect(inherited.report.findings[0].id).toBe('F-001');
  });

  it('clears an earlier mergeable verdict when a follow-up omits its finding, then accepts an explicit withdrawal', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    state.backend.repliesForNextRun = [
      { resultText: reviewText([structuredFinding]) },
      { resultText: 'Nothing to add.\nVERDICT: mergeable' },
      {
        resultText: reviewText([
          {
            ...structuredFinding,
            status: 'withdrawn',
            disposition: 'The operator identified existing coverage; verified it.',
          },
        ]),
      },
    ];
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, role: 'review' },
    });
    const { run } = startAgentRunResponseSchema.parse(started.json());
    await waitFor(
      () => state.context.storage.execution.runs.find(state.workspaceId, run.id)?.turnCount === 1,
      'initial report',
    );
    expect((await runDetail(state, run.id)).run.verdict).toBe('mergeable');
    for (const [index, text] of [
      'Please consolidate.',
      'Existing boundary coverage is in tests/boundary.ts; reconcile F-001.',
    ].entries()) {
      await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/messages`,
        headers: mutationHeaders(state),
        payload: { text },
      });
      await waitFor(
        () =>
          state.context.storage.execution.runs.find(state.workspaceId, run.id)?.turnCount ===
          index + 2,
        'follow-up report',
      );
      const detail = await runDetail(state, run.id);
      expect(detail.reviewReport?.status).toBe(index === 0 ? 'invalid' : 'complete');
      expect(detail.run.verdict).toBe(index === 0 ? undefined : 'mergeable');
    }
    await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/end`,
      headers: mutationHeaders(state),
      payload: {},
    });
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'finished',
      'end review',
    );
    await runToFinish(state, worktree.id, { role: 'implement', parentRunId: run.id });
    const root = state.backend.launches.at(-1)?.additionalDirectories?.[0];
    if (root === undefined) throw new Error('Missing run directory');
    const conversation = readFileSync(join(root, 'handoff/0000-conversation.md'), 'utf8');
    expect(conversation).toContain('Existing boundary coverage is in tests/boundary.ts');
    expect(conversation).toContain('Nothing to add.');
    expect(conversation).toContain('withdrawn');
  });

  it('flags irrecoverable upstream truncation and never accepts its verdict', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    state.backend.repliesForNextRun = [{ resultText: reviewText([]), truncated: true }];
    const review = await runToFinish(state, worktree.id, { role: 'review' });
    expect((await runDetail(state, review)).run.verdict).toBeUndefined();
    await runToFinish(state, worktree.id, { role: 'implement', parentRunId: review });
    expect(state.backend.launches.at(-1)?.prompt).toContain('already truncated upstream');
  });
});

it('validates a later review against the source snapshot delivered to its implementer', async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  state.backend.repliesForNextRun = [{ resultText: reviewText([structuredFinding]) }];
  // The source review ends before the handoff: one live agent per worktree (AGT-13).
  const run = { id: await runToFinish(state, worktree.id, { role: 'review' }) };
  const implement = await runToFinish(state, worktree.id, {
    role: 'implement',
    parentRunId: run.id,
  });
  // The source's journal grows after the implementer received it; its delivery
  // must stay pinned to the sequence it was handed.
  state.context.storage.execution.runEvents.append({
    id: asAgentRunEventId(randomUUID()),
    workspaceId: state.workspaceId,
    runId: run.id,
    occurredAt: new Date().toISOString(),
    kind: 'turn-completed',
    payload: {
      outcome: 'success',
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Later verification closes it.' },
        { ...structuredFinding, id: 'F-002', title: 'Later finding' },
      ]),
      turns: 2,
      durationMs: 1,
    },
  });
  expect((await runDetail(state, run.id)).reviewReport).toMatchObject({
    status: 'complete',
    report: { findings: [expect.anything(), expect.objectContaining({ id: 'F-002' })] },
  });
  const delivered = recordedFindings(
    state.context.storage.execution,
    present(state.context.storage.execution.runs.find(state.workspaceId, implement)),
  );
  expect([...delivered.keys()]).toEqual(['F-001']);
  expect(delivered.get('F-001')?.finding.status).toBe('open');
  state.backend.repliesForNextRun = [
    {
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Regression verified.' },
      ]),
    },
  ];
  const review = await runToFinish(state, worktree.id, { role: 'review', parentRunId: implement });
  expect((await runDetail(state, review)).reviewReport?.status).toBe('complete');
  const root = state.backend.launches.at(-1)?.additionalDirectories?.[0];
  if (root === undefined) throw new Error('Missing run directory');
  const manifest = JSON.parse(readFileSync(join(root, 'handoff/manifest.json'), 'utf8'));
  const original = JSON.parse(
    readFileSync(join(root, 'handoff', manifest.sources[1].report), 'utf8'),
  );
  expect(original.report.findings.map((finding: { id: string }) => finding.id)).toEqual(['F-001']);
  const initial = state.context.storage.execution.runEvents.listAfter({
    workspaceId: state.workspaceId,
    runId: review,
    after: 0,
    limit: 1,
  })[0];
  expect(initial).toMatchObject({
    kind: 'user-message',
    payload: {
      handoffSources: [
        expect.objectContaining({ runId: implement }),
        expect.objectContaining({ runId: run.id }),
      ],
    },
  });
});

it('refuses a handoff across worktrees even when both runs belong to the same work item', async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const review = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  const other = await registerAndWorktree(state, fixtureRepository());
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: other.worktree.id, role: 'implement', parentRunId: review },
  });
  expect(response.statusCode).toBe(404);
  expect(state.backend.launches).toHaveLength(1);
});

it('rejects oversized conversation handoffs before launching instead of dropping messages', async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  state.backend.repliesForNextRun = [
    {
      messages: Array.from({ length: 130 }, () => 'x'.repeat(256 * 1024)),
      resultText: 'VERDICT: mergeable',
    },
  ];
  const review = await runToFinish(state, worktree.id, { role: 'review' });
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'implement', parentRunId: review },
  });
  expect(response.statusCode).toBe(409);
  expect(response.body).toContain('exceeds 32 MiB');
  expect(state.backend.launches).toHaveLength(1);
  expect(
    state.context.storage.execution.runs.listForWorkItem(state.workspaceId, state.workItemId),
  ).toHaveLength(1);
});

it('adopts a preexisting worktree without rewriting its original base and refuses changes while a session is open', async () => {
  const state = await ready();
  const root = fixtureRepository();
  const { repository, worktree } = await registerAndWorktree(state, root);
  const legacyPath = join(state.context.config.execution.worktreeRoot, 'legacy');
  git(['worktree', 'add', '-b', 'legacy-item', legacyPath], root);
  const legacy = state.context.storage.execution.worktrees.insert({
    id: asWorktreeId('legacy'),
    workspaceId: state.workspaceId,
    repositoryId: repository.id,
    projectId: worktree.projectId,
    workItemId: state.workItemId,
    branchName: 'legacy-item',
    baseSha: worktree.baseSha,
    baseBranch: 'main',
    path: legacyPath,
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  });
  const launchPath = `work-items/${state.workItemId}/runs`;
  expect(
    (await branchCommand(state, launchPath, { worktreeId: legacy.id, role: 'review' })).statusCode,
  ).toBe(409);
  expect((await merge(state, legacy.id)).statusCode).toBe(409);
  const adopted = await branchCommand(state, `worktrees/${legacy.id}/retarget`, {
    expectedVersion: 1,
    integrationBranch: 'main',
  });
  expect(adopted.statusCode, adopted.body).toBe(200);
  expect(adopted.json().worktree).toMatchObject({
    baseSha: legacy.baseSha,
    baseBranch: 'main',
    integrationBranch: 'main',
    version: 2,
  });
  const launched = await branchCommand(state, launchPath, {
    worktreeId: legacy.id,
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  expect(launched.statusCode).toBe(200);
  expect(
    (await branchCommand(state, `worktrees/${legacy.id}/update`, { expectedVersion: 2 }))
      .statusCode,
  ).toBe(409);
  await branchCommand(state, `runs/${launched.json().run.id}/end`, {});
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(state.workspaceId, launched.json().run.id)
        ?.status === 'finished',
    'legacy review ended',
  );
  expect((await merge(state, legacy.id)).statusCode).toBe(200);
});

it('returns the complete latest outcome independently of event pagination', async () => {
  const state = await ready();
  const root = fixtureRepository();
  const { worktree } = await registerAndWorktree(state, root);
  await admit(state);
  const runId = await runToFinish(state, worktree.id, { role: 'implement' });
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/runs/${runId}`,
    headers: { cookie: state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  const latest = state.context.storage.execution.runEvents.latestOfKind(
    state.workspaceId,
    runId,
    'turn-completed',
  );
  if (latest?.kind !== 'turn-completed') throw new Error('Missing final event');
  expect(response.json().latestOutcome).toMatchObject({
    sequence: latest.sequence,
    text: latest.payload.resultText,
    outcome: latest.payload.outcome,
    truncated: false,
  });
});

it('still requires closed findings in ordinary work-item review reports', async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  state.backend.repliesForNextRun = [
    {
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Verified the regression.' },
      ]),
    },
  ];
  const parent = await runToFinish(state, worktree.id, { role: 'review' });
  state.backend.repliesForNextRun = [{ resultText: reviewText([]) }];
  const child = await runToFinish(state, worktree.id, { role: 'review', parentRunId: parent });
  expect((await runDetail(state, child)).reviewReport).toMatchObject({
    status: 'invalid',
    issues: [expect.stringContaining('F-001')],
  });
});

it('blocks a manual handoff while background work is reserved, while allowing cancellation', async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const url = `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`;
  const started = await state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'implement' },
  });
  const source = startAgentRunResponseSchema.parse(started.json()).run;
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(state.workspaceId, source.id)?.status === 'waiting',
    'completed turn',
  );
  present(state.backend.sessions[0]).backgroundWorkPending = true;
  const blocked = await state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'review', parentRunId: source.id },
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.body).toContain('background work');
  expect(state.backend.launches).toHaveLength(1);
  const cancelled = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${source.id}/cancel`,
    headers: mutationHeaders(state),
    payload: {},
  });
  expect(cancelled.statusCode).toBe(200);
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(state.workspaceId, source.id)?.status ===
      'cancelled',
    'background cancellation',
  );
  const allowed = await state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'review', parentRunId: source.id },
  });
  expect(allowed.statusCode, allowed.body).toBe(200);
});
