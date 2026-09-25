import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  AgentBackend,
  AgentLaunchRequest,
  AgentSession,
  AgentSessionItem,
} from '@craftingtable/agents';
import {
  agentRunDetailResponseSchema,
  createWorktreeResponseSchema,
  registerSourceRepositoryResponseSchema,
  startAgentRunResponseSchema,
  workCycleResponseSchema,
  workItemExecutionResponseSchema,
} from '@craftingtable/contracts';
import type { ExecutionScope } from '@craftingtable/domain';
import {
  type AgentBackendKind,
  type AgentExitReason,
  type AgentRunId,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  CYCLE_STEPS,
  type CompletionPolicy,
  type CycleProfiles,
  DEFAULT_COMPLETION_POLICY,
  FINALIZATION_STAGE_KINDS,
  type UserId,
  type WorkCycle,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import { sourceRecordDigest } from '@craftingtable/planning';
import type { LightMyRequestResponse } from 'fastify';
import { expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from './config.js';
import { resolveExecutable } from './services/executables.js';
import { PLAN_CRITERIA, PLAN_REQUIREMENTS } from './services/plan-acceptance-policy.js';
import {
  LOCAL_SLICES,
  localMapArchive,
  localScopeSource,
  withoutScaffolding,
} from './map-test-support.js';
import { createTestContext, type TestContext } from './test-support.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fixtures shared by the server-execution-*.test.ts files, split by aggregate from the
 * former server-execution.test.ts (R-I2). Each test file registers
 * `afterEach(cleanupExecutionFixtures)`.
 */

export const contexts: TestContext[] = [];
export const directories: string[] = [];
export async function cleanupExecutionFixtures(): Promise<void> {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

export function fixtureRepository(): string {
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
export class ScriptedBackend implements AgentBackend {
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

export interface ScriptedReply {
  readonly providerFailure?: import('@craftingtable/domain').ProviderFailure;
  readonly backgroundWorkPending?: boolean;
  readonly exitReason?: AgentExitReason;
  readonly messages?: readonly string[];
  readonly resultText: string;
  readonly truncated?: boolean;
  /** What the turn's one tool call prints; `README.md` when absent. */
  readonly toolOutput?: string;
}

export class ScriptedSession implements AgentSession {
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
          content: reply?.toolOutput ?? 'README.md',
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
          outcome: reply?.providerFailure ? 'error' : 'success',
          ...(reply?.providerFailure ? { providerFailure: reply.providerFailure } : {}),
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

export interface Ready {
  readonly context: TestContext;
  readonly cookie: string;
  readonly csrfToken: string;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly workItemId: ReturnType<typeof asWorkItemId>;
  readonly backend: ScriptedBackend;
}

export async function ready(
  options: {
    readonly now?: () => Date;
    readonly backend?: ScriptedBackend | null;
    readonly backends?: ReadonlyMap<AgentBackendKind, AgentBackend>;
    readonly gitOperations?: GitOperations;
    /**
     * Keeps the daemon's own controller loops running. Only for tests that race operator
     * commands against a controller pass held inside a Git operation or a launch; every
     * other daemon is stepped by `waitFor` and `stepDaemons` (R-B2 seam).
     */
    readonly workers?: boolean;
  } = {},
): Promise<Ready> {
  const backend = options.backend === undefined ? new ScriptedBackend() : options.backend;
  const context = await createTestContext({
    ...(options.now === undefined ? {} : { now: options.now }),
    gitOperations: options.gitOperations ?? createGitOperations({ gitExecutable: 'git' }),
    agentBackends: options.backends ?? new Map(backend === null ? [] : [[backend.kind, backend]]),
    workers: options.workers ?? false,
  });
  contexts.push(context);
  if (options.workers) freeRunning.add(context);
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

export function mutationHeaders(ready: Ready): Record<string, string> {
  return {
    cookie: ready.cookie,
    origin: ready.context.config.publicOrigin,
    [CSRF_HEADER_NAME]: ready.csrfToken,
    'content-type': 'application/json',
  };
}

export async function registerAndWorktree(
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

/**
 * One pass of every open test daemon's controllers (R-B2 seam): live runs settle, then the
 * roadmap scheduler, the cycle controller and notification delivery each run once.
 */
export async function stepDaemons(steps = 1): Promise<void> {
  for (let step = 0; step < steps; step++)
    for (const context of contexts) {
      if (freeRunning.has(context)) continue;
      const { services } = context;
      await services.agentRunService.quiesce();
      await services.roadmapService.tick();
      await services.workCycleService.tick();
      await services.agentRunService.quiesce();
      await services.notificationService.tick();
    }
}
/** Daemons created with `workers: true`, whose own loops run; stepping skips them. */
const freeRunning = new WeakSet<TestContext>();

/**
 * Steps the daemons until the predicate holds. Their loops are stopped, so state changes
 * only here; real time still passes between steps for sessions that answer on a timer.
 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await stepDaemons();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

export async function admit(state: Ready): Promise<void> {
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/admit`,
    headers: mutationHeaders(state),
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(200);
}

export async function runToFinish(
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

export async function mergeGate(state: Ready, worktreeId: string) {
  const execution = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/execution`,
    headers: { cookie: state.cookie },
  });
  return workItemExecutionResponseSchema.parse(execution.json()).mergeGates[
    worktreeId as WorktreeId
  ];
}

export async function merge(
  state: Ready,
  worktreeId: string,
  payload: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/worktrees/${worktreeId}/merge`,
    headers: mutationHeaders(state),
    payload,
  });
}

export const structuredFinding = {
  id: 'F-001',
  severity: 'minor',
  status: 'open',
  title: 'Boundary coverage',
  explanation: 'Cover the boundary.',
  recommendation: 'Add a regression case.',
};
export function reviewText(findings: readonly unknown[]) {
  return `\`\`\`craftingtable-review\n${JSON.stringify({ version: 1, complete: true, verdict: 'mergeable', exitGate: { met: true, evidence: 'Checks passed.' }, findings })}\n\`\`\`\nVERDICT: mergeable`;
}

export async function runDetail(state: Ready, id: AgentRunId) {
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/runs/${id}`,
    headers: { cookie: state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return agentRunDetailResponseSchema.parse(response.json());
}

/* Automated cycle exercises the same real Git/worktree and journal path as manual execution. */
export class CycleBackend extends ScriptedBackend {
  onLaunch: ((request: AgentLaunchRequest) => void) | undefined;
  replyForRequest: ((request: AgentLaunchRequest) => ScriptedReply) | undefined;
  constructor(
    private readonly outputs: readonly ScriptedReply[],
    kind: AgentBackendKind = 'claude-code',
  ) {
    super(kind);
  }
  private scripted = 0;
  /** The latest reply per worktree: concurrent cycles each repeat their own report. */
  private readonly lastReply = new Map<string, ScriptedReply>();
  /** Automatic output-format repairs launched so far (R-C2). */
  repairs = 0;
  override launch(request: AgentLaunchRequest): Promise<AgentSession> {
    this.onLaunch?.(request);
    // An automatic output-format repair resumes the session (R-C2). The scripted agent repeats
    // its report, so scripted outputs and reply scripts stay aligned with the steps.
    const repair =
      request.resumeSessionId !== undefined && request.prompt.startsWith(OUTPUT_REPAIR_PROMPT);
    if (repair) this.repairs += 1;
    const previous = repair ? this.lastReply.get(request.cwd) : undefined;
    const reply = previous ??
      this.replyForRequest?.(request) ??
      this.outputs[this.scripted++] ?? { resultText: 'No scripted result' };
    this.lastReply.set(request.cwd, reply);
    this.repliesForNextRun = [reply];
    return super.launch(request);
  }
}
export const OUTPUT_REPAIR_PROMPT = 'CraftingTable could not accept your final report';
export const cycleProfiles = Object.fromEntries(
  CYCLE_STEPS.map((step) => [
    step,
    { backend: 'claude-code', model: `${step}-model`, permissionMode: 'auto' },
  ]),
) as unknown as CycleProfiles;
export async function startCycle(
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
export function currentCycle(state: Ready, cycle: WorkCycle): WorkCycle {
  const found = state.context.storage.execution.cycles.find(state.workspaceId, cycle.id);
  if (!found) throw new Error('Missing cycle');
  return found;
}
export async function controlCycle(
  state: Ready,
  cycle: WorkCycle,
  action: 'pause' | 'resume' | 'stop',
) {
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: { action, expectedVersion: cycle.version },
  });
  expect(response.statusCode, response.body).toBe(200);
  return workCycleResponseSchema.parse(response.json()).cycle;
}
export async function cycleFixture(
  outputs: readonly ScriptedReply[],
  now?: () => Date,
  gitOperations?: GitOperations,
  options: { readonly workers?: boolean } = {},
) {
  const backend = new CycleBackend(outputs);
  const state = await ready({
    backend,
    ...(now === undefined ? {} : { now }),
    ...(gitOperations ? { gitOperations } : {}),
    ...(options.workers ? { workers: true } : {}),
  });
  const root = fixtureRepository();
  const { worktree } = await registerAndWorktree(state, root);
  await admit(state);
  return { state, backend, worktree, root };
}
export const designDone = { resultText: 'Design complete.\n\n## Open questions\nnone' };
export const implementationDone = { resultText: 'Implemented and checks passed.' };

/* Branch mechanics: real Git, authenticated commands, durable provenance. */
export async function branchCommand(
  state: Ready,
  path: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/${path}`,
    headers: mutationHeaders(state),
    payload,
  });
}
export function commitFile(path: string, filename: string, content: string) {
  writeFileSync(join(path, filename), content);
  git(['add', '--all'], path);
  git(['commit', '--no-gpg-sign', '-m', filename], path);
  return git(['rev-parse', 'HEAD'], path).trim();
}

/* Roadmaps exercise real admission, Git, cycles, operator merge, and durable revisions. */
export async function roadmapFixture(
  outputs: readonly ScriptedReply[] = [
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ],
  options: {
    gitOperations?: GitOperations;
    keepWorktree?: boolean;
    alternateBackend?: AgentBackend;
    workers?: boolean;
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
    ...(options.workers ? { workers: true } : {}),
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
export const roadmapId = '00000000-0000-4000-8000-000000000010';
export const entryIds = [
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000012',
];
export function roadmapInput(state: Ready, ids = [state.workItemId, asWorkItemId('item-2')]) {
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
export async function saveRoadmapRequest(
  state: Ready,
  input: unknown = roadmapInput(state),
  id = roadmapId,
): Promise<LightMyRequestResponse> {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${id}`,
    headers: mutationHeaders(state),
    payload: input as Record<string, unknown>,
  });
}
export function storedRoadmap(state: Ready) {
  const roadmap = state.context.storage.roadmaps.find(state.workspaceId, roadmapId);
  if (!roadmap) throw new Error('Missing roadmap');
  return roadmap;
}
export async function roadmapControl(
  state: Ready,
  action: 'start' | 'pause' | 'resume' | 'stop',
): Promise<LightMyRequestResponse> {
  const response = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: { action, expectedVersion: storedRoadmap(state).version },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}
export async function awaitRoadmapMerge(state: Ready, index: number) {
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
export async function mergeRoadmapAttempt(state: Ready, worktreeId: WorktreeId) {
  const merged = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/worktrees/${worktreeId}/merge`,
    headers: mutationHeaders(state),
    payload: {},
  });
  expect(merged.statusCode, merged.body).toBe(200);
}

export function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected fixture record');
  return value;
}
export const parallelScheduling = {
  mode: 'parallel' as const,
  maxInFlight: 2,
  maxPerRepository: 2,
  maxIntegrationRefreshes: 3,
};
export async function parallelFixture(
  options: {
    gitOperations?: GitOperations;
    keepWorktree?: boolean;
    independentThird?: boolean;
    workers?: boolean;
  } = {},
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
  if (!options.independentThird)
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
export async function useIntegration(
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

export async function finalizationFixture(
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
  backend.replyForRequest = finalizationReply;
  const profile = cycleProfiles.review;
  const legacyInput = {
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
  return { ...fixture, input: stagedInput(legacyInput), legacyInput, integration };
}
/**
 * Staged finalization settings (R-B10): the five stage kinds over the whole plan, each with
 * its own review and implement models (`<kind>-review`, `<kind>-implement`). Legacy
 * improvement rounds are empty.
 */
export function stagedInput<T extends { readonly policy: CompletionPolicy }>(
  base: T,
  stage: Partial<CompletionPolicy> = {},
) {
  return {
    ...base,
    rounds: [],
    stages: FINALIZATION_STAGE_KINDS.map((kind) => ({
      id: kind,
      kind,
      name: kind,
      instructions: `${kind} focus`,
      workItemSourceIds: [],
      review: { ...cycleProfiles.review, model: `${kind}-review` },
      implement: { ...cycleProfiles.remediate, model: `${kind}-implement` },
      policy: { ...DEFAULT_COMPLETION_POLICY, maxNits: 100, maxRemediationRounds: 1, ...stage },
      requiredChecks: ['fixture checks'],
    })),
  };
}
const STAGED_LEDGER = /`([^`]+\/craftingtable-finalization-state\.json)`/;
/** The staged evidence handoff a finalization prompt names. */
export function stagedLedger(request: AgentLaunchRequest) {
  const path = STAGED_LEDGER.exec(request.prompt)?.[1];
  if (!path) throw new Error('Expected staged evidence handoff');
  return JSON.parse(readFileSync(path, 'utf8')) as {
    stages: import('@craftingtable/domain').FinalizationStage[];
    progress: import('@craftingtable/domain').FinalizationProgress;
    reviewBaseline: import('@craftingtable/domain').ReviewBranchContext;
  };
}
/** The stage kind a staged finalization prompt is reviewing. */
export function stagedKind(request: AgentLaunchRequest) {
  const ledger = stagedLedger(request);
  return ledger.stages[ledger.progress.stageIndex]?.kind;
}
/** A complete stage review report: passing checks and every adopted obligation met. */
export function stagedText(
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
/** Whether a finalization launch implements (rather than reviews) a stage or round. */
export const implementsFinalization = (request: AgentLaunchRequest): boolean =>
  /^Role: (implement|remediate)$/m.test(request.prompt) || request.model === 'polish-model';
/**
 * The fixture's default finalization agent: implement steps report a commit, reviews pass. A
 * staged prompt gets a staged report; a legacy one the legacy conformance report.
 */
export function finalizationReply(request: AgentLaunchRequest): ScriptedReply {
  if (implementsFinalization(request))
    return { resultText: 'Committed and checked.\n\n## Open questions\nnone' };
  if (STAGED_LEDGER.test(request.prompt)) return { resultText: stagedText(request) };
  return {
    resultText: `Conformance assessed against the whole plan.\n\n## Open questions\nnone\n\n## Review report\n${reviewText([])}`,
  };
}
/** An optional simplification idea a stage may select or leave as follow-up work. */
export const stageIdea = {
  ...structuredFinding,
  id: 'S-1',
  category: 'simplification',
  severity: 'minor',
};
export async function beginFinalization(
  fixture: Awaited<ReturnType<typeof finalizationFixture>>,
  input: import('@craftingtable/contracts').StartFinalizationRequest = fixture.input,
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
export function finalizationCycle(
  state: Ready,
  value: import('@craftingtable/domain').Finalization,
) {
  return present(state.context.storage.execution.cycles.find(state.workspaceId, value.cycleId));
}
export async function finalizationCommand(
  state: Ready,
  value: import('@craftingtable/domain').Finalization,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
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

/**
 * Local scope fixtures exercise execution without claiming the full v0.3 map's future
 * authority. The map passes the v0.3 importer, as an operator's upload would (R-F3, FMT-15):
 * `alterSource` edits the local map, it is sealed and imported, and an edit the importer
 * rejects fails the fixture with its diagnostics. The definition the scopes use is that
 * imported map without its scaffolding repositories (see `withoutScaffolding`).
 */
export async function slicedFixture(
  alterSource?: (
    source: import('@craftingtable/domain').ConcurrencySource,
  ) => import('@craftingtable/domain').ConcurrencySource,
  useRevision = false,
) {
  const fixture = await roadmapFixture();
  if (useRevision) await useIntegration(fixture);
  const { state, repository } = fixture;
  const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]);
  const base = localScopeSource();
  const local = alterSource ? alterSource(base) : base;
  const imported = state.context.services.packageImportService.importConcurrency(
    auth,
    state.workspaceId,
    'local-scope-map.zip',
    localMapArchive({ ...local, map_id: `${local.map_id}-sealed` }),
  );
  const sealedId = imported.attempt.definitionId;
  if (imported.attempt.outcome !== 'succeeded' || sealedId === undefined)
    throw new Error(
      `The fixture map was not imported: ${imported.attempt.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`,
    );
  const sealed = present(state.context.storage.imports.definition(state.workspaceId, sealedId));
  const id = randomUUID();
  const stored = withoutScaffolding(sealed.source, local);
  state.context.storage.imports.addDefinition({
    ...sealed,
    id,
    mapId: stored.map_id,
    source: stored,
    digest: sourceRecordDigest(stored as unknown as import('@craftingtable/domain').JsonValue),
  });
  const definition = present(state.context.storage.imports.definition(state.workspaceId, id));
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
        workItems: definition.source.work_items
          .filter((p) => p.repository === 'local')
          .map((p) => ({
            sourceId: p.id,
            workItemId: p.id === 'local/AQ-02' ? fixture.second : state.workItemId,
            sourceRecordDigest: p.source_record_sha256,
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
  const scopes = LOCAL_SLICES.map((sourceId) => ({
    kind: 'slice' as const,
    definitionId: id,
    bindingRevision: 1,
    sourceId,
  }));
  const parentScope: ExecutionScope = {
    kind: 'parent-acceptance',
    definitionId: id,
    bindingRevision: 1,
    sourceId: 'local/AQ-01',
  };
  // The base map's one case, CASE-PARENT, is owned by the parent and produced by slice a.
  expectScopeCases(state, {
    'parent-acceptance local/AQ-01': ['CASE-PARENT'],
    'slice local/AQ-01/a': ['CASE-PARENT'],
    'slice-verification local/AQ-01/a': ['CASE-PARENT'],
  });
  return { ...fixture, auth, scopes, parentScope };
}
/** The local consumer's dependency environment: no upstream pins, one local test environment. */
export function configureLocalRuntime(
  auth: ReturnType<TestContext['services']['authService']['authenticate']>,
  state: Ready,
  definitionId: string,
) {
  return state.context.services.runtimeEvidenceService.configure(
    auth,
    state.workspaceId,
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
}
export async function scopeTree(
  f: Awaited<ReturnType<typeof slicedFixture>>,
  scope: ExecutionScope,
) {
  return f.state.context.services.executionService.createWorktree(
    f.auth,
    f.state.workspaceId,
    f.state.workItemId,
    { repositoryId: f.repository.id, executionScope: scope },
  );
}
/**
 * What each fixture scope must evidence, written out from the fixture maps instead of being
 * computed by the resolver under test (R-I5, QA-06). Requirements depend only on the scope; case
 * IDs depend on the fixture's map, so each fixture declares them with `expectScopeCases`. The
 * focused tests in server-execution-scopes and server-execution-scope-evidence check that the
 * resolver agrees.
 */
export const SCOPE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  'slice local/AQ-01/a': ['Tests passed', 'Complete local/AQ-01/a'],
  'slice-verification local/AQ-01/a': ['Tests passed', 'Complete local/AQ-01/a'],
  'slice local/AQ-01/b': ['Tests passed', 'Complete local/AQ-01/b'],
  'slice-verification local/AQ-01/b': ['Tests passed', 'Complete local/AQ-01/b'],
  'slice local/AQ-02/a': ['Tests passed', 'Complete local/AQ-02/a'],
  'slice-verification local/AQ-02/a': ['Tests passed', 'Complete local/AQ-02/a'],
  'parent-acceptance local/AQ-01': ['Original plan conforms', 'Queue accepts and drains one job.'],
  'parent-acceptance local/AQ-02': ['Original plan conforms', 'Done'],
};
export const scopeKey = (scope: ExecutionScope): string => `${scope.kind} ${scope.sourceId}`;
const scopeCaseExpectations = new WeakMap<Ready, Readonly<Record<string, readonly string[]>>>();
/** The case IDs a fixture's map assigns to its scopes; a scope not named here has none. */
export function expectScopeCases(state: Ready, cases: Record<string, readonly string[]>): void {
  scopeCaseExpectations.set(state, { ...scopeCaseExpectations.get(state), ...cases });
}
export function expectedScopeEvidence(state: Ready, scope: ExecutionScope) {
  const key = scopeKey(scope);
  const requirements = SCOPE_REQUIREMENTS[key];
  if (requirements === undefined) throw new Error(`No literal scope expectation for ${key}.`);
  return { requirements, caseIds: scopeCaseExpectations.get(state)?.[key] ?? [] };
}

export function scopeReport(
  state: Ready,
  scope: ExecutionScope,
  omitRequirement = false,
  omitCase = false,
) {
  const expected = expectedScopeEvidence(state, scope);
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
          : expected.requirements.map((requirement) => ({
              requirement,
              evidence: 'Verified against tests and source.',
            })),
        caseIds: omitCase ? [] : expected.caseIds,
      },
    }) +
    '\n```\nVERDICT: mergeable'
  );
}
/** Git as the daemon resolves it, on PATH, not a fixed install path (R-I5, QA-08). */
export const HOST_GIT: string = (() => {
  const git = resolveExecutable('git', undefined);
  if (git === undefined) throw new Error('The execution tests need a git executable on PATH.');
  return git;
})();

/** Cargo as the daemon resolves it (PATH, then rustup's default); undefined on a host without Rust. */
export const HOST_CARGO: string | undefined = resolveExecutable('cargo', undefined, process.env, [
  join(homedir(), '.cargo', 'bin'),
]);

/**
 * A test of the pinned Cargo build path, which the daemon refuses without Cargo ("The pinned
 * build adapter requires Cargo"). It runs wherever Cargo is installed and is skipped elsewhere.
 */
export const itNeedsCargo: ReturnType<typeof it.skipIf> = it.skipIf(HOST_CARGO === undefined);

export function runScopedFixtureCheck(request: import('@craftingtable/agents').AgentLaunchRequest) {
  if (!request.buildEnvironment) return;
  const manifest = JSON.parse(
    readFileSync(join(request.buildEnvironment.binDirectory, '../manifest.json'), 'utf8'),
  );
  if (manifest.verification?.mode === 'scoped-checks')
    execFileSync(
      join(request.buildEnvironment.binDirectory, 'ct-check'),
      ['--', HOST_GIT, 'diff', '--check', 'HEAD'],
      { cwd: request.cwd },
    );
}
export async function reviewScope(
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
export async function recordScope(
  f: Awaited<ReturnType<typeof slicedFixture>>,
  tree: import('@craftingtable/domain').Worktree,
  headers = mutationHeaders(f.state),
): Promise<LightMyRequestResponse> {
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

export async function launchScoped(
  f: Awaited<ReturnType<typeof slicedFixture>>,
  tree: import('@craftingtable/domain').Worktree,
): Promise<LightMyRequestResponse> {
  return f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/work-items/${f.state.workItemId}/runs`,
    headers: mutationHeaders(f.state),
    payload: { worktreeId: tree.id, role: 'design', permissionMode: 'auto' },
  });
}
export async function supervisedMapFixture(
  partial = false,
  parentAcceptance: 'manual' | 'automatic' = 'automatic',
  wholePlan = false,
  planApproval = false,
  singleOwner = false,
  amend: (
    source: import('@craftingtable/domain').ConcurrencySource,
  ) => import('@craftingtable/domain').ConcurrencySource = (source) => source,
) {
  const f = await slicedFixture(
    (s) =>
      amend({
        ...s,
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
        work_items: s.work_items.flatMap((p) => {
          const owned = singleOwner ? p.required_slices.slice(0, 1) : p.required_slices;
          return [
            {
              ...p,
              source_profile_case_ids: [],
              required_slices: owned,
              acceptance_requires: owned.map((id) => ({
                kind: 'slice' as const,
                id,
                state: 'verified' as const,
              })),
            },
            ...(wholePlan
              ? [
                  {
                    ...p,
                    id: 'local/AQ-02',
                    planning_order: 2,
                    source_exit_gate: 'Done',
                    source_profile_case_ids: [],
                    depends_on: ['local/AQ-01'],
                    required_slices: ['local/AQ-02/a'],
                    acceptance_requires: [
                      { kind: 'work_item' as const, id: 'local/AQ-01', state: 'accepted' as const },
                      { kind: 'slice' as const, id: 'local/AQ-02/a', state: 'verified' as const },
                    ],
                  },
                ]
              : []),
          ];
        }),
        slices: [
          ...(singleOwner ? s.slices.slice(0, 1) : s.slices),
          ...(wholePlan
            ? [
                {
                  ...s.slices[0]!,
                  id: 'local/AQ-02/a',
                  work_item: 'local/AQ-02',
                  title: 'local/AQ-02/a',
                  scope: 'Complete local/AQ-02/a',
                },
              ]
            : []),
        ].map((s) => ({
          ...s,
          start_requires: planApproval
            ? [{ kind: 'checkpoint' as const, id: 'STACK-PLAN-ACCEPTED', state: 'passed' as const }]
            : s.start_requires,
          decision_refs: ['CS-D01'],
        })),
        // Supervised maps carry no local case; the sealed package gives the peer lane one.
        acceptance_coverage: [],
        checkpoints: [
          ...s.checkpoints.filter((c) => c.id !== 'LOCAL-CASES'),
          ...(planApproval
            ? [
                {
                  ...s.checkpoints[0]!,
                  id: 'STACK-PLAN-ACCEPTED',
                  title: 'Approved concurrency sidecar and application bindings',
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
                ? { kind: 'slice', id: 'local/AQ-01/a', state: 'verified' }
                : { kind: 'work_item', id: 'local/AQ-01', state: 'accepted' },
            ],
            decision_refs: [],
            evidence_profile: 'scope-review',
            pass_criteria: ['Target inspected'],
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
  expectScopeCases(f.state, {
    'parent-acceptance local/AQ-01': [],
    'parent-acceptance local/AQ-02': [],
    'slice local/AQ-01/a': [],
    'slice-verification local/AQ-01/a': [],
  });
  const ws = f.state.workspaceId,
    definitionId = f.parentScope.definitionId;
  const runtime = await configureLocalRuntime(f.auth, f.state, definitionId);
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
    commitFile(request.cwd, `slice-${basename(request.cwd)}.txt`, 'Implemented bounded slice');
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
export const mapCommand = (
  f: Awaited<ReturnType<typeof supervisedMapFixture>>,
  command: string,
  payload: unknown,
  headers = mutationHeaders(f.state),
): Promise<LightMyRequestResponse> =>
  f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.state.workspaceId}/concurrency-definitions/${f.parentScope.definitionId}/supervision/${command}`,
    headers,
    payload: payload as Record<string, unknown>,
  });
export async function adoptSupervisedMap(f: Awaited<ReturnType<typeof supervisedMapFixture>>) {
  const result = await mapCommand(f, 'adopt', {
    bindingRevision: 1,
    decisionIds: ['CS-D01'],
    rationale: 'Reviewed exact definition and retained obligations.',
  });
  expect(result.statusCode, result.body).toBe(200);
}
