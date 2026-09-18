import { operatorDecisions } from './services/operator-decisions.js';
import { PLAN_REQUIREMENTS, PLAN_CRITERIA } from './services/plan-acceptance-policy.js';
import { acceptedEvidence } from './services/runtime-evidence-policy.js';
import { randomUUID } from 'node:crypto';
import {
  resolveScope,
  scopeRequirements,
  scopeCases,
  scopeEvidenceLedger,
} from './services/execution-scope.js';
import type { ExecutionScope } from '@craftingtable/domain';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentBackend,
  AgentLaunchRequest,
  AgentSession,
  AgentSessionItem,
} from '@craftingtable/agents';
import {
  evidenceSubmissionRequestSchema,
  agentRunCommandResponseSchema,
  agentRunDetailResponseSchema,
  createWorktreeResponseSchema,
  executionStatusResponseSchema,
  finalizationsResponseSchema,
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
  type AgentExitReason,
  type AgentRunId,
  asAgentRunId,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  asWorktreeId,
  CYCLE_STEPS,
  type CycleProfiles,
  DEFAULT_COMPLETION_POLICY,
  evaluateCycleCompletion,
  FINALIZATION_STAGE_KINDS,
  type UserId,
  type WorkCycle,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import { openCraftingTableStorage, openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER_NAME } from './config.js';
import { mergeGateFor } from './services/execution-service.js';
import { assessStageReport, stagedPromotionIssue } from './services/finalization-stage-policy.js';
import { recordedFindings, requiredFindingIds } from './services/run-handoff.js';
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
  readonly backgroundWorkPending?: boolean;
  readonly exitReason?: AgentExitReason;
  readonly messages?: readonly string[];
  readonly resultText: string;
  readonly truncated?: boolean;
}

class ScriptedSession implements AgentSession {
  readonly pid = 4242;
  backgroundWorkPending = false;
  endCount = 0;
  readonly sent: string[] = [];
  private readonly queue: AgentSessionItem[] = [];
  private waiter: ((item: IteratorResult<AgentSessionItem>) => void) | undefined;
  private closed = false;
  private turns = 0;
  private delayed = false;
  private exitReason: AgentExitReason | undefined;

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
    this.exitReason = reply?.exitReason;
    this.backgroundWorkPending = reply?.backgroundWorkPending ?? false;
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

  completeBackground(resultText: string): void {
    this.replies.unshift({ resultText });
    this.respondNow('Background completed');
  }

  end(): void {
    this.endCount++;
    this.exit(0, null);
  }

  kill(): void {
    this.exit(null, 'SIGTERM');
  }

  private exit(exitCode: number | null, signal: string | null): void {
    if (this.closed) return;
    this.push({
      type: 'exited',
      exitCode,
      signal,
      ...(this.exitReason ? { reason: this.exitReason } : {}),
    });
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

    // An acknowledged merge retry reconciles the same durable result without another commit.
    const previousHead = git(['rev-parse', 'HEAD'], repositoryPath);
    expect((await merge(state, worktree.id)).statusCode).toBe(200);
    expect(git(['rev-parse', 'HEAD'], repositoryPath)).toBe(previousHead);
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
        { ...structuredFinding, status: 'resolved', disposition: 'Later verification closes it.' },
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

/* Automated cycle exercises the same real Git/worktree and journal path as manual execution. */
class CycleBackend extends ScriptedBackend {
  onLaunch: ((request: AgentLaunchRequest) => void) | undefined;
  replyForRequest: ((request: AgentLaunchRequest) => ScriptedReply) | undefined;
  constructor(
    private readonly outputs: readonly ScriptedReply[],
    kind: AgentBackendKind = 'claude-code',
  ) {
    super(kind);
  }
  override launch(request: AgentLaunchRequest): Promise<AgentSession> {
    this.onLaunch?.(request);
    this.repliesForNextRun = [
      this.replyForRequest?.(request) ??
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
async function cycleFixture(
  outputs: readonly ScriptedReply[],
  now?: () => Date,
  gitOperations?: GitOperations,
) {
  const backend = new CycleBackend(outputs);
  const state = await ready({
    backend,
    ...(now === undefined ? {} : { now }),
    ...(gitOperations ? { gitOperations } : {}),
  });
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

  it('prepares historical sources without launching an agent, then carries collection tools into bounded recovery', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nCollect the historical baseline.' },
      designDone,
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    const base = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}`;
    const preview = await state.context.app.inject({
      method: 'GET',
      url: `${base}/baseline-preparation`,
      headers: { cookie: state.cookie },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const value = preview.json();
    expect(value.sources[0].ref).toBe(worktree.baseSha);
    const payload = {
      expectedVersion: value.expectedVersion,
      contextDigest: value.contextDigest,
      sources: value.sources.map((source: { alias: string; ref: string }) => ({
        alias: source.alias,
        ref: source.ref,
      })),
    };
    const noCsrf = await state.context.app.inject({
      method: 'POST',
      url: `${base}/baseline-preparation`,
      headers: { cookie: state.cookie },
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
    const prepared = await state.context.app.inject({
      method: 'POST',
      url: `${base}/baseline-preparation`,
      headers: mutationHeaders(state),
      payload,
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const saved = workCycleResponseSchema.parse(prepared.json()).cycle;
    expect(saved.baselinePreparation?.status).toBe('prepared');
    expect(saved.status).toBe('needs-attention');
    expect(backend.launches).toHaveLength(1);
    const source = present(saved.baselinePreparation?.sources[0]);
    expect(
      existsSync(
        join(present(saved.baselinePreparation).directory, source.directoryName, 'README.md'),
      ),
    ).toBe(true);
    const stale = await state.context.app.inject({
      method: 'POST',
      url: `${base}/baseline-preparation`,
      headers: mutationHeaders(state),
      payload,
    });
    expect(stale.statusCode).toBe(409);
    const discovery = await state.context.app.inject({
      method: 'GET',
      url: `${base}/design-recovery`,
      headers: { cookie: state.cookie },
    });
    const recovery = discovery.json();
    const response = await state.context.app.inject({
      method: 'POST',
      url: `${base}/design-recovery`,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: saved.version,
        snapshotDigest: recovery.snapshotDigest,
        mode: 'investigate',
        profile: { backend: 'claude-code' },
        instructions: 'Collect results; I retain all architectural decisions.',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(
      () =>
        backend.launches.length === 2 && currentCycle(state, cycle).status === 'needs-attention',
      'bounded collection ends',
    );
    const launch = present(backend.launches[1]);
    expect(launch.prompt).toContain('historical-cargo');
    expect(launch.prompt).toContain('Genuine architectural/implementation decisions remain');
    expect(launch.cwd).toBe(worktree.path);
    const directory = present(launch.additionalDirectories?.[0]);
    const logs = join(directory, 'historical-evidence');
    writeFileSync(
      join(logs, 'commands.jsonl'),
      '{"success":false,"currentRuntimeVerification":false}\n',
    );
    writeFileSync(join(logs, '123-456.log'), 'Recorded historical dependency failure');
    const evidence = await state.context.app.inject({
      method: 'GET',
      url: `${base}/baseline-evidence`,
      headers: { cookie: state.cookie },
    });
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(
      evidence
        .json()
        .artifacts.some((a: { content: string }) =>
          a.content.includes('Recorded historical dependency failure'),
        ),
    ).toBe(true);
    expect(currentCycle(state, cycle).status).toBe('needs-attention');
    expect(currentCycle(state, cycle).remediationRounds).toBe(0);
    const beforeRestart = currentCycle(state, cycle);
    state.context.storage.execution.cycles.replace(
      {
        ...beforeRestart,
        version: beforeRestart.version + 1,
        baselinePreparation: { ...present(beforeRestart.baselinePreparation), status: 'preparing' },
      },
      beforeRestart.version,
    );
    state.context.services.workCycleService.recoverInterrupted();
    expect(currentCycle(state, cycle).baselinePreparation?.status).toBe('failed');
    expect(currentCycle(state, cycle).baselinePreparation?.message).toContain(
      'interrupted by restart',
    );
    expect(backend.launches).toHaveLength(2);
  });

  it('recovers design with guidance and attachments in the same worktree and keeps review authority separate', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhich storage format?' },
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const preview = await state.context.app.inject({
      method: 'GET',
      url,
      headers: { cookie: state.cookie },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const snapshot = preview.json();
    expect(snapshot.questions).toContain('Which storage format?');
    expect(backend.launches).toHaveLength(1);
    const payload = {
      expectedVersion: snapshot.expectedVersion,
      snapshotDigest: snapshot.snapshotDigest,
      mode: 'continue',
      profile: { backend: 'claude-code', model: 'recovery-model' },
      instructions: 'Use SQLite; I own the storage decision.',
      attachments: [{ name: '../../decision.md', content: 'Operator supplied storage decision.' }],
    };
    const missingCsrf = await state.context.app.inject({
      method: 'POST',
      url,
      headers: { cookie: state.cookie },
      payload,
    });
    expect(missingCsrf.statusCode).toBe(403);
    const stale = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: { ...payload, snapshotDigest: '0'.repeat(64) },
    });
    expect(stale.statusCode).toBe(409);
    const invalid = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: { ...payload, profile: { ...payload.profile, permissionMode: 'bypass' } },
    });
    expect(invalid.statusCode).toBe(400);
    const launched = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload,
    });
    expect(launched.statusCode, launched.body).toBe(200);
    const reserved = workCycleResponseSchema.parse(launched.json()).cycle;
    expect(reserved.worktreeId).toBe(worktree.id);
    expect(reserved.designRecovery?.sourceRunId).toBe(snapshot.sourceRunId);
    expect(reserved.remediationRounds).toBe(0);
    const duplicate = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'recovered design');
    expect(backend.launches).toHaveLength(4);
    const request = present(backend.launches[1]);
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, reserved.currentRunId)?.role,
    ).toBe('design');
    expect(request.model).toBe('recovery-model');
    expect(request.prompt).toContain('Use SQLite');
    expect(request.prompt).toContain('Which storage format?');
    expect(backend.launches[2]?.model).toBe('implement-model');
    const path = join(
      present(request.temporaryDirectory),
      '..',
      'design-recovery',
      'operator-1.txt',
    );
    expect(readFileSync(path, 'utf8')).toContain('Operator supplied storage decision.');
    const implementation = present(backend.launches[2]);
    expect(
      readFileSync(
        join(present(implementation.temporaryDirectory), '..', 'design-recovery', 'operator-1.txt'),
        'utf8',
      ),
    ).toContain('Operator supplied storage decision.');
    expect(implementation.prompt).toContain('design-recovery/manifest.json');
    expect(currentCycle(state, cycle).status).toBe('awaiting-merge');
  });

  it('stops a design investigation even with no questions and continues only on a new explicit request', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nCollect baseline measurements.' },
      designDone,
      { resultText: '## Open questions\nWho approves the remaining decision?' },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const response = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'investigate',
        profile: { backend: 'claude-code' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'investigation completed',
    );
    expect(currentCycle(state, cycle).reason).toContain('investigation finished');
    expect(backend.launches).toHaveLength(2);
    await controlCycle(state, currentCycle(state, cycle), 'resume');
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'investigation cannot bypass review',
    );
    expect(backend.launches).toHaveLength(2);
    const next = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const continued = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: next.expectedVersion,
        snapshotDigest: next.snapshotDigest,
        mode: 'continue',
        profile: { backend: 'claude-code' },
        instructions: 'Use the collected measurements.',
      },
    });
    expect(continued.statusCode, continued.body).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'genuine question retained',
    );
    expect(backend.launches).toHaveLength(3);
    expect(currentCycle(state, cycle).step).toBe('design');
  });

  it('can adopt a manual design after an investigation without retaining the investigation stop', async () => {
    const { state, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhich owner?' },
      designDone,
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const response = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'investigate',
        profile: { backend: 'claude-code' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'investigation pause',
    );
    await runToFinish(state, worktree.id, {
      role: 'design',
      parentRunId: currentCycle(state, cycle).currentRunId,
    });
    await controlCycle(state, currentCycle(state, cycle), 'resume');
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'manual design adopted',
    );
  });

  it('preserves an unlaunched design recovery across restart without replaying it', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: '## Open questions\nWhich owner?' },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design pause');
    await state.context.services.workCycleService.shutdown();
    const url = `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/design-recovery`;
    const snapshot = (
      await state.context.app.inject({ method: 'GET', url, headers: { cookie: state.cookie } })
    ).json();
    const result = await state.context.app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: snapshot.expectedVersion,
        snapshotDigest: snapshot.snapshotDigest,
        mode: 'continue',
        profile: { backend: 'claude-code' },
        instructions: 'I own the decision.',
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    state.context.services.workCycleService.recoverInterrupted();
    const recovered = currentCycle(state, cycle);
    expect(recovered.status).toBe('needs-attention');
    expect(recovered.designRecovery?.instructions).toBe('I own the decision.');
    expect(backend.launches).toHaveLength(1);
    const fresh = await state.context.app.inject({
      method: 'GET',
      url,
      headers: { cookie: state.cookie },
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json().sourceRunId).toBe(snapshot.sourceRunId);
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

  it('extends an exhausted work-item cycle explicitly without resetting history or accepting duplicate grants', async () => {
    const review = { resultText: reviewText([structuredFinding]) };
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      review,
      implementationDone,
      review,
      implementationDone,
      {
        resultText: reviewText([
          { ...structuredFinding, status: 'resolved', disposition: 'Verified regression fix.' },
        ]),
      },
    ]);
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 1 },
      instructions: 'Keep the approved API.',
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'exhausted cycle');
    const paused = currentCycle(state, cycle);
    const payload = {
      action: 'authorize-remediation',
      expectedVersion: paused.version,
      additionalRounds: 1,
      instructions: 'Concentrate on the remaining regression.',
    };
    const authorize = (body: typeof payload) =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload: body,
      });
    const results = await Promise.all([authorize(payload), authorize(payload)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const granted = workCycleResponseSchema.parse(
      present(results.find((r) => r.statusCode === 200)).json(),
    ).cycle;
    expect(granted).toMatchObject({
      remediationRounds: 2,
      additionalRemediationRounds: 1,
      policy: { maxRemediationRounds: 1 },
      parentRunId: paused.currentRunId,
      worktreeId: worktree.id,
    });
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'review after recovery',
    );
    expect(backend.launches).toHaveLength(7);
    expect(backend.launches[5]?.prompt).toContain('Keep the approved API.');
    expect(backend.launches[5]?.prompt).toContain('Concentrate on the remaining regression.');
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(state.workspaceId, cycle.id)).toMatchObject({
        remediationRounds: 2,
        additionalRemediationRounds: 1,
        policy: { maxRemediationRounds: 1 },
      });
    } finally {
      reopened.close();
    }
    expect((await authorize(payload)).statusCode).toBe(409);
    const audits = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 1000 })
      .filter((e) => e.metadata?.action === 'authorize-remediation');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: 'user',
      actorUserId: state.userId,
      metadata: {
        initialRemediationAllowance: 1,
        additionalRemediationRounds: 1,
        remediationAllowance: 2,
      },
    });
  });

  it.each(['questions', 'invalid', 'truncated', 'branch'] as const)(
    'does not grant a work-item allowance across a %s checkpoint',
    async (checkpoint) => {
      const review =
        checkpoint === 'invalid'
          ? 'Review missing report.'
          : `${checkpoint === 'questions' ? '## Open questions\nWhich API should be changed?\n\n## Review report\n' : ''}${reviewText([structuredFinding])}`;
      const { state, backend, worktree } = await cycleFixture([
        designDone,
        implementationDone,
        { resultText: review, truncated: checkpoint === 'truncated' },
      ]);
      const cycle = await startCycle(state, worktree.id, {
        policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
      });
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'review checkpoint',
      );
      if (checkpoint === 'branch') git(['checkout', '-b', 'unexpected'], worktree.path);
      const before = currentCycle(state, cycle);
      const response = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
        headers: mutationHeaders(state),
        payload: {
          action: 'authorize-remediation',
          expectedVersion: before.version,
          additionalRounds: 1,
        },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(currentCycle(state, cycle)).toEqual(before);
      expect(backend.launches).toHaveLength(3);
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
  options: {
    gitOperations?: GitOperations;
    keepWorktree?: boolean;
    alternateBackend?: AgentBackend;
  } = {},
) {
  const backend = new CycleBackend(outputs);
  const state = await ready({
    backend,
    ...(options.alternateBackend
      ? {
          backends: new Map([
            [backend.kind, backend],
            [options.alternateBackend.kind, options.alternateBackend],
          ]),
        }
      : {}),
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

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected fixture record');
  return value;
}
const parallelScheduling = {
  mode: 'parallel' as const,
  maxInFlight: 2,
  maxPerRepository: 2,
  maxIntegrationRefreshes: 3,
};
async function parallelFixture(
  options: { gitOperations?: GitOperations; keepWorktree?: boolean } = {},
) {
  const fixture = await roadmapFixture(undefined, options);
  const { state, backend } = fixture;
  const third = asWorkItemId('item-3');
  state.context.storage.planning.workItems.insertMany([
    {
      id: third,
      workspaceId: state.workspaceId,
      projectId: asProjectId('project-1'),
      planVersionId: asPlanVersionId('version-1'),
      sourceId: 'AQ-03',
      ordinal: 2,
      title: 'Independent sibling',
      risk: 'low',
      primaryAreas: [],
      exitGate: 'Done',
      sourceFields: { id: 'AQ-03' },
    },
  ]);
  state.context.storage.planning.dependencies.insertMany([
    {
      id: asWorkItemDependencyId('fork-edge'),
      workspaceId: state.workspaceId,
      planVersionId: asPlanVersionId('version-1'),
      predecessorWorkItemId: state.workItemId,
      successorWorkItemId: third,
      kind: 'required',
      ordinal: 1,
    },
  ]);
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  const input = {
    ...roadmapInput(state, [state.workItemId, fixture.second, third]),
    scheduling: parallelScheduling,
  };
  present(input.entries[2]).id = '00000000-0000-4000-8000-000000000013';
  return { ...fixture, third, input };
}
async function itemRoadmapControl(state: Ready, entryId: string, action: 'pause' | 'resume') {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: { action, entryId, expectedVersion: storedRoadmap(state).version },
  });
}
describe('parallel roadmaps', () => {
  it('forks only after the predecessor merge, refreshes a sibling, and requires three operator merges', {
    timeout: 15000,
  }, async () => {
    const { state, backend, input, root } = await parallelFixture();
    const saved = await saveRoadmapRequest(state, input);
    expect(saved.statusCode, saved.body).toBe(200);
    await roadmapControl(state, 'start');
    const parent = await awaitRoadmapMerge(state, 0);
    expect(storedRoadmap(state).attempts).toHaveLength(1);
    expect(backend.launches).toHaveLength(3);
    await mergeRoadmapAttempt(state, parent.worktreeId);
    const left = await awaitRoadmapMerge(state, 1);
    const right = await awaitRoadmapMerge(state, 2);
    const leftTree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, left.worktreeId),
    );
    const rightTree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, right.worktreeId),
    );
    expect(leftTree.baseSha).toBe(rightTree.baseSha);
    expect(leftTree.branchName).not.toBe(rightTree.branchName);
    expect(backend.launches).toHaveLength(9);
    const priorReview = present(
      state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId),
    ).currentRunId;
    await mergeRoadmapAttempt(state, left.worktreeId);
    await waitFor(
      () => {
        const cycle = state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId);
        if (cycle?.status === 'needs-attention') throw new Error(cycle.reason);
        return cycle?.status === 'awaiting-merge' && cycle.currentRunId !== priorReview;
      },
      'fresh sibling review',
      6000,
    );
    const cycle = present(
      state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId),
    );
    expect(cycle.integrationRefreshes).toBe(1);
    const review = present(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    );
    expect(review.parentRunId).toBe(priorReview);
    expect(review.reviewBranchContext?.targetSha).toBe(git(['rev-parse', 'main'], root).trim());
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, right.worktreeId)?.mergedAt,
    ).toBeUndefined();
    await mergeRoadmapAttempt(state, right.worktreeId);
    await waitFor(() => storedRoadmap(state).status === 'completed', 'parallel completion');
    expect(backend.launches).toHaveLength(10);
  });

  it('treats list order as priority and retains awaiting-merge capacity', {
    timeout: 15000,
  }, async () => {
    const { state, input } = await parallelFixture();
    input.entries = [
      present(input.entries[1]),
      present(input.entries[0]),
      present(input.entries[2]),
    ];
    input.scheduling = { ...parallelScheduling, maxInFlight: 1 };
    expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    const parent = await awaitRoadmapMerge(state, 0);
    expect(parent.entryId).toBe(entryIds[0]);
    await mergeRoadmapAttempt(state, parent.worktreeId);
    await awaitRoadmapMerge(state, 1);
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).attempts).toHaveLength(2);
    const response = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/roadmaps`,
      headers: { cookie: state.cookie },
    });
    expect(response.body).toContain('capacity-blocked');
  });

  it('holds exclusion groups until merge, then creates the sibling from the updated baseline', {
    timeout: 15000,
  }, async () => {
    const { state, input } = await parallelFixture();
    const entries = input.entries.map((e, i) => ({
      ...e,
      exclusionGroups: i ? ['queue-contract'] : [],
    }));
    expect((await saveRoadmapRequest(state, { ...input, entries })).statusCode).toBe(200);
    await roadmapControl(state, 'start');
    await mergeRoadmapAttempt(state, (await awaitRoadmapMerge(state, 0)).worktreeId);
    const left = await awaitRoadmapMerge(state, 1);
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).attempts).toHaveLength(2);
    await mergeRoadmapAttempt(state, left.worktreeId);
    const right = await awaitRoadmapMerge(state, 2);
    const rightTree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, right.worktreeId),
    );
    expect(rightTree.baseSha).toBe(
      state.context.storage.planning.workItems.find(state.workspaceId, asWorkItemId('item-2'))
        ?.mergeSha,
    );
  });

  it('isolates design questions, supports item pause, and resumes all other items after recovery', {
    timeout: 15000,
  }, async () => {
    const { state, backend, input } = await parallelFixture();
    backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? request.cwd.includes('aq-02')
          ? { resultText: '## Open questions\nWhich API?' }
          : designDone
        : request.model === 'review-model'
          ? { resultText: reviewText([]) }
          : implementationDone;
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    await mergeRoadmapAttempt(state, (await awaitRoadmapMerge(state, 0)).worktreeId);
    const right = await awaitRoadmapMerge(state, 2);
    const left = present(storedRoadmap(state).attempts[1]);
    expect(
      state.context.storage.execution.cycles.find(state.workspaceId, left.cycleId)?.status,
    ).toBe('needs-attention');
    expect(storedRoadmap(state).status).toBe('running');
    const paused = await itemRoadmapControl(state, left.entryId, 'pause');
    expect(paused.statusCode, paused.body).toBe(200);
    state.context.services.roadmapService.recoverInterrupted();
    await roadmapControl(state, 'resume');
    expect(storedRoadmap(state).entryHolds?.[left.entryId]?.status).toBe('paused');
    expect(
      state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId)?.status,
    ).toBe('awaiting-merge');
    await mergeRoadmapAttempt(state, right.worktreeId);
    await roadmapControl(state, 'stop');
    expect(
      state.context.storage.execution.cycles.find(state.workspaceId, left.cycleId)?.status,
    ).toBe('stopped');
  });

  it('counts manual worktrees against repository capacity without adopting them', {
    timeout: 15000,
  }, async () => {
    const { state, backend, input, worktree } = await parallelFixture({ keepWorktree: true });
    input.scheduling = { ...parallelScheduling, maxPerRepository: 1 };
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    await state.context.services.roadmapService.tick();
    expect(storedRoadmap(state).attempts).toHaveLength(0);
    expect(backend.launches).toHaveLength(0);
    expect(
      state.context.storage.execution.worktrees.find(state.workspaceId, worktree.id)?.status,
    ).toBe('active');
  });

  it('aborts an integration conflict and pauses only the affected sibling', {
    timeout: 15000,
  }, async () => {
    const { state, backend, input } = await parallelFixture();
    backend.onLaunch = (request) => {
      if (request.model !== 'implement-model') return;
      writeFileSync(join(request.cwd, 'shared.txt'), request.cwd);
      git(['add', '.'], request.cwd);
      git(['commit', '-m', 'change shared file'], request.cwd);
    };
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    await mergeRoadmapAttempt(state, (await awaitRoadmapMerge(state, 0)).worktreeId);
    const left = await awaitRoadmapMerge(state, 1);
    const right = await awaitRoadmapMerge(state, 2);
    await mergeRoadmapAttempt(state, left.worktreeId);
    await waitFor(
      () =>
        state.context.storage.execution.cycles.find(state.workspaceId, right.cycleId)?.status ===
        'needs-attention',
      'conflicted sibling',
      6000,
    );
    expect(storedRoadmap(state).status).toBe('running');
    const tree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, right.worktreeId),
    );
    expect(git(['status', '--porcelain'], tree.path)).toBe('');
    expect(() => git(['rev-parse', '--verify', 'MERGE_HEAD'], tree.path)).toThrow();
    const merge = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/worktrees/${tree.id}/merge`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(merge.statusCode).toBe(409);
  });

  it('bounds repeated integration changes without ever merging automatically', {
    timeout: 15000,
  }, async () => {
    const { state, input, root } = await parallelFixture();
    input.entries = input.entries.slice(0, 1);
    input.scheduling = { ...parallelScheduling, maxIntegrationRefreshes: 1 };
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    const attempt = await awaitRoadmapMerge(state, 0);
    for (const index of [1, 2]) {
      writeFileSync(join(root, `external-${index}.txt`), 'external integration change');
      git(['add', '.'], root);
      git(['commit', '-m', 'external change'], root);
      await waitFor(
        () => {
          const cycle = present(
            state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId),
          );
          if (index === 1 && cycle.status === 'needs-attention') throw new Error(cycle.reason);
          return index === 1
            ? cycle.integrationRefreshes === 1 && cycle.status === 'awaiting-merge'
            : cycle.status === 'needs-attention';
        },
        'bounded refresh',
        6000,
      );
    }
    const cycle = present(
      state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId),
    );
    expect(cycle.reason).toContain('refresh limit');
    expect(cycle.integrationRefreshes).toBe(1);
    expect(storedRoadmap(state).status).toBe('running');
  });
});

it('parallel refresh cannot launch a review after stop supersedes in-flight Git', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, input, root, backend } = await parallelFixture({
    gitOperations: {
      ...realGit,
      updateWorktree: async (request) => {
        entered?.();
        await barrier;
        return realGit.updateWorktree(request);
      },
    },
  });
  input.entries = input.entries.slice(0, 1);
  await saveRoadmapRequest(state, input);
  await roadmapControl(state, 'start');
  const attempt = await awaitRoadmapMerge(state, 0);
  const initialLaunches = backend.launches.length;
  writeFileSync(join(root, 'integration-update.txt'), 'update');
  git(['add', '.'], root);
  git(['commit', '-m', 'integration update'], root);
  try {
    await waiting;
    await roadmapControl(state, 'stop');
  } finally {
    release?.();
  }
  await waitFor(
    () =>
      state.context.storage.execution.worktrees.find(state.workspaceId, attempt.worktreeId)
        ?.version === 2,
    'invalidated review',
  );
  // Let the actual Git mutation settle; no follow-on run may appear after stop.
  await state.context.services.workCycleService.shutdown();
  expect(backend.launches).toHaveLength(initialLaunches);
  expect(
    state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)?.status,
  ).toBe('stopped');
  expect(storedRoadmap(state).status).toBe('stopped');
});

it('parallel paused approvals still complete on merge and item controls retain HTTP protections', {
  timeout: 15000,
}, async () => {
  const { state, input, backend } = await parallelFixture();
  await saveRoadmapRequest(state, input);
  await roadmapControl(state, 'start');
  const parent = await awaitRoadmapMerge(state, 0);
  expect((await itemRoadmapControl(state, parent.entryId, 'pause')).statusCode).toBe(200);
  await mergeRoadmapAttempt(state, parent.worktreeId);
  await awaitRoadmapMerge(state, 1);
  await awaitRoadmapMerge(state, 2);
  expect(storedRoadmap(state).entryHolds?.[parent.entryId]).toBeUndefined();
  await roadmapControl(state, 'pause');
  const before = backend.launches.length;
  await state.context.services.roadmapService.tick();
  expect(backend.launches).toHaveLength(before);
  const invalid = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: {
      action: 'merge',
      entryId: parent.entryId,
      expectedVersion: storedRoadmap(state).version,
    },
  });
  expect(invalid.statusCode).toBe(400);
  const unauthorized = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: { cookie: state.cookie, origin: state.context.config.publicOrigin },
    payload: {
      action: 'resume',
      entryId: input.entries[1]?.id,
      expectedVersion: storedRoadmap(state).version,
    },
  });
  expect(unauthorized.statusCode).toBe(403);
});

it('parallel scheduling cannot release successors from a manual completion of its unmerged attempt', {
  timeout: 15000,
}, async () => {
  const { state, input } = await parallelFixture();
  await saveRoadmapRequest(state, input);
  await roadmapControl(state, 'start');
  await awaitRoadmapMerge(state, 0);
  state.context.storage.planning.workItems.complete({
    workspaceId: state.workspaceId,
    workItemId: state.workItemId,
    completedAt: new Date().toISOString(),
    completedByUserId: state.userId,
    projectId: asProjectId('project-1'),
  });
  await state.context.services.roadmapService.tick();
  expect(storedRoadmap(state).attempts).toHaveLength(1);
  expect(storedRoadmap(state).entryHolds?.[present(input.entries[0]).id]?.status).toBe(
    'needs-attention',
  );
});

it('finalizes an implementer’s tracked edits and staged new source before the first review', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    expect(request.temporaryDirectory).toBeTruthy();
    expect(request.temporaryDirectory?.startsWith(worktree.path)).toBe(false);
    expect(request.prompt).toContain('Do not redirect temporary files to the worktree root');
    writeFileSync(join(request.temporaryDirectory ?? '', 'generated-test.wal'), 'temporary');
    if (request.model === 'implement-model') {
      writeFileSync(join(worktree.path, 'README.md'), 'implementation edit');
      writeFileSync(join(worktree.path, 'added.ts'), 'intended new source');
      git(['add', '--', 'added.ts'], worktree.path);
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'checkpoint then review',
    6000,
  );
  const settled = currentCycle(state, cycle);
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
  ]);
  expect(settled.checkpoint?.paths).toEqual(['README.md', 'added.ts']);
  expect(settled.checkpoint?.commitSha).toBe(settled.reviewHeadSha);
  expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  expect(git(['log', '-1', '--format=%s'], worktree.path)).toContain('CraftingTable: finalize run');
});

it('hands dirty negative review findings directly to remediation', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
    {
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Verified fix.' },
      ]),
    },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'review-model' && backend.launches.length === 2)
      writeFileSync(join(worktree.path, 'review-test.wal'), 'review-generated');
    if (request.model === 'remediate-model') {
      expect(request.prompt).toContain('F-001');
      expect(request.prompt).toContain('Never blindly commit untracked files');
      rmSync(join(worktree.path, 'review-test.wal'));
      writeFileSync(join(worktree.path, 'README.md'), 'remediated source');
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'dirty review remediation',
    6000,
  );
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
    'remediate-model',
    'review-model',
  ]);
  expect(currentCycle(state, cycle).remediationRounds).toBe(1);
  expect(git(['ls-files'], worktree.path)).not.toContain('.wal');
});

it('routes unclassified new files through bounded remediation without checkpointing them blindly', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      writeFileSync(join(worktree.path, 'unknown.wal'), 'test artifact');
    if (request.model === 'remediate-model') {
      expect(git(['ls-files'], worktree.path)).not.toContain('unknown.wal');
      rmSync(join(worktree.path, 'unknown.wal'));
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'classified files',
    6000,
  );
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'remediate-model',
    'review-model',
  ]);
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

it('resumes an older dirty negative review directly into remediation', {
  timeout: 15000,
}, async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let rejectOnce = true;
  const backend = new CycleBackend([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
    {
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Verified after remediation.' },
      ]),
    },
  ]);
  const state = await ready({
    backend,
    gitOperations: {
      ...real,
      inspectWorktreeChanges: async (path) => {
        const result = await real.inspectWorktreeChanges(path);
        if (
          rejectOnce &&
          backend.launches.at(-1)?.model === 'review-model' &&
          result.ok &&
          result.value.untracked.length
        ) {
          rejectOnce = false;
          return {
            ok: false,
            failure: { kind: 'git-failed', message: 'Simulated pre-fix dirty review stop' },
          };
        }
        return result;
      },
    },
  });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  await admit(state);
  backend.onLaunch = (request) => {
    if (request.model === 'review-model' && backend.launches.length === 2)
      writeFileSync(join(worktree.path, 'review.wal'), 'generated');
    if (request.model === 'remediate-model') {
      expect(request.prompt).toContain('F-001');
      expect(request.prompt).toContain('Remove only confirmed generated test artifacts');
      rmSync(join(worktree.path, 'review.wal'));
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'old review stop');
  expect(currentCycle(state, cycle).step).toBe('review');
  await controlCycle(state, currentCycle(state, cycle), 'resume');
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'resumed remediation',
    6000,
  );
  expect(backend.launches.map((request) => request.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
    'remediate-model',
    'review-model',
  ]);
});

it('a stop during an automatic checkpoint cannot launch a late review', async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = new CycleBackend([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const state = await ready({
    backend,
    gitOperations: {
      ...real,
      checkpointWorktree: async (input) => {
        const result = await real.checkpointWorktree(input);
        entered?.();
        await barrier;
        return result;
      },
    },
  });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  await admit(state);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      writeFileSync(join(worktree.path, 'README.md'), 'source change');
  };
  const cycle = await startCycle(state, worktree.id);
  try {
    await waiting;
    expect(currentCycle(state, cycle).checkpoint?.commitSha).toBeUndefined();
    expect(currentCycle(state, cycle).checkpoint?.paths).toEqual(['README.md']);
    await controlCycle(state, currentCycle(state, cycle), 'stop');
  } finally {
    release?.();
  }
  await state.context.services.workCycleService.shutdown();
  expect(currentCycle(state, cycle).status).toBe('stopped');
  expect(backend.launches.map((request) => request.model)).toEqual([
    'design-model',
    'implement-model',
  ]);
  expect(git(['log', '-1', '--format=%s'], worktree.path)).toContain('CraftingTable: finalize run');
});

it.each(['untracked artifact', 'index-only change'])(
  'requires cleanup and a fresh review after a positive review leaves an %s',
  { timeout: 15000 },
  async (kind) => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const original = readFileSync(join(worktree.path, 'README.md'), 'utf8');
    backend.onLaunch = (request) => {
      if (request.model === 'review-model' && backend.launches.length === 2) {
        if (kind === 'untracked artifact')
          writeFileSync(join(worktree.path, 'review.wal'), 'temporary');
        else {
          writeFileSync(join(worktree.path, 'README.md'), 'staged change');
          git(['add', 'README.md'], worktree.path);
          writeFileSync(join(worktree.path, 'README.md'), original);
        }
      }
      if (request.model === 'remediate-model') {
        expect(request.prompt).toContain('The prior approval is invalid');
        if (kind === 'untracked artifact') rmSync(join(worktree.path, 'review.wal'));
        else git(['add', 'README.md'], worktree.path);
      }
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'fresh clean review',
      6000,
    );
    expect(backend.launches.map((request) => request.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'remediate-model',
      'review-model',
    ]);
    expect(currentCycle(state, cycle).remediationRounds).toBe(1);
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  },
);

async function resolutionCommand(state: Ready, cycle: WorkCycle, input: Record<string, unknown>) {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/integration-resolution`,
    headers: mutationHeaders(state),
    payload: { expectedVersion: cycle.version, ...input },
  });
}
async function resolutionFixture(gitOperations?: GitOperations) {
  const fixture = await cycleFixture(
    [designDone, implementationDone, { resultText: reviewText([]) }],
    undefined,
    gitOperations,
  );
  const { state, backend, worktree, root } = fixture;
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(worktree.path, 'README.md', 'item behavior\n');
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'initial approval');
  await controlCycle(state, currentCycle(state, cycle), 'pause');
  const target = commitFile(root, 'README.md', 'integration behavior\n');
  const inspected = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'inspect',
  });
  expect(inspected.statusCode, inspected.body).toBe(200);
  expect(currentCycle(state, cycle).integrationResolution?.paths).toEqual(['README.md']);
  return { ...fixture, cycle, target };
}

it('delegates a pinned conflict resolution from the browser and requires fresh review without moving integration', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree, root, cycle, target } = await resolutionFixture();
  const beforeRounds = currentCycle(state, cycle).remediationRounds;
  backend.replyForRequest = (request) =>
    request.model === 'resolution-model'
      ? { resultText: 'Combined checks passed.\n\n## Resolution status\nready' }
      : { resultText: reviewText([]) };
  backend.onLaunch = (request) => {
    if (request.model === 'resolution-model') {
      expect(request.prompt).toContain('Do not commit');
      expect(request.prompt).toContain(target.trim());
      expect(request.prompt).toContain('Preserve both behaviors');
      expect(request.prompt).not.toContain('commit your work on this branch');
      expect(git(['rev-parse', 'MERGE_HEAD'], worktree.path).trim()).toBe(target.trim());
      writeFileSync(join(worktree.path, 'README.md'), 'both behaviors\n');
      git(['add', 'README.md'], worktree.path);
    }
  };
  const started = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'start',
    profile: { ...cycleProfiles.remediate, model: 'resolution-model' },
    instructions: 'Preserve both behaviors',
  });
  expect(started.statusCode, started.body).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'resolved fresh review',
    6000,
  );
  const final = currentCycle(state, cycle);
  expect(final.integrationResolution?.status).toBe('completed');
  expect(final.integrationResolution?.commitSha).toBe(final.reviewHeadSha);
  expect(final.remediationRounds).toBe(beforeRounds);
  expect(backend.launches.slice(-2).map((request) => request.model)).toEqual([
    'resolution-model',
    'review-model',
  ]);
  expect(git(['rev-parse', 'main'], root).trim()).toBe(target.trim());
  expect(git(['log', '-1', '--format=%P'], worktree.path).trim().split(' ')).toEqual([
    final.integrationResolution?.headSha,
    target.trim(),
  ]);
  expect(git(['status', '--porcelain'], worktree.path)).toBe('');
});

it('keeps blocked resolution edits for guided retries and safely abandons from the browser', {
  timeout: 15000,
}, async () => {
  const { state, backend, worktree, cycle } = await resolutionFixture();
  backend.replyForRequest = () => ({
    resultText: 'Need a semantic choice.\n\n## Resolution status\nblocked',
  });
  backend.onLaunch = () => {
    writeFileSync(join(worktree.path, 'README.md'), 'partial choice\n');
  };
  const started = await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' });
  expect(started.statusCode, started.body).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'resolution asks question',
  );
  expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toBe('partial choice\n');
  const manual = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'implement', permissionMode: 'auto' },
  });
  expect(manual.statusCode).toBe(409);
  const resumed = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'resume',
    instructions: 'Preserve both behaviors',
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'second resolution question',
  );
  expect(backend.launches.length, JSON.stringify(currentCycle(state, cycle))).toBe(5);
  expect(backend.launches.at(-1)?.prompt).toContain('Preserve both behaviors');
  expect(currentCycle(state, cycle).integrationResolution?.attempts).toBe(2);
  expect(
    (await resolutionCommand(state, currentCycle(state, cycle), { action: 'resume' })).statusCode,
  ).toBe(200);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'third resolution question',
  );
  expect(currentCycle(state, cycle).integrationResolution?.attempts).toBe(3);
  const capped = await resolutionCommand(state, currentCycle(state, cycle), { action: 'resume' });
  expect(capped.statusCode).toBe(409);
  expect(capped.body).toContain('three-agent-attempt limit');
  writeFileSync(join(worktree.path, 'keep.txt'), 'untracked operator file');
  const abandoned = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'abandon',
  });
  expect(abandoned.statusCode, abandoned.body).toBe(200);
  expect(currentCycle(state, cycle).integrationResolution?.status).toBe('abandoned');
  expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toBe('item behavior\n');
  expect(existsSync(join(worktree.path, 'keep.txt'))).toBe(true);
});

it('protects resolution commands with CSRF and version checks and refuses a stale integration target', {
  timeout: 15000,
}, async () => {
  const { state, worktree, root, cycle } = await resolutionFixture();
  const csrf = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/integration-resolution`,
    headers: { cookie: state.cookie },
    payload: { action: 'start', expectedVersion: currentCycle(state, cycle).version },
  });
  expect(csrf.statusCode).toBe(403);
  expect((await resolutionCommand(state, cycle, { action: 'start' })).statusCode).toBe(409);
  commitFile(root, 'later.txt', 'integration advanced');
  const stale = await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.body).toContain('Branches changed');
  expect(git(['status', '--porcelain'], worktree.path)).toBe('');
});

it.each(['preparing', 'committing'] as const)(
  'recovers the %s integration reservation without repeating a finished Git operation or launching before explicit resume',
  { timeout: 15000 },
  async (phase) => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let enter: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const pauseResult = async <T>(result: T) => {
      if (!held) {
        held = true;
        enter?.();
        await barrier;
      }
      return result;
    };
    const fixture = await resolutionFixture({
      ...real,
      ...(phase === 'preparing'
        ? {
            prepareIntegrationResolution: async (input) =>
              pauseResult(await real.prepareIntegrationResolution(input)),
          }
        : {
            finishIntegrationResolution: async (input) =>
              pauseResult(await real.finishIntegrationResolution(input)),
          }),
    });
    const { state, backend, cycle, worktree, root } = fixture;
    backend.replyForRequest = (request) =>
      request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : { resultText: 'Verified both behaviors.\n\n## Resolution status\nready' };
    backend.onLaunch = (request) => {
      if (request.model !== 'review-model') {
        writeFileSync(join(worktree.path, 'README.md'), 'both behaviors\n');
        git(['add', 'README.md'], worktree.path);
      }
    };
    expect(
      (await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' })).statusCode,
    ).toBe(200);
    try {
      await entered;
      expect(currentCycle(state, cycle).integrationResolution?.status).toBe(phase);
      const beforeLaunches = backend.launches.length;
      state.context.services.workCycleService.recoverInterrupted();
      expect(currentCycle(state, cycle).status).toBe('needs-attention');
      expect(backend.launches).toHaveLength(beforeLaunches);
    } finally {
      release?.();
    }
    await waitFor(
      () => !state.context.services.executionService.branches.repositoryBusy(root),
      'Git reservation released',
    );
    expect(
      (await resolutionCommand(state, currentCycle(state, cycle), { action: 'resume' })).statusCode,
    ).toBe(200);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'recovered resolution',
      6000,
    );
    expect(currentCycle(state, cycle).integrationResolution?.attempts).toBe(1);
    expect(backend.launches).toHaveLength(5);
    expect(
      git(['log', '--format=%s'], worktree.path)
        .split('\n')
        .filter((line) => line.startsWith('CraftingTable: resolve integration')),
    ).toHaveLength(1);
  },
);

it('stop during resolution preparation preserves ownership and supports explicit browser abandonment', {
  timeout: 15000,
}, async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let enter: (() => void) | undefined;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, backend, worktree, root, cycle } = await resolutionFixture({
    ...real,
    prepareIntegrationResolution: async (input) => {
      const result = await real.prepareIntegrationResolution(input);
      enter?.();
      await barrier;
      return result;
    },
  });
  expect(
    (await resolutionCommand(state, currentCycle(state, cycle), { action: 'start' })).statusCode,
  ).toBe(200);
  try {
    await entered;
    await controlCycle(state, currentCycle(state, cycle), 'stop');
  } finally {
    release?.();
  }
  await waitFor(
    () => !state.context.services.executionService.branches.repositoryBusy(root),
    'stopped preparation',
  );
  expect(currentCycle(state, cycle).status).toBe('paused');
  expect(backend.launches).toHaveLength(3);
  expect(git(['rev-parse', 'MERGE_HEAD'], worktree.path).trim()).toBe(
    currentCycle(state, cycle).integrationResolution?.targetSha,
  );
  const branch = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/worktrees/${worktree.id}/update`,
    headers: mutationHeaders(state),
    payload: { expectedVersion: worktree.version },
  });
  expect(branch.statusCode).toBe(409);
  const abandoned = await resolutionCommand(state, currentCycle(state, cycle), {
    action: 'abandon',
  });
  expect(abandoned.statusCode, abandoned.body).toBe(200);
  expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  expect((await controlCycle(state, currentCycle(state, cycle), 'stop')).status).toBe('stopped');
});

async function useIntegration(
  fixture: Awaited<ReturnType<typeof roadmapFixture>>,
  name = 'revision',
) {
  const { state, root, repository } = fixture;
  git(['branch', name], root);
  const settings = present(
    state.context.storage.execution.branchSettings.find(
      state.workspaceId,
      asPlanVersionId('version-1'),
    ),
  );
  const result = await branchCommand(state, 'plan-versions/version-1/branch-settings', {
    expectedVersion: settings.version,
    repositoryId: repository.id,
    integrationBranch: name,
  });
  expect(result.statusCode, result.body).toBe(200);
}

it('automatically integrates sequential entries while preserving a per-item manual checkpoint', {
  timeout: 15000,
}, async () => {
  const fixture = await roadmapFixture();
  const { state, backend, root } = fixture;
  await useIntegration(fixture);
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  const input = roadmapInput(state);
  const saved = await saveRoadmapRequest(state, {
    ...input,
    automation: { integrationMerge: 'automatic', integrationConflicts: 'automatic' },
    entries: input.entries.map((e, i) =>
      i ? { ...e, automation: { integrationMerge: 'manual', integrationConflicts: 'manual' } } : e,
    ),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const main = git(['rev-parse', 'main'], root);
  await roadmapControl(state, 'start');
  const second = await awaitRoadmapMerge(state, 1);
  expect(storedRoadmap(state).attempts[0]?.status).toBe('completed');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
  expect(git(['rev-parse', 'revision'], root)).not.toBe(main);
  const first = present(storedRoadmap(state).attempts[0]);
  const operation = present(
    state.context.storage.execution.merges.latest(state.workspaceId, first.worktreeId),
  );
  expect(operation).toMatchObject({ status: 'cleaned', roadmapId, definitionRevision: 1 });
  expect(
    state.context.storage.execution.worktrees.find(state.workspaceId, second.worktreeId)?.mergedAt,
  ).toBeUndefined();
  await mergeRoadmapAttempt(state, second.worktreeId);
  await waitFor(
    () => storedRoadmap(state).status === 'completed',
    'manual override completes roadmap',
  );
});

it('keeps main protected from automatic roadmap merges', { timeout: 10000 }, async () => {
  const { state, root } = await roadmapFixture();
  const main = git(['rev-parse', 'main'], root);
  await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'protected main');
  expect(storedRoadmap(state).reason).toContain('explicit operator');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
});

it('automatically resolves parallel integration conflicts and freshly reviews before integrating', {
  timeout: 20000,
}, async () => {
  const fixture = await parallelFixture();
  const { state, backend, input, root } = fixture;
  await useIntegration(fixture);
  const base = git(['rev-parse', 'main'], root);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(request.cwd, 'README.md', `behavior ${request.cwd}\n`);
    if (request.model === 'resolution-auto') {
      writeFileSync(join(request.cwd, 'README.md'), 'both sibling behaviors\n');
      git(['add', 'README.md'], request.cwd);
    }
  };
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'resolution-auto'
        ? { resultText: 'Combined checks passed.\n\n## Resolution status\nready' }
        : request.model === 'review-model'
          ? { resultText: reviewText([]) }
          : implementationDone;
  await saveRoadmapRequest(state, {
    ...input,
    automation: {
      integrationMerge: 'automatic',
      integrationConflicts: 'automatic',
      resolutionProfile: { ...cycleProfiles.remediate, model: 'resolution-auto' },
    },
  });
  await roadmapControl(state, 'start');
  await waitFor(
    () => storedRoadmap(state).status === 'completed',
    'unattended parallel integration',
    15000,
  );
  expect(git(['rev-parse', 'main'], root)).toBe(base);
  expect(backend.launches.some((r) => r.model === 'resolution-auto')).toBe(true);
  const resolved = state.context.storage.execution.cycles
    .list(state.workspaceId)
    .find((c) => c.integrationResolution?.status === 'completed');
  expect(resolved?.status).toBe('completed');
  expect(
    state.context.storage.execution.runs.find(state.workspaceId, present(resolved).currentRunId)
      ?.role,
  ).toBe('review');
});

async function finalizationFixture(
  options: { gitOperations?: GitOperations; alternateBackend?: AgentBackend } = {},
) {
  const fixture = await roadmapFixture(undefined, options);
  const { state, backend, root, second } = fixture;
  await useIntegration(fixture);
  git(['checkout', 'revision'], root);
  const integration = commitFile(root, 'feature.txt', 'integrated feature\n').trim();
  git(['checkout', 'main'], root);
  for (const id of [state.workItemId, second]) {
    await admit({ ...state, workItemId: id });
    const completed = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${id}/complete`,
      headers: mutationHeaders(state),
      payload: {},
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const evidence = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/work-items/${id}/integration-evidence`,
      headers: mutationHeaders(state),
      payload: { commitSha: integration },
    });
    expect(evidence.statusCode, evidence.body).toBe(200);
  }
  backend.onLaunch = undefined;
  backend.replyForRequest = (request) => ({
    resultText: request.model?.includes('polish')
      ? 'Polish verified.\n\n## Open questions\nnone'
      : `Conformance assessed against the whole plan.\n\n## Open questions\nnone\n\n## Review report\n${reviewText([])}`,
  });
  const profile = cycleProfiles.review;
  const input = {
    expectedBranchVersion: present(
      state.context.storage.execution.branchSettings.find(
        state.workspaceId,
        asPlanVersionId('version-1'),
      ),
    ).version,
    targetBranch: 'main',
    rounds: [
      {
        review: { ...profile, model: 'assessment-model' },
        polish: { ...profile, model: 'polish-model' },
        instructions: 'Simplify repeated logic without changing behavior',
      },
    ],
    finalReview: { ...profile, model: 'final-review-model' },
    policy: { ...DEFAULT_COMPLETION_POLICY, maxNits: 0 },
    instructions: 'Check complete plan conformance and improve clarity',
  };
  return { ...fixture, input, integration };
}
async function beginFinalization(
  fixture: Awaited<ReturnType<typeof finalizationFixture>>,
  input = fixture.input,
) {
  const { state } = fixture;
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/plans/version-1/finalizations`,
    headers: mutationHeaders(state),
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().finalization as import('@craftingtable/domain').Finalization;
}
function finalizationCycle(state: Ready, value: import('@craftingtable/domain').Finalization) {
  return present(state.context.storage.execution.cycles.find(state.workspaceId, value.cycleId));
}
async function finalizationCommand(
  state: Ready,
  value: import('@craftingtable/domain').Finalization,
  action: string,
  extra: Record<string, unknown> = {},
) {
  const current = present(
    state.context.storage.execution.finalizations.find(state.workspaceId, value.id),
  );
  const cycle = state.context.storage.execution.cycles.find(state.workspaceId, value.cycleId);
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/finalizations/${value.id}/control`,
    headers: mutationHeaders(state),
    payload: {
      action,
      expectedVersion: current.version,
      expectedCycleVersion: cycle?.version,
      ...extra,
    },
  });
}

it('runs plan-scoped polish and independent verification, then requires explicit exact-commit promotion', {
  timeout: 15000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend, root, integration } = fixture;
  const main = git(['rev-parse', 'main'], root);
  backend.onLaunch = (request) => {
    if (request.model === 'polish-model') commitFile(request.cwd, 'polish.txt', 'simplified\n');
  };
  const value = await beginFinalization(fixture);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'final independent review',
    8000,
  );
  const cycle = finalizationCycle(state, value);
  expect(backend.launches.map((r) => r.model)).toEqual([
    'assessment-model',
    'polish-model',
    'assessment-model',
    'final-review-model',
  ]);
  expect(cycle.polishPhase).toBe('final-review');
  expect(backend.launches[0]?.prompt).toContain('# Plan finalization');
  expect(backend.launches[0]?.prompt).toContain('craftingtable-work-items.json');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
  expect(git(['rev-parse', 'revision'], root).trim()).toBe(integration);
  const tree = present(
    state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
  );
  expect(tree.workItemId).toBeUndefined();
  expect(tree.planVersionId).toBe('version-1');
  expect(
    state.context.storage.execution.runs.listForWorkItem(state.workspaceId, state.workItemId),
  ).toHaveLength(0);
  expect((await merge(state, tree.id)).statusCode).toBe(409);
  const review = present(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  ).reviewBranchContext;
  if (!review) throw new Error('Expected final review context');
  expect(
    (
      await finalizationCommand(state, value, 'merge', {
        expectedHeadSha: '0'.repeat(40),
        expectedTargetSha: review.targetSha,
      })
    ).statusCode,
  ).toBe(409);
  const promoted = await finalizationCommand(state, value, 'merge', {
    expectedHeadSha: review.headSha,
    expectedTargetSha: review.targetSha,
  });
  expect(promoted.statusCode, promoted.body).toBe(200);
  expect(promoted.json().finalization.status).toBe('completed');
  expect(readFileSync(join(root, 'polish.txt'), 'utf8')).toBe('simplified\n');
  expect(git(['rev-parse', 'revision'], root).trim()).toBe(integration);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.mergeSha,
  ).toBeUndefined();
});

it('stops finalization for genuine questions and never converts exhausted remediation into approval', {
  timeout: 15000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend, root } = fixture;
  const main = git(['rev-parse', 'main'], root);
  backend.replyForRequest = () => ({
    resultText: `## Open questions\nMay I change the intended public API?\n\n## Review report\n${reviewText([])}`,
  });
  const value = await beginFinalization(fixture, {
    ...fixture.input,
    rounds: [],
    policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
  });
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'finalization question',
  );
  expect(backend.launches).toHaveLength(1);
  expect(finalizationCycle(state, value).reason).toContain('input');
  backend.replyForRequest = () => ({
    resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([structuredFinding])}`,
  });
  const resumed = await finalizationCommand(state, value, 'resume', {
    instructions: 'Keep the public API unchanged; identify required fixes within the plan.',
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'finalization remediation limit',
  );
  expect(finalizationCycle(state, value).reason).toContain('limit');
  expect(git(['rev-parse', 'main'], root)).toBe(main);
});

it('invalidates final promotion after integration drift and preserves the snapshot on stop', {
  timeout: 10000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, root } = fixture;
  const value = await beginFinalization(fixture, { ...fixture.input, rounds: [] });
  await waitFor(() => finalizationCycle(state, value).status === 'awaiting-merge', 'final review');
  const cycle = finalizationCycle(state, value);
  const context = present(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  ).reviewBranchContext;
  if (!context) throw new Error('Expected final review context');
  git(['checkout', 'revision'], root);
  commitFile(root, 'extra.txt', 'external integration\n');
  git(['checkout', 'main'], root);
  const rejected = await finalizationCommand(state, value, 'merge', {
    expectedHeadSha: context.headSha,
    expectedTargetSha: context.targetSha,
  });
  expect(rejected.statusCode, rejected.body).toBe(409);
  expect(rejected.body).toContain('Integration changed');
  const stopped = await finalizationCommand(state, value, 'stop');
  expect(stopped.statusCode, stopped.body).toBe(200);
  expect(stopped.json().finalization.status).toBe('stopped');
  expect(
    existsSync(
      present(state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId))
        .path,
    ),
  ).toBe(true);
});

it('reconciles a committed delegated merge after interruption without merging or reviewing twice', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let calls = 0;
  const fixture = await roadmapFixture(undefined, {
    gitOperations: {
      ...realGit,
      mergeBranch: async (input) => {
        calls++;
        const result = await realGit.mergeBranch(input);
        if (result.ok && calls === 1)
          throw new Error('Interruption after Git commit, before recording completion');
        return result;
      },
    },
  });
  const { state, backend, root } = fixture;
  await useIntegration(fixture);
  await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'interrupted merge');
  const attempt = present(storedRoadmap(state).attempts[0]);
  const operation = present(
    state.context.storage.execution.merges.latest(state.workspaceId, attempt.worktreeId),
  );
  expect(operation.status).toBe('reserved');
  const committed = git(['rev-parse', 'revision'], root);
  expect(git(['log', '-1', '--format=%s', 'revision'], root)).toContain(operation.id);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('admitted');
  const stop = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${attempt.cycleId}/control`,
    headers: mutationHeaders(state),
    payload: {
      action: 'stop',
      expectedVersion: present(
        state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId),
      ).version,
    },
  });
  expect(stop.statusCode).toBe(409);
  expect(stop.body).toContain('pending merge');
  state.context.services.roadmapService.recoverInterrupted();
  state.context.services.workCycleService.recoverInterrupted();
  const launches = backend.launches.length;
  await roadmapControl(state, 'resume');
  await waitFor(() => storedRoadmap(state).status === 'completed', 'reconciled merge');
  expect(calls).toBe(1);
  expect(backend.launches).toHaveLength(launches);
  expect(git(['rev-parse', 'revision'], root)).toBe(committed);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, attempt.worktreeId)?.status,
  ).toBe('cleaned');
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('completed');
});

it('records completion before cleanup, exposes retry, and preserves edits added after integration', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let preserve = false;
  let calls = 0;
  const { state, backend, worktree, root } = await cycleFixture(
    [designDone, implementationDone, { resultText: reviewText([]) }],
    undefined,
    {
      ...realGit,
      mergeBranch: async (input) => {
        calls++;
        return realGit.mergeBranch(input);
      },
      removeWorktree: async (input) =>
        preserve && !input.worktreePath.includes('/.merge/')
          ? {
              ok: false,
              failure: { kind: 'git-failed', message: 'Simulated cleanup interruption' },
            }
          : realGit.removeWorktree(input),
    },
  );
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      commitFile(request.cwd, 'feature.txt', 'reviewed implementation');
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'reviewed branch');
  preserve = true;
  const response = await merge(state, worktree.id);
  expect(response.statusCode, response.body).toBe(200);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('completed');
  expect(existsSync(worktree.path)).toBe(true);
  const committed = git(['rev-parse', 'main'], root);
  const view = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/execution`,
    headers: { cookie: state.cookie },
  });
  expect(view.statusCode, view.body).toBe(200);
  expect(view.json().worktrees[0].mergeCleanupError).toContain('cleanup interruption');
  const source = git(['rev-parse', 'HEAD'], worktree.path).trim();
  preserve = false;
  commitFile(worktree.path, 'operator.txt', 'later operator commit');
  const retained = await merge(state, worktree.id);
  expect(retained.statusCode, retained.body).toBe(200);
  expect(existsSync(worktree.path)).toBe(true);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, worktree.id)?.cleanupError,
  ).toContain('different branch or commit');
  // Remove only this test's extra commit, then retry the browser command.
  git(['reset', '--hard', source], worktree.path);
  const cleaned = await merge(state, worktree.id);
  expect(cleaned.statusCode, cleaned.body).toBe(200);
  expect(calls).toBe(1);
  expect(existsSync(worktree.path)).toBe(false);
  expect(git(['rev-parse', 'main'], root)).toBe(committed);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, worktree.id),
  ).toMatchObject({ status: 'cleaned' });
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, worktree.id)?.cleanupError,
  ).toBeUndefined();
});

it('recovers finalization preparation only on explicit resume and preserves its reserved worktree', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let interrupted = false;
  const fixture = await finalizationFixture({
    gitOperations: {
      ...realGit,
      createWorktree: async (input) => {
        const result = await realGit.createWorktree(input);
        if (result.ok && input.branchName.startsWith('ct/finalize-') && !interrupted) {
          interrupted = true;
          throw new Error('Simulated interruption after finalization worktree creation');
        }
        return result;
      },
    },
  });
  const { state, backend, root } = fixture;
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/plans/version-1/finalizations`,
    headers: mutationHeaders(state),
    payload: { ...fixture.input, rounds: [] },
  });
  expect(response.statusCode).toBe(500);
  const value = present(state.context.storage.execution.finalizations.list(state.workspaceId)[0]);
  expect(value.status).toBe('preparing');
  expect(backend.launches).toHaveLength(0);
  const before = git(['worktree', 'list', '--porcelain'], root);
  expect(before).toContain(`ct/finalize-${value.id}`);
  state.context.services.workCycleService.recoverInterrupted();
  expect(backend.launches).toHaveLength(0);
  const resumed = await finalizationCommand(state, value, 'resume');
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'recovered plan review',
  );
  expect(git(['worktree', 'list', '--porcelain'], root)).toBe(before);
  expect(backend.launches).toHaveLength(1);
});

it('keeps a started entry manual when queued defaults change to automatic integration', {
  timeout: 15000,
}, async () => {
  const fixture = await roadmapFixture();
  const { state, backend } = fixture;
  await useIntegration(fixture);
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  await roadmapControl(state, 'pause');
  const saved = await saveRoadmapRequest(state, {
    ...roadmapInput(state),
    expectedVersion: storedRoadmap(state).version,
    automation: { integrationMerge: 'automatic', integrationConflicts: 'automatic' },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().progress[0].effectiveAutomation.integrationMerge).toBe('manual');
  expect(saved.json().progress[1].effectiveAutomation.integrationMerge).toBe('automatic');
  await roadmapControl(state, 'resume');
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, first.worktreeId),
  ).toBeUndefined();
  await mergeRoadmapAttempt(state, first.worktreeId);
  await waitFor(
    () => storedRoadmap(state).status === 'completed',
    'queued automatic integration',
    8000,
  );
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, first.worktreeId)?.roadmapId,
  ).toBeUndefined();
  const second = present(storedRoadmap(state).attempts[1]);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, second.worktreeId),
  ).toMatchObject({ roadmapId, definitionRevision: 2 });
});

it('holds integration merges while finalization is active or paused and releases them on stop', {
  timeout: 10000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, repository, root } = fixture;
  const value = await beginFinalization(fixture, { ...fixture.input, rounds: [] });
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'ready finalization',
  );
  const created = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/worktrees`,
    headers: mutationHeaders(state),
    payload: { repositoryId: repository.id },
  });
  expect(created.statusCode, created.body).toBe(200);
  const tree = createWorktreeResponseSchema.parse(created.json()).worktree;
  commitFile(tree.path, 'late-fix.txt', 'late integrated change');
  await runToFinish(state, tree.id, { role: 'review' });
  const initial = git(['rev-parse', 'revision'], root);
  const held = await merge(state, tree.id);
  expect(held.statusCode).toBe(409);
  expect(held.body).toContain('held for plan finalization');
  expect((await finalizationCommand(state, value, 'pause')).statusCode).toBe(200);
  expect((await merge(state, tree.id)).statusCode).toBe(409);
  expect(git(['rev-parse', 'revision'], root)).toBe(initial);
  const stopped = await finalizationCommand(state, value, 'stop');
  expect(stopped.statusCode, stopped.body).toBe(200);
  const released = await merge(state, tree.id);
  expect(released.statusCode, released.body).toBe(200);
  expect(git(['rev-parse', 'revision'], root)).not.toBe(initial);
});

it('cleans an interrupted reserved scratch worktree before retrying an uncommitted merge', {
  timeout: 15000,
}, async () => {
  const realGit = createGitOperations({ gitExecutable: 'git' });
  let interrupted = false;
  const fixture = await roadmapFixture(undefined, {
    gitOperations: {
      ...realGit,
      mergeBranch: async (input) => {
        if (!interrupted) {
          interrupted = true;
          git(
            ['worktree', 'add', '--', input.scratchPath, input.targetBranch],
            input.repositoryPath,
          );
          throw new Error('Interruption before merge');
        }
        return realGit.mergeBranch(input);
      },
    },
  });
  const { state, root } = fixture;
  await useIntegration(fixture);
  await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId]),
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
  });
  await roadmapControl(state, 'start');
  await waitFor(
    () => storedRoadmap(state).status === 'needs-attention',
    'reserved scratch interruption',
  );
  const attempt = present(storedRoadmap(state).attempts[0]);
  const operation = present(
    state.context.storage.execution.merges.latest(state.workspaceId, attempt.worktreeId),
  );
  expect(operation.status).toBe('reserved');
  expect(git(['worktree', 'list', '--porcelain'], root)).toContain(operation.id);
  await roadmapControl(state, 'resume');
  await waitFor(() => storedRoadmap(state).status === 'completed', 'recovered scratch merge', 8000);
  expect(git(['worktree', 'list', '--porcelain'], root)).not.toContain(operation.id);
});

it('compacts finalization findings while preserving closure history and requiring reopened findings', {
  timeout: 20000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend } = fixture;
  const history = Array.from({ length: 112 }, (_, index) => ({
    ...structuredFinding,
    id: `ITEM-${index}.F-001`,
    status: index === 0 ? 'withdrawn' : 'resolved',
    disposition: 'Verified during the integrated work item.',
  }));
  const closed = { ...structuredFinding, status: 'resolved', disposition: 'Verified the fix.' };
  const reports = [
    [...history, structuredFinding],
    [closed],
    [structuredFinding], // Independent final review reopens the concern.
    [], // An open finding still cannot disappear.
  ];
  let review = 0;
  backend.replyForRequest = (request) => ({
    resultText: request.model?.includes('polish')
      ? 'Fixed and verified.\n\n## Open questions\nnone'
      : `## Open questions\nnone\n\n## Review report\n${reviewText(reports[review++] ?? [closed])}`,
  });
  const value = await beginFinalization(fixture);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'missing reopened finding',
    12000,
  );
  const cycle = finalizationCycle(state, value);
  expect(cycle.reason).toContain('F-001');
  expect((await runDetail(state, cycle.currentRunId)).run.verdict).toBeUndefined();
  expect(backend.launches).toHaveLength(6);
  const current = present(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  );
  expect([...requiredFindingIds(state.context.storage.execution, current)]).toEqual(['F-001']);
  expect(recordedFindings(state.context.storage.execution, current).size).toBe(113);
  const finalLaunch = present(backend.launches.find((r) => r.model === 'final-review-model'));
  const handoff = join(present(finalLaunch.additionalDirectories?.[0]), 'handoff');
  const snapshot = JSON.parse(readFileSync(join(handoff, 'findings.json'), 'utf8'));
  expect(snapshot.requiredFindingIds).toEqual([]);
  expect(snapshot.closedFindingIds).toHaveLength(113);
  const archive = JSON.parse(readFileSync(join(handoff, snapshot.closedHistory), 'utf8'));
  expect(
    archive.findings.find((r: { finding: { id: string } }) => r.finding.id === 'F-001'),
  ).toMatchObject({ finding: closed, runId: expect.any(String), sequence: expect.any(Number) });
  const initial = state.context.storage.execution.runs
    .listForWorktree(state.workspaceId, value.worktreeId)
    .at(-1);
  expect(recordedFindings(state.context.storage.execution, present(initial)).size).toBe(113);
  expect(finalLaunch.prompt).not.toContain('Verified during the integrated work item.');
  const resumed = await finalizationCommand(state, value, 'resume');
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'closed reopened finding',
  );
  expect(
    (await runDetail(state, finalizationCycle(state, value).currentRunId)).reviewReport,
  ).toMatchObject({ status: 'complete', report: { findings: [closed] } });
});

it.each(['unchanged', 'candidate-changed', 'destination-changed', 'truncated'] as const)(
  'guides a rejected finalization report retry with %s evidence and expires attempt guidance',
  { timeout: 20000 },
  async (scenario) => {
    const fixture = await finalizationFixture();
    const { state, backend, root } = fixture;
    const report = {
      version: 1,
      complete: true,
      verdict: 'mergeable',
      exitGate: { met: true, evidence: 'Current and historical verification. '.repeat(800) },
      findings: [],
    };
    backend.replyForRequest = () => ({
      resultText: `## Open questions\nnone\n\n## Review report\n\`\`\`craftingtable-review\n${JSON.stringify(report)}\n\`\`\`\nVERDICT: mergeable`,
      ...(scenario === 'truncated' ? { truncated: true } : {}),
    });
    const value = await beginFinalization(fixture);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'oversized review',
    );
    const failed = finalizationCycle(state, value);
    if (scenario !== 'truncated') expect(failed.reason).toContain('exitGate.evidence');
    expect((await runDetail(state, failed.currentRunId)).run.verdict).toBeUndefined();
    if (scenario === 'candidate-changed') {
      const tree = present(
        state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
      );
      commitFile(tree.path, 'changed.txt', 'changed since the review\n');
    }
    if (scenario === 'destination-changed') commitFile(root, 'destination.txt', 'changed main\n');
    backend.replyForRequest = (request) => ({
      resultText: request.model?.includes('polish')
        ? 'Polish verified.\n\n## Open questions\nnone'
        : `## Open questions\nnone\n\n## Review report\n${reviewText([])}`,
    });
    const resumed = await finalizationCommand(state, value, 'resume', {
      instructions: 'Answer for this attempt only.',
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'corrected finalization',
      12000,
    );
    const retry = present(backend.launches[1]);
    expect(retry.prompt).toContain('## Correct the rejected review report');
    expect(retry.prompt).toContain('Answer for this attempt only.');
    if (scenario === 'unchanged') {
      expect(retry.prompt).toContain('same candidate and destination commits');
      expect(retry.prompt).toContain('exitGate.evidence');
    } else {
      expect(retry.prompt).toContain('Perform a fresh review and run the required verification');
      expect(retry.prompt).not.toContain('The daemon confirmed');
    }
    for (const launch of backend.launches.slice(2)) {
      expect(launch.prompt).not.toContain('Answer for this attempt only.');
      expect(launch.prompt).not.toContain('## Correct the rejected review report');
    }
    const retryRoot = present(retry.additionalDirectories?.[0]);
    const fullOutcome = readFileSync(join(retryRoot, 'handoff/0000-final.md'), 'utf8');
    expect(fullOutcome).toContain(report.exitGate.evidence);
    expect(retry.prompt.length).toBeLessThan(fullOutcome.length);
    expect(finalizationCycle(state, value).instructions).toBe('');
  },
);

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

it('authorizes bounded extra finalization remediation, preserves counts and rounds, and rejects replay', {
  timeout: 20000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend, root } = fixture;
  const initialMain = git(['rev-parse', 'main'], root);
  const result = (findings: readonly unknown[]) =>
    `## Open questions\nnone\n\n## Review report\n${reviewText(findings)}`;
  let fixed = false;
  backend.replyForRequest = (request) => ({
    resultText: request.model?.includes('polish')
      ? 'Checked the fix.\n\n## Open questions\nnone'
      : result([
          {
            ...structuredFinding,
            ...(fixed ? { status: 'resolved', disposition: 'Fix independently verified.' } : {}),
          },
        ]),
  });
  const value = await beginFinalization(fixture, {
    ...fixture.input,
    rounds: [present(fixture.input.rounds[0]), present(fixture.input.rounds[0])],
    policy: { ...fixture.input.policy, maxRemediationRounds: 1 },
  });
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'initial remediation limit',
    10000,
  );
  const before = finalizationCycle(state, value);
  expect(before).toMatchObject({ remediationRounds: 1, polishRound: 0, polishPhase: 'verify' });
  const count = backend.launches.length;
  const unchanged = await finalizationCommand(state, value, 'resume');
  expect(unchanged.statusCode).toBe(200);
  expect(backend.launches).toHaveLength(count);
  const versions = finalizationCycle(state, value);
  const requests = await Promise.all([
    finalizationCommand(state, value, 'authorize-remediation', {
      additionalRounds: 1,
      instructions: 'Focus on the remaining regression.',
    }),
    finalizationCommand(state, value, 'authorize-remediation', {
      additionalRounds: 1,
      instructions: 'Focus on the remaining regression.',
    }),
  ]);
  expect(requests.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const granted = present(requests.find((r) => r.statusCode === 200)).json();
  expect(granted.cycle).toMatchObject({
    step: 'remediate',
    remediationRounds: 2,
    additionalRemediationRounds: 1,
    parentRunId: versions.currentRunId,
  });
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'extended remediation limit',
  );
  expect(backend.launches[count]?.model).toBe('polish-model');
  expect(backend.launches[count]?.prompt).toContain('Focus on the remaining regression.');
  expect(backend.launches[count + 1]?.prompt).not.toContain('Focus on the remaining regression.');
  expect(finalizationCycle(state, value)).toMatchObject({
    remediationRounds: 2,
    additionalRemediationRounds: 1,
    policy: { maxRemediationRounds: 1 },
  });
  const reopened = openCraftingTableStorage(state.context.storage.databasePath);
  try {
    expect(reopened.execution.cycles.find(state.workspaceId, value.cycleId)).toMatchObject({
      remediationRounds: 2,
      additionalRemediationRounds: 1,
    });
  } finally {
    reopened.close();
  }
  fixed = true;
  expect(
    (await finalizationCommand(state, value, 'authorize-remediation', { additionalRounds: 2 }))
      .statusCode,
  ).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'remaining rounds and independent review',
    10000,
  );
  expect(finalizationCycle(state, value)).toMatchObject({
    worktreeId: before.worktreeId,
    remediationRounds: 3,
    additionalRemediationRounds: 3,
    polishPhase: 'final-review',
    polishRound: 2,
    policy: { maxRemediationRounds: 1, maxNits: 0 },
  });
  expect(backend.launches.at(-1)?.model).toBe('final-review-model');
  expect(git(['rev-parse', 'main'], root)).toBe(initialMain);
  expect((await merge(state, value.worktreeId)).statusCode).toBe(409);
  const audit = state.context.storage.audit
    .listWorkspace({ workspaceId: state.workspaceId, limit: 1000 })
    .filter((event) => event.metadata?.action === 'authorize-remediation');
  expect(audit).toHaveLength(2);
  expect(audit.map((event) => event.metadata?.additionalRemediationRounds).sort()).toEqual([1, 3]);
  expect(
    audit.every((event) => event.actorKind === 'user' && event.actorUserId === state.userId),
  ).toBe(true);
});

it.each(['questions', 'invalid', 'conflict'] as const)(
  'does not authorize extra remediation across a %s checkpoint',
  {
    timeout: 15000,
  },
  async (checkpoint) => {
    const fixture = await finalizationFixture();
    const { state, backend } = fixture;
    backend.replyForRequest = () => ({
      resultText: `## Open questions\n${checkpoint === 'questions' ? 'May I change the public API?' : 'none'}\n\n## Review report\n${checkpoint === 'invalid' ? 'Invalid review' : reviewText([structuredFinding])}`,
    });
    const value = await beginFinalization(fixture, {
      ...fixture.input,
      rounds: [],
      policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
    });
    await waitFor(() => finalizationCycle(state, value).status === 'needs-attention', 'checkpoint');
    const current = finalizationCycle(state, value);
    if (checkpoint === 'conflict')
      state.context.storage.transaction((tx) =>
        tx.execution.cycles.replace(
          {
            ...current,
            version: current.version + 1,
            integrationResolution: {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              status: 'detected',
              headSha: '1'.repeat(40),
              targetSha: '2'.repeat(40),
              targetBranch: 'main',
              paths: ['README.md'],
              diagnostics: 'Conflict',
              attempts: 0,
              createdAt: current.updatedAt,
            },
          },
          current.version,
        ),
      );
    const response = await finalizationCommand(state, value, 'authorize-remediation', {
      additionalRounds: 1,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(finalizationCycle(state, value).additionalRemediationRounds).toBeUndefined();
    expect(backend.launches).toHaveLength(1);
  },
);

it('requires CSRF and editor authority before authorizing finalization remediation', {
  timeout: 10000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend } = fixture;
  backend.replyForRequest = () => ({
    resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([structuredFinding])}`,
  });
  const value = await beginFinalization(fixture, {
    ...fixture.input,
    rounds: [],
    policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
  });
  await waitFor(() => finalizationCycle(state, value).status === 'needs-attention', 'budget');
  const noCsrf = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/finalizations/${value.id}/control`,
    headers: { cookie: state.cookie },
    payload: {
      action: 'authorize-remediation',
      additionalRounds: 1,
      expectedVersion: value.version,
      expectedCycleVersion: finalizationCycle(state, value).version,
    },
  });
  expect(noCsrf.statusCode).toBe(403);
  const db = openDatabase(state.context.storage.databasePath);
  try {
    db.prepare(
      "UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
    ).run(state.workspaceId, state.userId);
  } finally {
    db.close();
  }
  expect(
    (await finalizationCommand(state, value, 'authorize-remediation', { additionalRounds: 1 }))
      .statusCode,
  ).toBe(403);
  expect(finalizationCycle(state, value).additionalRemediationRounds).toBeUndefined();
  expect(backend.launches).toHaveLength(1);
});

it.each(['pause', 'revoke'] as const)(
  'rechecks finalization authorization after Git inspection when the operator chooses %s',
  { timeout: 15000 },
  async (change) => {
    const realGit = createGitOperations({ gitExecutable: 'git' });
    let duringInspection: (() => Promise<void>) | undefined;
    const fixture = await finalizationFixture({
      gitOperations: {
        ...realGit,
        inspectWorktreeChanges: async (path) => {
          const result = await realGit.inspectWorktreeChanges(path);
          const operation = duringInspection;
          duringInspection = undefined;
          await operation?.();
          return result;
        },
      },
    });
    const { state, backend } = fixture;
    backend.replyForRequest = () => ({
      resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([structuredFinding])}`,
    });
    const value = await beginFinalization(fixture, {
      ...fixture.input,
      rounds: [],
      policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
    });
    await waitFor(() => finalizationCycle(state, value).status === 'needs-attention', 'budget');
    duringInspection = async () => {
      if (change === 'pause') {
        const paused = await state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${state.workspaceId}/cycles/${value.cycleId}/control`,
          headers: mutationHeaders(state),
          payload: { action: 'pause', expectedVersion: finalizationCycle(state, value).version },
        });
        expect(paused.statusCode).toBe(200);
      } else {
        const db = openDatabase(state.context.storage.databasePath);
        try {
          db.prepare(
            "UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
          ).run(state.workspaceId, state.userId);
        } finally {
          db.close();
        }
      }
    };
    const response = await finalizationCommand(state, value, 'authorize-remediation', {
      additionalRounds: 1,
    });
    expect(response.statusCode, response.body).toBe(change === 'pause' ? 409 : 403);
    expect(finalizationCycle(state, value).additionalRemediationRounds).toBeUndefined();
    expect(finalizationCycle(state, value).remediationRounds).toBe(0);
    expect(backend.launches).toHaveLength(1);
  },
);

describe('background-work completion recovery', () => {
  const incomplete: ScriptedReply = {
    resultText: 'Waiting for verification.',
    exitReason: 'background-work-incomplete',
  };

  it('continues the same implementation with its handoff and original deadline, then requires review', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      incomplete,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id, { instructions: 'Keep the agreed scope.' });
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'completion recovery',
    );
    expect(backend.launches.map((r) => r.model)).toEqual([
      'design-model',
      'implement-model',
      'implement-model',
      'review-model',
    ]);
    expect(backend.launches[2]?.deadlineAt).toBe(backend.launches[1]?.deadlineAt);
    expect(backend.launches[2]?.prompt).toContain('completion recovery attempt 1 of 2');
    expect(backend.launches[2]?.prompt).toContain('Keep the agreed scope.');
    expect(currentCycle(state, cycle)).toMatchObject({
      resultContinuations: 0,
      remediationRounds: 0,
    });
    const runs = [
      ...state.context.storage.execution.runs.listForWorktree(state.workspaceId, worktree.id),
    ].reverse();
    expect(runs.map((r) => r.status)).toEqual(['finished', 'failed', 'finished', 'finished']);
    expect(runs[2]?.parentRunId).toBe(runs[1]?.id);
    const detail = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs/${runs[1]?.id}`,
      headers: { cookie: state.cookie },
    });
    const parsed = agentRunDetailResponseSchema.parse(detail.json());
    expect(parsed.completionIssue).toMatchObject({ reason: 'background-work-incomplete' });
    expect(parsed.latestOutcome?.text).toBe('Waiting for verification.');
  });

  it('stops after two continuations and retains the budget in durable state', async () => {
    const { state, backend, worktree } = await cycleFixture([incomplete, incomplete, incomplete]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'continuation allowance',
    );
    expect(backend.launches).toHaveLength(3);
    expect(new Set(backend.launches.map((r) => r.deadlineAt)).size).toBe(1);
    expect(currentCycle(state, cycle)).toMatchObject({
      resultContinuations: 2,
      remediationRounds: 0,
    });
    expect(currentCycle(state, cycle).reason).toContain('exhausted its two continuation');
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(state.workspaceId, cycle.id)).toMatchObject({
        resultContinuations: 2,
        runDeadlineAt: cycle.runDeadlineAt,
      });
    } finally {
      reopened.close();
    }
  });

  it.each([
    {
      resultText: 'Decision required.\n\n## Open questions\nShould cancellation change history?',
      exitReason: 'background-work-incomplete' as const,
    },
    {
      resultText: 'Background tests exceeded their deadline.',
      exitReason: 'background-work-timeout' as const,
    },
    {
      resultText: 'Waiting for verification.',
      exitReason: 'background-work-incomplete' as const,
      truncated: true,
    },
    { resultText: 'Missing checkpoint without a lifecycle failure.' },
  ])(
    'does not repair questions, timeouts, truncation, or ordinary missing checkpoints: $resultText',
    async (reply) => {
      const { state, backend, worktree } = await cycleFixture([reply]);
      const cycle = await startCycle(state, worktree.id);
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'operator attention',
      );
      expect(backend.launches).toHaveLength(1);
      expect(currentCycle(state, cycle).resultContinuations ?? 0).toBe(0);
    },
  );

  it('does not extend the original time limit to finish a continuation', async () => {
    let now = new Date('2026-09-14T12:00:00Z');
    const { state, backend, worktree } = await cycleFixture([incomplete, incomplete], () => now);
    backend.onLaunch = () => {
      if (backend.launches.length === 1) now = new Date(now.getTime() + 121 * 60_000);
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'original time limit',
    );
    expect(backend.launches).toHaveLength(2);
    expect(currentCycle(state, cycle).reason).toContain('Step time limit');
    expect(currentCycle(state, cycle).resultContinuations).toBe(1);
  });

  it('retains the finalization phase and independent review, with no automatic promotion', {
    timeout: 15000,
  }, async () => {
    const fixture = await finalizationFixture();
    const { state, backend, root } = fixture;
    const normalReply = backend.replyForRequest;
    let interrupted = false;
    backend.replyForRequest = (request) => {
      if (request.model === 'polish-model' && !interrupted) {
        interrupted = true;
        return incomplete;
      }
      return present(normalReply)(request);
    };
    const main = git(['rev-parse', 'main'], root);
    const value = await beginFinalization(fixture);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'final independent review',
    );
    expect(backend.launches.map((r) => r.model)).toEqual([
      'assessment-model',
      'polish-model',
      'polish-model',
      'assessment-model',
      'final-review-model',
    ]);
    expect(backend.launches[2]?.deadlineAt).toBe(backend.launches[1]?.deadlineAt);
    expect(backend.launches[2]?.prompt).toContain('Phase: polish; improvement round 1 of 1');
    expect(finalizationCycle(state, value)).toMatchObject({
      remediationRounds: 0,
      polishPhase: 'final-review',
    });
    expect(git(['rev-parse', 'main'], root)).toBe(main);
  });
});

it('an incomplete finalization review retains concerns and cannot close findings or supply a verdict', {
  timeout: 15000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend } = fixture;
  let review = 0;
  backend.replyForRequest = (request) => {
    if (request.model?.includes('polish'))
      return { resultText: 'Polish complete.\n\n## Open questions\nnone' };
    review++;
    const findings =
      review === 1
        ? [structuredFinding]
        : review === 2
          ? [
              {
                ...structuredFinding,
                status: 'resolved',
                disposition: 'Claimed fixed before background checks completed.',
              },
              { ...structuredFinding, id: 'F-002', title: 'A newly discovered concern' },
            ]
          : [];
    return {
      resultText: `## Open questions\nnone\n\n## Review report\n${reviewText(findings)}`,
      ...(review === 2 ? { exitReason: 'background-work-incomplete' as const } : {}),
    };
  };
  const value = await beginFinalization(fixture);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'missing unclosed findings',
  );
  const cycle = finalizationCycle(state, value);
  expect(cycle.reason).toContain('F-001');
  expect(cycle.reason).toContain('F-002');
  const runs = state.context.storage.execution.runs.listForWorktree(
    state.workspaceId,
    cycle.worktreeId,
  );
  const failed = present(runs.find((r) => r.status === 'failed'));
  const detail = await runDetail(state, failed.id);
  expect(detail.run.verdict).toBeUndefined();
  expect(detail.reviewReport?.status).toBe('invalid');
  expect(detail.completionIssue?.reason).toBe('background-work-incomplete');
  const next = present(runs.find((r) => r.id === cycle.currentRunId));
  expect([...requiredFindingIds(state.context.storage.execution, next)].sort()).toEqual([
    'F-001',
    'F-002',
  ]);
  expect(backend.launches).toHaveLength(4);
  expect(backend.launches[3]?.prompt).toContain('Reuse recorded passing checks only when');
  expect(backend.launches[3]?.prompt).not.toContain(
    'The prior review is incomplete or its candidate/destination snapshot cannot be reused',
  );
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

describe('collecting background review results', () => {
  it('keeps stdin open while background work is pending and ends only after the collected outcome', async () => {
    const { state, backend, worktree } = await cycleFixture([
      { resultText: 'Waiting for a background check.', backgroundWorkPending: true },
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'waiting',
      'background wait',
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const session = present(backend.sessions[0]);
    expect(session.endCount).toBe(0);
    expect(backend.launches).toHaveLength(1);
    expect(currentCycle(state, cycle).status).toBe('running');
    session.completeBackground(designDone.resultText);
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'collected result');
    expect(session.endCount).toBe(1);
    expect(backend.launches).toHaveLength(3);
    expect(currentCycle(state, cycle).resultContinuations ?? 0).toBe(0);
  });

  it('still cancels pending background work at the original step deadline', async () => {
    let now = new Date('2026-09-15T03:00:00Z');
    const { state, backend, worktree } = await cycleFixture(
      [{ resultText: 'Waiting.', backgroundWorkPending: true }],
      () => now,
    );
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => backend.sessions.length === 1, 'pending background work');
    now = new Date(now.getTime() + 121 * 60_000);
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'background time limit',
    );
    expect(currentCycle(state, cycle).reason).toContain('Step time limit');
    await waitFor(
      () =>
        state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.status ===
        'cancelled',
      'cancel background owner',
    );
    expect(backend.launches).toHaveLength(1);
    expect(backend.sessions[0]?.endCount).toBe(0);
  });

  it('continues a pinned review with test artifacts, preserves them in scratch, and still requires clean review evidence', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: 'Waiting for the matrix.', exitReason: 'background-work-incomplete' },
      { resultText: reviewText([]) },
    ]);
    const artifact = join(worktree.path, 'test-scratch.rs');
    let preserved: string | undefined;
    backend.onLaunch = (request) => {
      if (backend.launches.length === 2) writeFileSync(artifact, 'generated test fixture');
      if (backend.launches.length === 3) {
        expect(request.prompt).toContain(
          'Untracked paths present at continuation preflight: ["test-scratch.rs"]',
        );
        expect(request.prompt).toContain('Do not stage or commit it');
        preserved = join(present(request.temporaryDirectory), 'preserved-test-scratch.rs');
        renameSync(artifact, preserved);
      }
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'artifact recovery',
    );
    expect(readFileSync(present(preserved), 'utf8')).toBe('generated test fixture');
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
    expect(backend.launches.map((r) => r.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'review-model',
    ]);
    expect(backend.launches[3]?.deadlineAt).toBe(backend.launches[2]?.deadlineAt);
    expect(currentCycle(state, cycle)).toMatchObject({
      remediationRounds: 0,
      resultContinuations: 1,
    });
    const runs = state.context.storage.execution.runs.listForWorktree(
      state.workspaceId,
      worktree.id,
    );
    expect(runs[0]?.reviewBranchContext).toEqual(runs[1]?.reviewBranchContext);
  });

  it('cannot approve a continued review while an unknown untracked file remains', async () => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: 'Waiting.', exitReason: 'background-work-incomplete' },
      { resultText: reviewText([]) },
    ]);
    const artifact = join(worktree.path, 'unknown.txt');
    backend.onLaunch = () => {
      if (backend.launches.length === 2) writeFileSync(artifact, 'preserve me');
    };
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
    });
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'dirty continuation',
    );
    expect(backend.launches).toHaveLength(4);
    expect(readFileSync(artifact, 'utf8')).toBe('preserve me');
    expect((await merge(state, worktree.id)).statusCode).toBe(409);
    expect(currentCycle(state, cycle).remediationRounds).toBe(0);
  });

  it.each(['tracked', 'staged', 'index-only', 'head', 'target', 'merge'])(
    'does not continue a review when %s state changed',
    async (change) => {
      const { state, backend, worktree, root } = await cycleFixture([
        designDone,
        implementationDone,
        { resultText: 'Waiting.', exitReason: 'background-work-incomplete' },
      ]);
      backend.onLaunch = () => {
        if (backend.launches.length !== 2) return;
        if (change === 'tracked')
          writeFileSync(join(worktree.path, 'README.md'), 'unreviewed change');
        if (change === 'staged') {
          writeFileSync(join(worktree.path, 'new-source.rs'), 'new source');
          git(['add', '.'], worktree.path);
        }
        if (change === 'index-only') {
          const original = readFileSync(join(worktree.path, 'README.md'), 'utf8');
          writeFileSync(join(worktree.path, 'README.md'), 'staged edit');
          git(['add', 'README.md'], worktree.path);
          writeFileSync(join(worktree.path, 'README.md'), original);
          writeFileSync(join(worktree.path, 'test-scratch.rs'), 'temporary');
        }
        if (change === 'head') commitFile(worktree.path, 'other.txt', 'new commit');
        if (change === 'target') commitFile(root, 'upstream.txt', 'integration advanced');
        if (change === 'merge')
          writeFileSync(
            git(['rev-parse', '--git-path', 'MERGE_HEAD'], worktree.path).trim(),
            git(['rev-parse', 'HEAD'], worktree.path),
          );
      };
      const cycle = await startCycle(state, worktree.id);
      await waitFor(
        () => currentCycle(state, cycle).status === 'needs-attention',
        'changed review baseline',
      );
      expect(backend.launches).toHaveLength(3);
      expect(currentCycle(state, cycle).resultContinuations ?? 0).toBe(0);
      expect(currentCycle(state, cycle).reason).toMatch(
        /Review continuation requires|review baseline changed/,
      );
    },
  );

  it.each(['plain', 'guided', 'reserved'])(
    '%s resume of an interrupted finalization review can classify its artifacts',
    {
      timeout: 15000,
    },
    async (mode) => {
      const fixture = await finalizationFixture();
      const { state, backend } = fixture;
      const normal = present(backend.replyForRequest);
      let interrupted = false;
      let artifact: string | undefined;
      let preserved: string | undefined;
      backend.replyForRequest = (request) => {
        if (!interrupted) {
          interrupted = true;
          return {
            resultText: '## Open questions\nMay I preserve this generated fixture?',
            exitReason: 'background-work-incomplete',
          };
        }
        return normal(request);
      };
      backend.onLaunch = (request) => {
        if (backend.launches.length === 0) {
          artifact = join(request.cwd, 'test-scratch.rs');
          writeFileSync(artifact, 'generated fixture');
        } else if (backend.launches.length === 1) {
          expect(request.prompt).toContain(
            'Continue interrupted verification on the pinned review baseline',
          );
          if (mode === 'guided')
            expect(request.prompt).toContain('Preserve the fixture and finish verification.');
          preserved = join(present(request.temporaryDirectory), 'preserved-fixture.rs');
          renameSync(present(artifact), preserved);
        }
      };
      const value = await beginFinalization(fixture);
      await waitFor(
        () => finalizationCycle(state, value).status === 'needs-attention',
        'question before continuation',
      );
      if (mode === 'reserved') {
        // A restart or failed launch can leave the continuation reserved without a run record.
        const current = finalizationCycle(state, value);
        state.context.storage.transaction((tx) =>
          tx.execution.cycles.replace(
            {
              ...current,
              version: current.version + 1,
              currentRunId: asAgentRunId('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'),
              parentRunId: current.currentRunId,
              resultContinuations: 1,
            },
            current.version,
          ),
        );
      }
      expect(
        (
          await finalizationCommand(state, value, 'resume', {
            ...(mode === 'guided'
              ? { instructions: 'Preserve the fixture and finish verification.' }
              : {}),
          })
        ).statusCode,
      ).toBe(200);
      await waitFor(
        () => finalizationCycle(state, value).status === 'awaiting-merge',
        'guided artifact continuation',
      );
      expect(readFileSync(present(preserved), 'utf8')).toBe('generated fixture');
      expect(finalizationCycle(state, value).remediationRounds).toBe(0);
    },
  );
});

async function findingCheckpointFixture(severity: 'nit' | 'minor' = 'nit', questions = true) {
  const fixture = await finalizationFixture();
  const nit = { ...structuredFinding, severity };
  fixture.backend.replyForRequest = () => ({
    resultText: `## Open questions\n${questions ? 'Fix or defer this finding?' : 'none'}\n\n## Review report\n${reviewText([nit])}`,
  });
  const value = await beginFinalization(fixture, {
    ...fixture.input,
    rounds: [],
    policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
  });
  await waitFor(
    () => finalizationCycle(fixture.state, value).status === 'needs-attention',
    'finding decision',
  );
  return { ...fixture, value, nit };
}

describe('finalization finding decisions', () => {
  it('defers an open nit with provenance, requires fresh independent review, and retains explicit promotion', async () => {
    const { state, backend, value, nit, root } = await findingCheckpointFixture();
    const main = git(['rev-parse', 'main'], root).trim();
    backend.replyForRequest = (request) => {
      expect(request.prompt).toContain('Operator-deferred nits');
      expect(request.prompt).toContain('These findings remain OPEN');
      return { resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([nit])}` };
    };
    const response = await finalizationCommand(state, value, 'defer-nits', {
      findingIds: [nit.id],
      rationale: 'Optional cleanup deferred to follow-up.',
      instructions: 'Defer this nit; no source changes are authorized.',
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'independent review',
    );
    expect(backend.launches).toHaveLength(2);
    expect(backend.launches[1]?.model).toBe('final-review-model');
    const cycle = finalizationCycle(state, value);
    expect(cycle.remediationRounds).toBe(0);
    expect(cycle.reason).toContain('Final independent review meets the completion policy');
    expect(cycle.deferredNits?.[0]).toMatchObject({
      finding: { id: nit.id, status: 'open' },
      createdByUserId: state.userId,
    });
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.cycles.find(state.workspaceId, cycle.id)?.deferredNits).toEqual(
        cycle.deferredNits,
      );
    } finally {
      reopened.close();
    }
    expect(git(['rev-parse', 'main'], root).trim()).toBe(main);
    expect((await merge(state, value.worktreeId)).statusCode).toBe(409);
    const tree = present(
      state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
    );
    const approval = await finalizationCommand(state, value, 'merge', {
      expectedHeadSha: git(['rev-parse', 'HEAD'], tree.path).trim(),
      expectedTargetSha: main,
    });
    expect(approval.statusCode, approval.body).toBe(200);
  });

  it.each(['higher severity', 'changed details', 'technical gate', 'question'])(
    'does not let deferral bypass a subsequent %s',
    async (change) => {
      const { state, backend, value, nit } = await findingCheckpointFixture();
      backend.replyForRequest = () => ({
        resultText: `## Open questions\n${change === 'question' ? 'May I change the API?' : 'none'}\n\n## Review report\n${reviewText(
          [
            change === 'higher severity'
              ? { ...nit, severity: 'minor' }
              : change === 'changed details'
                ? { ...nit, explanation: 'Different concern' }
                : nit,
          ],
        ).replaceAll(
          change === 'technical gate' ? 'mergeable' : '__unchanged__',
          'changes-requested',
        )}`,
      });
      expect(
        (
          await finalizationCommand(state, value, 'defer-nits', {
            findingIds: [nit.id],
            rationale: 'Optional cleanup.',
          })
        ).statusCode,
      ).toBe(200);
      await waitFor(
        () => finalizationCycle(state, value).status === 'needs-attention',
        'new blocker',
      );
      expect(backend.launches).toHaveLength(2);
      expect((await merge(state, value.worktreeId)).statusCode).toBe(409);
    },
  );

  it.each(['head', 'target', 'minor', 'unknown'])(
    'rejects a finding decision after %s changes',
    async (change) => {
      const { state, value, nit, root } = await findingCheckpointFixture(
        change === 'minor' ? 'minor' : 'nit',
      );
      const tree = present(
        state.context.storage.execution.worktrees.find(state.workspaceId, value.worktreeId),
      );
      if (change === 'head') commitFile(tree.path, 'changed.txt', 'changed');
      if (change === 'target') commitFile(root, 'changed.txt', 'changed');
      const response = await finalizationCommand(state, value, 'defer-nits', {
        findingIds: [change === 'unknown' ? 'F-missing' : nit.id],
        rationale: 'Optional cleanup.',
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(finalizationCycle(state, value).deferredNits).toBeUndefined();
    },
  );

  it.each([true, false])(
    'grants focused attempts at an exhausted final review, with open questions: %s',
    async (questions) => {
      const { state, backend, value, nit } = await findingCheckpointFixture('minor', questions);
      backend.replyForRequest = (request) => {
        expect(request.prompt).toContain('Focused remediation batch:');
        if (request.model?.includes('polish') || request.model === 'review-model')
          return { resultText: 'Completed selected cleanup.\n\n## Open questions\nnone' };
        return {
          resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([{ ...nit, status: 'resolved', disposition: 'Selected cleanup verified.' }])}`,
        };
      };
      const response = await finalizationCommand(state, value, 'remediate-findings', {
        findingIds: [nit.id],
        rationale: 'Address this exact cleanup.',
        instructions: 'Fix the selected nit; preserve behavior.',
        additionalRounds: 1,
      });
      expect(response.statusCode, response.body).toBe(200);
      await waitFor(
        () => finalizationCycle(state, value).status === 'awaiting-merge',
        'focused verification',
      );
      expect(finalizationCycle(state, value)).toMatchObject({
        remediationRounds: 1,
        additionalRemediationRounds: 1,
        findingFocus: [nit.id],
      });
      expect(backend.launches).toHaveLength(3);
    },
  );
});

describe('finalization recovery agent selection', () => {
  it.each(['remediate-findings', 'authorize-remediation', 'defer-nits', 'resume'])(
    'switches backend for %s and all later reviews, retaining history and permissions',
    async (action) => {
      const codex = new CycleBackend([], 'codex');
      const fixture = await finalizationFixture({ alternateBackend: codex });
      const { state, backend } = fixture;
      const finding = {
        ...structuredFinding,
        severity: action === 'defer-nits' ? ('nit' as const) : ('minor' as const),
      };
      backend.replyForRequest = () =>
        action === 'resume'
          ? {
              resultText:
                'Interrupted review.\n\n## Open questions\nChoose a backend to finish verification.',
              exitReason: 'background-work-incomplete',
            }
          : { resultText: `## Open questions\nnone\n\n## Review report\n${reviewText([finding])}` };
      const value = await beginFinalization(fixture, {
        ...fixture.input,
        rounds: [],
        finalReview: { ...fixture.input.finalReview, permissionMode: 'edit-only' },
        policy: { ...fixture.input.policy, maxRemediationRounds: 0 },
      });
      await waitFor(
        () => finalizationCycle(state, value).status === 'needs-attention',
        'recovery checkpoint',
      );
      const originalCycle = finalizationCycle(state, value);
      const parent = originalCycle.currentRunId;
      const findings =
        action === 'resume'
          ? []
          : action === 'defer-nits'
            ? [finding]
            : [{ ...finding, status: 'resolved' as const, disposition: 'Verified selected fix.' }];
      codex.replyForRequest = (request) => ({
        resultText: /^Role: review$/m.test(request.prompt)
          ? `## Open questions\nnone\n\n## Review report\n${reviewText(findings)}`
          : 'Fix completed.\n\n## Open questions\nnone',
      });
      const agentOverride = { backend: 'codex', model: 'astra-fixture' };
      const response = await finalizationCommand(state, value, action, {
        agentOverride,
        ...(['remediate-findings', 'authorize-remediation'].includes(action)
          ? { additionalRounds: 1 }
          : {}),
        ...(['remediate-findings', 'defer-nits'].includes(action)
          ? { findingIds: [finding.id], rationale: 'Explicit finding decision.' }
          : {}),
      });
      expect(response.statusCode, response.body).toBe(200);
      await waitFor(
        () => finalizationCycle(state, value).status === 'awaiting-merge',
        'Codex final review',
      );
      expect(backend.launches).toHaveLength(1);
      expect(codex.launches.length).toBe(
        ['remediate-findings', 'authorize-remediation'].includes(action) ? 2 : 1,
      );
      expect(codex.launches.every((r) => r.model === 'astra-fixture')).toBe(true);
      expect(codex.launches.at(-1)?.permissionMode).toBe('edit-only');
      expect(
        state.context.storage.execution.runs
          .listForWorktree(state.workspaceId, value.worktreeId)
          .some((r) => r.backend === 'codex' && r.parentRunId === parent),
      ).toBe(true);
      const cycle = finalizationCycle(state, value);
      const reopened = openCraftingTableStorage(state.context.storage.databasePath);
      try {
        expect(
          reopened.execution.cycles.find(state.workspaceId, cycle.id)?.finalizationAgentOverride,
        ).toEqual(agentOverride);
      } finally {
        reopened.close();
      }
      expect(
        state.context.storage.execution.finalizations.find(state.workspaceId, value.id)
          ?.finalReview,
      ).toEqual(value.finalReview);
      expect(
        state.context.storage.audit
          .listWorkspace({ workspaceId: state.workspaceId, limit: 100 })
          .some(
            (e) =>
              e.metadata?.finalizationAgentOverride &&
              JSON.stringify(e.metadata.finalizationAgentOverride) ===
                JSON.stringify(agentOverride),
          ),
      ).toBe(true);
      expect(
        (
          await finalizationCommand(state, value, 'resume', {
            agentOverride: null,
            expectedCycleVersion: originalCycle.version,
          })
        ).statusCode,
      ).toBe(409);
      expect(finalizationCycle(state, value)).toEqual(cycle);
      if (action === 'remediate-findings') {
        await finalizationCommand(state, value, 'pause');
        backend.replyForRequest = () => ({
          resultText: `## Open questions\nnone\n\n## Review report\n${reviewText(findings)}`,
        });
        expect(
          (await finalizationCommand(state, value, 'resume', { agentOverride: null })).statusCode,
        ).toBe(200);
        await waitFor(
          () => finalizationCycle(state, value).status === 'awaiting-merge',
          'restored review',
        );
        expect(backend.launches.at(-1)?.model).toBe('final-review-model');
        expect(finalizationCycle(state, value).finalizationAgentOverride).toBeNull();
        expect(finalizationCycle(state, value).remediationRounds).toBe(cycle.remediationRounds);
      }
    },
  );
  it('rejects unavailable recovery backends without consuming allowance or replacing the reservation', async () => {
    const { state, value, nit } = await findingCheckpointFixture();
    const before = finalizationCycle(state, value);
    const response = await finalizationCommand(state, value, 'remediate-findings', {
      findingIds: [nit.id],
      rationale: 'Address this finding.',
      additionalRounds: 2,
      agentOverride: { backend: 'codex' },
    });
    expect(response.statusCode).toBe(503);
    expect(finalizationCycle(state, value)).toEqual(before);
  });
});

describe('completed plan and integration branch cleanup', () => {
  async function reviewForPromotion(options: Parameters<typeof finalizationFixture>[0] = {}) {
    const fixture = await finalizationFixture(options);
    const value = await beginFinalization(fixture, { ...fixture.input, rounds: [] });
    await waitFor(
      () => finalizationCycle(fixture.state, value).status === 'awaiting-merge',
      'final review',
    );
    const cycle = finalizationCycle(fixture.state, value);
    const reviewed = present(
      present(
        fixture.state.context.storage.execution.runs.find(
          fixture.state.workspaceId,
          cycle.currentRunId,
        ),
      ).reviewBranchContext,
    );
    return {
      ...fixture,
      value,
      approval: { expectedHeadSha: reviewed.headSha, expectedTargetSha: reviewed.targetSha },
    };
  }

  it('projects historical completion everywhere, scoped to the promoted plan version, and allows later cleanup', async () => {
    const { state, value, root, approval } = await reviewForPromotion();
    expect((await finalizationCommand(state, value, 'remove-integration-branch')).statusCode).toBe(
      409,
    );
    expect((await finalizationCommand(state, value, 'merge', approval)).statusCode).toBe(200);
    const main = git(['rev-parse', 'main'], root).trim();
    expect(git(['rev-parse', 'revision'], root).trim()).toBe(value.integrationSha);
    state.context.storage.planning.projects.setActivePlanVersionIfUnset({
      workspaceId: state.workspaceId,
      projectId: value.projectId,
      planVersionId: value.planVersionId,
    });
    const completion = {
      finalizationId: value.id,
      targetBranch: 'main',
      mergeSha: main,
      completedAt: expect.any(String),
    };
    for (const [url, pick] of [
      [`projects`, (body: { projects: { completion?: unknown }[] }) => present(body.projects[0])],
      [
        `projects/${value.projectId}`,
        (body: { project: { completion?: unknown } }) => body.project,
      ],
      [
        `projects/${value.projectId}/plan-versions/${value.planVersionId}`,
        (body: { version: { completion?: unknown } }) => body.version,
      ],
      ['snapshot', (body: { projects: { completion?: unknown }[] }) => present(body.projects[0])],
    ] as const) {
      const response = await state.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${state.workspaceId}/${url}`,
        headers: { cookie: state.cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(pick(response.json()).completion).toEqual(completion);
    }
    // A later import is preserved independently and never inherits completion.
    const plan = present(
      state.context.storage.planning.versions.find(state.workspaceId, value.planVersionId),
    );
    const next = state.context.storage.planning.versions.insert({
      ...plan,
      id: asPlanVersionId('version-2'),
      versionNumber: 2,
      contentDigest: 'a'.repeat(64),
    });
    expect(
      state.context.storage.planning.queries.versionSummaries(state.workspaceId, value.projectId),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: value.planVersionId, completion }),
        expect.objectContaining({ id: next.id }),
      ]),
    );
    expect(
      state.context.storage.planning.queries.versionCompletion(state.workspaceId, next.id),
    ).toBeUndefined();
    const cleaned = await finalizationCommand(state, value, 'remove-integration-branch', {
      expectedCycleVersion: 1,
    });
    expect(cleaned.statusCode, cleaned.body).toBe(200);
    expect(cleaned.json().finalization).toMatchObject({
      status: 'completed',
      integrationCleanup: { status: 'removed', requestedByUserId: state.userId },
    });
    expect(git(['branch', '--list', 'revision'], root).trim()).toBe('');
    expect(git(['rev-parse', 'main'], root).trim()).toBe(main);
    const settings = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/plan-versions/${value.planVersionId}/branch-settings`,
      headers: { cookie: state.cookie },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json()).toMatchObject({ integrationBranchRemoved: true, issues: [] });
    // A retry of an already completed removal must never delete a recreated branch.
    git(['branch', 'revision', 'main'], root);
    expect((await finalizationCommand(state, value, 'remove-integration-branch')).statusCode).toBe(
      200,
    );
    expect(git(['rev-parse', 'revision'], root).trim()).toBe(main);
  });

  it('retains opt-in through merge interruption and reconciles cleanup without merging twice', async () => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let merges = 0;
    const { state, value, root, approval } = await reviewForPromotion({
      gitOperations: {
        ...real,
        mergeBranch: async (input) => {
          merges++;
          await real.mergeBranch(input);
          throw new Error('Simulated interruption after Git commit');
        },
      },
    });
    expect(
      (
        await finalizationCommand(state, value, 'merge', {
          ...approval,
          removeIntegrationBranch: true,
        })
      ).statusCode,
    ).toBe(500);
    const main = git(['rev-parse', 'main'], root);
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    try {
      expect(reopened.execution.merges.latest(state.workspaceId, value.worktreeId)).toMatchObject({
        status: 'reserved',
        removeIntegrationBranch: true,
      });
    } finally {
      reopened.close();
    }
    const retry = await finalizationCommand(state, value, 'merge', approval);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().finalization.integrationCleanup.status).toBe('removed');
    expect(git(['branch', '--list', 'revision'], root).trim()).toBe('');
    expect(git(['rev-parse', 'main'], root)).toBe(main);
    expect(merges).toBe(1);
  });

  it('retries cleanup after deletion but before its acknowledgement without redoing promotion', async () => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let interrupted = false;
    const { state, value, root, approval } = await reviewForPromotion({
      gitOperations: {
        ...real,
        deleteBranch: async (input) => {
          const result = await real.deleteBranch(input);
          if (input.branchName === 'revision' && !interrupted) {
            interrupted = true;
            throw new Error('Simulated lost cleanup acknowledgement');
          }
          return result;
        },
      },
    });
    const response = await finalizationCommand(state, value, 'merge', {
      ...approval,
      removeIntegrationBranch: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().finalization).toMatchObject({
      status: 'completed',
      integrationCleanup: { status: 'blocked' },
    });
    const main = git(['rev-parse', 'main'], root);
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    try {
      expect(
        reopened.execution.finalizations.find(state.workspaceId, value.id)?.integrationCleanup
          ?.status,
      ).toBe('blocked');
    } finally {
      reopened.close();
    }
    const retry = await finalizationCommand(state, value, 'remove-integration-branch');
    expect(retry.json().finalization.integrationCleanup.status).toBe('removed');
    expect(git(['rev-parse', 'main'], root)).toBe(main);
  });

  it.each(['advanced', 'checked-out', 'protected', 'shared', 'destination-rewound'] as const)(
    'retains a %s branch while leaving the plan completed',
    async (reason) => {
      const { state, value, root, approval } = await reviewForPromotion();
      expect((await finalizationCommand(state, value, 'merge', approval)).statusCode).toBe(200);
      const settings = present(
        state.context.storage.execution.branchSettings.find(state.workspaceId, value.planVersionId),
      );
      if (reason === 'advanced') git(['branch', '-f', 'revision', 'main'], root);
      if (reason === 'checked-out') git(['checkout', 'revision'], root);
      if (reason === 'protected')
        state.context.storage.execution.branchSettings.save(
          { ...settings, manualMergeBranches: ['revision'], version: settings.version + 1 },
          settings.version,
        );
      if (reason === 'shared') {
        const plan = present(
          state.context.storage.planning.versions.find(state.workspaceId, value.planVersionId),
        );
        const next = state.context.storage.planning.versions.insert({
          ...plan,
          id: asPlanVersionId('version-2'),
          versionNumber: 2,
          contentDigest: 'b'.repeat(64),
        });
        state.context.storage.execution.branchSettings.save(
          { ...settings, planVersionId: next.id, version: 1 },
          0,
        );
      }
      if (reason === 'destination-rewound') git(['reset', '--hard', value.targetSha], root);
      const before = git(['rev-parse', 'revision'], root);
      const response = await finalizationCommand(state, value, 'remove-integration-branch');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().finalization).toMatchObject({
        status: 'completed',
        integrationCleanup: { status: 'blocked', error: expect.any(String) },
      });
      expect(git(['rev-parse', 'revision'], root)).toBe(before);
    },
  );
});

function stagedInput(fixture: Awaited<ReturnType<typeof finalizationFixture>>) {
  return {
    ...fixture.input,
    rounds: [],
    stages: FINALIZATION_STAGE_KINDS.map((kind) => ({
      id: kind,
      kind,
      name: kind,
      instructions: `${kind} focus`,
      workItemSourceIds: [],
      review: { ...cycleProfiles.review, model: `${kind}-review` },
      implement: { ...cycleProfiles.remediate, model: `${kind}-implement` },
      policy: { ...DEFAULT_COMPLETION_POLICY, maxNits: 100, maxRemediationRounds: 1 },
      requiredChecks: ['fixture checks'],
    })),
  };
}
function stagedLedger(request: AgentLaunchRequest) {
  const path = /`([^`]+\/craftingtable-finalization-state\.json)`/.exec(request.prompt)?.[1];
  if (!path) throw new Error('Expected staged evidence handoff');
  return JSON.parse(readFileSync(path, 'utf8')) as {
    stages: import('@craftingtable/domain').FinalizationStage[];
    progress: import('@craftingtable/domain').FinalizationProgress;
    reviewBaseline: import('@craftingtable/domain').ReviewBranchContext;
  };
}
function stagedText(
  request: AgentLaunchRequest,
  findings: readonly unknown[] = [],
  overrides: {
    questions?: string;
    evidence?: Record<string, unknown>;
    met?: boolean;
  } = {},
) {
  const ledger = stagedLedger(request);
  const stage = present(ledger.stages[ledger.progress.stageIndex]);
  const verdict = overrides.met === false ? 'changes-requested' : 'mergeable';
  return `## Open questions\n${overrides.questions ?? 'none'}\n\n## Review report\n\`\`\`craftingtable-review\n${JSON.stringify(
    {
      version: 1,
      complete: true,
      verdict,
      exitGate: {
        met: overrides.met ?? true,
        evidence: 'Fixture checks and obligations assessed.',
      },
      findings,
      finalization: {
        stageId: stage.id,
        fullChecks: stage.kind === 'final-review',
        checks: [
          {
            name: 'fixture checks',
            status: 'passed',
            evidence: 'Fixture suite passed at this candidate.',
          },
        ],
        obligations: ledger.progress.obligations.map((o) => ({
          id: o.id,
          status: 'met',
          evidence: 'feature.txt implementation and fixture checks.',
        })),
        ...overrides.evidence,
      },
    },
  )}\n\`\`\`\nVERDICT: ${verdict}`;
}
const stageIdea = {
  ...structuredFinding,
  id: 'S-1',
  category: 'simplification',
  severity: 'minor',
};

describe('staged finalization', () => {
  it('selects one optional batch, retains follow-ups and independently verifies before explicit promotion', {
    timeout: 20000,
  }, async () => {
    const fixture = await finalizationFixture();
    const { state, backend, root } = fixture;
    const input = stagedInput(fixture);
    input.stages = input.stages.map((s) =>
      s.kind === 'simplification' ? { ...s, policy: { ...s.policy, maxRemediationRounds: 0 } } : s,
    );
    const main = git(['rev-parse', 'main'], root);
    let implemented = false;
    backend.onLaunch = (request) => {
      if (request.model === 'simplification-implement') {
        implemented = true;
        commitFile(request.cwd, 'simplified.txt', 'selected S-1 only\n');
      }
    };
    backend.replyForRequest = (request) => {
      if (request.model?.endsWith('-implement'))
        return { resultText: 'Selected batch committed.\n\n## Open questions\nnone' };
      const ledger = stagedLedger(request);
      const current = ledger.stages[ledger.progress.stageIndex];
      const findings =
        current?.kind === 'simplification'
          ? implemented
            ? [
                { ...stageIdea, status: 'resolved', disposition: 'Verified simplified.txt.' },
                { ...stageIdea, id: 'S-3', title: 'A new optional idea' },
              ]
            : [stageIdea, { ...stageIdea, id: 'S-2', title: 'Another optional idea' }]
          : [];
      return { resultText: stagedText(request, findings) };
    };
    const value = await beginFinalization(fixture, input);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'optional selection',
      8000,
    );
    expect(finalizationCycle(state, value).finalizationProgress?.stageIndex).toBe(2);
    expect(finalizationCycle(state, value).finalizationProgress?.stages[2]?.status).toBe(
      'selecting',
    );
    expect(
      (await finalizationCommand(state, value, 'authorize-remediation', { additionalRounds: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await finalizationCommand(state, value, 'remediate-findings', {
          findingIds: ['S-1'],
          rationale: 'select',
          additionalRounds: 1,
        })
      ).statusCode,
    ).toBe(409);
    const resumed = await finalizationCommand(state, value, 'resume');
    expect(resumed.statusCode, resumed.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'review after resume',
    );
    expect(implemented).toBe(false);
    const selected = await finalizationCommand(state, value, 'select-stage-findings', {
      selectedFindingIds: ['S-1'],
      rationale: 'Keep this change focused.',
      additionalRounds: 2,
    });
    expect(selected.statusCode, selected.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'all stages verified',
      10000,
    );
    const cycle = finalizationCycle(state, value);
    const progress = present(cycle.finalizationProgress);
    expect(progress.stages.every((s) => s.status === 'completed')).toBe(true);
    expect(progress.followUps.map((f) => f.id).sort()).toEqual(['S-2', 'S-3']);
    expect(progress.followUps.every((f) => f.status === 'open')).toBe(true);
    expect(progress.stages[2]).toMatchObject({
      selectedFindingIds: ['S-1'],
      remediationRounds: 1,
      additionalRemediationRounds: 2,
    });
    expect(progress.stages[4]?.additionalRemediationRounds).toBe(0);
    expect(cycle.remediationRounds).toBe(1);
    expect(backend.launches.filter((r) => r.model?.endsWith('-implement'))).toHaveLength(1);
    expect(progress.obligations.every((o) => o.status === 'met' && o.source && o.requirement)).toBe(
      true,
    );
    const response = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/plans/version-1/finalizations`,
      headers: { cookie: state.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      finalizationsResponseSchema.parse(response.json()).finalizations[0]?.cycle
        ?.finalizationProgress,
    ).toEqual(progress);
    const reopened = openCraftingTableStorage(state.context.storage.databasePath);
    expect(
      reopened.execution.cycles.find(state.workspaceId, cycle.id)?.finalizationProgress,
    ).toEqual(progress);
    reopened.close();
    const baseline = present(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)
        ?.reviewBranchContext,
    );
    expect(git(['rev-parse', 'main'], root)).toBe(main);
    const promoted = await finalizationCommand(state, value, 'merge', {
      expectedHeadSha: baseline.headSha,
      expectedTargetSha: baseline.targetSha,
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(readFileSync(join(root, 'simplified.txt'), 'utf8')).toContain('selected S-1');
  });

  it('reopens correctness for a later nit regression and retains that stage’s spent budget', {
    timeout: 25000,
  }, async () => {
    const alternate = new CycleBackend([], 'codex');
    const fixture = await finalizationFixture({ alternateBackend: alternate });
    const { state, backend } = fixture;
    let fixes = 0;
    let regression = false;
    const defect = { ...structuredFinding, category: 'correctness', severity: 'nit' };
    const reply = (request: AgentLaunchRequest) => {
      if (/^Role: implement$/m.test(request.prompt))
        return { resultText: 'Committed and checked.\n\n## Open questions\nnone' };
      const ledger = stagedLedger(request);
      const kind = ledger.stages[ledger.progress.stageIndex]?.kind;
      if (kind === 'final-review' && fixes === 1) regression = true;
      return {
        resultText: stagedText(
          request,
          !fixes
            ? [defect]
            : regression
              ? [
                  {
                    ...defect,
                    id: 'C-2',
                    status: fixes > 1 ? 'resolved' : 'open',
                    ...(fixes > 1 ? { disposition: 'Regression checked.' } : {}),
                  },
                ]
              : [{ ...defect, status: 'resolved', disposition: 'Checked initial fix.' }],
        ),
      };
    };
    const launch = (request: AgentLaunchRequest) => {
      if (/^Role: implement$/m.test(request.prompt)) {
        fixes++;
        commitFile(request.cwd, `fix-${fixes}.txt`, 'fixed\n');
      }
    };
    backend.onLaunch = launch;
    alternate.onLaunch = launch;
    backend.replyForRequest = reply;
    alternate.replyForRequest = reply;
    const value = await beginFinalization(fixture, stagedInput(fixture));
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'reopened exhausted stage',
      12000,
    );
    let cycle = finalizationCycle(state, value);
    expect(cycle.reason).toContain('limit');
    expect(cycle.finalizationProgress?.stageIndex).toBe(0);
    expect(cycle.finalizationProgress?.stages[0]?.remediationRounds).toBe(1);
    expect(cycle.finalizationProgress?.stages[4]?.status).toBe('pending');
    expect(
      (
        await finalizationCommand(state, value, 'defer-nits', {
          findingIds: ['C-2'],
          rationale: 'This must not waive correctness.',
        })
      ).statusCode,
    ).toBe(409);
    const recovered = await finalizationCommand(state, value, 'remediate-findings', {
      findingIds: ['C-2'],
      rationale: 'Fix this regression.',
      additionalRounds: 1,
      agentOverride: { backend: 'codex', model: 'recovery-model' },
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'regression and final review',
      10000,
    );
    cycle = finalizationCycle(state, value);
    expect(fixes).toBe(2);
    expect(cycle.finalizationProgress?.stageIndex).toBe(4);
    expect(cycle.finalizationProgress?.stages[0]).toMatchObject({
      remediationRounds: 2,
      additionalRemediationRounds: 1,
    });
    expect(cycle.finalizationProgress?.stages[4]?.additionalRemediationRounds).toBe(0);
    expect(alternate.launches.every((r) => r.model === 'recovery-model')).toBe(true);
    expect(alternate.launches.at(-1)?.prompt).toContain('final-review');
  });

  it('requires an explicit plan adjustment and revalidation without waiving questions or failed checks', {
    timeout: 20000,
  }, async () => {
    const fixture = await finalizationFixture();
    const { state, backend } = fixture;
    let question = true;
    let failed = false;
    backend.replyForRequest = (request) => {
      const ledger = stagedLedger(request);
      const kind = ledger.stages[ledger.progress.stageIndex]?.kind;
      const obligation = present(ledger.progress.obligations[0]);
      if (kind === 'conformance' && !obligation.approvedChange)
        return {
          resultText: stagedText(request, [], {
            met: false,
            questions: 'Approve the narrower obligation?',
            evidence: {
              obligations: ledger.progress.obligations.map((o, i) => ({
                id: o.id,
                status: i ? 'met' : 'change-requested',
                evidence: 'Explicit adjustment needed.',
                ...(!i ? { proposedRequirement: 'Preserve the supported API.' } : {}),
              })),
            },
          }),
        };
      return {
        resultText: stagedText(request, [], {
          questions:
            kind === 'conformance' && question ? 'Which extra behavior is intended?' : 'none',
          met: !failed,
          ...(failed
            ? {
                evidence: {
                  checks: [
                    {
                      name: 'fixture checks',
                      status: 'failed',
                      evidence: 'A required test failed.',
                    },
                  ],
                },
              }
            : {}),
        }),
      };
    };
    const input = stagedInput(fixture);
    input.stages = input.stages.map((s) => ({
      ...s,
      policy: { ...s.policy, maxRemediationRounds: 0 },
    }));
    const value = await beginFinalization(fixture, input);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'plan adjustment',
      6000,
    );
    const obligation = present(
      finalizationCycle(state, value).finalizationProgress?.obligations[0],
    );
    expect(obligation.status).toBe('change-requested');
    const approved = await finalizationCommand(state, value, 'approve-plan-change', {
      obligationId: obligation.id,
      rationale: 'Scope decision for this plan.',
      instructions: 'Keep every required check.',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'remaining question',
    );
    const current = finalizationCycle(state, value);
    expect(current.reason).toContain('open questions');
    expect(current.finalizationProgress?.obligations[0]).toMatchObject({
      requirement: 'Preserve the supported API.',
      approvedChange: {
        previousRequirement: obligation.requirement,
        rationale: 'Scope decision for this plan.',
      },
    });
    question = false;
    failed = true;
    expect(
      (
        await finalizationCommand(state, value, 'resume', {
          instructions: 'Keep supported behavior.',
        })
      ).statusCode,
    ).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'required check failed',
      6000,
    );
    expect(finalizationCycle(state, value).reason).toContain('limit');
    expect(finalizationCycle(state, value).finalizationProgress?.stageIndex).toBe(1);
    expect(backend.launches.every((r) => /^Role: review$/m.test(r.prompt))).toBe(true);
  });

  it('rejects incomplete final evidence and forbids stale or unapproved obligation substitutions', {
    timeout: 15000,
  }, async () => {
    const fixture = await finalizationFixture();
    const { state, backend } = fixture;
    let fullChecks = false;
    backend.replyForRequest = (request) => ({
      resultText: stagedText(request, [], { evidence: { fullChecks } }),
    });
    const value = await beginFinalization(fixture, stagedInput(fixture));
    await waitFor(
      () => finalizationCycle(state, value).status === 'needs-attention',
      'missing final checks',
      9000,
    );
    let cycle = finalizationCycle(state, value);
    expect(cycle.finalizationProgress?.stageIndex).toBe(4);
    const run = present(
      state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    );
    expect(run.verdict).toBeUndefined();
    expect(
      (
        await finalizationCommand(state, value, 'merge', {
          expectedHeadSha: run.reviewBranchContext?.headSha,
          expectedTargetSha: run.reviewBranchContext?.targetSha,
        })
      ).statusCode,
    ).toBe(409);
    fullChecks = true;
    expect(
      (await finalizationCommand(state, value, 'resume', { instructions: 'Run the full checks.' }))
        .statusCode,
    ).toBe(200);
    await waitFor(
      () => finalizationCycle(state, value).status === 'awaiting-merge',
      'complete final checks',
    );
    cycle = finalizationCycle(state, value);
    const detail = await runDetail(state, cycle.currentRunId);
    const assessment = detail.reviewReport;
    if (assessment?.status !== 'complete' || !assessment.report.finalization)
      throw new Error('Expected complete stage evidence');
    const baseline = present(detail.run.reviewBranchContext);
    expect(stagedPromotionIssue(value, cycle, assessment, baseline)).toBeUndefined();
    expect(
      assessStageReport(
        {
          ...value,
          stages: value.stages?.map((s) =>
            s.kind === 'correctness'
              ? { ...s, requiredChecks: [...s.requiredChecks, 'Additional performance gate'] }
              : s,
          ),
        },
        cycle,
        assessment,
        baseline,
      ).status,
    ).toBe('invalid');

    const parked = {
      ...stageIdea,
      status: 'open' as const,
      severity: 'nit' as const,
      category: 'polish' as const,
    };
    const parkedCycle = {
      ...cycle,
      finalizationProgress: { ...present(cycle.finalizationProgress), followUps: [parked] },
    };
    expect(
      evaluateCycleCompletion(
        parkedCycle,
        { ...assessment, report: { ...assessment.report, findings: [parked] } },
        baseline,
      ).action,
    ).toBe('awaiting-merge');
    expect(
      evaluateCycleCompletion(
        parkedCycle,
        {
          ...assessment,
          report: { ...assessment.report, findings: [{ ...parked, category: 'correctness' }] },
        },
        baseline,
      ).action,
    ).toBe('remediate');

    expect(
      stagedPromotionIssue(
        value,
        {
          ...cycle,
          finalizationProgress: {
            ...present(cycle.finalizationProgress),
            obligations: present(cycle.finalizationProgress).obligations.map((o) => ({
              ...o,
              headSha: 'a'.repeat(40),
            })),
          },
        },
        assessment,
        baseline,
      ),
    ).toContain('current');
    const substitute = {
      ...assessment,
      report: {
        ...assessment.report,
        finalization: {
          ...assessment.report.finalization,
          obligations: assessment.report.finalization.obligations.map((o) => ({
            ...o,
            requirement: 'Silently weakened',
          })),
        },
      },
    };
    expect(assessStageReport(value, cycle, substitute, baseline).status).toBe('invalid');
    const missing = {
      ...assessment,
      report: {
        ...assessment.report,
        finalization: { ...assessment.report.finalization, obligations: [] },
      },
    };
    expect(assessStageReport(value, cycle, missing, baseline).status).toBe('invalid');
    const reused = {
      ...assessment,
      report: {
        ...assessment.report,
        finalization: {
          ...assessment.report.finalization,
          obligations: assessment.report.finalization.obligations.map((o) => ({
            ...o,
            reusedFromRunId: cycle.currentRunId,
          })),
        },
      },
    };
    expect(assessStageReport(value, cycle, reused, baseline).status).toBe('invalid');
    const conformanceCycle = {
      ...cycle,
      finalizationProgress: { ...present(cycle.finalizationProgress), stageIndex: 1 },
    };
    const outsideFinal = {
      ...reused,
      report: {
        ...reused.report,
        finalization: { ...reused.report.finalization, stageId: 'conformance' },
      },
    };
    expect(assessStageReport(value, conformanceCycle, outsideFinal, baseline).status).toBe(
      'complete',
    );
    expect(
      assessStageReport(value, conformanceCycle, outsideFinal, {
        ...baseline,
        headSha: 'b'.repeat(40),
      }).status,
    ).toBe('invalid');
  });
});

it('keeps all selected stage findings required when recovery temporarily focuses on a subset', {
  timeout: 20000,
}, async () => {
  const fixture = await finalizationFixture();
  const { state, backend } = fixture;
  const fixed = new Set<string>();
  let implementations = 0;
  backend.onLaunch = (request) => {
    if (/^Role: implement$/m.test(request.prompt)) {
      implementations++;
      if (implementations > 1) {
        const cycle = present(
          state.context.storage.execution.cycles
            .list(state.workspaceId)
            .find((c) => c.finalizationId),
        );
        for (const id of cycle.findingFocus ?? []) fixed.add(id);
      }
      commitFile(request.cwd, `partial-${implementations}.txt`, 'bounded progress\n');
    }
  };
  backend.replyForRequest = (request) => {
    if (/^Role: implement$/m.test(request.prompt))
      return { resultText: 'Committed the partial work.\n\n## Open questions\nnone' };
    const ledger = stagedLedger(request);
    const kind = ledger.stages[ledger.progress.stageIndex]?.kind;
    return {
      resultText: stagedText(
        request,
        kind === 'simplification'
          ? ['S-1', 'S-2'].map((id) => ({
              ...stageIdea,
              id,
              ...(fixed.has(id)
                ? { status: 'resolved', disposition: 'Verified the selected change.' }
                : {}),
            }))
          : [],
      ),
    };
  };
  const value = await beginFinalization(fixture, stagedInput(fixture));
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'stage selection',
    6000,
  );
  expect(
    (
      await finalizationCommand(state, value, 'select-stage-findings', {
        selectedFindingIds: ['S-1', 'S-2'],
        rationale: 'Both changes are worth doing.',
      })
    ).statusCode,
  ).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'selected batch allowance',
  );
  expect(
    (
      await finalizationCommand(state, value, 'remediate-findings', {
        findingIds: ['S-1'],
        rationale: 'Fix the first concern in this attempt.',
        additionalRounds: 1,
      })
    ).statusCode,
  ).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'needs-attention',
    'remaining selected finding',
  );
  const cycle = finalizationCycle(state, value);
  expect(cycle.finalizationProgress?.stageIndex).toBe(2);
  expect(cycle.finalizationProgress?.stages[2]?.selectedFindingIds).toEqual(['S-1', 'S-2']);
  expect(cycle.finalizationProgress?.followUps).toEqual([]);
  const view = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/plans/version-1/finalizations`,
    headers: { cookie: state.cookie },
  });
  expect(view.json().finalizations[0].checkpointFindings.map((f: { id: string }) => f.id)).toEqual([
    'S-2',
  ]);
  expect(
    (
      await finalizationCommand(state, value, 'remediate-findings', {
        findingIds: ['S-2'],
        rationale: 'Finish the original selected batch.',
        additionalRounds: 1,
      })
    ).statusCode,
  ).toBe(200);
  await waitFor(
    () => finalizationCycle(state, value).status === 'awaiting-merge',
    'selected batch complete',
    6000,
  );
  expect(implementations).toBe(3);
});

/* Local scope fixtures exercise execution without claiming the full v0.3 map's future authority. */
async function slicedFixture(
  alterSource?: (
    source: import('@craftingtable/domain').ConcurrencySource,
  ) => import('@craftingtable/domain').ConcurrencySource,
  useRevision = false,
) {
  const fixture = await roadmapFixture();
  if (useRevision) await useIntegration(fixture);
  const { state, repository } = fixture;
  const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]);
  const imported = state.context.services.packageImportService.importConcurrency(
    auth,
    state.workspaceId,
    'map.zip',
    readFileSync(
      new URL(
        '../../../fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip',
        import.meta.url,
      ),
    ),
  );
  const original = state.context.storage.imports.definition(
    state.workspaceId,
    imported.attempt.definitionId!,
  )!;
  const parent = original.source.work_items[0]!;
  const slice = original.source.slices[0]!;
  const id = randomUUID();
  const sources = ['AQ-01.A', 'AQ-01.B'];
  const source: typeof original.source = {
    ...original.source,
    map_id: 'local-scope-fixture',
    resource_locks: original.source.resource_locks.map((l) => ({ ...l, repository: 'local' })),
    repositories: original.source.repositories
      .filter((r) => r.role === 'planned_application')
      .slice(0, 1),
    acceptance_coverage: [],
    baseline_acceptance_coverage: [],
    evidence_profiles: [
      {
        id: 'scope-review',
        required_evidence: ['Tests passed'],
        reviewer_roles: ['independent-reviewer'],
        independence_required: true,
      },
      {
        id: 'work-item-exit',
        required_evidence: ['Original plan conforms'],
        reviewer_roles: ['independent-reviewer'],
        independence_required: true,
      },
    ],
    work_items: [
      {
        ...parent,
        id: 'AQ-01',
        depends_on: [],
        source_exit_gate: 'Queue accepts and drains one job.',
        required_slices: sources,
        acceptance_requires: [],
        acceptance_evidence_profile: 'work-item-exit',
        source_profile_case_ids: ['CASE-PARENT'],
        profile_evidence_slices: [],
        aq_baseline_case_ids: [],
      },
    ],
    slices: sources.map((sourceId) => ({
      ...slice,
      id: sourceId,
      work_item: 'AQ-01',
      title: sourceId,
      scope: `Complete ${sourceId}`,
      excludes: ['Other slice work'],
      start_requires: [],
      merge_requires: [],
      verify_requires: [],
      evidence_profile: 'scope-review',
      decision_refs: [],
      early_start_exception: false,
      aq_baseline_case_ids: [],
      resources_by_phase: { start: [], merge: [], verify: [] },
    })),
  };
  state.context.storage.imports.addDefinition({
    ...original,
    id,
    mapId: source.map_id,
    source: alterSource ? alterSource(source) : source,
    digest: 'b'.repeat(64),
  });
  const settings = state.context.storage.execution.branchSettings.find(
    state.workspaceId,
    asPlanVersionId('version-1'),
  )!;
  state.context.storage.imports.addBindings({
    definitionId: id,
    workspaceId: state.workspaceId,
    revision: 1,
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
    bindings: [
      {
        alias: 'local',
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        repositoryId: repository.id,
        integrationBranch: settings.integrationBranch,
        branchSettingsVersion: settings.version,
        sourceArtifacts: [],
        workItems: state.context.storage.imports
          .definition(state.workspaceId, id)!
          .source.work_items.map((p) => ({
            sourceId: p.id,
            workItemId: p.id === 'AQ-02' ? fixture.second : state.workItemId,
            sourceRecordDigest: 'a'.repeat(64),
          })),
      },
    ],
  });
  state.context.storage.planning.projects.setActivePlanVersionIfUnset({
    workspaceId: state.workspaceId,
    projectId: asProjectId('project-1'),
    planVersionId: asPlanVersionId('version-1'),
  });
  await admit(state);
  const scopes = sources.map((sourceId) => ({
    kind: 'slice' as const,
    definitionId: id,
    bindingRevision: 1,
    sourceId,
  }));
  const parentScope: ExecutionScope = {
    kind: 'parent-acceptance',
    definitionId: id,
    bindingRevision: 1,
    sourceId: 'AQ-01',
  };
  return { ...fixture, auth, scopes, parentScope };
}
async function scopeTree(f: Awaited<ReturnType<typeof slicedFixture>>, scope: ExecutionScope) {
  return f.state.context.services.executionService.createWorktree(
    f.auth,
    f.state.workspaceId,
    f.state.workItemId,
    { repositoryId: f.repository.id, executionScope: scope },
  );
}
function scopeReport(
  state: Ready,
  scope: ExecutionScope,
  omitRequirement = false,
  omitCase = false,
) {
  const resolved = resolveScope(state.context.storage, state.workspaceId, state.workItemId, scope);
  return (
    '```craftingtable-review\n' +
    JSON.stringify({
      version: 1,
      complete: true,
      verdict: 'mergeable',
      exitGate: { met: true, evidence: 'Reviewed' },
      findings: [],
      scopeEvidence: {
        scope,
        requirements: omitRequirement
          ? []
          : scopeRequirements(resolved).map((requirement) => ({
              requirement,
              evidence: 'Verified against tests and source.',
            })),
        caseIds: omitCase ? [] : scopeCases(resolved),
      },
    }) +
    '\n```\nVERDICT: mergeable'
  );
}
function runScopedFixtureCheck(request: import('@craftingtable/agents').AgentLaunchRequest) {
  if (!request.buildEnvironment) return;
  const manifest = JSON.parse(
    readFileSync(join(request.buildEnvironment.binDirectory, '../manifest.json'), 'utf8'),
  );
  if (manifest.verification?.mode === 'scoped-checks')
    execFileSync(
      join(request.buildEnvironment.binDirectory, 'ct-check'),
      ['--', '/usr/bin/git', 'diff', '--check', 'HEAD'],
      { cwd: request.cwd },
    );
}
async function reviewScope(
  f: Awaited<ReturnType<typeof slicedFixture>>,
  tree: import('@craftingtable/domain').Worktree,
  omitRequirement = false,
  omitCase = false,
) {
  f.backend.replyForRequest = (request) => {
    runScopedFixtureCheck(request);
    return { resultText: scopeReport(f.state, tree.executionScope!, omitRequirement, omitCase) };
  };
  return runToFinish(f.state, tree.id, { role: 'review' });
}
async function recordScope(
  f: Awaited<ReturnType<typeof slicedFixture>>,
  tree: import('@craftingtable/domain').Worktree,
  headers = mutationHeaders(f.state),
) {
  return f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/worktrees/${tree.id}/scope-evidence`,
    headers,
    payload: {
      expectedWorktreeVersion: f.state.context.storage.execution.worktrees.find(
        f.state.workspaceId,
        tree.id,
      )!.version,
    },
  });
}

describe('execution slices and parent acceptance', () => {
  it('keeps sibling merges separate, verifies exact scopes and accepts the independently reviewed parent', async () => {
    const f = await slicedFixture(),
      { state, root } = f;
    const a = await scopeTree(f, f.scopes[0]!),
      b = await scopeTree(f, f.scopes[1]!);
    expect(a.branchName).not.toBe(b.branchName);
    expect(a.path).not.toBe(b.path);
    await expect(scopeTree(f, f.scopes[0]!)).rejects.toThrow('active worktree');
    await expect(scopeTree(f, { ...f.scopes[0]!, sourceId: 'foreign-slice' })).rejects.toThrow();
    await expect(scopeTree(f, f.parentScope)).rejects.toThrow('has not merged');
    await expect(scopeTree(f, { ...f.scopes[0]!, kind: 'slice-verification' })).rejects.toThrow(
      'Merge this slice',
    );
    await expect(
      state.context.services.executionService.createWorktree(
        f.auth,
        state.workspaceId,
        state.workItemId,
        { repositoryId: f.repository.id },
      ),
    ).rejects.toThrow('uses execution slices');
    commitFile(a.path, 'a.txt', 'A');
    await reviewScope(f, a, true);
    expect((await merge(state, a.id)).statusCode).toBe(409);
    await reviewScope(f, a);
    const landedA = await merge(state, a.id);
    expect(landedA.statusCode, landedA.body).toBe(200);
    expect(landedA.json().workItemCompleted).toBe(false);
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    const bypass = await branchCommand(state, `work-items/${state.workItemId}/complete`, {});
    expect(bypass.statusCode, bypass.body).toBe(409);
    const evidenceA = await recordScope(f, a);
    expect(evidenceA.statusCode, evidenceA.body).toBe(200);
    expect(evidenceA.json()).toEqual({ recorded: true, workItemCompleted: false });
    // Sibling branch must refresh and receive its own fresh review after integration advances.
    git(['merge', '--no-edit', 'main'], b.path);
    commitFile(b.path, 'b.txt', 'B');
    await reviewScope(f, b);
    const landedB = await merge(state, b.id);
    expect(landedB.statusCode, landedB.body).toBe(200);
    await expect(scopeTree(f, f.parentScope)).rejects.toThrow('has not been verified');
    expect((await recordScope(f, b)).statusCode).toBe(200);
    const acceptance = await scopeTree(f, f.parentScope);
    const disallowed = await branchCommand(state, `work-items/${state.workItemId}/runs`, {
      worktreeId: acceptance.id,
      role: 'implement',
    });
    expect(disallowed.statusCode, disallowed.body).toBe(409);
    await reviewScope(f, acceptance, false, true);
    const missingCase = await recordScope(f, acceptance);
    expect(missingCase.statusCode, missingCase.body).toBe(409);
    expect(missingCase.body).toContain('CASE-PARENT');
    await reviewScope(f, acceptance);
    expect((await merge(state, acceptance.id)).statusCode).toBe(409);
    commitFile(root, 'post-review.txt', 'Integration advanced after review');
    const staleParent = await recordScope(f, acceptance);
    expect(staleParent.statusCode, staleParent.body).toBe(409);
    git(['merge', '--no-edit', 'main'], acceptance.path);
    await reviewScope(f, acceptance);
    const accepted = await recordScope(f, acceptance);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ recorded: true, workItemCompleted: true });
    expect((await recordScope(f, acceptance)).json()).toEqual({
      recorded: false,
      workItemCompleted: true,
    });
    const item = state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId);
    expect(item?.status).toBe('completed');
    expect(item?.mergeSha).toBe(git(['rev-parse', 'main'], root).trim());
    expect(
      state.context.storage.planning.dependencies.listPredecessors(state.workspaceId, f.second)[0]
        ?.status,
    ).toBe('completed');
    const reopened = openCraftingTableStorage(state.context.config.databasePath);
    try {
      expect(reopened.scopeReceipts.list(state.workspaceId, state.workItemId)).toHaveLength(3);
      expect(reopened.execution.worktrees.find(state.workspaceId, a.id)?.executionScope).toEqual(
        f.scopes[0],
      );
    } finally {
      reopened.close();
    }
    expect(f.backend.launches.at(-1)?.prompt).toContain('Original plan conforms');
    expect(f.backend.launches.at(-1)?.prompt).toContain('CASE-PARENT');
    const lastRun = state.context.storage.execution.runs.listForWorktree(
      state.workspaceId,
      acceptance.id,
    )[0]!;
    const ledger = JSON.parse(
      readFileSync(
        join(
          state.context.config.execution.runsRoot,
          lastRun.id,
          'plan',
          'craftingtable-scope-evidence.json',
        ),
        'utf8',
      ),
    );
    expect(ledger.receipts).toHaveLength(2);
    const db = openDatabase(state.context.config.databasePath);
    try {
      expect(() => db.prepare('UPDATE scope_receipts SET record_json = record_json').run()).toThrow(
        'immutable',
      );
      expect(() =>
        db.prepare('UPDATE worktrees SET execution_scope_json = NULL WHERE id = ?').run(a.id),
      ).toThrow('immutable');
    } finally {
      db.close();
    }
  });
  it('allows sibling cycles and persists their scope through roadmap reservations', {
    timeout: 15000,
  }, async () => {
    const f = await slicedFixture(),
      { state } = f;
    f.backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? designDone
        : request.model === 'review-model'
          ? {
              resultText: scopeReport(
                state,
                state.context.storage.execution.worktrees
                  .listForWorkItem(state.workspaceId, state.workItemId)
                  .find((t) => t.path === request.cwd)!.executionScope!,
              ),
            }
          : implementationDone;
    const input = {
      ...roadmapInput(state, [state.workItemId, state.workItemId]),
      scheduling: {
        mode: 'parallel',
        maxInFlight: 2,
        maxPerRepository: 2,
        maxIntegrationRefreshes: 3,
      },
      entries: roadmapInput(state, [state.workItemId, state.workItemId]).entries.map((e, i) => ({
        ...e,
        executionScope: f.scopes[i],
      })),
    };
    const saved = await saveRoadmapRequest(state, input);
    expect(saved.statusCode, saved.body).toBe(200);
    await roadmapControl(state, 'start');
    await waitFor(
      () => state.context.storage.execution.cycles.list(state.workspaceId).length === 2,
      'two sibling cycles',
      8000,
    );
    const cycles = state.context.storage.execution.cycles.list(state.workspaceId);
    expect(new Set(cycles.map((c) => c.executionScope?.sourceId)).size).toBe(2);
    expect(new Set(cycles.map((c) => c.worktreeId)).size).toBe(2);
    for (const cycle of cycles)
      await waitFor(
        () => {
          const c = currentCycle(state, cycle);
          if (c.status === 'needs-attention') throw new Error(c.reason);
          return c.status === 'awaiting-merge';
        },
        `review ${cycle.executionScope?.sourceId}`,
        8000,
      );
    const first = cycles[0]!,
      second = cycles[1]!;
    await mergeRoadmapAttempt(state, first.worktreeId);
    await waitFor(
      () =>
        currentCycle(state, second).integrationRefreshes === 1 &&
        currentCycle(state, second).status === 'awaiting-merge',
      'fresh slice review',
      6000,
    );
    await mergeRoadmapAttempt(state, second.worktreeId);
    await waitFor(() => storedRoadmap(state).status === 'completed', 'slice roadmap completed');
    expect(
      state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
    ).toBe('admitted');
    expect(
      state.context.storage.planning.dependencies.listPredecessors(state.workspaceId, f.second)[0]
        ?.status,
    ).toBe('admitted');
  });
  it('rejects stale integration evidence, supports fresh verification, and keeps older bound attempts visible', async () => {
    const f = await slicedFixture(),
      { state, root } = f;
    const a = await scopeTree(f, f.scopes[0]!);
    commitFile(a.path, 'a.txt', 'A');
    await reviewScope(f, a);
    expect((await merge(state, a.id)).statusCode).toBe(200);
    commitFile(root, 'later.txt', 'Later integration change');
    const stale = await recordScope(f, a);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.body).toContain('fresh slice verification');
    const verification = await scopeTree(f, { ...f.scopes[0]!, kind: 'slice-verification' });
    await reviewScope(f, verification);
    const badCsrf = await recordScope(f, verification, {
      ...mutationHeaders(state),
      'x-craftingtable-csrf': 'bad',
    });
    expect(badCsrf.statusCode).toBe(403);
    const accepted = await recordScope(f, verification);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const old = state.context.storage.imports.bindings(
      state.workspaceId,
      f.scopes[0]!.definitionId,
    )[0]!;
    state.context.storage.imports.addBindings({ ...old, revision: 2 });
    const choices = state.context.services.executionService.executionScopes(
      f.auth,
      state.workspaceId,
      state.workItemId,
    ).choices;
    expect(choices[0]?.scope.bindingRevision).toBe(1);
    expect(choices[0]?.status).toBe('merged'); // Historical receipt remains visible but cannot approve a superseded binding.
    const settings = state.context.storage.execution.branchSettings.find(
      state.workspaceId,
      asPlanVersionId('version-1'),
    )!;
    state.context.storage.execution.branchSettings.save(
      { ...settings, version: settings.version + 1 },
      settings.version,
    );
    await expect(scopeTree(f, f.scopes[1]!)).rejects.toThrow('binding changed');
  });
});

it('enforces slice phase requirements in manual controls without treating checkpoints as passed', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s, i) =>
      i === 0
        ? s
        : {
            ...s,
            start_requires: [{ kind: 'slice', id: 'AQ-01.A', state: 'merged' }],
            verify_requires: [{ kind: 'checkpoint', id: 'external-proof', state: 'passed' }],
          },
    ),
  }));
  await expect(scopeTree(f, f.scopes[1]!)).rejects.toThrow('must be merged');
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewScope(f, a);
  expect((await merge(f.state, a.id)).statusCode).toBe(200);
  const b = await scopeTree(f, f.scopes[1]!);
  commitFile(b.path, 'b.txt', 'B');
  await reviewScope(f, b);
  expect((await merge(f.state, b.id)).statusCode).toBe(200);
  const evidence = await recordScope(f, b);
  expect(evidence.statusCode, evidence.body).toBe(409);
  expect(evidence.body).toContain('Checkpoint external-proof must pass');
  expect(
    f.state.context.storage.scopeReceipts.list(f.state.workspaceId, f.state.workItemId),
  ).toHaveLength(0);
});

/* Transition scheduling coordinates daemon work without asserting external qualification. */
function withLocalPhaseResources(source: import('@craftingtable/domain').ConcurrencySource) {
  return {
    ...source,
    slices: source.slices.map((s) => ({
      ...s,
      resources_by_phase: {
        start: ['isolated-development-workspace'],
        merge: ['isolated-development-workspace'],
        verify: ['isolated-development-workspace'],
      },
    })),
  };
}
async function launchScoped(
  f: Awaited<ReturnType<typeof slicedFixture>>,
  tree: import('@craftingtable/domain').Worktree,
) {
  return f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
    headers: mutationHeaders(f.state),
    payload: { worktreeId: tree.id, role: 'design', permissionMode: 'auto' },
  });
}
it('phase reservations serialize competing launches and release on terminal failure, cancellation and restart', async () => {
  const f = await slicedFixture(withLocalPhaseResources),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  const responses = await Promise.all([launchScoped(f, a), launchScoped(f, b)]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const successful = responses.find((r) => r.statusCode === 200)!;
  const run = startAgentRunResponseSchema.parse(successful.json()).run;
  expect(state.context.storage.phaseScheduling.active()).toMatchObject([
    { ownerId: run.id, phase: 'start', resourceKey: 'local-development' },
  ]);
  const occupied = responses[0]!.statusCode === 200 ? a : b;
  const free = occupied.id === a.id ? b : a;
  const cancelled = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/cancel`,
    headers: mutationHeaders(state),
    payload: {},
  });
  expect(cancelled.statusCode).toBe(200);
  await waitFor(
    () => !state.context.storage.phaseScheduling.active().length,
    'reservation released',
  );
  f.backend.failNextLaunch = true;
  const failed = await launchScoped(f, free);
  expect(failed.statusCode, failed.body).toBe(200);
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
  const fresh = await launchScoped(f, free);
  expect(fresh.statusCode, fresh.body).toBe(200);
  const reopened = openCraftingTableStorage(state.context.storage.databasePath);
  expect(reopened.phaseScheduling.active()).toHaveLength(1);
  reopened.close();
  state.context.services.agentRunService.recoverInterrupted();
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
});
it('phase resources reserve all or none and release Git reservations after a failed operation', async () => {
  const { reservePhase, withPhaseReservation } = await import('./services/phase-resources.js');
  const f = await slicedFixture(withLocalPhaseResources),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  const resolved = resolveScope(
    state.context.storage,
    state.workspaceId,
    state.workItemId,
    f.scopes[0]!,
  );
  state.context.storage.transaction((tx) =>
    reservePhase(tx, resolved, b, 'merge', 'operation:held', new Date().toISOString()),
  );
  const before = state.context.storage.phaseScheduling.active();
  await expect(
    withPhaseReservation(state.context.storage, resolved, a, 'merge', async () => {
      throw new Error('must not run');
    }),
  ).rejects.toThrow('repository:');
  expect(state.context.storage.phaseScheduling.active()).toEqual(before);
  state.context.storage.transaction((tx) =>
    tx.phaseScheduling.release('operation:held', new Date().toISOString(), 'test-finished'),
  );
  await expect(
    withPhaseReservation(state.context.storage, resolved, a, 'merge', async () => {
      throw new Error('Git failure');
    }),
  ).rejects.toThrow('Git failure');
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
});
it('phase gates let development merge while qualified verification waits without holding resources', async () => {
  const f = await slicedFixture((source) => ({
    ...withLocalPhaseResources(source),
    slices: withLocalPhaseResources(source).slices.map((s) => ({
      ...s,
      resources_by_phase: { ...s.resources_by_phase, verify: ['controlled-native-test-host'] },
    })),
  }));
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewScope(f, a);
  expect(f.state.context.storage.phaseScheduling.active()).toHaveLength(0);
  const merged = await merge(f.state, a.id);
  expect(merged.statusCode, merged.body).toBe(200);
  const receipt = await recordScope(f, a);
  expect(receipt.statusCode, receipt.body).toBe(409);
  expect(receipt.body).toContain('fresh slice-verification');
  expect(f.state.context.storage.phaseScheduling.active()).toHaveLength(0);
  expect(f.state.context.services.executionService.branches.repositoryBusy(f.root)).toBe(false);
  await expect(scopeTree(f, f.scopes[1]!)).resolves.toHaveProperty('executionScope', f.scopes[1]);
  const view = f.state.context.services.executionService.executionScopes(
    f.auth,
    f.state.workspaceId,
    f.state.workItemId,
  );
  expect(view.choices[0]?.phases.find((p) => p.phase === 'verify')?.blockers).toContainEqual(
    expect.objectContaining({ kind: 'authorization' }),
  );
});
it('phase gates require explicit bound early-development authorization but retain parent barriers', async () => {
  const f = await slicedFixture((source) => ({
      ...source,
      slices: source.slices.map((s) => ({ ...s, early_start_exception: true })),
    })),
    { state } = f;
  // A required external parent is incomplete; avoid a cycle with the fixture's AQ-02 successor.
  const predecessor = asWorkItemId('external-parent');
  state.context.storage.planning.workItems.insertMany([
    {
      id: predecessor,
      workspaceId: state.workspaceId,
      projectId: asProjectId('project-1'),
      planVersionId: asPlanVersionId('version-1'),
      sourceId: 'PRE',
      ordinal: 3,
      title: 'Predecessor',
      risk: 'low',
      primaryAreas: [],
      exitGate: 'Done',
      sourceFields: { id: 'PRE' },
    },
  ]);
  state.context.storage.planning.dependencies.insertMany([
    {
      id: asWorkItemDependencyId('early-edge'),
      workspaceId: state.workspaceId,
      planVersionId: asPlanVersionId('version-1'),
      predecessorWorkItemId: predecessor,
      successorWorkItemId: state.workItemId,
      kind: 'required',
      ordinal: 1,
    },
  ]);
  await expect(scopeTree(f, f.scopes[0]!)).rejects.toThrow('Parent predecessor');
  const url = `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/scope-scheduling`;
  const denied = await state.context.app.inject({
    method: 'POST',
    url,
    headers: { cookie: state.cookie },
    payload: { scope: f.scopes[0] },
  });
  expect(denied.statusCode).toBe(403);
  const authorized = await state.context.app.inject({
    method: 'POST',
    url,
    headers: mutationHeaders(state),
    payload: { scope: f.scopes[0] },
  });
  expect(authorized.statusCode, authorized.body).toBe(200);
  const a = await scopeTree(f, f.scopes[0]!);
  await expect(scopeTree(f, f.scopes[1]!)).rejects.toThrow('Parent predecessor');
  commitFile(a.path, 'early.txt', 'Early');
  await reviewScope(f, a);
  const merged = await merge(state, a.id);
  expect(merged.statusCode, merged.body).toBe(200);
  await expect(scopeTree(f, f.parentScope)).rejects.toThrow('Parent predecessor');
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('admitted');
  expect(
    state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 100 })
      .filter((e) => e.action === 'scope.scheduling-authorized'),
  ).toHaveLength(1);
});
it('phase resource waits resume cycles automatically without consuming the execution deadline', async () => {
  const f = await slicedFixture(withLocalPhaseResources),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  const started = await launchScoped(f, a);
  const run = startAgentRunResponseSchema.parse(started.json()).run;
  const cycle = await startCycle(state, b.id);
  await waitFor(() => !!currentCycle(state, cycle).phaseWait, 'queued for resources');
  expect(currentCycle(state, cycle).status).toBe('running');
  expect(
    state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
  ).toBeUndefined();
  const deadline = currentCycle(state, cycle).runDeadlineAt;
  await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/runs/${run.id}/end`,
    headers: mutationHeaders(state),
    payload: {},
  });
  await waitFor(
    () => !!state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId),
    'queued cycle starts',
    6000,
  );
  expect(Date.parse(currentCycle(state, cycle).runDeadlineAt)).toBeGreaterThan(
    Date.parse(deadline),
  );
  expect(currentCycle(state, cycle).phaseWait).toBeNull();
});
it('phase merge dependencies let an independent sibling integrate first and then refresh the waiting review', {
  timeout: 20000,
}, async () => {
  const f = await slicedFixture(
      (source) => ({
        ...withLocalPhaseResources(source),
        slices: withLocalPhaseResources(source).slices.map((s, i) =>
          i === 0
            ? { ...s, merge_requires: [{ kind: 'slice', id: 'AQ-01.B', state: 'merged' }] }
            : s,
        ),
      }),
      true,
    ),
    { state } = f;
  f.backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? {
            resultText: scopeReport(
              state,
              state.context.storage.execution.worktrees
                .listForWorkItem(state.workspaceId, state.workItemId)
                .find((t) => t.path === request.cwd)!.executionScope!,
            ),
          }
        : implementationDone;
  const saved = await saveRoadmapRequest(state, {
    ...roadmapInput(state, [state.workItemId, state.workItemId]),
    scheduling: {
      mode: 'parallel',
      maxInFlight: 2,
      maxPerRepository: 2,
      maxIntegrationRefreshes: 3,
    },
    automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
    entries: roadmapInput(state, [state.workItemId, state.workItemId]).entries.map((e, i) => ({
      ...e,
      executionScope: f.scopes[i],
    })),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(
    () => {
      const r = storedRoadmap(state);
      const stalled = state.context.storage.execution.cycles
        .list(state.workspaceId)
        .find((c) => c.status === 'needs-attention');
      if (stalled) throw new Error(stalled.reason);
      if (
        r.status === 'needs-attention' ||
        Object.values(r.entryHolds ?? {}).some((h) => h.status === 'needs-attention')
      )
        throw new Error(JSON.stringify(r));
      return r.status === 'completed';
    },
    'phase dependency roadmap completes',
    14000,
  );
  const trees = state.context.storage.execution.worktrees.listForWorkItem(
    state.workspaceId,
    state.workItemId,
  );
  const a = trees.find((t) => t.executionScope?.sourceId === 'AQ-01.A')!,
    b = trees.find((t) => t.executionScope?.sourceId === 'AQ-01.B')!;
  expect(git(['merge-base', '--is-ancestor', b.mergeSha!, a.mergeSha!], f.root)).toBe('');
  expect(
    state.context.storage.execution.cycles
      .list(state.workspaceId)
      .find((c) => c.worktreeId === a.id)?.integrationRefreshes,
  ).toBeGreaterThanOrEqual(1);
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
  expect(
    state.context.storage.planning.workItems.find(state.workspaceId, state.workItemId)?.status,
  ).toBe('admitted');
});
it('phase verification capacity is separate and restart releases operation reservations without erasing history', async () => {
  const { reservePhase } = await import('./services/phase-resources.js');
  const f = await slicedFixture(withLocalPhaseResources),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!),
    b = await scopeTree(f, f.scopes[1]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  const r = resolveScope(state.context.storage, state.workspaceId, state.workItemId, f.scopes[0]!);
  state.context.storage.transaction((tx) =>
    reservePhase(tx, r, a, 'verify', 'operation:verification', new Date().toISOString()),
  );
  const run = await launchScoped(f, b);
  expect(run.statusCode, run.body).toBe(200);
  expect(
    state.context.storage.phaseScheduling
      .active()
      .map((r) => r.resourceKey)
      .sort(),
  ).toEqual(['local-development', 'local-verification']);
  const db = openDatabase(state.context.storage.databasePath);
  expect(() => db.prepare('DELETE FROM phase_reservations').run()).toThrow('immutable');
  db.close();
  state.context.services.agentRunService.recoverInterrupted();
  expect(state.context.storage.phaseScheduling.active()).toHaveLength(0);
  const reopened = openDatabase(state.context.storage.databasePath);
  expect(
    reopened
      .prepare('SELECT count(*) AS n FROM phase_reservations WHERE released_at IS NOT NULL')
      .get(),
  ).toMatchObject({ n: 2 });
  reopened.close();
});
it('phase verification worktrees do not consume roadmap development capacity', async () => {
  const f = await slicedFixture(withLocalPhaseResources),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!);
  commitFile(a.path, 'a.txt', 'A');
  await reviewScope(f, a);
  expect((await merge(state, a.id)).statusCode).toBe(200);
  const verification = await scopeTree(f, { ...f.scopes[0]!, kind: 'slice-verification' });
  f.backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? designDone
      : request.model === 'review-model'
        ? { resultText: scopeReport(state, f.scopes[1]!) }
        : implementationDone;
  const input = roadmapInput(state, [state.workItemId]);
  const saved = await saveRoadmapRequest(state, {
    ...input,
    scheduling: {
      mode: 'parallel',
      maxInFlight: 1,
      maxPerRepository: 1,
      maxIntegrationRefreshes: 3,
    },
    entries: input.entries.map((e) => ({ ...e, executionScope: f.scopes[1] })),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .list(state.workspaceId)
        .some((c) => c.status === 'awaiting-merge'),
    'development beside pending verification',
    6000,
  );
  expect(
    state.context.storage.execution.worktrees.find(state.workspaceId, verification.id)?.status,
  ).toBe('active');
  expect(
    state.context.storage.scopeReceipts.list(state.workspaceId, state.workItemId),
  ).toHaveLength(0);
});
it('phase started milestones require a launched run, not a cycle queued for resources', async () => {
  const { reservePhase } = await import('./services/phase-resources.js');
  const f = await slicedFixture((source) => ({
      ...withLocalPhaseResources(source),
      slices: withLocalPhaseResources(source).slices.map((s, i) =>
        i ? { ...s, start_requires: [{ kind: 'slice', id: 'AQ-01.A', state: 'started' }] } : s,
      ),
    })),
    { state } = f;
  const a = await scopeTree(f, f.scopes[0]!);
  state.context.storage.phaseScheduling.setCapacity('local-development', 1);
  state.context.storage.transaction((tx) =>
    reservePhase(
      tx,
      resolveScope(tx, state.workspaceId, state.workItemId, f.scopes[0]!),
      a,
      'start',
      'operation:held',
      new Date().toISOString(),
    ),
  );
  const cycle = await startCycle(state, a.id);
  await waitFor(() => !!currentCycle(state, cycle).phaseWait, 'queued start');
  await expect(scopeTree(f, f.scopes[1]!)).rejects.toThrow('must be started');
  state.context.storage.transaction((tx) =>
    tx.phaseScheduling.release('operation:held', new Date().toISOString(), 'test-finished'),
  );
  await waitFor(
    () =>
      !!state.context.storage.execution.runs.find(state.workspaceId, cycle.currentRunId)?.startedAt,
    'real start',
    6000,
  );
  const { scopePhaseBlockers } = await import('./services/execution-scope.js');
  expect(
    scopePhaseBlockers(
      state.context.storage,
      state.workspaceId,
      state.workItemId,
      f.scopes[1]!,
      'start',
      { resources: false },
    ),
  ).toEqual([]);
});

async function evidenceFixture(checkpointOwner = 'local') {
  const f = await slicedFixture((source) => ({
    ...source,
    repositories: source.repositories.map((r) => ({ ...r, id: 'local' })),
    work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
    checkpoints: [
      {
        ...source.checkpoints[0]!,
        id: 'LOCAL-QUALIFIED',
        kind: 'contract',
        owner: checkpointOwner,
        requires: [],
        decision_refs: [],
        evidence_profile: 'scope-review',
        pass_criteria: ['Exact source tested'],
      },
      {
        ...source.checkpoints[0]!,
        id: 'LOCAL-PUBLISHED',
        kind: 'release',
        owner: checkpointOwner,
        requires: [{ kind: 'checkpoint', id: 'LOCAL-QUALIFIED', state: 'passed' }],
        decision_refs: [],
        evidence_profile: 'scope-review',
        pass_criteria: ['Publication retrieved'],
      },
    ],
    acceptance_coverage: [
      {
        id: 'CASE-LOCAL',
        source_id: 'local',
        source_record_sha256: 'c'.repeat(64),
        owner_work_item: 'AQ-01',
        producing_slices: ['AQ-01.A'],
        checkpoint: 'LOCAL-QUALIFIED',
        requires_kata_host: true,
        evidence_status_on_import: 'unresolved',
      },
    ],
  }));
  const svc = f.state.context.services.runtimeEvidenceService,
    definitionId = f.parentScope.definitionId;
  const input = {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [],
    consumers: [{ alias: 'local', upstreams: [] }],
    environments: [
      {
        id: 'native',
        kind: 'external-native' as const,
        identityDigest: '1'.repeat(64),
        fixtureDigest: '2'.repeat(64),
        toolchainDigest: '3'.repeat(64),
        authorization: 'Local fixture operator authorizes isolated test fixtures.',
      },
      {
        id: 'kata',
        kind: 'external-kata' as const,
        identityDigest: '4'.repeat(64),
        fixtureDigest: '2'.repeat(64),
        toolchainDigest: '3'.repeat(64),
        authorization: 'Operator authorizes this actual Kata host and VM.',
      },
    ],
  };
  const view = await svc.configure(f.auth, f.state.workspaceId, definitionId, input);
  const spec = view.subjects.find((s) => s.subject.sourceId === 'LOCAL-QUALIFIED')!;
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: f.root,
    encoding: 'utf8',
  }).trim();
  const submission: import('@craftingtable/contracts').EvidenceSubmissionRequest = {
    runtimeId: view.current!.id,
    subject: spec.subject,
    subjectCommit: head,
    environmentId: 'kata',
    executedBy: 'implementation-author',
    executedAt: new Date().toISOString(),
    reviewers: [
      { identity: 'independent-reviewer', roles: spec.reviewerRoles, artifact: 'review' },
    ],
    requirements: spec.requirements.map((requirement) => ({ requirement, artifact: 'log' })),
    cases: spec.cases.map((c) => ({
      id: c.id,
      sourceRecordDigest: c.sourceRecordDigest,
      result: 'passed',
      artifact: 'log',
    })),
    artifacts: [
      { name: 'log', content: 'actual host/VM observations and passing case output' },
      {
        name: 'review',
        content: 'Independent reviewer examined source and reproduced the required case.',
      },
    ],
    kata: {
      runtime: 'kata',
      hostIdentity: 'test-host',
      vmIdentity: 'test-vm',
      imageDigest: '5'.repeat(64),
      configurationDigest: '6'.repeat(64),
      observationArtifact: 'log',
      noNativeFallback: true,
    },
  };
  return { ...f, svc, definitionId, input, view, submission };
}
it('requires independently reviewed exact case coverage and distinguishes native from actual Kata', async () => {
  const f = await evidenceFixture(),
    ws = f.state.workspaceId;
  const submit = (input: import('@craftingtable/contracts').EvidenceSubmissionRequest) =>
    f.svc.submit(f.auth, ws, f.definitionId, input);
  await expect(submit({ ...f.submission, cases: [] })).rejects.toThrow('CASE-LOCAL');
  await expect(
    submit({ ...f.submission, cases: [...f.submission.cases, ...f.submission.cases] }),
  ).rejects.toThrow('Duplicate case');
  await expect(
    submit({
      ...f.submission,
      cases: f.submission.cases.map((c) => ({ ...c, sourceRecordDigest: 'a'.repeat(64) })),
    }),
  ).rejects.toThrow('exact source record');
  await expect(submit({ ...f.submission, executedBy: 'independent-reviewer' })).rejects.toThrow(
    'independent review',
  );
  const { kata: _kata, ...native } = f.submission;
  await expect(submit({ ...native, environmentId: 'native' })).rejects.toThrow('Actual Kata');
  const submitted = await submit(f.submission);
  const s = submitted.submissions[0]!;
  expect(s.decision).toBeUndefined();
  const accepted = await f.svc.decide(f.auth, ws, f.definitionId, {
    submissionId: s.submission.id,
    outcome: 'accepted',
    rationale: 'Examined attached verification and independent review.',
  });
  expect(accepted.submissions[0]?.decision?.outcome).toBe('accepted');
  expect(accepted.subjects.find((s) => s.subject.sourceId === 'LOCAL-PUBLISHED')?.issues).toEqual(
    [],
  );
  // Eligibility is not a publication pass, and a new runtime invalidates the accepted old pass.
  expect(
    accepted.submissions.some((s) => s.submission.subject.sourceId === 'LOCAL-PUBLISHED'),
  ).toBe(false);
  const revised = await f.svc.configure(f.auth, ws, f.definitionId, {
    ...f.input,
    expectedGeneration: 1,
  });
  expect(revised.submissions[0]?.decision?.outcome).toBe('accepted');
  expect(revised.submissions[0]?.issues.join(' ')).toContain('inactive runtime');
  expect(
    revised.subjects.find((s) => s.subject.sourceId === 'LOCAL-PUBLISHED')?.issues.join(' '),
  ).toContain('LOCAL-QUALIFIED');
  await expect(
    f.svc.decide(f.auth, ws, f.definitionId, {
      submissionId: s.submission.id,
      outcome: 'accepted',
      rationale: 'Retry stale record.',
    }),
  ).rejects.toThrow('inactive runtime');
});
it('checks actual Git freshness at evidence review and keeps decisions immutable', async () => {
  const f = await evidenceFixture(),
    ws = f.state.workspaceId;
  const submitted = await f.svc.submit(f.auth, ws, f.definitionId, f.submission);
  const s = submitted.submissions[0]!.submission;
  execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'integration advanced',
    ],
    { cwd: f.root },
  );
  await expect(
    f.svc.decide(f.auth, ws, f.definitionId, {
      submissionId: s.id,
      outcome: 'accepted',
      rationale: 'Old evidence.',
    }),
  ).rejects.toThrow('current integration commit');
  await f.svc.decide(f.auth, ws, f.definitionId, {
    submissionId: s.id,
    outcome: 'rejected',
    rationale: 'Integration advanced; collect fresh results.',
  });
  await expect(
    f.svc.decide(f.auth, ws, f.definitionId, {
      submissionId: s.id,
      outcome: 'rejected',
      rationale: 'Duplicate.',
    }),
  ).rejects.toThrow('immutable decision');
});
it('protects runtime routes with workspace authorization and mutation CSRF', async () => {
  const f = await evidenceFixture(),
    base = `/api/workspaces/${f.state.workspaceId}/concurrency-definitions/${f.definitionId}/runtime`;
  const anonymous = await f.state.context.app.inject({ method: 'GET', url: base });
  expect(anonymous.statusCode).toBe(401);
  const noCsrf = await f.state.context.app.inject({
    method: 'POST',
    url: `${base}/configure`,
    headers: { cookie: f.state.cookie },
    payload: f.input,
  });
  expect(noCsrf.statusCode).toBe(403);
  const view = await f.state.context.app.inject({
    method: 'GET',
    url: base,
    headers: { cookie: f.state.cookie },
  });
  expect(view.statusCode, view.body).toBe(200);
  const bad = await f.state.context.app.inject({
    method: 'POST',
    url: `${base}/submit`,
    headers: {
      cookie: f.state.cookie,
      origin: f.state.context.config.publicOrigin,
      'x-craftingtable-csrf': f.state.csrfToken,
    },
    payload: {},
  });
  expect(bad.statusCode, bad.body).toBe(400);
});

it.each(['integration', 'implementation'] as const)(
  'supplies isolated %s verification and freezes generation-bound review provenance',
  async (mode) => {
    const f = await slicedFixture((source) => ({
      ...source,
      checkpoints: [],
      slices: source.slices.map((s) => ({ ...s, mode })),
      repositories: [
        { ...source.repositories[0]!, id: 'local' },
        { ...source.repositories[0]!, id: 'provider', role: 'implemented_upstream' },
      ],
      work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
    }));
    const provider = fixtureRepository();
    writeFileSync(
      join(provider, 'Cargo.toml'),
      '[package]\nname="ct_runtime_provider"\nversion="0.2.0"\nedition="2021"\n[lib]\npath="lib.rs"\n',
    );
    writeFileSync(join(provider, 'lib.rs'), 'pub fn value()->u32{42}\n');
    git(['add', '.'], provider);
    git(['commit', '-m', 'provider'], provider);
    writeFileSync(
      join(f.root, 'Cargo.toml'),
      '[package]\nname="ct_runtime_consumer"\nversion="0.1.0"\nedition="2021"\n[lib]\npath="lib.rs"\n[dependencies]\nct_runtime_provider="0.2"\n',
    );
    writeFileSync(
      join(f.root, 'lib.rs'),
      '#[test] fn pin(){assert_eq!(ct_runtime_provider::value(),42);}\n',
    );
    const cargo = join(process.env.HOME!, '.cargo/bin/cargo');
    execFileSync(
      cargo,
      [
        'generate-lockfile',
        '--offline',
        '--config',
        `patch.crates-io.ct_runtime_provider.path=${JSON.stringify(provider)}`,
      ],
      { cwd: f.root },
    );
    git(['add', '.'], f.root);
    git(['commit', '-m', 'consumer'], f.root);
    const registered = await f.state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.state.workspaceId}/repositories`,
      headers: mutationHeaders(f.state),
      payload: { rootPath: provider, displayName: 'Pinned provider' },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const repository = registerSourceRepositoryResponseSchema.parse(registered.json()).repository;
    const ws = f.state.workspaceId,
      definitionId = f.parentScope.definitionId,
      svc = f.state.context.services.runtimeEvidenceService,
      storage = f.state.context.storage;
    const old = storage.imports.bindings(ws, definitionId)[0]!;
    storage.imports.addBindings({
      ...old,
      revision: 2,
      bindings: [
        ...old.bindings,
        {
          alias: 'provider',
          repositoryId: repository.id,
          integrationBranch: 'main',
          sourceArtifacts: [],
          workItems: [],
        },
      ],
    });
    const observed = await svc.inspect(f.auth, ws, definitionId, {
      bindingRevision: 2,
      alias: 'provider',
      ref: 'main',
    });
    expect(observed.packages).toEqual([
      { name: 'ct_runtime_provider', path: '', version: '0.2.0' },
    ]);
    const config = {
      bindingRevision: 2,
      expectedGeneration: 0,
      pins: [
        {
          alias: 'provider',
          ref: 'main',
          conformanceRevision: 'local-fixture',
          packages: observed.packages,
        },
      ],
      consumers: [{ alias: 'local', upstreams: ['provider'] }],
      environments: [
        {
          id: 'local',
          kind: 'local-development' as const,
          identityDigest: '1'.repeat(64),
          fixtureDigest: '2'.repeat(64),
          toolchainDigest: '3'.repeat(64),
          authorization: 'Isolated fixture builds only.',
        },
      ],
    };
    await svc.configure(f.auth, ws, definitionId, config);
    const scope = { ...f.scopes[0]!, bindingRevision: 2 },
      tree = await scopeTree(f, scope);
    f.backend.replyForRequest = () => ({ resultText: scopeReport(f.state, scope) });
    const withoutBuild = await runToFinish(f.state, tree.id, { role: 'review' });
    expect(() => svc.assertRun(tree, withoutBuild)).toThrow('frozen pinned build record');
    f.backend.replyForRequest = (request) => {
      expect(request.buildEnvironment?.namespace).toBeTruthy();
      expect(request.prompt).toContain('Pinned dependency environment:');
      execFileSync(
        join(request.buildEnvironment!.binDirectory, mode === 'integration' ? 'cargo' : 'ct-check'),
        mode === 'integration'
          ? ['test', '--offline']
          : [
              '--',
              process.execPath,
              '-e',
              'if(!require("node:fs").readFileSync("lib.rs","utf8").includes("pin()"))process.exit(1)',
            ],
        {
          cwd: request.cwd,
          env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
          stdio: 'pipe',
        },
      );
      return { resultText: scopeReport(f.state, scope) };
    };
    if (mode === 'integration') {
      const original = f.backend.replyForRequest;
      f.backend.replyForRequest = (request) => {
        execFileSync(
          join(request.buildEnvironment!.binDirectory, 'ct-check'),
          ['--', process.execPath, '-e', 'console.log("contract checked")'],
          { cwd: request.cwd },
        );
        return { resultText: scopeReport(f.state, scope) };
      };
      const scopedOnly = await runToFinish(f.state, tree.id, { role: 'review' });
      expect(() => svc.assertRun(tree, scopedOnly)).toThrow('successful pinned Cargo');
      f.backend.replyForRequest = original;
    }
    const run = await runToFinish(f.state, tree.id, { role: 'review' });
    expect(() => svc.assertRun(tree, run)).not.toThrow();
    const environment = storage.runtimeEvidence.run(ws, run)!;
    const manifest = JSON.parse(
      readFileSync(environment.manifestPath, 'utf8'),
    ) as import('@craftingtable/agents').PinnedCargoManifest;
    if (mode === 'integration') {
      expect(manifest.packages[0]!.path).not.toBe(provider);
      expect(manifest.packages[0]!.path).toContain('/scratch/dependencies/');
    } else {
      expect(manifest.packages).toHaveLength(0);
      expect(manifest.verification?.mode).toBe('scoped-checks');
    }
    const frozen = storage.runtimeEvidence.build(ws, run)!;
    expect(frozen.error).toBeUndefined();
    expect(frozen.receipts).toContain('"success":true');
    rmSync(manifest.receiptPath);
    expect(() => svc.assertRun(tree, run)).not.toThrow();
    const db = openDatabase(storage.databasePath);
    try {
      expect(() =>
        db.prepare('UPDATE run_build_records SET record_json=? WHERE run_id=?').run('{}', run),
      ).toThrow('immutable');
    } finally {
      db.close();
    }
    await svc.configure(f.auth, ws, definitionId, { ...config, expectedGeneration: 1 });
    expect(() => svc.assertRun(tree, run)).toThrow('obsolete dependency environment');
    git(['commit', '--allow-empty', '-m', 'provider advanced'], provider);
    await expect(
      svc.configure(f.auth, ws, definitionId, {
        ...config,
        expectedGeneration: 2,
        pins: config.pins.map((p) => ({ ...p, expectedCommitSha: observed.commitSha })),
      }),
    ).rejects.toThrow('ref advanced before saving');
    const prepared = svc.prepare(tree, randomUUID(), join(f.state.context.directory, 'new-run'));
    if (mode === 'integration') await expect(prepared).rejects.toThrow('integration changed');
    else await expect(prepared).resolves.toMatchObject({ verification: { mode: 'scoped-checks' } });
  },
);

it('binds consumer evidence independently of checkpoint ownership and derives cross-project build providers', async () => {
  const f = await evidenceFixture('aq');
  const { testedRepositories, requiredUpstreams } = await import(
    './services/runtime-evidence-policy.js'
  );
  const imported = f.state.context.storage.imports
    .definitions(f.state.workspaceId)
    .find((d) => d.id !== f.definitionId)!;
  expect(testedRepositories(imported, { kind: 'checkpoint', sourceId: 'WI-AQ-G1' })).toEqual([
    'wi',
  ]);
  expect(testedRepositories(imported, { kind: 'checkpoint', sourceId: 'EXO-AQ-G1' })).toEqual([
    'exo',
  ]);
  expect(requiredUpstreams(imported, 'wi')).toEqual(['aq']);
  expect(requiredUpstreams(imported, 'exo')).toEqual(['aq', 'wi']);
  await expect(
    f.svc.submit(f.auth, f.state.workspaceId, f.definitionId, {
      ...f.submission,
      subjectCommit: 'f'.repeat(40),
    }),
  ).rejects.toThrow('current integration commit');
  const { subjectCommit: _commit, ...noCode } = f.submission;
  await expect(f.svc.submit(f.auth, f.state.workspaceId, f.definitionId, noCode)).rejects.toThrow(
    'exact tested local consumer commit',
  );
  const submitted = await f.svc.submit(f.auth, f.state.workspaceId, f.definitionId, {
    ...noCode,
    testedCode: [{ alias: 'local', commitSha: f.submission.subjectCommit! }],
  });
  expect(submitted.submissions[0]?.submission.testedCode).toEqual([
    { alias: 'local', commitSha: f.submission.subjectCommit },
  ]);
});

async function supervisedMapFixture(
  partial = false,
  parentAcceptance: 'manual' | 'automatic' = 'automatic',
  wholePlan = false,
  planApproval = false,
) {
  const f = await slicedFixture(
    (s) => ({
      ...s,
      repositories: s.repositories.map((r) => ({ ...r, id: 'local' })),
      decisions: [s.decisions[0]!],
      evidence_profiles: [
        ...(planApproval
          ? [
              {
                id: 'plan-approval',
                required_evidence: [...PLAN_REQUIREMENTS],
                reviewer_roles: ['stack-integration-owner'],
                independence_required: true as const,
              },
            ]
          : []),
        ...s.evidence_profiles.map((p) => ({
          ...p,
          reviewer_roles: [
            'repository-maintainer',
            'independent-security-reviewer-if-required-by-source',
          ],
        })),
      ],
      work_items: s.work_items.flatMap((p) => [
        { ...p, repository: 'local', source_profile_case_ids: [] },
        ...(wholePlan
          ? [
              {
                ...p,
                id: 'AQ-02',
                source_item_id: 'AQ-02',
                source_exit_gate: 'Done',
                repository: 'local',
                source_profile_case_ids: [],
                required_slices: [],
                depends_on: ['AQ-01'],
              },
            ]
          : []),
      ]),
      slices: s.slices.map((s) => ({
        ...s,
        start_requires: planApproval
          ? [{ kind: 'checkpoint' as const, id: 'STACK-PLAN-ACCEPTED', state: 'passed' as const }]
          : s.start_requires,
        decision_refs: ['CS-D01'],
      })),
      checkpoints: [
        ...(planApproval
          ? [
              {
                ...s.checkpoints[0]!,
                id: 'STACK-PLAN-ACCEPTED',
                owner: 'stack',
                kind: 'plan_approval' as const,
                requires: [],
                decision_refs: ['CS-D01'],
                evidence_profile: 'plan-approval',
                pass_criteria: [...PLAN_CRITERIA],
              },
            ]
          : []),
        {
          ...s.checkpoints[0]!,
          id: 'LOCAL-TARGET',
          owner: 'local',
          kind: 'semantic_review',
          title: 'Local target',
          requires: [
            partial
              ? { kind: 'slice', id: 'AQ-01.A', state: 'verified' }
              : { kind: 'work_item', id: 'AQ-01', state: 'accepted' },
          ],
          decision_refs: [],
          evidence_profile: 'scope-review',
          pass_criteria: ['Target inspected'],
          evidence_owners: [],
          historical_producer_work_items: [],
        },
      ],
      planning_targets: [
        {
          id: 'LOCAL',
          checkpoint: 'LOCAL-TARGET',
          scope: 'Selected local proof',
          is_release: false,
        },
      ],
      terminal_checkpoint: 'LOCAL-TARGET',
    }),
    true,
  );
  const ws = f.state.workspaceId,
    definitionId = f.parentScope.definitionId;
  const runtime = await f.state.context.services.runtimeEvidenceService.configure(
    f.auth,
    ws,
    definitionId,
    {
      bindingRevision: 1,
      expectedGeneration: 0,
      pins: [],
      consumers: [{ alias: 'local', upstreams: [] }],
      environments: [
        {
          id: 'local-tests',
          kind: 'local-development',
          identityDigest: 'a'.repeat(64),
          fixtureDigest: 'b'.repeat(64),
          toolchainDigest: 'c'.repeat(64),
          authorization: 'Local isolated test fixtures',
        },
      ],
    },
  );
  const base = roadmapInput(f.state, [f.state.workItemId]).entries[0]!;
  const configuration: import('@craftingtable/domain').CrossProjectConfiguration = {
    definitionId,
    bindingRevision: 1,
    targetId: 'LOCAL',
    selection: 'target-only',
    parentAcceptance,
    defaults: {
      reviewerRoles: [
        'repository-maintainer',
        'independent-security-reviewer-if-required-by-source',
      ],
      profiles: base.profiles,
      policy: base.policy,
      instructions: 'Preserve exact scope.',
      automation: { integrationMerge: 'automatic', integrationConflicts: 'automatic' },
    },
    overrides: [],
  };
  f.backend.replyForRequest = (request) => {
    if (request.model === 'design-model') return designDone;
    if (request.model === 'review-model') {
      runScopedFixtureCheck(request);
      const tree = f.state.context.storage.execution.worktrees
        .listActive(ws)
        .find((t) => t.path === request.cwd)!;
      return {
        resultText:
          '## Open questions\nnone\n## Review report\n' +
          scopeReport({ ...f.state, workItemId: tree.workItemId! }, tree.executionScope!),
      };
    }
    commitFile(
      request.cwd,
      `slice-${request.cwd.includes('01-a') ? 'a' : 'b'}.txt`,
      'Implemented bounded slice',
    );
    return implementationDone;
  };
  const service = f.state.context.services.crossProjectService;
  const input: import('@craftingtable/contracts').SaveCrossProjectRequest = {
    roadmapId,
    expectedVersion: 0,
    name: 'Cross-project fixture',
    configuration: { ...configuration, overrides: [] },
    scheduling: parallelScheduling,
  };
  return { ...f, service, input, runtime };
}
const mapCommand = (
  f: Awaited<ReturnType<typeof supervisedMapFixture>>,
  command: string,
  payload: unknown,
  headers = mutationHeaders(f.state),
) =>
  f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/concurrency-definitions/${f.parentScope.definitionId}/supervision/${command}`,
    headers,
    payload: payload as Record<string, unknown>,
  });
async function adoptSupervisedMap(f: Awaited<ReturnType<typeof supervisedMapFixture>>) {
  const result = await mapCommand(f, 'adopt', {
    bindingRevision: 1,
    decisionIds: ['CS-D01'],
    rationale: 'Reviewed exact definition and retained obligations.',
  });
  expect(result.statusCode, result.body).toBe(200);
}
it('adopts exact map decisions separately, previews exclusions, guards HTTP authority and records inherited settings', async () => {
  const f = await supervisedMapFixture(true),
    ws = f.state.workspaceId;
  const preview = f.service.view(f.auth, ws, f.input.configuration);
  expect(preview.nodes.some((n) => n.sourceId === 'AQ-01.B' && !n.included)).toBe(true);
  expect(preview.nodes.some((n) => n.kind === 'work_item' && n.included)).toBe(false);
  expect(
    (
      await mapCommand(
        f,
        'adopt',
        { bindingRevision: 1, decisionIds: ['CS-D01'], rationale: 'Review' },
        { cookie: f.state.cookie },
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (await mapCommand(f, 'adopt', { bindingRevision: 1, decisionIds: [], rationale: 'Review' }))
      .statusCode,
  ).toBe(409);
  const { roadmapEntryInputSchema } = await import('@craftingtable/contracts');
  const disallowed = await f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/roadmaps/${roadmapId}`,
    headers: mutationHeaders(f.state),
    payload: {
      expectedVersion: 0,
      name: 'Cannot independently delegate acceptance',
      entries: [
        roadmapEntryInputSchema.parse({
          ...roadmapInput(f.state, [f.state.workItemId]).entries[0],
          executionScope: f.parentScope,
        }),
      ],
    },
  });
  expect(disallowed.statusCode, disallowed.body).toBe(409);
  expect(disallowed.body).toContain('parent acceptance reviews');
  const saved = f.service.save(f.auth, ws, {
    ...f.input,
    configuration: {
      ...f.input.configuration,
      overrides: [
        {
          level: 'project',
          key: 'local',
          settings: { ...f.input.configuration.defaults, instructions: 'Project defaults' },
        },
        {
          level: 'activity',
          key: 'verification',
          settings: { ...f.input.configuration.defaults, instructions: 'Independent verification' },
        },
        {
          level: 'individual',
          key: 'development:AQ-01.A',
          settings: { ...f.input.configuration.defaults, instructions: 'Specific slice' },
        },
      ],
    },
  });
  expect(saved.roadmap.definition.entries.map((e) => e.instructions)).toEqual([
    'Specific slice',
    'Independent verification',
  ]);
  expect(
    (
      await f.state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws}/roadmaps/${roadmapId}/control`,
        headers: mutationHeaders(f.state),
        payload: { action: 'start', expectedVersion: storedRoadmap(f.state).version },
      })
    ).statusCode,
  ).toBe(409);
  await adoptSupervisedMap(f);
  const after = f.service.view(f.auth, ws, f.input.configuration);
  expect(after.decisions.every((d) => d.adopted)).toBe(true);
  expect(
    after.nodes.find((n) => n.kind === 'slice' && n.state === 'verified')?.reviewerRoles,
  ).toEqual(['repository-maintainer', 'independent-security-reviewer-if-required-by-source']);
  expect(
    after.nodes.filter((n) => n.kind === 'checkpoint').every((n) => !n.reviewerRoles?.length),
  ).toBe(true);

  expect(after.targetReached).toBe(false);
  expect(
    (
      await mapCommand(f, 'adopt', {
        bindingRevision: 2,
        decisionIds: ['CS-D01'],
        rationale: 'Old binding',
      })
    ).statusCode,
  ).toBe(409);
  expect(f.backend.launches).toHaveLength(0);
  expect(f.state.context.storage.scopeReceipts.list(ws, f.state.workItemId)).toHaveLength(0);
  const reopened = openCraftingTableStorage(f.state.context.config.databasePath);
  try {
    expect(reopened.imports.adoptions(ws, f.parentScope.definitionId)).toHaveLength(1);
  } finally {
    reopened.close();
  }
  expect(
    (
      await mapCommand(f, 'preview', {
        ...f.input.configuration,
        defaults: undefined,
        overrides: undefined,
        parentAcceptance: undefined,
        targetId: 'invented',
      })
    ).statusCode,
  ).toBe(409);
});
it('supervises slices, fresh verification and independent parent acceptance without completing an unproven target', {
  timeout: 20000,
}, async () => {
  const f = await supervisedMapFixture(),
    { state } = f,
    ws = state.workspaceId;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  const notifications = state.context.services.notificationService;
  const { DEFAULT_NOTIFICATION_PREFERENCES } = await import('@craftingtable/domain');
  notifications.save(f.auth, ws, {
    expectedVersion: 0,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
    applicationToken: 'a'.repeat(30),
    userKey: 'u'.repeat(30),
  });
  await notifications.tick();
  expect(
    state.context.storage.notifications
      .records(ws)
      .some((n) => n.sourceKey.includes(':checkpoints:')),
  ).toBe(false);
  expect((await roadmapControl(state, 'start')).statusCode).toBe(200);
  await waitFor(
    () => {
      const r = storedRoadmap(state),
        bad = Object.values(r.entryHolds ?? {}).find((h) => h.status === 'needs-attention');
      if (bad) throw new Error(bad.reason);
      const cycle = state.context.storage.execution.cycles
        .list(ws)
        .find((c) => c.status === 'needs-attention');
      if (cycle) throw new Error(cycle.reason);
      return (
        state.context.storage.planning.workItems.find(ws, state.workItemId)?.status === 'completed'
      );
    },
    'parent independently accepted',
    15000,
  );
  const scopes = state.context.storage.scopeReceipts.list(ws, state.workItemId);
  expect(scopes.filter((s) => s.scope.kind === 'slice')).toHaveLength(2);
  expect(scopes.filter((s) => s.scope.kind === 'parent-acceptance')).toHaveLength(1);
  expect(scopes.every((s) => s.reviewerRoles?.includes('repository-maintainer'))).toBe(true);
  expect(storedRoadmap(state).status).toBe('running');
  expect(f.service.view(f.auth, ws, f.input.configuration).targetReached).toBe(false);
  expect(f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted).toBe(true);
  await notifications.tick();
  const alert = state.context.storage.notifications
    .records(ws)
    .find((n) => n.sourceKey.includes(':checkpoints:'))!;
  expect(alert.message).toContain('LOCAL-TARGET');
  const delivered = alert.deliveredCount;
  await notifications.tick();
  expect(
    state.context.storage.notifications.records(ws).find((n) => n.id === alert.id)?.deliveredCount,
  ).toBe(delivered);
  await roadmapControl(state, 'pause');
  const before = storedRoadmap(state);
  const changed = f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: before.version,
    configuration: {
      ...f.input.configuration,
      defaults: { ...f.input.configuration.defaults, instructions: 'Future queued guidance' },
    },
  });
  expect(
    changed.roadmap.definition.entries.every((e) => e.instructions === 'Preserve exact scope.'),
  ).toBe(true);
  await roadmapControl(state, 'resume');
  const evidence = state.context.services.runtimeEvidenceService;
  const spec = (await evidence.view(f.auth, ws, f.parentScope.definitionId)).subjects.find(
    (s) => s.subject.sourceId === 'LOCAL-TARGET',
  )!;
  const submitted = await evidence.submit(f.auth, ws, f.parentScope.definitionId, {
    runtimeId: f.runtime.current!.id,
    subject: spec.subject,
    subjectCommit: git(['rev-parse', 'revision'], f.root).trim(),
    environmentId: 'local-tests',
    executedBy: 'author',
    executedAt: new Date().toISOString(),
    reviewers: [
      { identity: 'independent-reviewer', roles: spec.reviewerRoles, artifact: 'review' },
    ],
    requirements: spec.requirements.map((requirement) => ({ requirement, artifact: 'review' })),
    cases: [],
    artifacts: [
      { name: 'review', content: 'Independently inspected the target and all required receipts.' },
    ],
  });
  await evidence.decide(f.auth, ws, f.parentScope.definitionId, {
    submissionId: submitted.submissions[0]!.submission.id,
    outcome: 'accepted',
    rationale: 'Independent target review accepted.',
  });
  await waitFor(() => storedRoadmap(state).status === 'completed', 'selected scope completion');
  const view = f.service.view(f.auth, ws, f.input.configuration);
  expect(view.selectedScopeComplete).toBe(true);
  expect(view.finalized).toBe(false);
  const attempts = storedRoadmap(state).attempts;
  expect(attempts).toHaveLength(5);
  for (const a of attempts) {
    const c = state.context.storage.execution.cycles.find(ws, a.cycleId)!;
    if (c.executionScope?.kind !== 'slice') expect(c.step).toBe('review');
  }
});
it('keeps parent approval manual and preserves attempts across restart without relaunch', {
  timeout: 20000,
}, async () => {
  const f = await supervisedMapFixture(false, 'manual'),
    { state } = f,
    ws = state.workspaceId;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .list(ws)
        .some(
          (c) => c.executionScope?.kind === 'parent-acceptance' && c.status === 'awaiting-merge',
        ),
    'parent approval',
    15000,
  );
  expect(state.context.storage.planning.workItems.find(ws, state.workItemId)?.status).toBe(
    'admitted',
  );
  const count = f.backend.launches.length;
  state.context.services.roadmapService.recoverInterrupted();
  await state.context.services.roadmapService.tick();
  expect(f.backend.launches).toHaveLength(count);
  expect(storedRoadmap(state).status).toBe('needs-attention');
  const tree = state.context.storage.execution.worktrees
    .listForWorkItem(ws, state.workItemId)
    .find((t) => t.executionScope?.kind === 'parent-acceptance')!;
  expect((await recordScope(f, tree)).statusCode).toBe(200);
  expect(state.context.storage.planning.workItems.find(ws, state.workItemId)?.status).toBe(
    'completed',
  );
});
it('pauses a verification question without authorizing implementation in the review snapshot', {
  timeout: 15000,
}, async () => {
  const f = await supervisedMapFixture(true),
    { state } = f,
    ws = state.workspaceId,
    normal = f.backend.replyForRequest;
  f.backend.replyForRequest = (request) => {
    const tree = state.context.storage.execution.worktrees
      .listForWorkItem(ws, state.workItemId)
      .find((t) => t.path === request.cwd);
    return tree?.executionScope?.kind === 'slice-verification'
      ? {
          resultText:
            '## Open questions\nWhich compatibility choice should apply?\n## Review report\n' +
            scopeReport(state, tree.executionScope),
        }
      : normal!(request);
  };
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      state.context.storage.execution.cycles
        .list(ws)
        .some(
          (c) => c.executionScope?.kind === 'slice-verification' && c.status === 'needs-attention',
        ),
    'verification question',
    10000,
  );
  expect(state.context.storage.scopeReceipts.list(ws, state.workItemId)).toHaveLength(0);
  expect(
    f.backend.launches
      .filter((r) =>
        state.context.storage.execution.worktrees
          .listForWorkItem(ws, state.workItemId)
          .some((t) => t.path === r.cwd && t.executionScope?.kind === 'slice-verification'),
      )
      .every((r) => r.model === 'review-model'),
  ).toBe(true);
});

const amendmentCommand = (
  f: Awaited<ReturnType<typeof supervisedMapFixture>>,
  action: string,
  payload: unknown,
  headers = mutationHeaders(f.state),
) =>
  f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/roadmaps/${roadmapId}/amendments${action ? `/${action}` : ''}`,
    headers,
    payload: payload as Record<string, unknown>,
  });
it('holds a roadmap for reviewed amendments, checks stale previews and preserves immutable decisions across recovery', async () => {
  const f = await supervisedMapFixture(true),
    ws = f.state.workspaceId,
    service = f.state.context.services.mapAmendmentService;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input);
  const candidate = { ...f.input.configuration, selection: 'prioritize-full' as const };
  const selection = {
    definitionId: candidate.definitionId,
    bindingRevision: 1,
    targetId: candidate.targetId,
    selection: candidate.selection,
  };
  expect(
    (await amendmentCommand(f, 'preview', selection, { cookie: f.state.cookie })).statusCode,
  ).toBe(403);
  expect((await amendmentCommand(f, 'preview', selection)).statusCode).toBe(200);
  const proposed = await amendmentCommand(f, '', {
    expectedVersion: saved.roadmap.version,
    candidate: selection,
    summary: 'Include retained work after the initial proof.',
  });
  expect(proposed.statusCode, proposed.body).toBe(200);
  const view = proposed.json(),
    pending = view.history[0];
  expect(f.state.context.storage.roadmaps.find(ws, roadmapId)?.status).toBe('paused');
  await expect(
    f.state.context.services.roadmapService.control(
      f.auth,
      ws,
      roadmapId,
      'resume',
      saved.roadmap.version + 1,
    ),
  ).rejects.toThrow(/amendment/);
  const decision = {
    amendmentId: pending.id,
    outcome: 'apply',
    impactDigest: '0'.repeat(64),
    rationale: 'Reviewed complete retained obligations.',
    reuseIntegrationIds: [],
  };
  expect((await amendmentCommand(f, 'decision', decision)).statusCode).toBe(409);
  const applied = await amendmentCommand(f, 'decision', {
    ...decision,
    impactDigest: view.pendingImpact.digest,
  });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().history[0].decision.previous.definition.crossProject.selection).toBe(
    'target-only',
  );
  expect(
    f.state.context.storage.roadmaps.find(ws, roadmapId)?.definition.crossProject?.selection,
  ).toBe('prioritize-full');
  expect(f.state.context.storage.roadmaps.find(ws, roadmapId)?.status).toBe('paused');
  f.state.context.services.roadmapService.recoverInterrupted();
  await f.state.context.services.roadmapService.tick();
  expect(f.state.context.storage.execution.worktrees.listActive(ws)).toHaveLength(0);
  expect(
    (
      await amendmentCommand(f, 'decision', {
        ...decision,
        impactDigest: view.pendingImpact.digest,
      })
    ).statusCode,
  ).toBe(409);
  const ready = service.finalization(f.auth, ws, roadmapId).projects[0]!;
  expect(ready.status).toBe('blocked');
  expect(ready.blockers.join(' ')).toContain('partial target');
});
it('rebinds a reviewed replacement without carrying adoption or evidence and retains old roadmap revisions', async () => {
  const f = await supervisedMapFixture(),
    ws = f.state.workspaceId,
    storage = f.state.context.storage,
    service = f.state.context.services.mapAmendmentService;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input);
  const old = storage.imports.definition(ws, f.parentScope.definitionId)!,
    binding = storage.imports.bindings(ws, old.id)[0]!;
  const id = randomUUID();
  storage.transaction((tx) => {
    tx.imports.addDefinition({
      ...old,
      id,
      revision: 'amended',
      source: { ...old.source, revision: 'amended' },
    });
    tx.imports.addBindings({ ...binding, definitionId: id });
  });
  const candidate = {
    definitionId: id,
    bindingRevision: 1,
    targetId: 'LOCAL',
    selection: 'target-only' as const,
  };
  const v = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: saved.roadmap.version,
    candidate,
    summary: 'Adopt revised scope.',
  });
  const impact = v.pendingImpact!;
  expect(impact.blockers).toEqual([]);
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: v.history[0]!.id,
    outcome: 'apply',
    impactDigest: impact.digest,
    rationale: 'Reviewed replacement; require new approvals.',
    reuseIntegrationIds: [],
  });
  expect(storage.amendments.superseded(ws, old.id, 1)).toBe(true);
  expect(
    storage.roadmaps.history(ws, roadmapId).some((d) => d.crossProject?.definitionId === old.id),
  ).toBe(true);
  expect(f.service.view(f.auth, ws, candidate).blockers.join(' ')).toMatch(/adopt/i);
  expect(storage.imports.adoptions(ws, id)).toHaveLength(0);
  expect(storage.runtimeEvidence.generations(ws, id, 1)).toHaveLength(0);
});

it('keeps live runs in their original context and retires idle attempts only after explicit amendment approval', {
  timeout: 15000,
}, async () => {
  const f = await supervisedMapFixture(true),
    { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage,
    service = state.context.services.mapAmendmentService;
  f.service.save(f.auth, ws, {
    ...f.input,
    configuration: {
      ...f.input.configuration,
      defaults: { ...f.input.configuration.defaults, instructions: 'DEFER-TURNS' },
    },
  });
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      storage.execution.cycles
        .list(ws)
        .some((c) => storage.execution.runs.find(ws, c.currentRunId)?.status === 'running'),
    'live cycle',
  );
  const cycle = storage.execution.cycles.list(ws)[0]!,
    run = storage.execution.runs.find(ws, cycle.currentRunId)!;
  const original = storage.imports.definition(ws, f.parentScope.definitionId)!,
    binding = storage.imports.bindings(ws, original.id)[0]!,
    id = randomUUID();
  storage.imports.addDefinition({
    ...original,
    id,
    revision: 'replacement-live',
    source: { ...original.source, revision: 'replacement-live' },
  });
  storage.imports.addBindings({ ...binding, definitionId: id });
  const proposed = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: storedRoadmap(state).version,
    candidate: {
      definitionId: id,
      bindingRevision: 1,
      targetId: 'LOCAL',
      selection: 'target-only',
    },
    summary: 'Explicit scope replacement after the current session.',
  });
  expect(proposed.pendingImpact!.blockers.join(' ')).toContain(run.id);
  expect(storage.execution.runs.find(ws, run.id)?.brief).toBe(run.brief);
  expect(storage.execution.cycles.find(ws, cycle.id)?.status).toBe('paused');
  const request = {
    amendmentId: proposed.history[0]!.id,
    outcome: 'apply' as const,
    impactDigest: proposed.pendingImpact!.digest,
    rationale: 'Retain original context as history.',
    reuseIntegrationIds: [],
  };
  await expect(service.decide(f.auth, ws, roadmapId, request)).rejects.toThrow(/Wait for/);
  const cancel = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/runs/${run.id}/cancel`,
    headers: mutationHeaders(state),
    payload: {},
  });
  expect(cancel.statusCode, cancel.body).toBe(200);
  await waitFor(
    () => storage.execution.runs.find(ws, run.id)?.status === 'cancelled',
    'cancel complete',
  );
  const current = service.view(f.auth, ws, roadmapId);
  expect(current.pendingImpact!.blockers).toEqual([]);
  await service.decide(f.auth, ws, roadmapId, {
    ...request,
    impactDigest: current.pendingImpact!.digest,
  });
  expect(storage.execution.worktrees.find(ws, cycle.worktreeId)?.status).toBe('active');
  expect(storage.amendments.retired(ws, cycle.worktreeId)).toBe(true);
  expect(storage.execution.cycles.find(ws, cycle.id)?.status).toBe('stopped');
  expect(storedRoadmap(state).attempts).toHaveLength(0);
  expect(
    service.view(f.auth, ws, roadmapId).history[0]?.decision?.previous.attempts[0]?.cycleId,
  ).toBe(cycle.id);
  await expect(
    state.context.services.workCycleService.control(
      f.auth,
      ws,
      cycle.id,
      'resume',
      storage.execution.cycles.find(ws, cycle.id)!.version,
    ),
  ).rejects.toThrow();
  const reopened = openCraftingTableStorage(state.context.config.databasePath);
  try {
    expect(reopened.amendments.retired(ws, cycle.worktreeId)).toBe(true);
    expect(reopened.amendments.list(ws)[0]?.decision?.outcome).toBe('applied');
  } finally {
    reopened.close();
  }
});
it('reconciles stale reviews on the same binding while retaining integrated code and requiring independent acceptance again', {
  timeout: 25000,
}, async () => {
  const f = await supervisedMapFixture(),
    { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () => storage.planning.workItems.find(ws, state.workItemId)?.status === 'completed',
    'original acceptance',
    15000,
  );
  await roadmapControl(state, 'pause');
  const old = storedRoadmap(state),
    runtime = f.runtime.current!;
  await state.context.services.runtimeEvidenceService.configure(
    f.auth,
    ws,
    f.parentScope.definitionId,
    {
      bindingRevision: 1,
      expectedGeneration: runtime.generation,
      pins: [],
      consumers: runtime.consumers.map((c) => ({ ...c, upstreams: [...c.upstreams] })),
      environments: [...runtime.environments],
    },
  );
  expect(f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted).toBe(false);
  const service = state.context.services.mapAmendmentService,
    proposed = await service.propose(f.auth, ws, roadmapId, {
      expectedVersion: storedRoadmap(state).version,
      candidate: {
        definitionId: f.parentScope.definitionId,
        bindingRevision: 1,
        targetId: 'LOCAL',
        selection: 'target-only',
      },
      summary: 'Fresh acceptance under revised dependency environment.',
    });
  expect(proposed.pendingImpact!.attempts.filter((a) => a.disposition === 'retain')).toHaveLength(
    2,
  );
  expect(proposed.pendingImpact!.attempts.filter((a) => a.disposition === 'retire')).toHaveLength(
    3,
  );
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: proposed.history[0]!.id,
    outcome: 'apply',
    impactDigest: proposed.pendingImpact!.digest,
    rationale: 'Require fresh independent verification; retain integration.',
    reuseIntegrationIds: [],
  });
  await roadmapControl(state, 'resume');
  await waitFor(
    () => f.service.view(f.auth, ws, f.input.configuration).fullPlanAccepted,
    'fresh parent acceptance',
    15000,
  );
  expect(
    storage.scopeReceipts
      .list(ws, state.workItemId)
      .filter((r) => r.scope.kind === 'parent-acceptance'),
  ).toHaveLength(2);
  expect(
    storedRoadmap(state).attempts.filter((a) => old.attempts.some((prior) => prior.id === a.id)),
  ).toHaveLength(2);
});

it('coordinates full-plan finalization with frozen map and runtime context and retains exact operator promotion', {
  timeout: 25000,
}, async () => {
  const f = await supervisedMapFixture(false, 'automatic', true),
    { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage,
    service = state.context.services.mapAmendmentService;
  const input = {
    ...f.input,
    configuration: { ...f.input.configuration, selection: 'prioritize-full' as const },
  };
  f.service.save(f.auth, ws, input);
  await adoptSupervisedMap(f);
  const settings = storage.execution.branchSettings.find(ws, asPlanVersionId('version-1'))!;
  const finalInput = {
    expectedBranchVersion: settings.version,
    targetBranch: 'main',
    rounds: [],
    finalReview: cycleProfiles.review,
    policy: DEFAULT_COMPLETION_POLICY,
    instructions: 'Final independent plan conformance.',
  };
  await expect(
    state.context.services.finalizationService.start(
      f.auth,
      ws,
      asPlanVersionId('version-1'),
      finalInput,
    ),
  ).rejects.toThrow(/original plan work item/);
  await roadmapControl(state, 'start');
  await waitFor(
    () => storage.planning.workItems.find(ws, f.second)?.status === 'completed',
    'complete original plan',
    15000,
  );
  await roadmapControl(state, 'pause');
  expect(service.finalization(f.auth, ws, roadmapId).projects[0]?.status).toBe('ready');
  f.backend.onLaunch = undefined;
  f.backend.replyForRequest = () => ({
    resultText: `## Open questions
none
## Review report
${reviewText([])}`,
  });
  const before = git(['rev-parse', 'main'], f.root),
    started = await state.context.services.finalizationService.start(
      f.auth,
      ws,
      asPlanVersionId('version-1'),
      finalInput,
    ),
    value = started.finalization;
  expect(value.mapContext?.runtimeId).toBe(f.runtime.current!.id);
  await waitFor(
    () => {
      const c = finalizationCycle(state, value);
      if (c.status === 'needs-attention') throw new Error(c.reason);
      return c.status === 'awaiting-merge';
    },
    'pinned final review',
    8000,
  );
  const cycle = finalizationCycle(state, value),
    run = storage.execution.runs.find(ws, cycle.currentRunId)!;
  expect(storage.runtimeEvidence.run(ws, run.id)?.runtimeId).toBe(f.runtime.current!.id);
  expect(git(['rev-parse', 'main'], f.root)).toBe(before);
  expect((await merge(state, value.worktreeId)).statusCode).toBe(409);
  const proposed = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: storedRoadmap(state).version,
    candidate: {
      definitionId: f.parentScope.definitionId,
      bindingRevision: 1,
      targetId: 'LOCAL',
      selection: 'prioritize-full',
    },
    summary: 'Scope changes must wait for finalization.',
  });
  expect(proposed.pendingImpact?.blockers.join(' ')).toContain('finalization');
  expect(
    (
      await finalizationCommand(state, value, 'merge', {
        expectedHeadSha: run.reviewBranchContext!.headSha,
        expectedTargetSha: run.reviewBranchContext!.targetSha,
      })
    ).statusCode,
  ).toBe(409);
  const current = service.view(f.auth, ws, roadmapId);
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: current.history[0]!.id,
    outcome: 'reject',
    impactDigest: current.pendingImpact!.digest,
    rationale: 'Keep current finalization context.',
    reuseIntegrationIds: [],
  });
  const promoted = await finalizationCommand(state, value, 'merge', {
    expectedHeadSha: run.reviewBranchContext!.headSha,
    expectedTargetSha: run.reviewBranchContext!.targetSha,
  });
  expect(promoted.statusCode, promoted.body).toBe(200);
  expect(service.finalization(f.auth, ws, roadmapId).projects[0]?.status).toBe('promoted');
  const { providerBranch } = await import('./services/map-finalization-policy.js');
  expect(
    providerBranch(storage, ws, {
      planVersionId: value.planVersionId,
      integrationBranch: 'revision',
    }),
  ).toBe('main');
  expect(f.service.view(f.auth, ws, input.configuration).published).toBe(false);
});
it('explicitly reuses unchanged integration code across definitions without transferring verification', {
  timeout: 20000,
}, async () => {
  const f = await supervisedMapFixture(true),
    { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage,
    service = state.context.services.mapAmendmentService;
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  await roadmapControl(state, 'start');
  await waitFor(
    () =>
      storage.scopeReceipts.list(ws, state.workItemId).some((r) => r.scope.sourceId === 'AQ-01.A'),
    'slice independently verified',
    10000,
  );
  await roadmapControl(state, 'pause');
  const old = storage.imports.definition(ws, f.parentScope.definitionId)!,
    binding = storage.imports.bindings(ws, old.id)[0]!,
    id = randomUUID();
  storage.imports.addDefinition({
    ...old,
    id,
    revision: 'reuse',
    source: { ...old.source, revision: 'reuse' },
  });
  storage.imports.addBindings({ ...binding, definitionId: id });
  const candidate = {
    definitionId: id,
    bindingRevision: 1,
    targetId: 'LOCAL',
    selection: 'target-only' as const,
  };
  const proposed = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: storedRoadmap(state).version,
    candidate,
    summary: 'Reuse reviewed unchanged code; review evidence again.',
  });
  const impact = proposed.pendingImpact!;
  expect(impact.integrations).toHaveLength(1);
  expect(impact.integrations[0]?.eligible).toBe(true);
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: proposed.history[0]!.id,
    outcome: 'apply',
    impactDigest: impact.digest,
    rationale: 'Ancestry checked; no approval migration.',
    reuseIntegrationIds: ['AQ-01.A'],
  });
  const view = f.service.view(f.auth, ws, candidate);
  expect(view.nodes.find((n) => n.sourceId === 'AQ-01.A' && n.state === 'merged')?.satisfied).toBe(
    true,
  );
  expect(
    view.nodes.find((n) => n.sourceId === 'AQ-01.A' && n.state === 'verified')?.satisfied,
  ).toBe(false);
  expect(
    storage.scopeReceipts.list(ws, state.workItemId).every((r) => r.scope.definitionId !== id),
  ).toBe(true);
  await state.context.services.runtimeEvidenceService.configure(f.auth, ws, id, {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [],
    consumers: f.runtime.current!.consumers.map((c) => ({ ...c, upstreams: [...c.upstreams] })),
    environments: [...f.runtime.current!.environments],
  });
  state.context.services.crossProjectService.adopt(f.auth, ws, id, {
    bindingRevision: 1,
    decisionIds: ['CS-D01'],
    rationale: 'Explicit replacement adoption.',
  });
  const verification = await scopeTree(f, {
    ...f.scopes[0]!,
    definitionId: id,
    kind: 'slice-verification',
  });
  expect(verification.executionScope?.definitionId).toBe(id);
});

it('activates only the reviewed replacement plan while preserving admitted history in the old version', async () => {
  const f = await supervisedMapFixture(true),
    { state } = f,
    ws = state.workspaceId,
    storage = state.context.storage,
    service = state.context.services.mapAmendmentService;
  const saved = f.service.save(f.auth, ws, f.input),
    old = storage.imports.definition(ws, f.parentScope.definitionId)!,
    binding = storage.imports.bindings(ws, old.id)[0]!,
    original = storage.planning.versions.find(ws, asPlanVersionId('version-1'))!,
    item = storage.planning.workItems.find(ws, state.workItemId)!;
  const revised = storage.planning.versions.insert({
      ...original,
      id: asPlanVersionId('version-2'),
      versionNumber: 2,
      contentDigest: '9'.repeat(64),
    }),
    nextItem = asWorkItemId('revised-item');
  storage.planning.workItems.insertMany([{ ...item, id: nextItem, planVersionId: revised.id }]);
  const settings = storage.execution.branchSettings.find(ws, original.id)!;
  storage.execution.branchSettings.save({ ...settings, planVersionId: revised.id, version: 1 }, 0);
  const id = randomUUID();
  storage.imports.addDefinition({
    ...old,
    id,
    revision: 'revised-plan',
    source: { ...old.source, revision: 'revised-plan' },
  });
  storage.imports.addBindings({
    ...binding,
    definitionId: id,
    bindings: binding.bindings.map((b) => ({
      ...b,
      planVersionId: revised.id,
      branchSettingsVersion: 1,
      workItems: b.workItems.map((w) => ({ ...w, workItemId: nextItem })),
    })),
  });
  const proposed = await service.propose(f.auth, ws, roadmapId, {
    expectedVersion: saved.roadmap.version,
    candidate: {
      definitionId: id,
      bindingRevision: 1,
      targetId: 'LOCAL',
      selection: 'target-only',
    },
    summary: 'Review revised plan before activation.',
  });
  expect(proposed.pendingImpact!.bindings[0]?.activate).toBe(true);
  expect(proposed.pendingImpact!.blockers).toEqual([]);
  expect(storage.planning.projects.find(ws, item.projectId)?.activePlanVersionId).toBe(original.id);
  await service.decide(f.auth, ws, roadmapId, {
    amendmentId: proposed.history[0]!.id,
    outcome: 'apply',
    impactDigest: proposed.pendingImpact!.digest,
    rationale: 'Activate this exact revised plan and preserve history.',
    reuseIntegrationIds: [],
  });
  expect(storage.planning.projects.find(ws, item.projectId)?.activePlanVersionId).toBe(revised.id);
  expect(storage.planning.workItems.find(ws, item.id)?.status).toBe('admitted');
  expect(storage.planning.workItems.find(ws, nextItem)?.status).toBe('proposed');
  expect(
    storedRoadmap(state).definition.entries.every(
      (e) => e.planVersionId === revised.id && e.workItemId === nextItem,
    ),
  ).toBe(true);
});

it('discovers reviewable local setup without saving, preserves exact pins, and rejects stale or altered captures', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    checkpoints: [],
    repositories: [
      { ...source.repositories[0]!, id: 'local' },
      { ...source.repositories[0]!, id: 'provider', role: 'implemented_upstream' },
    ],
    work_items: source.work_items.map((w) => ({ ...w, repository: 'local' })),
    aq_baseline_binding: { ...source.aq_baseline_binding!, repository: 'provider' },
  }));
  const provider = fixtureRepository();
  writeFileSync(
    join(provider, 'Cargo.toml'),
    '[package]\nname="discovery_provider"\nversion="0.2.0"\nedition="2021"\n',
  );
  git(['add', '.'], provider);
  git(['commit', '-m', 'provider'], provider);
  const registered = await f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/repositories`,
    headers: mutationHeaders(f.state),
    payload: { rootPath: provider, displayName: 'Discovery fixture' },
  });
  const repository = registerSourceRepositoryResponseSchema.parse(registered.json()).repository;
  const { workspaceId: ws, context } = f.state,
    storage = context.storage;
  const definitionId = f.parentScope.definitionId;
  const binding = storage.imports.bindings(ws, definitionId)[0]!;
  storage.imports.addBindings({
    ...binding,
    revision: 2,
    bindings: [
      ...binding.bindings,
      {
        alias: 'provider',
        repositoryId: repository.id,
        sourceArtifacts: [],
        workItems: [],
      },
    ],
  });
  const base = `/api/workspaces/${ws}/concurrency-definitions/${definitionId}/runtime`;
  const payload = { bindingRevision: 2, refs: [] };
  const forbidden = await context.app.inject({
    method: 'POST',
    url: `${base}/discover`,
    headers: { cookie: f.state.cookie },
    payload,
  });
  expect(forbidden.statusCode).toBe(403);
  const response = await context.app.inject({
    method: 'POST',
    url: `${base}/discover`,
    headers: mutationHeaders(f.state),
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  const { discoverRuntimeResponseSchema } = await import('@craftingtable/contracts');
  const { configuration } = discoverRuntimeResponseSchema.parse(response.json());
  expect(configuration.pins[0]).toMatchObject({
    alias: 'provider',
    ref: 'main',
    expectedCommitSha: git(['rev-parse', 'HEAD'], provider).trim(),
    conformanceRevision: '16',
  });
  expect(configuration.consumers).toEqual([{ alias: 'local', upstreams: ['provider'] }]);
  const env = configuration.environments[0]!;
  expect(env.kind).toBe('local-development');
  expect(env.discovery?.toolchains).toContain('rustc');
  expect(storage.runtimeEvidence.generations(ws, definitionId, 2)).toHaveLength(0);
  const svc = context.services.runtimeEvidenceService;
  await expect(
    svc.configure(f.auth, ws, definitionId, {
      ...configuration,
      environments: [{ ...env, identityDigest: 'a'.repeat(64) }],
    }),
  ).rejects.toThrow('must match');
  await expect(
    svc.configure(f.auth, ws, definitionId, {
      ...configuration,
      environments: [{ ...env, kind: 'external-kata' }],
    }),
  ).rejects.toThrow('cannot qualify external');
  const saved = await svc.configure(f.auth, ws, definitionId, configuration);
  expect(saved.current?.environments[0]?.discovery).toEqual(env.discovery);
  await expect(svc.configure(f.auth, ws, definitionId, configuration)).rejects.toThrow(
    'Runtime or plan binding changed',
  );
  const draft = await svc.discover(f.auth, ws, definitionId, payload);
  git(['commit', '--allow-empty', '-m', 'Upstream moved after discovery'], provider);
  await expect(svc.configure(f.auth, ws, definitionId, draft.configuration)).rejects.toThrow(
    'advanced before saving',
  );
  storage.imports.addBindings({ ...storage.imports.bindings(ws, definitionId)[0]!, revision: 3 });
  await expect(svc.discover(f.auth, ws, definitionId, payload)).rejects.toThrow('binding changed');
  expect(storage.imports.adoptions(ws, definitionId)).toHaveLength(0);
});

it('generates saved plan facts without approval, guards HTTP authority and starts only after explicit plan review', async () => {
  const f = await supervisedMapFixture(false, 'automatic', false, true);
  const { context, workspaceId: ws } = f.state;
  const svc = context.services.runtimeEvidenceService;
  const id = f.parentScope.definitionId;
  const base = `/api/workspaces/${ws}/concurrency-definitions/${id}/runtime`;
  await adoptSupervisedMap(f);
  expect((await svc.view(f.auth, ws, id)).planAcceptance?.roadmaps).toHaveLength(0);
  const saved = f.service.save(f.auth, ws, f.input).roadmap;
  const ready = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  expect(ready.state).toBe('ready-to-generate');
  expect(
    f.service
      .view(f.auth, ws, f.input.configuration)
      .setupRequirements.some((r) => r.kind === 'plan-acceptance'),
  ).toBe(true);
  await expect(
    context.services.roadmapService.control(f.auth, ws, saved.id, 'start', saved.version),
  ).rejects.toThrow('Waiting for plan acceptance');
  const payload = {
    roadmapId: saved.id,
    definitionRevision: ready.definitionRevision,
    snapshotDigest: ready.snapshotDigest,
  };
  const post = (headers = mutationHeaders(f.state), body = payload) =>
    context.app.inject({ method: 'POST', url: `${base}/generate-plan`, headers, payload: body });
  expect((await post({ cookie: f.state.cookie })).statusCode).toBe(403);
  expect(
    (await post(mutationHeaders(f.state), { ...payload, snapshotDigest: '0'.repeat(64) }))
      .statusCode,
  ).toBe(409);
  const response = await post();
  expect(response.statusCode, response.body).toBe(200);
  const generated = response.json();
  const evidence = generated.submissions[0].submission;
  expect(evidence.generatedPlan.roadmapId).toBe(saved.id);
  expect(evidence.reviewers).toEqual([]);
  expect(generated.planAcceptance.roadmaps[0].state).toBe('awaiting-review');
  expect(generated.submissions[0].issues).toEqual([]);
  expect(context.storage.runtimeEvidence.decisions(ws)).toHaveLength(0);
  expect(context.storage.roadmaps.find(ws, saved.id)?.attempts).toHaveLength(0);
  expect(evidence.artifacts.map((a: { name: string }) => a.name)).toEqual(
    expect.arrayContaining(['map', 'binding', 'adoption', 'runtime', 'roadmap', 'resources']),
  );
  expect((await post()).statusCode).toBe(200);
  expect(context.storage.runtimeEvidence.submissions(ws, id)).toHaveLength(1);
  const manualPackage = {
    runtimeId: evidence.runtimeId,
    subject: evidence.subject,
    environmentId: evidence.environmentId,
    executedBy: evidence.executedBy,
    executedAt: evidence.executedAt,
    reviewers: [
      {
        identity: 'Independent fixture reviewer',
        roles: ['stack-integration-owner'],
        artifact: 'plan-review-guide',
      },
    ],
    requirements: evidence.requirements,
    cases: evidence.cases,
    artifacts: evidence.artifacts.map((a: { name: string; content: string }) => ({
      name: a.name,
      content: a.content,
    })),
  };
  expect(evidenceSubmissionRequestSchema.safeParse(manualPackage).success).toBe(true);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `${base}/submit`,
        headers: mutationHeaders(f.state),
        payload: { ...manualPackage, generatedPlan: evidence.generatedPlan },
      })
    ).statusCode,
  ).toBe(400);
  const accepted = await svc.decide(f.auth, ws, id, {
    submissionId: evidence.id,
    outcome: 'accepted',
    rationale:
      'I reviewed the exact saved plan and configured independent review responsibilities as stack-integration-owner.',
  });
  expect(accepted.planAcceptance!.roadmaps[0]!.state).toBe('accepted');
  expect(f.service.view(f.auth, ws, f.input.configuration).blockers).toEqual([]);
  expect(context.storage.roadmaps.find(ws, saved.id)?.status).toBe('draft');
  await context.services.roadmapService.control(f.auth, ws, saved.id, 'start', saved.version);
  expect(context.storage.roadmaps.find(ws, saved.id)?.status).toBe('running');
  const prior = accepted.current!;
  await svc.configure(f.auth, ws, id, {
    bindingRevision: 1,
    expectedGeneration: prior.generation,
    pins: [],
    consumers: prior.consumers.map((c) => ({ ...c, upstreams: [...c.upstreams] })),
    environments: [...prior.environments],
  });
  expect(acceptedEvidence(context.storage, ws, id, 1, evidence.subject)).toBeUndefined();
});

it('invalidates generated plan evidence when saved settings change and rejects stale acceptance after an await', async () => {
  const f = await supervisedMapFixture(false, 'automatic', false, true);
  const { context, workspaceId: ws } = f.state;
  const svc = context.services.runtimeEvidenceService,
    id = f.parentScope.definitionId;
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, ws, f.input).roadmap;
  const ready = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  const generated = await svc.generatePlanEvidence(f.auth, ws, id, {
    roadmapId: saved.id,
    definitionRevision: ready.definitionRevision,
    snapshotDigest: ready.snapshotDigest,
  });
  const first = generated.submissions[0]!.submission;
  const changed = f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: saved.version,
    name: 'Revised saved settings',
  }).roadmap;
  await expect(
    svc.decide(f.auth, ws, id, {
      submissionId: first.id,
      outcome: 'accepted',
      rationale: 'Review old facts',
    }),
  ).rejects.toThrow('Saved configuration changed');
  expect(context.storage.runtimeEvidence.decisions(ws)).toHaveLength(0);
  const current = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  const next = await svc.generatePlanEvidence(f.auth, ws, id, {
    roadmapId: saved.id,
    definitionRevision: current.definitionRevision,
    snapshotDigest: current.snapshotDigest,
  });
  const second = next.submissions.find((s) => s.submission.id !== first.id)!.submission;
  await svc.decide(f.auth, ws, id, {
    submissionId: second.id,
    outcome: 'accepted',
    rationale: 'Reviewed revised settings',
  });
  expect(acceptedEvidence(context.storage, ws, id, 1, second.subject)?.id).toBe(second.id);
  // The idle scan only uses a shared snapshot to defer work. A later scan sees new settings.
  const service = context.services.roadmapService;
  const spy = vi.spyOn(context.storage.imports, 'definition');
  service['deferredEntries'](changed);
  expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
  spy.mockRestore();
  f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: changed.version,
    name: 'Changed again',
  });
  expect(acceptedEvidence(context.storage, ws, id, 1, second.subject)).toBeUndefined();
  expect(
    service['deferredEntries'](context.storage.roadmaps.find(ws, saved.id)!).size,
  ).toBeGreaterThan(0);
  const pending = (await svc.view(f.auth, ws, id)).planAcceptance!.roadmaps[0]!;
  const thirdView = await svc.generatePlanEvidence(f.auth, ws, id, {
    roadmapId: saved.id,
    definitionRevision: pending.definitionRevision,
    snapshotDigest: pending.snapshotDigest,
  });
  const third = thirdView.submissions.find((s) => !s.decision && !s.issues.length)!.submission;
  const review = svc.decide(f.auth, ws, id, {
    submissionId: third.id,
    outcome: 'accepted',
    rationale: 'Reviewed before a concurrent settings change',
  });
  const latest = context.storage.roadmaps.find(ws, saved.id)!;
  f.service.save(f.auth, ws, {
    ...f.input,
    expectedVersion: latest.version,
    name: 'Changed during review',
  });
  await expect(review).rejects.toThrow('Saved configuration changed');
  expect(
    context.storage.runtimeEvidence.decisions(ws).some((d) => d.submissionId === third.id),
  ).toBe(false);
});

it('native resource approval is scoped, revocable and never admits Kata or development receipts', async () => {
  const { nativeHostDigest } = await import('@craftingtable/agents');
  const { phaseResources } = await import('./services/phase-resources.js');
  const { resolveScope } = await import('./services/execution-scope.js');
  const { currentScopeReceipt } = await import('./services/runtime-evidence-policy.js');
  const f = await slicedFixture((source) => ({
    ...source,
    checkpoints: [],
    slices: source.slices.map((s, i) => ({
      ...s,
      resources_by_phase: {
        ...s.resources_by_phase,
        verify: [i === 0 ? 'controlled-native-test-host' : 'kata-instance-test-host'],
      },
    })),
  }));
  const { state } = f,
    tx = state.context.storage,
    ws = state.workspaceId,
    scope = f.scopes[0]!;
  const runtime = {
    id: randomUUID(),
    workspaceId: ws,
    definitionId: scope.definitionId,
    bindingRevision: 1,
    generation: 1,
    digest: 'a'.repeat(64),
    pins: [],
    consumers: [],
    environments: [],
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  };
  tx.runtimeEvidence.addGeneration(runtime);
  const resolved = resolveScope(tx, ws, state.workItemId, scope);
  expect(phaseResources(tx, resolved, 'verify').blockers[0]?.kind).toBe('authorization');
  const approval = {
    id: randomUUID(),
    workspaceId: ws,
    definitionId: scope.definitionId,
    bindingRevision: 1,
    runtimeId: runtime.id,
    approved: true,
    hostDigest: nativeHostDigest(),
    auditDigest: 'a'.repeat(64),
    audit: 'fixture',
    rationale: 'Approve fixtures',
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  };
  tx.runtimeEvidence.addNativeApproval(approval);
  expect(phaseResources(tx, resolved, 'verify')).toMatchObject({
    blockers: [],
    resources: [{ key: 'local-verification' }],
  });
  expect(
    phaseResources(tx, resolveScope(tx, ws, state.workItemId, f.scopes[1]!), 'verify').blockers[0]
      ?.kind,
  ).toBe('authorization');
  // An implementation review without native provenance cannot become a current native receipt.
  expect(
    currentScopeReceipt(tx, ws, {
      scope,
      workspaceId: ws,
      reviewRunId: asAgentRunId('missing'),
    } as import('@craftingtable/domain').ScopeReceipt),
  ).toBe(false);
  tx.runtimeEvidence.addNativeApproval({ ...approval, id: randomUUID(), approved: false });
  expect(phaseResources(tx, resolved, 'verify').blockers[0]?.kind).toBe('authorization');
  // The HTTP boundary requires CSRF before an audit/approval can run.
  const denied = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/concurrency-definitions/${scope.definitionId}/runtime/authorize-native`,
    headers: { cookie: state.cookie },
    payload: {},
  });
  expect(denied.statusCode).toBe(403);
  const agents = await import('@craftingtable/agents');
  const audit = {
    hostDigest: nativeHostDigest(),
    auditDigest: 'b'.repeat(64),
    facts: 'Audited fixtures',
    ready: true,
    issues: [],
    kata: { installed: false, kvmAvailable: true, message: 'Not installed' },
  };
  const spy = vi.spyOn(agents, 'auditNativeEnvironment').mockResolvedValue(audit);
  try {
    const prior = tx.runtimeEvidence.nativeApprovals(ws, scope.definitionId, 1)[0]!;
    const input = {
      bindingRevision: 1,
      runtimeId: runtime.id,
      expectedApprovalId: prior.id,
      approved: true,
      auditDigest: audit.auditDigest,
      rationale: 'Reviewed captured limits',
    };
    await expect(
      state.context.services.runtimeEvidenceService.approveNative(f.auth, ws, scope.definitionId, {
        ...input,
        auditDigest: 'c'.repeat(64),
      }),
    ).rejects.toThrow('audit changed');
    const saved = await state.context.services.runtimeEvidenceService.approveNative(
      f.auth,
      ws,
      scope.definitionId,
      input,
    );
    expect(saved.nativeVerification.current).toBe(true);
    expect(tx.runtimeEvidence.generations(ws, scope.definitionId, 1)).toHaveLength(1);
    const { buildVerificationPolicy } = await import('./services/build-verification-policy.js');
    const verificationScope = { ...scope, kind: 'slice-verification' as const };
    const policy = buildVerificationPolicy(
      tx.imports.definition(ws, scope.definitionId)!,
      verificationScope,
    );
    const runId = asAgentRunId(randomUUID()),
      manifestDigest = 'd'.repeat(64),
      headSha = 'e'.repeat(40);
    const native = saved.nativeVerification.approval!;
    let receipt = {
      kind: 'scoped-check',
      success: true,
      clean: true,
      headSha,
      manifestDigest,
      runId,
      runtimeId: runtime.id,
      verificationMode: policy.mode,
      policyDigest: agents.cargoManifestDigest(JSON.stringify(policy)),
      nativeVerification: {
        approvalId: native.id,
        hostDigest: native.hostDigest,
        auditDigest: native.auditDigest,
      },
    };
    const runSpy = vi.spyOn(tx.runtimeEvidence, 'run').mockReturnValue({
      runId,
      workspaceId: ws,
      runtimeId: runtime.id,
      manifestPath: '/unused',
      manifestDigest,
      nativeApprovalId: native.id,
    });
    const buildSpy = vi.spyOn(tx.runtimeEvidence, 'build').mockImplementation(() => ({
      runId,
      workspaceId: ws,
      runtimeId: runtime.id,
      manifestDigest,
      digest: 'f'.repeat(64),
      receipts: JSON.stringify(receipt),
    }));
    const agentSpy = vi.spyOn(tx.execution.runs, 'find').mockReturnValue({
      id: runId,
      reviewBranchContext: { headSha },
    } as import('@craftingtable/domain').AgentRun);
    try {
      // Parent acceptance must become stale when its native prerequisite authority changes.
      const parentReceipt = {
        scope: f.parentScope,
        workspaceId: ws,
        reviewRunId: runId,
      } as import('@craftingtable/domain').ScopeReceipt;
      expect(currentScopeReceipt(tx, ws, parentReceipt)).toBe(true);
      runSpy.mockReturnValueOnce({
        runId,
        workspaceId: ws,
        runtimeId: runtime.id,
        manifestPath: '/unused',
        manifestDigest,
        nativeApprovalId: randomUUID(),
      });
      expect(currentScopeReceipt(tx, ws, parentReceipt)).toBe(false);
      const tree = {
        workspaceId: ws,
        repositoryId: f.repository.id,
        executionScope: verificationScope,
      } as import('@craftingtable/domain').Worktree;
      expect(() => state.context.services.runtimeEvidenceService.assertRun(tree, runId)).toThrow(
        'successful ct-native',
      );
      receipt = { ...receipt, kind: 'native-check' };
      expect(() =>
        state.context.services.runtimeEvidenceService.assertRun(tree, runId),
      ).not.toThrow();
      receipt = {
        ...receipt,
        nativeVerification: { ...receipt.nativeVerification, approvalId: randomUUID() },
      };
      expect(() => state.context.services.runtimeEvidenceService.assertRun(tree, runId)).toThrow(
        'successful ct-native',
      );
    } finally {
      runSpy.mockRestore();
      buildSpy.mockRestore();
      agentSpy.mockRestore();
    }

    await expect(
      state.context.services.runtimeEvidenceService.approveNative(
        f.auth,
        ws,
        scope.definitionId,
        input,
      ),
    ).rejects.toThrow('approval changed');
  } finally {
    spy.mockRestore();
  }
});

it('alerts for an eligible missing native environment, not future dependency waits, and resolves after approval', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    evidence_profiles: source.evidence_profiles.map((p) => ({
      ...p,
      reviewer_roles: ['repository-maintainer'],
    })),
    slices: source.slices.map((s) => ({
      ...s,
      resources_by_phase: { ...s.resources_by_phase, verify: ['controlled-native-test-host'] },
    })),
  }));
  const { state } = f,
    ws = state.workspaceId,
    tx = state.context.storage;
  await state.context.services.roadmapService.shutdown();
  const input = roadmapInput(state, [state.workItemId]);
  const saved = await saveRoadmapRequest(state, {
    ...input,
    entries: input.entries.map((e) => ({
      ...e,
      executionScope: f.scopes[0],
    })),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const draft = storedRoadmap(state);
  tx.roadmaps.save(
    {
      ...draft,
      definition: {
        ...draft.definition,
        entries: draft.definition.entries.map((e) => ({
          ...e,
          executionScope: { ...f.scopes[0]!, kind: 'slice-verification' as const },
        })),
      },
      version: draft.version + 1,
      status: 'running',
    },
    draft.version,
  );
  const { DEFAULT_NOTIFICATION_PREFERENCES } = await import('@craftingtable/domain');
  const notifications = state.context.services.notificationService;
  notifications.save(f.auth, ws, {
    expectedVersion: 0,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
    applicationToken: 'a'.repeat(30),
    userKey: 'u'.repeat(30),
  });
  await notifications.tick();
  const alerts = () =>
    tx.notifications.records(ws).filter((n) => n.sourceKey.includes(':environments:'));
  expect(alerts()).toHaveLength(0);
  const tree = await scopeTree(f, f.scopes[0]!);
  commitFile(tree.path, 'a.txt', 'A');
  await reviewScope(f, tree);
  expect((await merge(state, tree.id)).statusCode).toBe(200);
  await notifications.tick();
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]?.state).toBe('active');
  expect(alerts()[0]?.message).toContain('controlled-native-test-host');
  const { nativeHostDigest } = await import('@craftingtable/agents');
  const runtimeId = randomUUID();
  tx.runtimeEvidence.addGeneration({
    id: runtimeId,
    workspaceId: ws,
    definitionId: f.parentScope.definitionId,
    bindingRevision: 1,
    generation: 1,
    digest: 'a'.repeat(64),
    pins: [],
    consumers: [{ alias: 'local', upstreams: [] }],
    environments: [],
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  });
  tx.runtimeEvidence.addNativeApproval({
    id: randomUUID(),
    workspaceId: ws,
    definitionId: f.parentScope.definitionId,
    bindingRevision: 1,
    runtimeId,
    approved: true,
    hostDigest: nativeHostDigest(),
    auditDigest: 'a'.repeat(64),
    audit: 'fixture',
    rationale: 'Approved',
    createdAt: new Date().toISOString(),
    createdByUserId: state.userId,
  });
  await notifications.tick();
  expect(alerts().filter((n) => n.state === 'active')).toHaveLength(1);
  expect(alerts().find((n) => n.state === 'active')?.message).toContain('reviewer qualifications');
  const roleSpy = vi
    .spyOn(await import('./services/map-adoption-policy.js'), 'scopeReviewerRoles')
    .mockReturnValue(['repository-maintainer']);
  try {
    await notifications.tick();
    expect(alerts().every((n) => n.state === 'resolved')).toBe(true);
  } finally {
    roleSpy.mockRestore();
  }
});

it.each([false, true])(
  'slice remediation recovery preserves exact scope (missing evidence: %s)',
  async (omitEvidence) => {
    const f = await slicedFixture();
    const { state, backend } = f;
    const scope = f.scopes[0]!;
    const tree = await scopeTree(f, scope);
    let resolved = false;
    backend.replyForRequest = (request) => {
      if (request.model === 'design-model') return designDone;
      if (request.model !== 'review-model') return implementationDone;
      const finding = resolved
        ? { ...structuredFinding, status: 'resolved', disposition: 'Verified the slice fix.' }
        : structuredFinding;
      return {
        resultText: scopeReport(state, scope, omitEvidence)
          .replace('"findings":[]', `"findings":${JSON.stringify([finding])}`)
          .replaceAll('mergeable', resolved ? 'mergeable' : 'changes-requested'),
      };
    };
    const cycle = await startCycle(state, tree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
    });
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'slice checkpoint',
    );
    const before = currentCycle(state, cycle);
    resolved = true;
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'authorize-remediation',
        expectedVersion: before.version,
        additionalRounds: 1,
      },
    });
    expect(response.statusCode, response.body).toBe(omitEvidence ? 409 : 200);
    if (omitEvidence) {
      expect(currentCycle(state, cycle)).toEqual(before);
      expect(backend.launches).toHaveLength(3);
    } else {
      expect(workCycleResponseSchema.parse(response.json()).cycle).toMatchObject({
        executionScope: scope,
        additionalRemediationRounds: 1,
      });
      await waitFor(
        () => currentCycle(state, cycle).status === 'awaiting-merge',
        'recovered slice review',
      );
      expect(currentCycle(state, cycle)).toMatchObject({
        executionScope: scope,
        remediationRounds: 1,
        policy: { maxRemediationRounds: 0 },
      });
      expect(backend.launches).toHaveLength(5);
    }
  },
);

it('adopts immutable repository policy, packages fresh evidence, and expires prior review approval', async () => {
  const state = await ready();
  const root = fixtureRepository();
  git(['branch', 'revision'], root);
  const { worktree } = await registerAndWorktree(state, root, 'revision');
  const path = 'plan-versions/version-1/repository-policy';
  const preview = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/${path}`,
    headers: { cookie: state.cookie },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.json().policy).toBeUndefined();
  const input = {
    expectedVersion: 0,
    expectedBranchSettingsVersion: 1,
    controlMode: 'controller-local',
    experimentalFreeze: preview.json().proposedFreeze,
    interpretation: 'Use controller gates now; preserve the experimental baseline.',
    publicationRequirement: 'Verify remote protections before first publication.',
  };
  await runToFinish(state, worktree.id, { role: 'review', instructions: 'VERDICT-MERGEABLE' });
  const saved = await branchCommand(state, path, input);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json()).toMatchObject({
    settingsVersion: 1,
    issues: [],
    policy: { version: 1, adoptedByUserId: state.userId },
    observedFreezeSha: git(['rev-parse', 'main'], root).trim(),
  });
  const branches = state.context.services.executionService.branches;
  expect(() =>
    branches.requirePolicyMergeTarget(state.workspaceId, worktree.repositoryId, 'main'),
  ).toThrow('frozen by repository policy');
  expect(() =>
    branches.requirePolicyMergeTarget(state.workspaceId, worktree.repositoryId, 'revision'),
  ).not.toThrow();
  expect(() =>
    branches.requirePolicyMergeTarget(state.workspaceId, worktree.repositoryId, 'main', true),
  ).not.toThrow();
  expect((await branchCommand(state, path, input)).statusCode).toBe(409);
  expect((await merge(state, worktree.id)).statusCode).toBe(409);
  const review = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  const run = state.context.storage.execution.runs.find(state.workspaceId, review)!;
  expect(run.reviewBranchContext?.repositoryPolicyVersion).toBe(1);
  const evidencePath = run.brief.match(/`([^`]+\/craftingtable-repository-policy.json)`/)?.[1];
  expect(evidencePath).toBeTruthy();
  const evidence = JSON.parse(readFileSync(evidencePath!, 'utf8'));
  expect(evidence.policy).toMatchObject({
    version: 1,
    experimentalFreeze: input.experimentalFreeze,
  });
  expect(evidence.limitations.join(' ')).toContain('No remote protection');
  const reopened = openCraftingTableStorage(state.context.storage.databasePath);
  try {
    expect(
      reopened.execution.branchSettings.policy(state.workspaceId, asPlanVersionId('version-1'))
        ?.version,
    ).toBe(1);
  } finally {
    reopened.close();
  }
  const changed = await branchCommand(state, path, {
    ...input,
    expectedVersion: 1,
    interpretation: 'Revised operator interpretation.',
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect((await merge(state, worktree.id)).statusCode).toBe(409);
  // A direct Git mutation is observable, not prevented by the claimed local workflow control.
  commitFile(root, 'outside-controller.txt', 'changed baseline');
  const drift = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/${path}`,
    headers: { cookie: state.cookie },
  });
  expect(drift.json().issues.join(' ')).toContain('frozen experimental branch moved');
  expect((await branchCommand(state, path, { ...input, expectedVersion: 2 })).statusCode).toBe(409);
  expect(git(['rev-parse', 'revision'], root).trim()).toBe(input.experimentalFreeze.commitSha);
});

it('carries recorded operator guidance into related verification and acceptance scopes only', async () => {
  const f = await slicedFixture();
  const { state, backend } = f;
  const tree = await scopeTree(f, f.scopes[0]!);
  backend.replyForRequest = () => ({ resultText: '## Open questions\nWhich policy applies?' });
  const cycle = await startCycle(state, tree.id, {
    instructions: 'Original operator instruction: local integration controls.',
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'design question');
  const stopped = await controlCycle(state, currentCycle(state, cycle), 'stop');
  expect(operatorDecisions(state.context.storage, state.workspaceId, [f.second])).toEqual([]);
  expect(
    operatorDecisions(state.context.storage, state.workspaceId, [state.workItemId], {
      ...f.scopes[0]!,
      bindingRevision: 999,
    }),
  ).toEqual([]);
  for (const scope of [
    f.scopes[0]!,
    { ...f.scopes[0]!, kind: 'slice-verification' as const },
    f.parentScope,
  ]) {
    const ledger = scopeEvidenceLedger(
      state.context.storage,
      resolveScope(state.context.storage, state.workspaceId, state.workItemId, scope),
    );
    expect(ledger.operatorDecisions).toEqual([
      expect.objectContaining({
        sourceCycleId: stopped.id,
        cycleInstructions: 'Original operator instruction: local integration controls.',
      }),
    ]);
  }
});
