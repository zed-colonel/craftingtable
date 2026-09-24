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
  type ProviderFailure,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import type { ServiceSet } from './composition.js';
import { CSRF_HEADER_NAME } from './config.js';
import { createTestContext, type TestContext } from './test-support.js';

/**
 * Shared fixture for cycle-controller tests: a real daemon context with one repository,
 * two admitted-in-order work items, and a scripted agent whose turns finish only when the
 * test says so. With `workers: false` the controller loops stay stopped and the test steps
 * them with `stepController`, so nothing depends on wall-clock time (R-B2).
 */

const GIT_ENV = {
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

/** Polls a condition; only for tests that let the real worker loops run. */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 4000,
): Promise<void> {
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
export class HeldSession implements AgentSession {
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

  /** Ends the turn with a model-service failure and exits, as the vendor CLI does. */
  failWithService(providerFailure: ProviderFailure): void {
    this.push({
      type: 'event',
      event: {
        kind: 'turn-completed',
        payload: {
          outcome: 'error',
          resultText: providerFailure.message,
          providerFailure,
          turns: 1,
          durationMs: 5,
        },
      },
    });
    this.exit(1, null);
  }

  /** The process dies mid-turn without a result. */
  crash(): void {
    this.exit(1, null);
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

export class HeldBackend implements AgentBackend {
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

  /** The most recently launched session. */
  get latest(): HeldSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error('No session launched');
    return session;
  }
}

export const cycleProfiles = Object.fromEntries(
  CYCLE_STEPS.map((step) => [
    step,
    { backend: 'claude-code', model: `${step}-model`, permissionMode: 'auto' },
  ]),
) as unknown as CycleProfiles;

export const designDone = 'Design complete.\n\n## Open questions\nnone';
export const openQuestions = 'Done.\n\n## Open questions\nWhich queue should own retries?';
export function reviewText(findings: readonly unknown[] = []): string {
  return `\`\`\`craftingtable-review\n${JSON.stringify({ version: 1, complete: true, verdict: 'mergeable', exitGate: { met: true, evidence: 'Checks passed.' }, findings })}\n\`\`\`\nVERDICT: mergeable`;
}

export interface CycleFixture {
  readonly context: TestContext;
  readonly services: ServiceSet;
  readonly backend: HeldBackend;
  readonly workspaceId: WorkspaceId;
  readonly headers: Record<string, string>;
  readonly repositoryId: string;
  readonly worktreeId: string;
  cleanup(): Promise<void>;
}

export async function createCycleFixture(
  options: { readonly workers?: boolean } = {},
): Promise<CycleFixture> {
  const backend = new HeldBackend();
  const context = await createTestContext({
    gitOperations: createGitOperations({ gitExecutable: 'git' }),
    agentBackends: new Map([[backend.kind, backend]]),
    ...(options.workers === false ? { workers: false } : {}),
  });
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-cycle-repo-'));
  const cleanup = async () => {
    await context.cleanup();
    rmSync(root, { recursive: true, force: true });
  };
  try {
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
        name: 'Cycle project',
        slug: 'cycle-project',
        createdAt: at,
        createdByUserId: user.id,
      });
      tx.planning.bundles.insert({
        id: asPlanBundleId('bundle-1'),
        workspaceId,
        projectId: asProjectId('project-1'),
        logicalName: 'cycle',
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
    git(['init', '--initial-branch=main', '.'], root);
    writeFileSync(join(root, 'README.md'), '# fixture\n');
    git(['add', '--all'], root);
    git(['commit', '--no-gpg-sign', '-m', 'initial'], root);
    const inject = async (url: string, payload: Record<string, unknown>) => {
      const response = await context.app.inject({ method: 'POST', url, headers, payload });
      if (response.statusCode !== 200)
        throw new Error(`${url}: ${response.statusCode} ${response.body}`);
      return response.json();
    };
    const repositoryId = registerSourceRepositoryResponseSchema.parse(
      await inject(`/api/workspaces/${workspaceId}/repositories`, {
        rootPath: root,
        displayName: 'Fixture',
      }),
    ).repository.id;
    await inject(`/api/workspaces/${workspaceId}/plan-versions/version-1/branch-settings`, {
      repositoryId,
      integrationBranch: 'main',
      expectedVersion: 0,
    });
    const worktree = createWorktreeResponseSchema.parse(
      await inject(`/api/workspaces/${workspaceId}/work-items/item-1/worktrees`, {
        repositoryId,
      }),
    ).worktree;
    await inject(`/api/workspaces/${workspaceId}/work-items/item-1/admit`, {});
    return {
      context,
      services: context.services,
      backend,
      workspaceId,
      headers,
      repositoryId,
      worktreeId: worktree.id,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function startCycle(f: CycleFixture): Promise<WorkCycle> {
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
  if (response.statusCode !== 200) throw new Error(`start cycle: ${response.body}`);
  return workCycleResponseSchema.parse(response.json()).cycle;
}

export function storedCycle(f: CycleFixture, id: string): WorkCycle {
  const found = f.context.storage.execution.cycles.find(f.workspaceId, id as WorkCycle['id']);
  if (!found) throw new Error('Missing cycle');
  return found;
}

export function storedRun(f: CycleFixture, id: string): AgentRun | undefined {
  return f.context.storage.execution.runs.find(f.workspaceId, id as AgentRun['id']);
}

export function runFinished(f: CycleFixture, id: string) {
  const event = f.context.storage.execution.runEvents.latestOfKind(
    f.workspaceId,
    id as AgentRun['id'],
    'run-finished',
  );
  return event?.kind === 'run-finished' ? event.payload : undefined;
}

/**
 * One deterministic controller step: journal every event the scripted sessions already
 * produced, run one reconcile pass over every cycle, and journal what that pass caused.
 * No wall-clock waiting (R-B2).
 */
export async function stepController(services: ServiceSet, steps = 1): Promise<void> {
  for (let step = 0; step < steps; step++) {
    await services.agentRunService.quiesce();
    await services.workCycleService.tick();
    await services.agentRunService.quiesce();
  }
}
