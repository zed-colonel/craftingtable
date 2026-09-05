import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentBackend,
  AgentLaunchRequest,
  AgentSession,
  AgentSessionItem,
} from '@craftingtable/agents';
import {
  agentRunCommandResponseSchema,
  agentRunDetailResponseSchema,
  createWorktreeResponseSchema,
  executionStatusResponseSchema,
  mergeWorktreeResponseSchema,
  registerSourceRepositoryResponseSchema,
  removeWorktreeResponseSchema,
  runEventPageResponseSchema,
  sourceRepositoryListResponseSchema,
  startAgentRunResponseSchema,
  workItemExecutionResponseSchema,
  workspaceRunsResponseSchema,
  worktreeDiffResponseSchema,
} from '@craftingtable/contracts';
import {
  type AgentRunId,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asWorkItemId,
  type UserId,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from './config.js';
import { createTestContext, type TestContext } from './test-support.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const contexts: TestContext[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-exec-repo-'));
  directories.push(root);
  git(['init', '--initial-branch=main', '.'], root);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  git(['add', '--all'], root);
  git(['commit', '--no-gpg-sign', '-m', 'initial'], root);
  return root;
}

/**
 * A scripted backend: every launched session records the request, echoes each
 * user message as an assistant turn, and exits when ended or killed.
 */
class ScriptedBackend implements AgentBackend {
  readonly kind = 'claude-code' as const;
  readonly launches: AgentLaunchRequest[] = [];
  readonly sessions: ScriptedSession[] = [];
  failNextLaunch = false;

  describe() {
    return { kind: this.kind, label: 'Scripted', executable: '/fake/claude' };
  }

  launch(request: AgentLaunchRequest): Promise<AgentSession> {
    if (this.failNextLaunch) {
      this.failNextLaunch = false;
      return Promise.reject(new Error('scripted launch failure'));
    }
    this.launches.push(request);
    const session = new ScriptedSession(request);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

class ScriptedSession implements AgentSession {
  readonly pid = 4242;
  readonly sent: string[] = [];
  private readonly queue: AgentSessionItem[] = [];
  private waiter: ((item: IteratorResult<AgentSessionItem>) => void) | undefined;
  private closed = false;
  private turns = 0;

  constructor(request: AgentLaunchRequest) {
    this.push({
      type: 'event',
      event: {
        kind: 'session-started',
        payload: {
          backend: 'claude-code',
          backendSessionId: 'scripted-session',
          model: 'scripted-model',
          permissionMode: request.permissionMode,
          cwd: request.cwd,
          billing: 'subscription',
        },
      },
    });
    this.respond(request.prompt);
  }

  /**
   * A review brief that carries the operator marker `VERDICT-MERGEABLE` (or
   * `VERDICT-CHANGES`) ends its turn with the matching verdict line, the way
   * a real review run is instructed to.
   */
  /** A prompt marker asks for a result made of multibyte characters at the limit. */
  private resultText(text: string): string {
    if (text.includes('MULTIBYTE-RESULT')) {
      return '→'.repeat(4000);
    }
    return `done turn ${this.turns}${this.verdictLine(text)}`;
  }

  private verdictLine(text: string): string {
    if (text.includes('VERDICT-MERGEABLE')) return '\n\nVERDICT: mergeable';
    if (text.includes('VERDICT-CHANGES')) return '\nVERDICT: changes-requested\n';
    return '';
  }

  private respond(text: string): void {
    this.turns += 1;
    this.push({
      type: 'event',
      event: {
        kind: 'tool-call',
        payload: {
          toolUseId: `t${this.turns}`,
          name: 'Bash',
          input: { command: 'ls' },
          summary: 'ls',
        },
      },
    });
    this.push({
      type: 'event',
      event: {
        kind: 'tool-result',
        payload: {
          toolUseId: `t${this.turns}`,
          content: 'README.md',
          isError: false,
          truncated: false,
        },
      },
    });
    this.push({
      type: 'event',
      event: { kind: 'assistant-message', payload: { text: `echo: ${text.slice(0, 20)}` } },
    });
    this.push({
      type: 'event',
      event: {
        kind: 'turn-completed',
        payload: {
          outcome: 'success',
          resultText: this.resultText(text),
          costUsd: 0.5 * this.turns,
          turns: this.turns,
          durationMs: 10,
        },
      },
    });
  }

  readonly items: AsyncIterable<AgentSessionItem> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<AgentSessionItem>> => {
        const item = this.queue.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    }),
  };

  private push(item: AgentSessionItem): void {
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: item, done: false });
      return;
    }
    this.queue.push(item);
  }

  send(text: string): boolean {
    if (this.closed) return false;
    this.sent.push(text);
    this.respond(text);
    return true;
  }

  end(): void {
    this.exit(0, null);
  }

  kill(): void {
    this.exit(null, 'SIGTERM');
  }

  private exit(exitCode: number | null, signal: string | null): void {
    if (this.closed) return;
    this.push({ type: 'exited', exitCode, signal });
    this.closed = true;
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }
}

interface Ready {
  readonly context: TestContext;
  readonly cookie: string;
  readonly csrfToken: string;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly workItemId: ReturnType<typeof asWorkItemId>;
  readonly backend: ScriptedBackend;
}

async function ready(options: { readonly backend?: ScriptedBackend | null } = {}): Promise<Ready> {
  const backend = options.backend === undefined ? new ScriptedBackend() : options.backend;
  const context = await createTestContext({
    gitOperations: createGitOperations({ gitExecutable: 'git' }),
    agentBackend: backend,
  });
  contexts.push(context);
  await context.bootstrap();
  const login = await context.login();
  const user = context.storage.users.findByNormalizedUsername('test-user');
  if (user === undefined) throw new Error('bootstrap user missing');
  const workspaceId = context.storage.workspaces.listAuthorized(user.id)[0]?.workspace.id;
  if (workspaceId === undefined) throw new Error('default workspace missing');

  const projectId = asProjectId('project-1');
  const planVersionId = asPlanVersionId('version-1');
  const workItemId = asWorkItemId('item-1');
  const now = '2026-09-04T00:00:00.000Z';
  context.storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: projectId,
      workspaceId,
      name: 'Exec project',
      slug: 'exec-project',
      createdAt: now,
      createdByUserId: user.id,
    });
    tx.planning.bundles.insert({
      id: asPlanBundleId('bundle-1'),
      workspaceId,
      projectId,
      logicalName: 'exec',
      createdAt: now,
    });
    tx.planning.versions.insert({
      id: planVersionId,
      workspaceId,
      projectId,
      bundleId: asPlanBundleId('bundle-1'),
      versionNumber: 1,
      contentDigest: 'e'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'plan.md',
      normalizedSource: { document: 'plan.md' },
      itemCount: 1,
      requiredDependencyCount: 0,
      createdAt: now,
      createdByUserId: user.id,
    });
    tx.planning.workItems.insertMany([
      {
        id: workItemId,
        workspaceId,
        projectId,
        planVersionId,
        sourceId: 'AQ-01',
        ordinal: 0,
        title: 'Establish the queue',
        risk: 'high',
        primaryAreas: ['queue'],
        exitGate: 'Queue accepts and drains one job.',
        sourceFields: { id: 'AQ-01', notes: 'be careful' },
      },
    ]);
  });
  return {
    context,
    cookie: login.cookie,
    csrfToken: login.csrfToken,
    workspaceId,
    userId: user.id,
    workItemId,
    backend: backend ?? new ScriptedBackend(),
  };
}

function mutationHeaders(ready: Ready): Record<string, string> {
  return {
    cookie: ready.cookie,
    origin: ready.context.config.publicOrigin,
    [CSRF_HEADER_NAME]: ready.csrfToken,
    'content-type': 'application/json',
  };
}

async function registerAndWorktree(state: Ready, repositoryPath: string) {
  const registered = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/repositories`,
    headers: mutationHeaders(state),
    payload: { rootPath: repositoryPath, displayName: 'Fixture' },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const repository = registerSourceRepositoryResponseSchema.parse(registered.json());
  const worktreeResponse = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/worktrees`,
    headers: mutationHeaders(state),
    payload: { repositoryId: repository.repository.id },
  });
  expect(worktreeResponse.statusCode, worktreeResponse.body).toBe(200);
  const { worktree } = createWorktreeResponseSchema.parse(worktreeResponse.json());
  return { repository: repository.repository, worktree };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

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
      backends: [{ kind: 'claude-code', available: true }],
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
    expect(launch?.cwd).toBe(worktree.path);
    expect(launch?.prompt).toContain('# Work item AQ-01: Establish the queue');
    expect(launch?.prompt).toContain('Keep it small.');
    expect(launch?.prompt).toContain(worktree.branchName);
    expect(launch?.additionalDirectories?.[0]).toBe(
      join(state.context.config.execution.runsRoot, run.id),
    );

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

async function admit(state: Ready): Promise<void> {
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/admit`,
    headers: mutationHeaders(state),
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function runToFinish(
  state: Ready,
  worktreeId: string,
  payload: Record<string, unknown>,
): Promise<AgentRunId> {
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId, ...payload },
  });
  expect(started.statusCode, started.body).toBe(200);
  const { run } = startAgentRunResponseSchema.parse(started.json());
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
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status === 'finished',
    'finish',
  );
  return run.id;
}

async function mergeGate(state: Ready, worktreeId: string) {
  const execution = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/execution`,
    headers: { cookie: state.cookie },
  });
  return workItemExecutionResponseSchema.parse(execution.json()).mergeGates[
    worktreeId as WorktreeId
  ];
}

async function merge(state: Ready, worktreeId: string) {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/worktrees/${worktreeId}/merge`,
    headers: mutationHeaders(state),
    payload: {},
  });
}

describe('review-gated merge', () => {
  it('opens the gate only after the latest run is a mergeable review, then merges and completes', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);

    // No review yet: refused.
    expect(await mergeGate(state, worktree.id)).toMatchObject({
      mergeable: false,
      reason: 'no-review',
    });
    expect((await merge(state, worktree.id)).statusCode).toBe(409);

    // The implementation commits on the branch.
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'implement' });
    expect((await mergeGate(state, worktree.id))?.reason).toBe('no-review');

    // A review that requests changes keeps the gate closed.
    const changes = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-CHANGES',
    });
    expect(state.context.storage.execution.runs.find(state.workspaceId, changes)?.verdict).toBe(
      'changes-requested',
    );
    expect(await mergeGate(state, worktree.id)).toMatchObject({
      mergeable: false,
      reason: 'changes-requested',
      reviewRunId: changes,
    });

    // A mergeable review opens it; a later implement run closes it again.
    const approved = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    expect(await mergeGate(state, worktree.id)).toMatchObject({
      mergeable: true,
      reason: 'ready',
      reviewRunId: approved,
    });
    await runToFinish(state, worktree.id, { role: 'implement' });
    expect((await mergeGate(state, worktree.id))?.reason).toBe('superseded-by-later-run');
    const final = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    expect((await mergeGate(state, worktree.id))?.reviewRunId).toBe(final);

    const merged = await merge(state, worktree.id);
    expect(merged.statusCode, merged.body).toBe(200);
    const result = mergeWorktreeResponseSchema.parse(merged.json());
    expect(result.targetBranch).toBe('main');
    expect(result.workItemCompleted).toBe(true);
    expect(result.worktree).toMatchObject({ status: 'removed', mergeSha: result.mergeSha });
    expect(git(['rev-parse', 'HEAD'], repositoryPath).trim()).toBe(result.mergeSha);
    expect(git(['log', '--oneline', '-3'], repositoryPath)).toContain('add feature');
    expect(git(['branch', '--list', worktree.branchName], repositoryPath).trim()).toBe('');
    expect(git(['worktree', 'list'], repositoryPath)).not.toContain(worktree.path);

    const item = state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId);
    expect(item?.status).toBe('completed');
    expect(item?.mergeSha).toBe(result.mergeSha);
    expect(item?.completionWorktreeId).toBe(worktree.id);

    const actions = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 100 })
      .map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['worktree.merged', 'work-item.completed']));
    const kinds = state.context.storage.workspaceEvents
      .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 100 })
      .map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['worktree-merged', 'work-item-completed']));

    // Merging again is refused: the worktree is gone.
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
  });

  it('refuses a merge when the worktree is dirty or the primary checkout is not on the default branch', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });

    writeFileSync(join(worktree.path, 'uncommitted.txt'), 'oops\n');
    const dirty = await merge(state, worktree.id);
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toMatchObject({
      error: { message: expect.stringMatching(/uncommitted/) },
    });
    rmSync(join(worktree.path, 'uncommitted.txt'));

    git(['checkout', '-b', 'elsewhere'], repositoryPath);
    const wrongBranch = await merge(state, worktree.id);
    expect(wrongBranch.statusCode).toBe(400);
    expect(wrongBranch.json()).toMatchObject({
      error: { message: expect.stringMatching(/elsewhere/) },
    });
    git(['checkout', 'main'], repositoryPath);

    // A conflicting change on main is reported and aborted, leaving main clean.
    writeFileSync(join(repositoryPath, 'feature.txt'), 'conflict\n');
    git(['add', '--all'], repositoryPath);
    git(['commit', '--no-gpg-sign', '-m', 'conflicting'], repositoryPath);
    const conflict = await merge(state, worktree.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { message: expect.stringMatching(/conflict/) },
    });
    expect(git(['status', '--porcelain'], repositoryPath)).toBe('');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');
  });
});
