import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentBackend,
  AgentLaunchRequest,
  AgentSession,
  AgentSessionItem,
} from '@craftingtable/agents';
import {
  createWorktreeResponseSchema,
  registerSourceRepositoryResponseSchema,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import {
  type AgentRun,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asWorkItemDependencyId,
  asWorkItemId,
  CYCLE_STEPS,
  type CycleProfiles,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import { afterEach, describe, expect, it } from 'vitest';
import { createServices, type ServiceSet } from './composition.js';
import { CSRF_HEADER_NAME } from './config.js';
import { DRAIN_REQUEST_FILE, DRAIN_STATUS_FILE } from './services/daemon-drain.js';
import { createTestContext, FastTestPasswordHasher, type TestContext } from './test-support.js';

/**
 * R-B9: a restart drains live agent turns, and after a clean restart an interrupted cycle
 * step resumes its vendor session with no operator action. Crashes, lost sessions and
 * failed resumes keep the explicit operator resume.
 */

const contexts: TestContext[] = [];
const restarted: ServiceSet[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const services of restarted.splice(0)) await services.daemonDrain.drain(0);
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A session whose turn completes only when the test releases it, like a long agent turn.
 * It reports a vendor session id unless told not to, and exits by signal when killed.
 */
class HeldSession implements AgentSession {
  readonly pid = 5151;
  readonly backgroundWorkPending = false;
  private readonly queue: AgentSessionItem[] = [];
  private waiter: ((item: IteratorResult<AgentSessionItem>) => void) | undefined;
  private closed = false;

  constructor(
    readonly request: AgentLaunchRequest,
    sessionId: string | undefined,
  ) {
    if (sessionId !== undefined)
      this.push({
        type: 'event',
        event: {
          kind: 'session-started',
          payload: {
            backend: 'claude-code',
            backendSessionId: sessionId,
            model: request.model ?? 'default',
            permissionMode: request.permissionMode,
            cwd: request.cwd,
            billing: 'subscription',
          },
        },
      });
  }

  /** Completes the turn with a final message, as an agent reporting its result. */
  release(resultText: string): void {
    this.push({
      type: 'event',
      event: { kind: 'assistant-message', payload: { text: resultText } },
    });
    this.push({
      type: 'event',
      event: {
        kind: 'turn-completed',
        payload: { outcome: 'success', resultText, costUsd: 0.1, turns: 1, durationMs: 5 },
      },
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
  }
}

class HeldBackend implements AgentBackend {
  readonly kind = 'claude-code' as const;
  readonly sessions: HeldSession[] = [];
  withoutSessionId = false;
  failResumes = false;

  describe() {
    return { kind: this.kind, label: 'Held', executable: '/fake/claude', models: [] };
  }

  launch(request: AgentLaunchRequest): Promise<AgentSession> {
    if (this.failResumes && request.resumeSessionId !== undefined)
      return Promise.reject(new Error('No conversation found with that session id'));
    const session = new HeldSession(
      request,
      this.withoutSessionId ? undefined : `vendor-session-${this.sessions.length + 1}`,
    );
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  get launches(): readonly AgentLaunchRequest[] {
    return this.sessions.map((session) => session.request);
  }
}

const cycleProfiles = Object.fromEntries(
  CYCLE_STEPS.map((step) => [
    step,
    { backend: 'claude-code', model: `${step}-model`, permissionMode: 'auto' },
  ]),
) as unknown as CycleProfiles;

interface Fixture {
  readonly context: TestContext;
  readonly backend: HeldBackend;
  readonly workspaceId: WorkspaceId;
  readonly headers: Record<string, string>;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

async function fixture(): Promise<Fixture> {
  const backend = new HeldBackend();
  const context = await createTestContext({
    gitOperations: createGitOperations({ gitExecutable: 'git' }),
    agentBackends: new Map([[backend.kind, backend]]),
  });
  contexts.push(context);
  await context.bootstrap();
  const login = await context.login();
  const user = context.storage.users.findByNormalizedUsername('test-user');
  const workspaceId = user && context.storage.workspaces.listAuthorized(user.id)[0]?.workspace.id;
  if (!user || !workspaceId) throw new Error('bootstrap failed');
  const at = '2026-09-23T00:00:00.000Z';
  context.storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: asProjectId('project-1'),
      workspaceId,
      name: 'Restart project',
      slug: 'restart-project',
      createdAt: at,
      createdByUserId: user.id,
    });
    tx.planning.bundles.insert({
      id: asPlanBundleId('bundle-1'),
      workspaceId,
      projectId: asProjectId('project-1'),
      logicalName: 'restart',
      createdAt: at,
    });
    tx.planning.versions.insert({
      id: asPlanVersionId('version-1'),
      workspaceId,
      projectId: asProjectId('project-1'),
      bundleId: asPlanBundleId('bundle-1'),
      versionNumber: 1,
      contentDigest: 'e'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'plan.md',
      normalizedSource: { document: 'plan.md' },
      itemCount: 2,
      requiredDependencyCount: 1,
      createdAt: at,
      createdByUserId: user.id,
    });
    tx.planning.workItems.insertMany(
      ['item-1', 'item-2'].map((id, ordinal) => ({
        id: asWorkItemId(id),
        workspaceId,
        projectId: asProjectId('project-1'),
        planVersionId: asPlanVersionId('version-1'),
        sourceId: `AQ-0${ordinal + 1}`,
        ordinal,
        title: `Item ${ordinal + 1}`,
        risk: 'low' as const,
        primaryAreas: [],
        exitGate: 'Done',
        sourceFields: { id: `AQ-0${ordinal + 1}` },
      })),
    );
    tx.planning.dependencies.insertMany([
      {
        id: asWorkItemDependencyId('edge'),
        workspaceId,
        planVersionId: asPlanVersionId('version-1'),
        predecessorWorkItemId: asWorkItemId('item-1'),
        successorWorkItemId: asWorkItemId('item-2'),
        kind: 'required',
        ordinal: 0,
      },
    ]);
  });
  const headers = {
    cookie: login.cookie,
    origin: context.config.publicOrigin,
    [CSRF_HEADER_NAME]: login.csrfToken,
    'content-type': 'application/json',
  };
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-restart-repo-'));
  directories.push(root);
  git(['init', '--initial-branch=main', '.'], root);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  git(['add', '--all'], root);
  git(['commit', '--no-gpg-sign', '-m', 'initial'], root);
  const registered = await context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/repositories`,
    headers,
    payload: { rootPath: root, displayName: 'Fixture' },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const repositoryId = registerSourceRepositoryResponseSchema.parse(registered.json()).repository
    .id;
  const settings = await context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/plan-versions/version-1/branch-settings`,
    headers,
    payload: { repositoryId, integrationBranch: 'main', expectedVersion: 0 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  const worktree = await context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/work-items/item-1/worktrees`,
    headers,
    payload: { repositoryId },
  });
  expect(worktree.statusCode, worktree.body).toBe(200);
  const admitted = await context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/work-items/item-1/admit`,
    headers,
    payload: {},
  });
  expect(admitted.statusCode, admitted.body).toBe(200);
  return {
    context,
    backend,
    workspaceId,
    headers,
    repositoryId,
    worktreeId: createWorktreeResponseSchema.parse(worktree.json()).worktree.id,
  };
}

async function startCycle(f: Fixture): Promise<WorkCycle> {
  const response = await f.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.workspaceId}/work-items/item-1/cycles`,
    headers: f.headers,
    payload: {
      worktreeId: f.worktreeId,
      profiles: cycleProfiles,
      policy: DEFAULT_COMPLETION_POLICY,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const started = workCycleResponseSchema.parse(response.json()).cycle;
  await waitFor(() => f.backend.sessions.length === 1, 'design launch');
  await waitFor(() => run(f, cycle(f, started.id).currentRunId)?.status === 'running', 'live');
  return started;
}

function cycle(f: Fixture, id: string): WorkCycle {
  const found = f.context.storage.execution.cycles.find(f.workspaceId, id as WorkCycle['id']);
  if (!found) throw new Error('Missing cycle');
  return found;
}

function run(f: Fixture, id: string): AgentRun | undefined {
  return f.context.storage.execution.runs.find(f.workspaceId, id as AgentRun['id']);
}

function finished(f: Fixture, id: string) {
  const event = f.context.storage.execution.runEvents.latestOfKind(
    f.workspaceId,
    id as AgentRun['id'],
    'run-finished',
  );
  return event?.kind === 'run-finished' ? event.payload : undefined;
}

/** Starts a second daemon on the same database, as a restart does after the first stops. */
async function restart(f: Fixture): Promise<ServiceSet> {
  const services = await createServices(f.context.storage, f.context.config, {
    notificationTransport: { send: async () => ({ status: 'accepted' }) },
    passwordHasher: new FastTestPasswordHasher(),
    gitOperations: createGitOperations({ gitExecutable: 'git' }),
    agentBackends: new Map([[f.backend.kind, f.backend]]),
  });
  restarted.push(services);
  services.roadmapService.startWorker();
  services.workCycleService.startWorker();
  return services;
}

const designDone = 'Design complete.\n\n## Open questions\nnone';

describe('restart drain and automatic resume (R-B9)', () => {
  it('interrupts a long turn at the bound and resumes its session after a clean restart', async () => {
    const f = await fixture();
    const started = await startCycle(f);
    const interruptedId = cycle(f, started.id).currentRunId;

    expect(await f.context.services.daemonDrain.drain(20)).toBe(1);
    expect(run(f, interruptedId)?.status).toBe('interrupted');
    expect(finished(f, interruptedId)).toMatchObject({ reason: 'daemon-drain' });
    // The cycle is not stopped for the operator: the restart continues it.
    expect(cycle(f, started.id).status).toBe('running');

    await restart(f);
    await waitFor(() => f.backend.sessions.length === 2, 'resumed launch');
    const resumed = f.backend.launches[1];
    expect(resumed).toMatchObject({
      resumeSessionId: 'vendor-session-1',
      model: 'design-model',
      permissionMode: 'auto',
      deadlineAt: started.runDeadlineAt,
    });
    expect(resumed?.prompt).toContain('CraftingTable restarted while this step was in progress');
    expect(resumed?.additionalDirectories).toContain(
      join(f.context.config.execution.runsRoot, interruptedId),
    );
    const current = cycle(f, started.id);
    expect(current).toMatchObject({
      status: 'running',
      step: 'design',
      parentRunId: interruptedId,
    });
    expect(current.reason).toContain('Resuming the design session');

    // The resumed session finishes the step and the cycle moves on without the operator.
    await waitFor(() => run(f, current.currentRunId)?.status === 'running', 'resumed live');
    f.backend.sessions[1]?.release(designDone);
    await waitFor(() => cycle(f, started.id).step === 'implement', 'advance to implement');
  });

  it('lets a turn that finishes within the bound complete instead of interrupting it', async () => {
    const f = await fixture();
    const started = await startCycle(f);
    const designRunId = cycle(f, started.id).currentRunId;

    const draining = f.context.services.daemonDrain.drain(10_000);
    expect(f.context.services.agentRunService.busyRunCount()).toBe(1);
    f.backend.sessions[0]?.release(designDone);
    expect(await draining).toBe(0);
    expect(run(f, designRunId)?.status).toBe('finished');
    // The next step was reserved but not launched while draining.
    expect(f.backend.sessions).toHaveLength(1);

    await restart(f);
    await waitFor(() => f.backend.sessions.length === 2, 'next step after restart');
    expect(f.backend.launches[1]).toMatchObject({ model: 'implement-model' });
    expect(f.backend.launches[1]?.resumeSessionId).toBeUndefined();
  });

  it('resumes an interrupted review on its pinned review baseline', async () => {
    const f = await fixture();
    const started = await startCycle(f);
    f.backend.sessions[0]?.release(designDone);
    await waitFor(() => f.backend.sessions.length === 2, 'implement launch');
    const worktree = f.backend.launches[1]?.cwd as string;
    writeFileSync(join(worktree, 'change.txt'), 'implemented');
    git(['add', '.'], worktree);
    git(['commit', '--no-gpg-sign', '-m', 'implementation'], worktree);
    await waitFor(() => run(f, cycle(f, started.id).currentRunId)?.status === 'running', 'live');
    f.backend.sessions[1]?.release('Implemented and checks passed.');
    await waitFor(() => f.backend.sessions.length === 3, 'review launch');
    await waitFor(() => run(f, cycle(f, started.id).currentRunId)?.status === 'running', 'review');
    const review = run(f, cycle(f, started.id).currentRunId);

    expect(await f.context.services.daemonDrain.drain(0)).toBe(1);
    await restart(f);
    await waitFor(() => f.backend.sessions.length === 4, 'resumed review');
    expect(f.backend.launches[3]).toMatchObject({
      resumeSessionId: 'vendor-session-3',
      model: 'review-model',
    });
    const resumed = run(f, cycle(f, started.id).currentRunId);
    expect(resumed?.role).toBe('review');
    expect(resumed?.reviewBranchContext?.headSha).toBe(review?.reviewBranchContext?.headSha);
  });

  it('refuses new runs while draining', async () => {
    const f = await fixture();
    f.context.services.agentRunService.beginDrain();
    const response = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/work-items/item-1/runs`,
      headers: f.headers,
      payload: { worktreeId: f.worktreeId },
    });
    expect(response.statusCode, response.body).toBe(503);
    expect(f.backend.sessions).toHaveLength(0);
  });

  it('keeps the explicit resume after a crash', async () => {
    const f = await fixture();
    const started = await startCycle(f);
    const services = f.context.services;
    // A crash: the loops die with the process and the drain never records a clean stop.
    await services.roadmapService.shutdown();
    await services.workCycleService.shutdown();
    (services.agentRunService as unknown as { live: Map<string, unknown> }).live.clear();

    await restart(f);
    await waitFor(() => cycle(f, started.id).status === 'needs-attention', 'crash attention');
    expect(cycle(f, started.id).reason).toContain('Daemon restarted');
    expect(f.backend.sessions).toHaveLength(1);
  });

  it('asks the operator when the interrupted run never reported a session', async () => {
    const f = await fixture();
    f.backend.withoutSessionId = true;
    const response = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/work-items/item-1/cycles`,
      headers: f.headers,
      payload: {
        worktreeId: f.worktreeId,
        profiles: cycleProfiles,
        policy: DEFAULT_COMPLETION_POLICY,
      },
    });
    const started = workCycleResponseSchema.parse(response.json()).cycle;
    await waitFor(() => f.backend.sessions.length === 1, 'launch');
    await f.context.services.daemonDrain.drain(0);
    await restart(f);
    await waitFor(() => cycle(f, started.id).status === 'needs-attention', 'attention');
    expect(cycle(f, started.id).reason).toContain('before its agent session could be resumed');
    expect(f.backend.sessions).toHaveLength(1);
  });

  it('asks the operator when the resume fails', async () => {
    const f = await fixture();
    const started = await startCycle(f);
    await f.context.services.daemonDrain.drain(0);
    f.backend.failResumes = true;
    await restart(f);
    await waitFor(() => cycle(f, started.id).status === 'needs-attention', 'failed resume');
    const resumedRun = run(f, cycle(f, started.id).currentRunId);
    expect(resumedRun?.status).toBe('failed');
  });

  it('keeps a running roadmap running across a clean restart', async () => {
    const f = await fixture();
    const roadmapId = '00000000-0000-4000-8000-000000000010';
    const removed = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/worktrees/${f.worktreeId}/remove`,
      headers: f.headers,
      payload: {},
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const saved = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/roadmaps/${roadmapId}`,
      headers: f.headers,
      payload: {
        expectedVersion: 0,
        name: 'Restart roadmap',
        entries: ['item-1', 'item-2'].map((workItemId, index) => ({
          id: `00000000-0000-4000-8000-00000000001${index + 1}`,
          workItemId,
          profiles: cycleProfiles,
          policy: DEFAULT_COMPLETION_POLICY,
          instructions: '',
        })),
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const roadmap = () => f.context.storage.roadmaps.find(f.workspaceId, roadmapId);
    const control = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/roadmaps/${roadmapId}/control`,
      headers: f.headers,
      payload: { action: 'start', expectedVersion: roadmap()?.version },
    });
    expect(control.statusCode, control.body).toBe(200);
    await waitFor(() => f.backend.sessions.length === 1, 'roadmap design launch');

    expect(await f.context.services.daemonDrain.drain(0)).toBe(1);
    await restart(f);
    await waitFor(() => f.backend.sessions.length === 2, 'roadmap step resumed');
    expect(f.backend.launches[1]?.resumeSessionId).toBe('vendor-session-1');
    expect(roadmap()?.status).toBe('running');
  });

  it('drains on a deploy request, and a withdrawn request resumes admissions', async () => {
    const f = await fixture();
    await startCycle(f);
    const drain = f.context.services.daemonDrain;
    const dataDir = f.context.config.dataDir;
    const status = () => JSON.parse(readFileSync(join(dataDir, DRAIN_STATUS_FILE), 'utf8'));

    writeFileSync(
      join(dataDir, DRAIN_REQUEST_FILE),
      JSON.stringify({ id: 'r1', mode: 'when-idle' }),
    );
    drain.poll();
    expect(status()).toMatchObject({ requestId: 'r1', state: 'draining', busyRuns: 1 });
    expect(f.context.services.agentRunService.isDraining()).toBe(true);

    rmSync(join(dataDir, DRAIN_REQUEST_FILE));
    drain.poll();
    await waitFor(() => !drain.isDraining(), 'cancelled drain');
    expect(f.context.services.agentRunService.isDraining()).toBe(false);
    expect(existsSync(join(dataDir, DRAIN_STATUS_FILE))).toBe(false);

    // Once a stop signal joins a requested drain, withdrawing the request no longer cancels it.
    writeFileSync(
      join(dataDir, DRAIN_REQUEST_FILE),
      JSON.stringify({ id: 'r2', mode: 'when-idle' }),
    );
    drain.poll();
    const stopping = drain.drain(60_000);
    rmSync(join(dataDir, DRAIN_REQUEST_FILE));
    drain.poll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drain.isDraining()).toBe(true);
    drain.expedite();
    expect(await stopping).toBe(1);
    expect(status()).toMatchObject({ requestId: 'r2', state: 'drained', interruptedRuns: 1 });
  });

  it('interrupts at a deploy request’s own bound', async () => {
    const f = await fixture();
    await startCycle(f);
    const dataDir = f.context.config.dataDir;
    writeFileSync(
      join(dataDir, DRAIN_REQUEST_FILE),
      JSON.stringify({ id: 'r3', mode: 'bounded', timeoutSeconds: 0 }),
    );
    f.context.services.daemonDrain.poll();
    const status = () => JSON.parse(readFileSync(join(dataDir, DRAIN_STATUS_FILE), 'utf8'));
    await waitFor(() => status().state === 'drained', 'drained status');
    expect(status()).toMatchObject({ requestId: 'r3', interruptedRuns: 1 });
  });
});
