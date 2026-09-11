import { openDatabase } from '@craftingtable/storage';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  repositoryBranchesResponseSchema,
  runEventPageResponseSchema,
  runProfilesResponseSchema,
  sourceRepositoryListResponseSchema,
  startAgentRunResponseSchema,
  workCycleResponseSchema,
  workCyclesResponseSchema,
  workItemExecutionResponseSchema,
  workspaceRunsResponseSchema,
  worktreeDiffResponseSchema,
} from '@craftingtable/contracts';
import {
  type AgentBackendKind,
  type AgentRunId,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  asWorktreeId,
  CYCLE_STEPS,
  type CycleProfiles,
  DEFAULT_COMPLETION_POLICY,
  type UserId,
  type WorkCycle,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from './config.js';
import { mergeGateFor } from './services/execution-service.js';
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
  constructor(readonly kind: AgentBackendKind = 'claude-code') {}
  readonly launches: AgentLaunchRequest[] = [];
  readonly sessions: ScriptedSession[] = [];
  repliesForNextRun: ScriptedReply[] = [];
  failNextLaunch = false;

  describe() {
    return {
      kind: this.kind,
      label: 'Scripted',
      executable: '/fake/claude',
      models: [{ id: 'scripted-model', label: 'Scripted model' }],
    };
  }

  launch(request: AgentLaunchRequest): Promise<AgentSession> {
    if (this.failNextLaunch) {
      this.failNextLaunch = false;
      return Promise.reject(new Error('scripted launch failure'));
    }
    this.launches.push(request);
    const session = new ScriptedSession(request, this.kind, this.repliesForNextRun.splice(0));
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

interface ScriptedReply {
  readonly messages?: readonly string[];
  readonly resultText: string;
  readonly truncated?: boolean;
}

class ScriptedSession implements AgentSession {
  readonly pid = 4242;
  readonly sent: string[] = [];
  private readonly queue: AgentSessionItem[] = [];
  private waiter: ((item: IteratorResult<AgentSessionItem>) => void) | undefined;
  private closed = false;
  private turns = 0;
  private delayed = false;

  constructor(
    request: AgentLaunchRequest,
    kind: AgentBackendKind,
    private readonly replies: ScriptedReply[] = [],
  ) {
    this.push({
      type: 'event',
      event: {
        kind: 'session-started',
        payload: {
          backend: kind,
          backendSessionId: 'scripted-session',
          model: 'scripted-model',
          permissionMode: request.permissionMode,
          cwd: request.cwd,
          billing: 'subscription',
        },
      },
    });
    this.delayed = request.prompt.includes('DEFER-TURNS');
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
    if (this.delayed) setTimeout(() => this.respondNow(text), 50);
    else this.respondNow(text);
  }

  private respondNow(text: string): void {
    this.turns += 1;
    const reply = this.replies.shift();
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
    for (const message of reply?.messages ?? [`echo: ${text.slice(0, 20)}`]) {
      this.push({
        type: 'event',
        event: { kind: 'assistant-message', payload: { text: message } },
      });
    }
    this.push({
      type: 'event',
      event: {
        kind: 'turn-completed',
        payload: {
          outcome: 'success',
          resultText: reply?.resultText ?? this.resultText(text),
          ...(reply?.truncated === undefined ? {} : { truncated: reply.truncated }),
          costUsd: 0.5 * this.turns,
          ...(text.includes('TELEMETRY')
            ? {
                model: 'rerouted-model',
                tokenUsage: {
                  inputTokens: 10,
                  cachedInputTokens: 5,
                  outputTokens: 2,
                  reasoningOutputTokens: 1,
                  totalTokens: 12,
                },
              }
            : {}),
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

async function ready(
  options: {
    readonly now?: () => Date;
    readonly backend?: ScriptedBackend | null;
    readonly backends?: ReadonlyMap<AgentBackendKind, AgentBackend>;
    readonly gitOperations?: GitOperations;
  } = {},
): Promise<Ready> {
  const backend = options.backend === undefined ? new ScriptedBackend() : options.backend;
  const context = await createTestContext({
    ...(options.now === undefined ? {} : { now: options.now }),
    gitOperations: options.gitOperations ?? createGitOperations({ gitExecutable: 'git' }),
    agentBackends: options.backends ?? new Map(backend === null ? [] : [[backend.kind, backend]]),
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

async function registerAndWorktree(
  state: Ready,
  repositoryPath: string,
  integrationBranch = 'main',
) {
  const registered = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/repositories`,
    headers: mutationHeaders(state),
    payload: { rootPath: repositoryPath, displayName: 'Fixture' },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const repository = registerSourceRepositoryResponseSchema.parse(registered.json());
  const settings = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/plan-versions/version-1/branch-settings`,
    headers: mutationHeaders(state),
    payload: {
      repositoryId: repository.repository.id,
      integrationBranch,
      expectedVersion:
        state.context.storage.execution.branchSettings.find(
          state.workspaceId,
          asPlanVersionId('version-1'),
        )?.version ?? 0,
    },
  });
  expect(settings.statusCode, settings.body).toBe(200);
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

async function merge(state: Ready, worktreeId: string, payload: Record<string, unknown> = {}) {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/worktrees/${worktreeId}/merge`,
    headers: mutationHeaders(state),
    payload,
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

    // A primary checkout on another branch does not block the merge: main is
    // updated through a scratch worktree and the checkout stays where it was.
    git(['checkout', '-b', 'elsewhere'], repositoryPath);
    const elsewhere = await merge(state, worktree.id);
    expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    const landed = mergeWorktreeResponseSchema.parse(elsewhere.json());
    expect(git(['rev-parse', 'main'], repositoryPath).trim()).toBe(landed.mergeSha);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repositoryPath).trim()).toBe('elsewhere');
    expect(existsSync(join(state.context.config.execution.worktreeRoot, '.merge'))).toBe(true);
    expect(readdirSync(join(state.context.config.execution.worktreeRoot, '.merge'))).toEqual([]);
    git(['checkout', 'main'], repositoryPath);
  });

  it('merges into the recorded integration branch without changing main', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    git(['branch', 'aq-cont-1'], repositoryPath);
    const { worktree } = await registerAndWorktree(state, repositoryPath, 'aq-cont-1');
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });

    const branches = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/repositories/${worktree.repositoryId}/branches`,
      headers: { cookie: state.cookie },
    });
    expect(repositoryBranchesResponseSchema.parse(branches.json())).toEqual({
      branches: ['aq-cont-1', worktree.branchName, 'main'],
      checkedOut: 'main',
    });

    const invalid = await merge(state, worktree.id, { targetBranch: worktree.branchName });
    expect(invalid.statusCode).toBe(409);
    const hostile = await merge(state, worktree.id, { targetBranch: '--evil' });
    expect(hostile.statusCode).toBe(409);

    const mainHead = git(['rev-parse', 'main'], repositoryPath).trim();
    const merged = await merge(state, worktree.id, { targetBranch: 'aq-cont-1' });
    expect(merged.statusCode, merged.body).toBe(200);
    const result = mergeWorktreeResponseSchema.parse(merged.json());
    expect(result).toMatchObject({ targetBranch: 'aq-cont-1', createdTarget: false });
    expect(git(['rev-parse', 'aq-cont-1'], repositoryPath).trim()).toBe(result.mergeSha);
    expect(git(['log', '--oneline', 'aq-cont-1'], repositoryPath)).toContain('add feature');
    // main is untouched and the worktree branch is gone.
    expect(git(['rev-parse', 'main'], repositoryPath).trim()).toBe(mainHead);
    expect(git(['branch', '--list', worktree.branchName], repositoryPath).trim()).toBe('');
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('completed');
    const event = state.context.storage.workspaceEvents
      .listAfter({ workspaceId: state.workspaceId, after: 0, limit: 100 })
      .find((entry) => entry.kind === 'worktree-merged');
    expect(event?.kind === 'worktree-merged' && event.payload.targetBranch).toBe('aq-cont-1');
  });

  it('reports a conflicting merge and leaves the checkout clean', async () => {
    const state = await ready();
    const repositoryPath = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, repositoryPath);
    await admit(state);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'add feature'], worktree.path);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });

    // A conflicting change on main is reported and aborted, leaving main clean.
    writeFileSync(join(repositoryPath, 'feature.txt'), 'conflict\n');
    git(['add', '--all'], repositoryPath);
    git(['commit', '--no-gpg-sign', '-m', 'conflicting'], repositoryPath);
    const conflict = await merge(state, worktree.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { message: expect.stringMatching(/Integration branch advanced/) },
    });
    expect(git(['status', '--porcelain'], repositoryPath)).toBe('');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');
  });

  it('seeds a remediation run with the review findings from the journal', async () => {
    const state = await ready();
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    await admit(state);
    const review = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-CHANGES',
    });
    const started = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, role: 'implement', parentRunId: review },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { run } = startAgentRunResponseSchema.parse(started.json());
    expect(run.parentRunId).toBe(review);
    const launch = state.backend.launches.at(-1);
    expect(launch?.prompt).toContain('## Remediation');
    expect(launch?.prompt).toContain('## Review findings to address (verdict: changes-requested)');
    expect(launch?.prompt).toContain('VERDICT: changes-requested');
    expect(launch?.prompt).toContain('disposition for each finding');

    // A parent from another work item is refused.
    const other = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id, role: 'implement', parentRunId: 'no-such-run' },
    });
    expect(other.statusCode).toBe(404);
  });
});

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

it('never opens the merge gate for a failed, cancelled or interrupted review with an earlier verdict', async () => {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const id = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  const run = state.context.storage.execution.runs.find(state.workspaceId, id);
  const storedWorktree = state.context.storage.execution.worktrees.find(
    state.workspaceId,
    worktree.id,
  );
  if (run === undefined || storedWorktree === undefined) throw new Error('Missing fixtures');
  expect(mergeGateFor(storedWorktree, [run]).mergeable).toBe(true);
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    expect(mergeGateFor(storedWorktree, [{ ...run, status }]).mergeable).toBe(false);
  }
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
      profiles: [
        { role: 'design', backend: 'claude-code', permissionMode: 'auto', stored: false },
        { role: 'implement', backend: 'claude-code', permissionMode: 'auto', stored: false },
        { role: 'review', backend: 'claude-code', permissionMode: 'auto', stored: false },
      ],
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
    expect(after.profiles).toEqual([
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

const structuredFinding = {
  id: 'F-001',
  severity: 'minor',
  status: 'open',
  title: 'Boundary coverage',
  explanation: 'Cover the boundary.',
  recommendation: 'Add a regression case.',
};
function reviewText(findings: readonly unknown[]) {
  return `\`\`\`craftingtable-review\n${JSON.stringify({ version: 1, complete: true, verdict: 'mergeable', exitGate: { met: true, evidence: 'Checks passed.' }, findings })}\n\`\`\`\nVERDICT: mergeable`;
}

async function runDetail(state: Ready, id: AgentRunId) {
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/runs/${id}`,
    headers: { cookie: state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return agentRunDetailResponseSchema.parse(response.json());
}

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
  state.backend.repliesForNextRun = [
    { resultText: reviewText([structuredFinding]) },
    {
      resultText: reviewText([
        structuredFinding,
        { ...structuredFinding, id: 'F-002', title: 'Later finding' },
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
    'source review',
  );
  const implement = await runToFinish(state, worktree.id, {
    role: 'implement',
    parentRunId: run.id,
  });
  await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/messages`,
    headers: mutationHeaders(state),
    payload: { text: 'Check another edge case.' },
  });
  await waitFor(
    () => state.context.storage.execution.runs.find(state.workspaceId, run.id)?.turnCount === 2,
    'later source revision',
  );
  expect((await runDetail(state, run.id)).reviewReport).toMatchObject({
    status: 'complete',
    report: { findings: [expect.anything(), expect.objectContaining({ id: 'F-002' })] },
  });
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

/* Automated cycle exercises the same real Git/worktree and journal path as manual execution. */
class CycleBackend extends ScriptedBackend {
  onLaunch: ((request: AgentLaunchRequest) => void) | undefined;
  constructor(private readonly outputs: readonly ScriptedReply[]) {
    super();
  }
  override launch(request: AgentLaunchRequest): Promise<AgentSession> {
    this.onLaunch?.(request);
    this.repliesForNextRun = [
      this.outputs[this.launches.length] ?? { resultText: 'No scripted result' },
    ];
    return super.launch(request);
  }
}
const cycleProfiles = Object.fromEntries(
  CYCLE_STEPS.map((step) => [
    step,
    { backend: 'claude-code', model: `${step}-model`, permissionMode: 'auto' },
  ]),
) as CycleProfiles;
async function startCycle(
  state: Ready,
  worktreeId: WorktreeId,
  overrides: Record<string, unknown> = {},
) {
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/cycles`,
    headers: mutationHeaders(state),
    payload: {
      worktreeId,
      profiles: cycleProfiles,
      policy: DEFAULT_COMPLETION_POLICY,
      ...overrides,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return workCycleResponseSchema.parse(response.json()).cycle;
}
function currentCycle(state: Ready, cycle: WorkCycle): WorkCycle {
  const found = state.context.storage.execution.cycles.find(state.workspaceId, cycle.id);
  if (!found) throw new Error('Missing cycle');
  return found;
}
async function controlCycle(state: Ready, cycle: WorkCycle, action: 'pause' | 'resume' | 'stop') {
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: { action, expectedVersion: cycle.version },
  });
  expect(response.statusCode, response.body).toBe(200);
  return workCycleResponseSchema.parse(response.json()).cycle;
}
async function cycleFixture(outputs: readonly ScriptedReply[], now?: () => Date) {
  const backend = new CycleBackend(outputs);
  const state = await ready({ backend, ...(now === undefined ? {} : { now }) });
  const root = fixtureRepository();
  const { worktree } = await registerAndWorktree(state, root);
  await admit(state);
  return { state, backend, worktree, root };
}
const designDone = { resultText: 'Design complete.\n\n## Open questions\nnone' };
const implementationDone = { resultText: 'Implemented and checks passed.' };

describe('single work-item automation', () => {
  it('remediates mergeable minor findings, preserves lineage and models, and stops for operator merge', async () => {
    const { state, backend, worktree, root } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([structuredFinding]) },
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Boundary regression passed.' },
        ]),
      },
    ]);
    backend.onLaunch = (request) => {
      if (request.model === 'implement-model') {
        writeFileSync(join(worktree.path, 'implemented.txt'), 'review this change');
        git(['add', '.'], worktree.path);
        git(['commit', '-m', 'implementation'], worktree.path);
      }
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'merge approval');
    expect(existsSync(join(root, 'implemented.txt'))).toBe(false);
    const settled = currentCycle(state, cycle);
    expect(backend.launches.map((launch) => launch.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'remediate-model',
      'review-model',
    ]);
    expect(settled.remediationRounds).toBe(1);
    expect(settled.reviewHeadSha).toBe(git(['rev-parse', 'HEAD'], worktree.path).trim());
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    expect(existsSync(worktree.path)).toBe(true);
    const runs = state.context.storage.execution.runs
      .listForWorktree(state.workspaceId, worktree.id)
      .toReversed();
    expect(runs.map((run) => run.role)).toEqual([
      'design',
      'implement',
      'review',
      'implement',
      'review',
    ]);
    for (let index = 1; index < runs.length; index++)
      expect(runs[index]?.parentRunId).toBe(runs[index - 1]?.id);
    expect(runs[3]?.brief).toContain('F-001');
    const listing = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/cycles`,
      headers: { cookie: state.cookie },
    });
    expect(workCyclesResponseSchema.parse(listing.json()).cycles[0]?.status).toBe('awaiting-merge');
    const events = state.context.storage.workspaceEvents.listAfter({
      workspaceId: state.workspaceId,
      after: 0,
      limit: 500,
    });
    expect(
      events.some(
        (event) => event.kind === 'work-cycle-changed' && event.payload.status === 'awaiting-merge',
      ),
    ).toBe(true);
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/merge`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => currentCycle(state, cycle).status === 'completed', 'cycle completion');
    expect(git(['branch', '--show-current'], root).trim()).toBe('main');
    expect(readFileSync(join(root, 'implemented.txt'), 'utf8')).toBe('review this change');
  });

  it('pauses for design questions and adopts a manual resolution on explicit resume', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhich storage format?' },
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'design questions',
    );
    expect(backend.launches).toHaveLength(1);
    await runToFinish(state, worktree.id, {
      role: 'design',
      parentRunId: currentCycle(state, cycle).currentRunId,
    });
    await controlCycle(state, currentCycle(state, cycle), 'resume');
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'resolved design');
    expect(backend.launches).toHaveLength(4);
  });

  it.each([
    [
      'unstructured review',
      { resultText: 'VERDICT: mergeable' },
      DEFAULT_COMPLETION_POLICY,
      'structured',
    ],
    [
      'truncated review',
      { resultText: reviewText([]), truncated: true },
      DEFAULT_COMPLETION_POLICY,
      'complete successful',
    ],
    [
      'remediation budget',
      { resultText: reviewText([structuredFinding]) },
      { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
      'limit reached',
    ],
  ] as const)(
    'pauses for %s and never merges through it',
    async (_name, review, policy, reason) => {
      const { state, backend, worktree } = await cycleFixture([
        designDone,
        implementationDone,
        review,
      ]);
      const cycle = await startCycle(state, worktree.id, { policy });
      await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', reason);
      expect(currentCycle(state, cycle).reason).toContain(reason);
      expect(backend.launches).toHaveLength(3);
      const merge = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/merge`,
        headers: mutationHeaders(state),
        payload: {},
      });
      expect(merge.statusCode).toBe(409);
    },
  );

  it('stops after two unchanged remediation rounds even with remaining budget', async () => {
    const review = { resultText: reviewText([structuredFinding]) };
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      review,
      implementationDone,
      review,
      implementationDone,
      review,
    ]);
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 10 },
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'stalled reviews');
    expect(currentCycle(state, cycle).reason).toContain('Two remediation rounds');
    expect(backend.launches).toHaveLength(7);
  });

  it('does not treat disappearing finding IDs as resolution', async () => {
    const { state, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([structuredFinding]) },
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'missing finding');
    expect(currentCycle(state, cycle).reason).toContain('structured');
  });

  it('rejects a stale reviewed commit at operator merge', async () => {
    const { state, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'merge approval');
    writeFileSync(join(worktree.path, 'later.txt'), 'unreviewed');
    git(['add', '.'], worktree.path);
    git(['commit', '-m', 'later'], worktree.path);
    const merge = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/merge`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(merge.statusCode).toBe(409);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it('rejects duplicate starts, stale controls, missing CSRF and foreign-workspace controls', async () => {
    const { state, worktree } = await cycleFixture([{ resultText: '## Open questions\nQuestion' }]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'questions');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`;
    const stale = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: { action: 'resume', expectedVersion: cycle.version },
    });
    expect(stale.statusCode).toBe(409);
    const csrf = await state.context.app.inject({
      method: 'POST',
      url,
      headers: { cookie: state.cookie, origin: state.context.config.publicOrigin },
      payload: { action: 'resume', expectedVersion: currentCycle(state, cycle).version },
    });
    expect(csrf.statusCode).toBe(403);
    const foreign = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/foreign/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'stop', expectedVersion: currentCycle(state, cycle).version },
    });
    expect(foreign.statusCode).toBe(404);
    const duplicate = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/cycles`,
      headers: mutationHeaders(state),
      payload: {
        worktreeId: worktree.id,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
      },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('recovers a durable reservation without replaying it after restart', async () => {
    const { state, backend, worktree } = await cycleFixture([designDone]);
    await state.context.services.workCycleService.shutdown();
    const cycle = await startCycle(state, worktree.id);
    expect(backend.launches).toHaveLength(0);
    state.context.services.workCycleService.recoverInterrupted();
    expect(currentCycle(state, cycle).status).toBe('needs-attention');
    expect(currentCycle(state, cycle).reason).toContain('restarted');
    expect(backend.launches).toHaveLength(0);
    const stopped = await controlCycle(state, currentCycle(state, cycle), 'stop');
    expect(stopped.status).toBe('stopped');
    // Manual flow remains available after the cycle has relinquished ownership.
    await runToFinish(state, worktree.id, { role: 'design' });
    expect(backend.launches).toHaveLength(1);
  });

  it('requires completed required predecessors, while admission remains manual', async () => {
    const { state, backend, worktree } = await cycleFixture([designDone]);
    state.context.storage.planning.workItems.insertMany([
      {
        id: asWorkItemId('predecessor'),
        workspaceId: state.workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        sourceId: 'AQ-00',
        ordinal: 1,
        title: 'Prerequisite',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'Done',
        sourceFields: {},
      },
    ]);
    state.context.storage.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId('dependency-1'),
        workspaceId: state.workspaceId,
        planVersionId: asPlanVersionId('version-1'),
        predecessorWorkItemId: asWorkItemId('predecessor'),
        successorWorkItemId: state.workItemId,
        kind: 'required',
        ordinal: 0,
      },
    ]);
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/cycles`,
      headers: mutationHeaders(state),
      payload: {
        worktreeId: worktree.id,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('AQ-00');
    expect(backend.launches).toHaveLength(0);
  });
});

describe('cycle supervision and operator races', () => {
  it('cancels a timed-out run and leaves the quality gate closed', async () => {
    let time = new Date();
    const { state, backend, worktree } = await cycleFixture([designDone], () => time);
    const cycle = await startCycle(state, worktree.id, { instructions: 'DEFER-TURNS' });
    await waitFor(() => backend.launches.length === 1, 'launch');
    time = new Date(time.getTime() + 121 * 60_000);
    state.context.services.workspaceEventNotifier.notify();
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'timeout');
    expect(currentCycle(state, cycle).reason).toContain('time limit');
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'cancelled',
      'cancelled process',
    );
    expect(backend.launches).toHaveLength(1);
  });

  it('allows manual control only after pausing and resumes through the completed design', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id, { instructions: 'DEFER-TURNS' });
    await waitFor(() => backend.launches.length === 1, 'design launch');
    const blocked = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
      headers: mutationHeaders(state),
      payload: { worktreeId: worktree.id },
    });
    expect(blocked.statusCode).toBe(409);
    const paused = await controlCycle(state, currentCycle(state, cycle), 'pause');
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'waiting',
      'manual waiting session',
    );
    expect(backend.launches).toHaveLength(1);
    const ended = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/runs/${cycle.currentRunId}/end`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(ended.statusCode).toBe(200);
    await controlCycle(state, paused, 'resume');
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'resumed cycle');
    expect(backend.launches).toHaveLength(3);
  });

  it('kills a delayed launch when the operator stops its reservation', async () => {
    let release: (() => void) | undefined;
    let launching = false;
    class DelayedBackend extends ScriptedBackend {
      override async launch(request: AgentLaunchRequest): Promise<AgentSession> {
        launching = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return super.launch(request);
      }
    }
    const backend = new DelayedBackend();
    const state = await ready({ backend });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    await admit(state);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => launching, 'pending launch');
    try {
      await controlCycle(state, currentCycle(state, cycle), 'stop');
    } finally {
      release?.();
    }
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'cancelled',
      'delayed process cancellation',
    );
    expect(currentCycle(state, cycle).status).toBe('stopped');
    expect(backend.launches).toHaveLength(1);
  });
});

it('does not lose earlier cycle findings when an unrelated manual run is resumed', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
  ]);
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'policy stop');
  await runToFinish(state, worktree.id, { role: 'implement' });
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'resume', expectedVersion: currentCycle(state, cycle).version },
  });
  expect(response.statusCode).toBe(409);
  expect(response.body).toContain('handoff lineage');
  expect(backend.launches).toHaveLength(4);
});

/* Branch mechanics: real Git, authenticated commands, durable provenance. */
async function branchCommand(state: Ready, path: string, payload: Record<string, unknown>) {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/${path}`,
    headers: mutationHeaders(state),
    payload,
  });
}
function commitFile(path: string, filename: string, content: string) {
  writeFileSync(join(path, filename), content);
  git(['add', '--all'], path);
  git(['commit', '--no-gpg-sign', '-m', filename], path);
  return git(['rev-parse', 'HEAD'], path).trim();
}

describe('plan integration branches', () => {
  it('uses the integration head with main checked out, and preserves existing worktree targets across configuration changes', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const main = git(['rev-parse', 'main'], root).trim();
    git(['checkout', '-b', 'revision'], root);
    const revision = commitFile(root, 'integration.txt', 'previously merged item');
    git(['checkout', 'main'], root);
    const { repository, worktree } = await registerAndWorktree(state, root, 'revision');
    expect(worktree).toMatchObject({
      baseSha: revision,
      baseBranch: 'revision',
      integrationBranch: 'revision',
    });
    expect(readFileSync(join(worktree.path, 'integration.txt'), 'utf8')).toBe(
      'previously merged item',
    );
    expect(git(['rev-parse', 'main'], root).trim()).toBe(main);
    const changed = await branchCommand(state, 'plan-versions/version-1/branch-settings', {
      repositoryId: repository.id,
      integrationBranch: 'next-revision',
      createFromBranch: 'revision',
      expectedVersion: 1,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(git(['branch', '--show-current'], root).trim()).toBe('main');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)
        ?.integrationBranch,
    ).toBe('revision');
    const next = await branchCommand(state, `work-items/${state.workItemId}/worktrees`, {
      repositoryId: repository.id,
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().worktree).toMatchObject({
      integrationBranch: 'next-revision',
      baseSha: revision,
    });
    const stale = await branchCommand(state, 'plan-versions/version-1/branch-settings', {
      repositoryId: repository.id,
      integrationBranch: 'should-not-exist',
      createFromBranch: 'main',
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(git(['branch', '--list', 'should-not-exist'], root).trim()).toBe('');
  });

  it('rejects missing targets, unauthorized settings, and changing the target at merge time', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { repository, worktree } = await registerAndWorktree(state, root);
    const path = 'plan-versions/version-1/branch-settings';
    const payload = {
      repositoryId: repository.id,
      integrationBranch: 'missing',
      expectedVersion: 1,
    };
    const missing = await branchCommand(state, path, payload);
    expect(missing.statusCode).toBe(409);
    expect(git(['branch', '--list', 'missing'], root)).toBe('');
    const csrf = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/${path}`,
      headers: { cookie: state.cookie },
      payload,
    });
    expect(csrf.statusCode).toBe(403);
    const foreign = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/foreign/${path}`,
      headers: mutationHeaders(state),
      payload,
    });
    expect(foreign.statusCode).toBe(404);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    const wrongTarget = await merge(state, worktree.id, { targetBranch: 'missing' });
    expect(wrongTarget.statusCode).toBe(409);
    expect(wrongTarget.body).toContain('Retarget');
    expect(git(['branch', '--list', 'missing'], root)).toBe('');
  });

  it('refuses stale manual reviews, updates integration without completing the item, and requires review again', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, root);
    await admit(state);
    commitFile(worktree.path, 'item.txt', 'item');
    const oldReview = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    const target = commitFile(root, 'other-item.txt', 'integration advanced');
    const before = git(['rev-parse', 'HEAD'], worktree.path).trim();
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    const updated = await branchCommand(state, `worktrees/${worktree.id}/update`, {
      expectedVersion: worktree.version,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(git(['rev-parse', 'main'], root).trim()).toBe(target);
    expect(git(['rev-parse', 'HEAD'], worktree.path).trim()).not.toBe(before);
    expect(readFileSync(join(worktree.path, 'other-item.txt'), 'utf8')).toBe(
      'integration advanced',
    );
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    expect(
      (await branchCommand(state, `worktrees/${worktree.id}/update`, { expectedVersion: 1 }))
        .statusCode,
    ).toBe(409);
    const diffResponse = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/diff`,
      headers: { cookie: state.cookie },
    });
    expect(diffResponse.statusCode).toBe(200);
    expect(diffResponse.json().baseSha).toBe(target);
    expect(diffResponse.json().files.map((file: { path: string }) => file.path)).toEqual([
      'item.txt',
    ]);
    const review = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
      parentRunId: oldReview,
    });
    const run = state.context.storage.execution.runs.find(state.workspaceId, review);
    expect(run?.reviewBranchContext).toMatchObject({
      targetBranch: 'main',
      targetSha: target,
      worktreeVersion: 2,
    });
    expect(run?.brief).toContain(target);
    const merged = await merge(state, worktree.id);
    expect(merged.statusCode, merged.body).toBe(200);
    expect(readFileSync(join(root, 'item.txt'), 'utf8')).toBe('item');
  });

  it('refuses a changed source commit and invalidates review on an explicit retarget', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, root);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    commitFile(worktree.path, 'unreviewed.txt', 'unreviewed');
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    git(['branch', 'revision'], root);
    const retarget = await branchCommand(state, `worktrees/${worktree.id}/retarget`, {
      expectedVersion: 1,
      integrationBranch: 'revision',
    });
    expect(retarget.statusCode).toBe(200);
    expect(retarget.json().worktree).toMatchObject({
      integrationBranch: 'revision',
      baseBranch: 'main',
      version: 2,
    });
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    expect((await merge(state, worktree.id)).statusCode).toBe(200);
    expect(existsSync(join(root, 'unreviewed.txt'))).toBe(false);
  });

  it('aborts conflicting integration updates, preserves both branches, and closes the review gate', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { worktree } = await registerAndWorktree(state, root);
    const source = commitFile(worktree.path, 'conflict.txt', 'item');
    await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
    const target = commitFile(root, 'conflict.txt', 'integration');
    const response = await branchCommand(state, `worktrees/${worktree.id}/update`, {
      expectedVersion: 1,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('conflict');
    expect(git(['rev-parse', 'HEAD'], worktree.path).trim()).toBe(source);
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(target);
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.version,
    ).toBe(2);
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
  });

  it('checks prerequisite commit ancestry and accepts explicit evidence for a historical manual completion', async () => {
    const state = await ready();
    const root = fixtureRepository();
    const { repository } = await registerAndWorktree(state, root);
    const prerequisite = asWorkItemId('prior');
    state.context.storage.transaction((tx) => {
      tx.planning.workItems.insertMany([
        {
          id: prerequisite,
          workspaceId: state.workspaceId,
          projectId: asProjectId('project-1'),
          planVersionId: asPlanVersionId('version-1'),
          sourceId: 'AQ-00',
          ordinal: 2,
          title: 'Prerequisite',
          risk: 'low',
          primaryAreas: [],
          exitGate: 'done',
          sourceFields: {},
        },
      ]);
      tx.planning.workItems.complete({
        workspaceId: state.workspaceId,
        workItemId: prerequisite,
        projectId: asProjectId('project-1'),
        completedAt: new Date().toISOString(),
        completedByUserId: state.userId,
      });
      tx.planning.dependencies.insertMany([
        {
          id: asWorkItemDependencyId('prior-edge'),
          workspaceId: state.workspaceId,
          planVersionId: asPlanVersionId('version-1'),
          predecessorWorkItemId: prerequisite,
          successorWorkItemId: state.workItemId,
          kind: 'required',
          ordinal: 0,
        },
      ]);
    });
    const blocked = await branchCommand(state, `work-items/${state.workItemId}/worktrees`, {
      repositoryId: repository.id,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain('no recorded merge commit');
    git(['checkout', '-b', 'unmerged-prior'], root);
    const evidence = commitFile(root, 'prerequisite.txt', 'prior work');
    git(['checkout', 'main'], root);
    expect(
      (await branchCommand(state, 'work-items/prior/integration-evidence', { commitSha: evidence }))
        .statusCode,
    ).toBe(409);
    git(['merge', '--no-ff', '--no-edit', 'unmerged-prior'], root);
    const recorded = await branchCommand(state, 'work-items/prior/integration-evidence', {
      commitSha: evidence.slice(0, 12),
    });
    expect(
      state.context.storage.execution.branchSettings.evidence(
        state.workspaceId,
        prerequisite,
        repository.id,
      ),
    ).toBe(evidence);
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json().missingEvidence).toEqual([]);
    // Historical completion is still immutable and untouched.
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, prerequisite)?.mergeSha,
    ).toBeUndefined();
    expect(
      (
        await branchCommand(state, `work-items/${state.workItemId}/worktrees`, {
          repositoryId: repository.id,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('resumes an awaiting-merge cycle through a fresh review after updating integration', async () => {
    const { state, backend, root, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'initial approval');
    const oldReview = currentCycle(state, cycle).currentRunId;
    const target = commitFile(root, 'parallel-item.txt', 'approved elsewhere');
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    expect(
      (await branchCommand(state, `worktrees/${worktree.id}/update`, { expectedVersion: 1 }))
        .statusCode,
    ).toBe(409);
    const paused = await controlCycle(state, currentCycle(state, cycle), 'pause');
    const update = await branchCommand(state, `worktrees/${worktree.id}/update`, {
      expectedVersion: 1,
    });
    expect(update.statusCode, update.body).toBe(200);
    await controlCycle(state, paused, 'resume');
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'renewed approval');
    const renewed = currentCycle(state, cycle).currentRunId;
    expect(renewed).not.toBe(oldReview);
    expect(backend.launches).toHaveLength(4);
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, renewed)?.reviewBranchContext
        ?.targetSha,
    ).toBe(target);
    expect((await merge(state, worktree.id)).statusCode).toBe(200);
  });
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

it('serializes operator merges for different items in the same repository', async () => {
  const state = await ready();
  const root = fixtureRepository();
  const { worktree: first } = await registerAndWorktree(state, root);
  const secondId = asWorkItemId('parallel-item');
  state.context.storage.planning.workItems.insertMany([
    {
      id: secondId,
      workspaceId: state.workspaceId,
      projectId: first.projectId,
      planVersionId: asPlanVersionId('version-1'),
      sourceId: 'AQ-02',
      ordinal: 1,
      title: 'Independent item',
      risk: 'low',
      primaryAreas: [],
      exitGate: 'done',
      sourceFields: {},
    },
  ]);
  const secondState = { ...state, workItemId: secondId };
  const { worktree: second } = await registerAndWorktree(secondState, root);
  commitFile(first.path, 'first.txt', 'first');
  commitFile(second.path, 'second.txt', 'second');
  await runToFinish(state, first.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
  await runToFinish(secondState, second.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
  const results = await Promise.all([merge(state, first.id), merge(secondState, second.id)]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  expect(results.find((result) => result.statusCode === 409)?.body).toContain('Another merge');
  expect(
    Number(existsSync(join(root, 'first.txt'))) + Number(existsSync(join(root, 'second.txt'))),
  ).toBe(1);
});

it.each(['pause', 'stop'] as const)(
  'honors %s while Git preflight is pending without launching an agent',
  async (action) => {
    const realGit = createGitOperations({ gitExecutable: 'git' });
    let blocking = false;
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = await ready({
      gitOperations: {
        ...realGit,
        resolveBranch: async (path, branch) => {
          if (blocking) {
            entered = true;
            await gate;
          }
          return realGit.resolveBranch(path, branch);
        },
      },
    });
    const { worktree } = await registerAndWorktree(state, fixtureRepository());
    await admit(state);
    blocking = true;
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => entered, 'Git preflight began');
    try {
      await controlCycle(state, currentCycle(state, cycle), action);
    } finally {
      release();
    }
    await state.context.services.workCycleService.shutdown();
    expect(state.backend.launches).toHaveLength(0);
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    ).toBeUndefined();
    expect(currentCycle(state, cycle).status).toBe(action === 'pause' ? 'paused' : 'stopped');
  },
);

/* Roadmaps exercise real admission, Git, cycles, operator merge, and durable revisions. */
async function roadmapFixture(
  outputs: readonly ScriptedReply[] = [
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ],
  options: { gitOperations?: GitOperations; keepWorktree?: boolean } = {},
) {
  const backend = new CycleBackend(outputs);
  const state = await ready({
    backend,
    ...(options.gitOperations ? { gitOperations: options.gitOperations } : {}),
  });
  const root = fixtureRepository();
  const { repository, worktree } = await registerAndWorktree(state, root);
  if (!options.keepWorktree) {
    const removed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/remove`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(removed.statusCode, removed.body).toBe(200);
  }
  const second = asWorkItemId('item-2');
  state.context.storage.planning.workItems.insertMany([
    {
      id: second,
      workspaceId: state.workspaceId,
      projectId: asProjectId('project-1'),
      planVersionId: asPlanVersionId('version-1'),
      sourceId: 'AQ-02',
      ordinal: 1,
      title: 'Continue the queue',
      risk: 'low',
      primaryAreas: [],
      exitGate: 'Done',
      sourceFields: { id: 'AQ-02' },
    },
  ]);
  state.context.storage.planning.dependencies.insertMany([
    {
      id: asWorkItemDependencyId('queue-edge'),
      workspaceId: state.workspaceId,
      planVersionId: asPlanVersionId('version-1'),
      predecessorWorkItemId: state.workItemId,
      successorWorkItemId: second,
      kind: 'required',
      ordinal: 0,
    },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model') {
      writeFileSync(join(request.cwd, `change-${backend.launches.length}.txt`), 'implemented');
      git(['add', '.'], request.cwd);
      git(['commit', '-m', 'implementation'], request.cwd);
    }
  };
  return { state, root, repository, worktree, backend, second };
}
const roadmapId = '00000000-0000-4000-8000-000000000010';
const entryIds = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
function roadmapInput(state: Ready, ids = [state.workItemId, asWorkItemId('item-2')]) {
  return {
    expectedVersion: 0,
    name: 'Queue roadmap',
    entries: ids.map((workItemId, index) => ({
      id: entryIds[index] as string,
      workItemId,
      profiles: cycleProfiles,
      policy: DEFAULT_COMPLETION_POLICY,
      instructions: '',
    })),
  };
}
async function saveRoadmapRequest(
  state: Ready,
  input: unknown = roadmapInput(state),
  id = roadmapId,
) {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${id}`,
    headers: mutationHeaders(state),
    payload: input as Record<string, unknown>,
  });
}
function storedRoadmap(state: Ready) {
  const roadmap = state.context.storage.roadmaps.find(state.workspaceId, roadmapId);
  if (!roadmap) throw new Error('Missing roadmap');
  return roadmap;
}
async function roadmapControl(state: Ready, action: 'start' | 'pause' | 'resume' | 'stop') {
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: { action, expectedVersion: storedRoadmap(state).version },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}
async function awaitRoadmapMerge(state: Ready, index: number) {
  await waitFor(
    () => {
      const attempt = storedRoadmap(state).attempts[index];
      return (
        !!attempt &&
        state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)?.status ===
          'awaiting-merge'
      );
    },
    `roadmap merge ${index}`,
    6000,
  );
  const attempt = storedRoadmap(state).attempts[index];
  if (!attempt) throw new Error('Missing attempt');
  return attempt;
}
async function mergeRoadmapAttempt(state: Ready, worktreeId: WorktreeId) {
  const merged = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/worktrees/${worktreeId}/merge`,
    headers: mutationHeaders(state),
    payload: {},
  });
  expect(merged.statusCode, merged.body).toBe(200);
}

describe('sequential roadmaps', () => {
  it('saves without execution, delegates each item, and advances only after operator merges', async () => {
    const { state, backend, root, second } = await roadmapFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const saved = await saveRoadmapRequest(state);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(backend.launches).toHaveLength(0);
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('proposed');
    expect(storedRoadmap(state).definition.entries[0]?.planVersionId).toBe('version-1');
    await roadmapControl(state, 'start');
    const first = await awaitRoadmapMerge(state, 0);
    expect(backend.launches).toHaveLength(3);
    expect(storedRoadmap(state).attempts).toHaveLength(1);
    expect(state.context.storage.planning.workItems.find(state.workspaceId, second)?.status).toBe(
      'proposed',
    );
    const firstTree = state.context.storage.execution.worktrees.find(
      state.workspaceId,
      first.worktreeId,
    );
    expect(firstTree?.mergedAt).toBeUndefined();
    await Promise.all([
      state.context.services.roadmapService.tick(),
      state.context.services.roadmapService.tick(),
    ]);
    expect(backend.launches).toHaveLength(3);
    await mergeRoadmapAttempt(state, first.worktreeId);
    const secondAttempt = await awaitRoadmapMerge(state, 1);
    const secondTree = state.context.storage.execution.worktrees.find(
      state.workspaceId,
      secondAttempt.worktreeId,
    );
    expect(secondTree?.baseSha).toBe(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.mergeSha,
    );
    expect(secondTree?.integrationBranch).toBe('main');
    expect(first.id).not.toBe(first.entryId);
    expect(first.cycleId).not.toBe(first.id);
    expect(backend.launches.map((r) => r.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'design-model',
      'implement-model',
      'review-model',
    ]);
    await mergeRoadmapAttempt(state, secondAttempt.worktreeId);
    await waitFor(() => storedRoadmap(state).status === 'completed', 'roadmap completion');
    expect(storedRoadmap(state).attempts.every((a) => a.status === 'completed')).toBe(true);
    expect(git(['log', '--oneline'], root)).toContain('implementation');
    const events = state.context.storage.workspaceEvents.listAfter({
      workspaceId: state.workspaceId,
      after: 0,
      limit: 500,
    });
    expect(
      events.some((e) => e.kind === 'roadmap-changed' && e.payload.status === 'completed'),
    ).toBe(true);
  });

  it('keeps manual worktrees and external prerequisites as blockers, and rejects reversed dependencies', async () => {
    const { state, backend, worktree, second } = await roadmapFixture(undefined, {
      keepWorktree: true,
    });
    const backwards = await saveRoadmapRequest(
      state,
      roadmapInput(state, [second, state.workItemId]),
    );
    expect(backwards.statusCode).toBe(409);
    expect(backwards.body).toContain('must appear before');
    expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    await waitFor(
      () => storedRoadmap(state).reason.includes('unmerged worktree'),
      'repository blocker',
    );
    expect(backend.launches).toHaveLength(0);
    expect(storedRoadmap(state).attempts).toHaveLength(0);
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');
    await roadmapControl(state, 'pause');
    const input = roadmapInput(state, [second]);
    expect(
      (await saveRoadmapRequest(state, { ...input, expectedVersion: storedRoadmap(state).version }))
        .statusCode,
    ).toBe(200);
    await roadmapControl(state, 'resume');
    await waitFor(
      () => storedRoadmap(state).reason.includes('outside this roadmap'),
      'external blocker',
    );
    expect(backend.launches).toHaveLength(0);
  });

  it('preserves revision history, freezes started settings, and applies queued model changes after resume', async () => {
    const { state, backend } = await roadmapFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      designDone,
    ]);
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    const first = await awaitRoadmapMerge(state, 0);
    await roadmapControl(state, 'pause');
    let input = roadmapInput(state);
    input.expectedVersion = storedRoadmap(state).version;
    const changed = {
      ...input,
      entries: input.entries.map((e, index) =>
        index === 0 ? { ...e, instructions: 'Alter started scope' } : e,
      ),
    };
    expect((await saveRoadmapRequest(state, changed)).statusCode).toBe(409);
    input = {
      ...input,
      entries: input.entries.map((e, index) =>
        index === 1
          ? {
              ...e,
              profiles: {
                ...e.profiles,
                design: { ...e.profiles.design, model: 'queued-new-model' },
              },
            }
          : e,
      ),
    };
    const saved = await saveRoadmapRequest(state, input);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(storedRoadmap(state).definition.revision).toBe(2);
    expect(storedRoadmap(state).attempts[0]?.definitionRevision).toBe(1);
    expect(
      state.context.storage.roadmaps.history(state.workspaceId, roadmapId).map((d) => d.revision),
    ).toEqual([2, 1]);
    expect(
      state.context.storage.roadmaps.history(state.workspaceId, roadmapId)[1]?.entries[1]?.profiles
        .design.model,
    ).toBe('design-model');
    await mergeRoadmapAttempt(state, first.worktreeId);
    await state.context.services.roadmapService.tick();
    expect(backend.launches).toHaveLength(3);
    await roadmapControl(state, 'resume');
    await waitFor(() => backend.launches.length >= 4, 'queued settings');
    expect(backend.launches[3]?.model).toBe('queued-new-model');
    expect(storedRoadmap(state).attempts[1]?.definitionRevision).toBe(2);
  });

  it('requires explicit roadmap resume after recovery and never restarts a merged item', async () => {
    const { state, backend } = await roadmapFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      designDone,
    ]);
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    const first = await awaitRoadmapMerge(state, 0);
    state.context.services.roadmapService.recoverInterrupted();
    expect(storedRoadmap(state).status).toBe('needs-attention');
    await mergeRoadmapAttempt(state, first.worktreeId);
    await state.context.services.roadmapService.tick();
    expect(backend.launches).toHaveLength(3);
    await roadmapControl(state, 'resume');
    await waitFor(() => backend.launches.length >= 4, 'resume recovered roadmap');
    expect(storedRoadmap(state).attempts).toHaveLength(2);
    expect(storedRoadmap(state).attempts[0]?.status).toBe('completed');
  });

  it('stops for design questions and manual takeover without starting later entries', async () => {
    const { state, backend } = await roadmapFixture([
      { resultText: '## Open questions\nChoose an approach.' },
    ]);
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'design question');
    expect(backend.launches).toHaveLength(1);
    await roadmapControl(state, 'stop');
    expect(storedRoadmap(state).status).toBe('stopped');
    expect(state.context.storage.execution.worktrees.listActive(state.workspaceId)).toHaveLength(1);
    expect(state.context.storage.execution.cycles.list(state.workspaceId)[0]?.status).toBe(
      'stopped',
    );
  });

  it('does not accept manual completion as a substitute for merging its current worktree', async () => {
    const { state, backend } = await roadmapFixture();
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    await awaitRoadmapMerge(state, 0);
    const completed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/complete`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(completed.statusCode, completed.body).toBe(200);
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).attempts).toHaveLength(1);
    expect(backend.launches).toHaveLength(3);
    expect(storedRoadmap(state).status).not.toBe('completed');
  });

  it('enforces CSRF, workspace isolation, versions, unique items, and a single delegated queue', async () => {
    const { state } = await roadmapFixture(undefined, { keepWorktree: true });
    const input = roadmapInput(state);
    expect(
      (await saveRoadmapRequest(state, { ...input, entries: [input.entries[0], input.entries[0]] }))
        .statusCode,
    ).toBe(400);
    await saveRoadmapRequest(state);
    expect((await saveRoadmapRequest(state)).statusCode).toBe(409);
    const csrf = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
      headers: { cookie: state.cookie, origin: state.context.config.publicOrigin },
      payload: { action: 'start', expectedVersion: 1 },
    });
    expect(csrf.statusCode).toBe(403);
    const foreign = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/foreign/roadmaps/${roadmapId}/history`,
      headers: { cookie: state.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    const unauthenticated = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/roadmaps`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const other = '00000000-0000-4000-8000-000000000099';
    expect((await saveRoadmapRequest(state, input, other)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    const duplicate = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${other}/control`,
      headers: mutationHeaders(state),
      payload: { action: 'start', expectedVersion: 1 },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('records a late worktree but never launches its cycle after stop during Git creation', async () => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let delay = false;
    let entered = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { state, backend } = await roadmapFixture(undefined, {
      gitOperations: {
        ...real,
        async createWorktree(input) {
          if (delay) {
            entered = true;
            await gate;
          }
          return real.createWorktree(input);
        },
      },
    });
    delay = true;
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    await waitFor(() => entered, 'worktree creation');
    await roadmapControl(state, 'stop');
    release();
    await waitFor(
      () => state.context.storage.execution.worktrees.listActive(state.workspaceId).length === 1,
      'late worktree',
    );
    expect(storedRoadmap(state).status).toBe('stopped');
    expect(backend.launches).toHaveLength(0);
    expect(state.context.storage.execution.cycles.list(state.workspaceId)).toHaveLength(0);
  });
});

it('resumes a paused preparation without duplicating its worktree or losing a newer command', async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let delay = false;
  let entered = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, backend } = await roadmapFixture(undefined, {
    gitOperations: {
      ...real,
      async createWorktree(input) {
        if (delay) {
          entered = true;
          await gate;
        }
        return real.createWorktree(input);
      },
    },
  });
  try {
    delay = true;
    await saveRoadmapRequest(state);
    await roadmapControl(state, 'start');
    await waitFor(() => entered, 'pending Git');
    const reserved = storedRoadmap(state).attempts[0]?.worktreeId;
    await roadmapControl(state, 'pause');
    await roadmapControl(state, 'resume');
    release();
    const attempt = await awaitRoadmapMerge(state, 0);
    expect(attempt.worktreeId).toBe(reserved);
    expect(state.context.storage.execution.worktrees.listActive(state.workspaceId)).toHaveLength(1);
    expect(backend.launches).toHaveLength(3);
    expect(storedRoadmap(state).status).toBe('running');
  } finally {
    release();
  }
});

it('pauses before creating a worktree when a queued branch binding changes, and adopts it only on save', async () => {
  const { state, root, repository } = await roadmapFixture();
  await saveRoadmapRequest(state);
  git(['branch', 'new-target'], root);
  const changed = await branchCommand(state, 'plan-versions/version-1/branch-settings', {
    repositoryId: repository.id,
    integrationBranch: 'new-target',
    expectedVersion: 1,
  });
  expect(changed.statusCode, changed.body).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'changed target');
  expect(storedRoadmap(state).attempts).toHaveLength(0);
  expect(storedRoadmap(state).reason).toContain('branch settings changed');
  expect(
    (
      await saveRoadmapRequest(state, {
        ...roadmapInput(state),
        expectedVersion: storedRoadmap(state).version,
      })
    ).statusCode,
  ).toBe(200);
  await roadmapControl(state, 'resume');
  const attempt = await awaitRoadmapMerge(state, 0);
  expect(
    state.context.storage.execution.worktrees.find(state.workspaceId, attempt.worktreeId)
      ?.integrationBranch,
  ).toBe('new-target');
});

it('rechecks delegated membership and denies viewer control while preserving read access', async () => {
  const { state, backend } = await roadmapFixture(undefined, { keepWorktree: true });
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  const db = openDatabase(state.context.storage.databasePath);
  try {
    db.prepare(
      "UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
    ).run(state.workspaceId, state.userId);
  } finally {
    db.close();
  }
  await waitFor(
    () => storedRoadmap(state).status === 'needs-attention',
    'revoked roadmap authority',
  );
  expect(storedRoadmap(state).reason).toContain('no longer has permission');
  expect(backend.launches).toHaveLength(0);
  const read = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/roadmaps`,
    headers: { cookie: state.cookie },
  });
  expect(read.statusCode, read.body).toBe(200);
  const control = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'resume', expectedVersion: storedRoadmap(state).version },
  });
  expect(control.statusCode).toBe(403);
});
